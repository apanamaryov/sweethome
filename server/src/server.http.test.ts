import fs from "fs";
import os from "os";
import path from "path";
import http from "http";
import request from "supertest";
import { WebSocket } from "ws";
import { loadConfig } from "./config";
import { Inverter } from "./inverter";
import { createServer } from "./server";

/**
 * Migrated from scripts/selfcheck-auth-http.ts: that script hand-rolls http.request
 * calls against a REAL createServer(...) to exercise the actual Express middleware
 * order and the actual admin-only route list (selfcheck-auth.ts only tests the
 * Auth/AuthDb/policy units in isolation). Here the same real server is driven with
 * supertest instead of a bespoke http client, and a few extra cases are added
 * (page redirects, IP lockout, WS auth gate) that the script didn't cover.
 *
 * Like service.test.ts, Auth's AuthDb always lives on a real file (constructor does
 * fs.mkdirSync(dataDir) + new AuthDb(...)), so each test gets its own fs.mkdtempSync
 * DATA_DIR. INVERTER_TRANSPORT=mock avoids needing real hardware; the Inverter is
 * never start()-ed (matches selfcheck-auth-http.ts) so there's no poll loop to clean
 * up — getSnapshot() still returns the default Snapshot object synchronously.
 */

describe("server.ts (HTTP integration via supertest)", () => {
  let tmp: string;
  let inverter: Inverter;
  let server: http.Server;

  beforeEach(() => {
    // env must be set before loadConfig() — it reads process.env synchronously.
    process.env.INVERTER_TRANSPORT = "mock";
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "server-http-test-"));
    process.env.DATA_DIR = tmp;

    const cfg = loadConfig();
    inverter = new Inverter(cfg);
    server = createServer(inverter, cfg, null);
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      if (server.listening) server.close(() => resolve());
      else resolve();
    });
    inverter.removeAllListeners();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function setCookieOf(res: request.Response): string {
    const sc = res.headers["set-cookie"];
    expect(sc).toBeDefined();
    return (sc as unknown as string[])[0].split(";")[0];
  }

  async function loginAs(username: string, password: string): Promise<string> {
    const res = await request(server).post("/api/login").send({ username, password });
    expect(res.status).toBe(200);
    return setCookieOf(res);
  }

  /** Logs in and clears the seeded must_change_password flag, returning a fully-usable cookie. */
  async function freshSessionCookie(username: string, password: string, newPassword: string): Promise<string> {
    const cookie = await loginAs(username, password);
    const res = await request(server)
      .post("/api/change-password")
      .set("Cookie", cookie)
      .send({ currentPassword: password, newPassword });
    expect(res.status).toBe(200);
    return cookie;
  }

  describe("no session", () => {
    it("GET /api/meta -> 401 Unauthorized", async () => {
      const res = await request(server).get("/api/meta");
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ ok: false, error: "Unauthorized" });
    });

    it("GET /api/snapshot -> 401 Unauthorized", async () => {
      const res = await request(server).get("/api/snapshot");
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ ok: false, error: "Unauthorized" });
    });

    it("GET /login is reachable (static, ungated)", async () => {
      const res = await request(server).get("/login");
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch(/html/);
    });

    it("GET / redirects to /login", async () => {
      const res = await request(server).get("/");
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe("/login");
    });
  });

  describe("admin login (seeded admin/admin)", () => {
    it("logs in, sets a session cookie, reports mustChangePassword true", async () => {
      const res = await request(server).post("/api/login").send({ username: "admin", password: "admin" });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, role: "admin", mustChangePassword: true });
      expect(setCookieOf(res)).toMatch(/^inv_session=/);
    });

    it("rejects a wrong password with 401 bad_password", async () => {
      const res = await request(server).post("/api/login").send({ username: "admin", password: "nope" });
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ ok: false, code: "bad_password", error: "Wrong credentials" });
      expect(res.headers["set-cookie"]).toBeUndefined();
    });

    it("grants admin routes access once the password has been changed", async () => {
      const cookie = await freshSessionCookie("admin", "admin", "admin123");

      const users = await request(server).get("/api/users").set("Cookie", cookie);
      expect(users.status).toBe(200);
      expect(Array.isArray(users.body)).toBe(true);

      const snapshot = await request(server).get("/api/snapshot").set("Cookie", cookie);
      expect(snapshot.status).toBe(200);
    });
  });

  describe("GET /api/stats/solar-window", () => {
    it("без сессии → 401", async () => {
      const res = await request(server).get("/api/stats/solar-window");
      expect(res.status).toBe(401);
    });

    it("с сессией, но статистика выключена (stats=null) → 503", async () => {
      const cookie = await freshSessionCookie("admin", "admin", "admin123");
      const res = await request(server).get("/api/stats/solar-window").set("Cookie", cookie);
      expect(res.status).toBe(503);
    });
  });

  describe("must_change_password gate", () => {
    it("blocks /api/snapshot and /api/control but allows me/change-password/logout", async () => {
      const cookie = await loginAs("admin", "admin");

      let res = await request(server).get("/api/snapshot").set("Cookie", cookie);
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ ok: false, code: "must_change_password", error: "Password change required" });

      res = await request(server)
        .post("/api/control")
        .set("Cookie", cookie)
        .send({ type: "outputSourcePriority", value: 0 });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("must_change_password");

      res = await request(server).get("/api/me").set("Cookie", cookie);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ username: "admin", role: "admin", mustChangePassword: true });

      res = await request(server)
        .post("/api/change-password")
        .set("Cookie", cookie)
        .send({ currentPassword: "admin", newPassword: "admin123" });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });

      // Gate lifts once the password is actually changed.
      res = await request(server).get("/api/snapshot").set("Cookie", cookie);
      expect(res.status).toBe(200);
      res = await request(server).get("/api/me").set("Cookie", cookie);
      expect(res.body.mustChangePassword).toBe(false);
    });

    it("logout works even while must_change_password is still set", async () => {
      const cookie = await loginAs("admin", "admin");

      const res = await request(server).post("/api/logout").set("Cookie", cookie);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });

      // The session is gone: /api/me (allowed pre-change-password) now 401s.
      const after = await request(server).get("/api/me").set("Cookie", cookie);
      expect(after.status).toBe(401);
    });

    it("redirects /change-password page itself through (no loop) but other pages to /change-password", async () => {
      const cookie = await loginAs("admin", "admin");

      let res = await request(server).get("/change-password").set("Cookie", cookie);
      expect(res.status).toBe(200);

      res = await request(server).get("/").set("Cookie", cookie);
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe("/change-password");
    });
  });

  describe("viewer login (seeded user/user)", () => {
    it("gets 403 on admin-only API routes", async () => {
      const cookie = await freshSessionCookie("user", "user", "viewer1");

      let res = await request(server)
        .post("/api/control")
        .set("Cookie", cookie)
        .send({ type: "outputSourcePriority", value: 0 });
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ ok: false, code: "forbidden", error: "Admins only" });

      res = await request(server).get("/api/users").set("Cookie", cookie);
      expect(res.status).toBe(403);

      res = await request(server).post("/api/lock").set("Cookie", cookie).send({ locked: true });
      expect(res.status).toBe(403);
    });

    it("gets 200 on / and /stats pages, and can read /api/snapshot", async () => {
      const cookie = await freshSessionCookie("user", "user", "viewer1");

      let res = await request(server).get("/").set("Cookie", cookie);
      expect(res.status).toBe(200);

      res = await request(server).get("/stats").set("Cookie", cookie);
      expect(res.status).toBe(200);

      res = await request(server).get("/api/snapshot").set("Cookie", cookie);
      expect(res.status).toBe(200);
    });

    it("redirects away from admin-only pages (e.g. /settings) to /", async () => {
      const cookie = await freshSessionCookie("user", "user", "viewer1");

      const res = await request(server).get("/settings").set("Cookie", cookie);
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe("/");
    });
  });

  describe("IP-based lockout (trust proxy 1 hop, req.ip via X-Forwarded-For)", () => {
    it("locks out after 5 failed logins from the same IP, even against correct creds", async () => {
      const ip = "203.0.113.7";
      for (let i = 0; i < 5; i++) {
        const res = await request(server)
          .post("/api/login")
          .set("X-Forwarded-For", ip)
          .send({ username: "admin", password: "wrong" });
        expect(res.status).toBe(401);
      }

      const res = await request(server)
        .post("/api/login")
        .set("X-Forwarded-For", ip)
        .send({ username: "admin", password: "admin" }); // correct creds — still locked out
      expect(res.status).toBe(429);
      expect(res.body.ok).toBe(false);
      expect(res.body.code).toBe("rate_limited");
      expect(res.body.minutes).toBeGreaterThan(0);
    });

    it("does not lock out a different IP", async () => {
      const lockedIp = "203.0.113.7";
      for (let i = 0; i < 5; i++) {
        await request(server)
          .post("/api/login")
          .set("X-Forwarded-For", lockedIp)
          .send({ username: "admin", password: "wrong" });
      }

      const res = await request(server)
        .post("/api/login")
        .set("X-Forwarded-For", "198.51.100.1")
        .send({ username: "admin", password: "admin" });
      expect(res.status).toBe(200);
    });
  });

  describe("WebSocket /ws", () => {
    async function listen(): Promise<number> {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve());
      });
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("server did not bind to a port");
      return addr.port;
    }

    function waitForEvent<T>(ws: WebSocket, event: "message" | "close" | "error"): Promise<T> {
      return new Promise((resolve, reject) => {
        ws.once(event, (arg: T) => resolve(arg));
        ws.once("error", reject);
      });
    }

    function closeClient(ws: WebSocket): Promise<void> {
      return new Promise((resolve) => {
        if (ws.readyState === WebSocket.CLOSED) return resolve();
        ws.once("close", () => resolve());
        ws.close();
      });
    }

    it("pushes a snapshot right after upgrade for an authenticated, password-changed session", async () => {
      const port = await listen();
      const cookie = await freshSessionCookie("admin", "admin", "admin123");

      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Cookie: cookie } });
      const raw = await waitForEvent<Buffer>(ws, "message");
      const msg = JSON.parse(raw.toString());

      expect(msg.type).toBe("snapshot");
      expect(msg.data).toBeDefined();
      expect(msg.data.mode).toBe("Unknown"); // default Snapshot — Inverter was never start()-ed

      await closeClient(ws);
    });

    it("closes the connection with code 4401 when there is no valid session", async () => {
      const port = await listen();

      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      const code = await waitForEvent<number>(ws, "close");

      expect(code).toBe(4401);
      await closeClient(ws);
    });

    it("closes the connection with code 4401 while must_change_password is still set", async () => {
      const port = await listen();
      const cookie = await loginAs("admin", "admin"); // fresh seed, must_change_password still true

      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Cookie: cookie } });
      const code = await waitForEvent<number>(ws, "close");

      expect(code).toBe(4401);
      await closeClient(ws);
    });
  });
});
