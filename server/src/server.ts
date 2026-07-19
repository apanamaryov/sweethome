import http from "http";
import path from "path";
import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import { Inverter } from "./inverter";
import { Config } from "./config";
import { Auth, tokenFromCookieHeader } from "./auth";
import {
  OUTPUT_SOURCE_PRIORITY,
  CHARGER_SOURCE_PRIORITY,
  ALLOWED_MAX_CHARGE_CURRENT,
  ALLOWED_MAX_AC_CHARGE_CURRENT,
  ControlType,
} from "./protocol/pi30";
import { Snapshot } from "./protocol/types";

const CONTROL_TYPES: ControlType[] = [
  "outputSourcePriority",
  "chargerSourcePriority",
  "maxChargingCurrent",
  "maxAcChargingCurrent",
  "batteryRechargeVoltage",
  "batteryRedischargeVoltage",
];

export function createServer(inverter: Inverter, cfg: Config): http.Server {
  const app = express();
  app.use(express.json());

  const auth = new Auth(cfg.dataDir, cfg.auth.password, cfg.auth.sessionTtlDays);
  if (!auth.enabled) {
    console.log("[inverter-monitor] auth disabled (set AUTH_PASSWORD to protect the UI/API)");
  }
  const reqToken = (req: express.Request) => tokenFromCookieHeader(req.headers.cookie);

  // The UI shell redirects to the login page when there is no session; static
  // assets themselves (css/js/login page) stay open — they contain no data.
  app.get(["/", "/index.html"], (req, res, next) => {
    if (auth.verifyToken(reqToken(req))) return next();
    res.redirect("/login.html");
  });

  const publicDir = path.join(__dirname, "..", "public");
  app.use(express.static(publicDir));

  app.post("/api/login", (req, res) => {
    if (!auth.enabled) return res.json({ ok: true });
    const { password } = req.body ?? {};
    if (typeof password !== "string") {
      return res.status(400).json({ ok: false, error: "password must be a string" });
    }
    try {
      const token = auth.login(password, req.socket.remoteAddress ?? "unknown");
      if (!token) {
        return res.status(401).json({ ok: false, code: "bad_password", error: "Wrong password" });
      }
      res.setHeader("Set-Cookie", auth.cookie(token));
      res.json({ ok: true });
    } catch (e) {
      const err = e as Error & { code?: number; retryMinutes?: number };
      if (err.code === 429) {
        return res
          .status(429)
          .json({ ok: false, code: "rate_limited", minutes: err.retryMinutes, error: err.message });
      }
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  app.post("/api/logout", (req, res) => {
    auth.logout(reqToken(req));
    res.setHeader("Set-Cookie", auth.clearCookie());
    res.json({ ok: true });
  });

  // Everything else under /api requires a session.
  app.use("/api", (req, res, next) => {
    if (auth.verifyToken(reqToken(req))) return next();
    res.status(401).json({ ok: false, error: "Unauthorized" });
  });

  app.get("/api/health", (_req, res) => res.json({ ok: true }));

  app.get("/api/snapshot", (_req, res) => res.json(inverter.getSnapshot()));

  app.get("/api/meta", (_req, res) => {
    res.json({
      authEnabled: auth.enabled,
      allowControl: cfg.allowControl,
      outputSourcePriority: OUTPUT_SOURCE_PRIORITY,
      chargerSourcePriority: CHARGER_SOURCE_PRIORITY,
      maxChargingCurrent: ALLOWED_MAX_CHARGE_CURRENT,
      maxAcChargingCurrent: ALLOWED_MAX_AC_CHARGE_CURRENT,
    });
  });

  app.post("/api/control", async (req, res) => {
    try {
      const { type, value } = req.body ?? {};
      if (!CONTROL_TYPES.includes(type)) {
        return res.status(400).json({ ok: false, error: `Unknown control type: ${type}` });
      }
      const numValue = Number(value);
      if (!Number.isFinite(numValue)) {
        return res.status(400).json({ ok: false, error: "value must be a number" });
      }
      const result = await inverter.control(type as ControlType, numValue);
      res.json(result);
    } catch (e) {
      res.status(400).json({ ok: false, error: (e as Error).message });
    }
  });

  app.post("/api/lock", (req, res) => {
    try {
      const { locked } = req.body ?? {};
      if (typeof locked !== "boolean") {
        return res.status(400).json({ ok: false, error: "locked must be a boolean" });
      }
      const result = inverter.setLock(locked);
      res.json({ ok: true, ...result });
    } catch (e) {
      res.status(400).json({ ok: false, error: (e as Error).message });
    }
  });

  app.get("/api/baseline", (_req, res) => res.json(inverter.getBaseline()));

  app.post("/api/baseline/recapture", async (_req, res) => {
    try {
      const baseline = await inverter.recaptureBaseline();
      res.json({ ok: true, baseline });
    } catch (e) {
      res.status(400).json({ ok: false, error: (e as Error).message });
    }
  });

  app.post("/api/raw", async (req, res) => {
    try {
      const { command } = req.body ?? {};
      if (typeof command !== "string") {
        return res.status(400).json({ ok: false, error: "command must be a string" });
      }
      const reply = await inverter.rawQuery(command);
      res.json({ ok: true, command, reply });
    } catch (e) {
      res.status(400).json({ ok: false, error: (e as Error).message });
    }
  });

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: "/ws" });

  const broadcast = (snap: Snapshot) => {
    const msg = JSON.stringify({ type: "snapshot", data: snap });
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(msg);
    }
  };
  inverter.on("snapshot", broadcast);

  wss.on("connection", (ws, req) => {
    if (!auth.verifyToken(tokenFromCookieHeader(req.headers.cookie))) {
      ws.close(4401, "Unauthorized");
      return;
    }
    ws.send(JSON.stringify({ type: "snapshot", data: inverter.getSnapshot() }));
  });

  return server;
}
