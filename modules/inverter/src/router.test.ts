import fs from "fs";
import os from "os";
import path from "path";
import express from "express";
import request from "supertest";
import type { AuthContext, RequestIdentity } from "@sweethome/shared/module";
import { Inverter } from "./inverter";
import { loadInverterConfig, InverterConfig } from "./config";
import { createInverterRouter } from "./router";

/**
 * Мини-харнесс: инжектит req.user/req.auth напрямую (как это делает authenticate
 * хоста) и монтирует роутер модуля на /api/inverter, как это делает createServer.
 * Реальный Inverter с transport: "mock" — тот же приём, что в server.http.test.ts
 * (never start()-ed: getSnapshot()/setLock()/previewControl() работают синхронно
 * без поднятого поллинга).
 */
function appWith(
  deps: Parameters<typeof createInverterRouter>[0],
  user: RequestIdentity,
  auth: AuthContext
): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = user;
    req.auth = auth;
    next();
  });
  app.use("/api/inverter", createInverterRouter(deps));
  return app;
}

const admin = (over: Partial<RequestIdentity> = {}): RequestIdentity => ({
  userId: 1,
  username: "admin",
  role: "admin",
  mustChangePassword: false,
  expiresAt: Number.MAX_SAFE_INTEGER,
  ...over,
});

const viewer = (over: Partial<RequestIdentity> = {}): RequestIdentity => ({
  userId: 2,
  username: "user",
  role: "viewer",
  mustChangePassword: false,
  expiresAt: Number.MAX_SAFE_INTEGER,
  ...over,
});

const sessionAuth: AuthContext = { kind: "session", scopes: ["read", "write"] };
const readToken: AuthContext = { kind: "token", scopes: ["read"], tokenName: "ro" };
const writeToken: AuthContext = { kind: "token", scopes: ["read", "write"], tokenName: "rw" };

describe("createInverterRouter", () => {
  let tmp: string;
  let cfg: InverterConfig;
  let inverter: Inverter;

  beforeEach(() => {
    process.env.INVERTER_TRANSPORT = "mock";
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "inverter-router-test-"));
    cfg = loadInverterConfig(tmp);
    inverter = new Inverter(cfg);
  });

  afterEach(() => {
    inverter.removeAllListeners();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  describe("admin gate on control/lock/raw/baseline", () => {
    it("403s a viewer", async () => {
      const app = appWith({ inverter, stats: null, cfg }, viewer(), sessionAuth);

      const control = await request(app)
        .post("/api/inverter/control")
        .send({ type: "outputSourcePriority", value: 0 });
      expect(control.status).toBe(403);
      expect(control.body).toEqual({ ok: false, code: "forbidden", error: "Admins only" });

      const lock = await request(app).post("/api/inverter/lock").send({ locked: true });
      expect(lock.status).toBe(403);

      const raw = await request(app).post("/api/inverter/raw").send({ command: "R 201" });
      expect(raw.status).toBe(403);

      const baseline = await request(app).get("/api/inverter/baseline");
      expect(baseline.status).toBe(403);

      // /api/inverter/baseline/recapture — тот же префикс-гейт, что и /baseline.
      const recapture = await request(app).post("/api/inverter/baseline/recapture");
      expect(recapture.status).toBe(403);
    });

    it("lets an admin through the gate", async () => {
      const app = appWith({ inverter, stats: null, cfg }, admin(), sessionAuth);
      const res = await request(app).get("/api/inverter/baseline");
      expect(res.status).toBe(200);
    });
  });

  describe("write scope on control/lock/raw", () => {
    it("allows a control preview without the write scope but denies the actual write", async () => {
      const app = appWith({ inverter, stats: null, cfg }, admin(), readToken);

      const preview = await request(app)
        .post("/api/inverter/control")
        .send({ type: "chargerSourcePriority", value: 3, preview: true });
      expect(preview.status).toBe(200);
      expect(preview.body).toMatchObject({ ok: true, preview: true, register: 331 });

      const write = await request(app)
        .post("/api/inverter/control")
        .send({ type: "chargerSourcePriority", value: 3 });
      expect(write.status).toBe(403);
      expect(write.body.code).toBe("scope_required");
    });

    it("denies lock and a raw W without the write scope", async () => {
      const app = appWith({ inverter, stats: null, cfg }, admin(), readToken);

      const lock = await request(app).post("/api/inverter/lock").send({ locked: false });
      expect(lock.status).toBe(403);
      expect(lock.body.code).toBe("scope_required");

      const rawWrite = await request(app).post("/api/inverter/raw").send({ command: "W 331 3" });
      expect(rawWrite.status).toBe(403);
      expect(rawWrite.body.code).toBe("scope_required");
    });

    it("allows lock/unlock once the token has the write scope", async () => {
      const app = appWith({ inverter, stats: null, cfg }, admin(), writeToken);
      const unlock = await request(app).post("/api/inverter/lock").send({ locked: false });
      expect(unlock.status).toBe(200);
      expect(unlock.body.locked).toBe(false);
    });
  });

  describe("statistics routes without a recorder", () => {
    it("503s when stats is null", async () => {
      const app = appWith({ inverter, stats: null, cfg }, admin(), sessionAuth);
      const res = await request(app).get("/api/inverter/stats/solar-window");
      expect(res.status).toBe(503);
    });
  });
});
