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
} from "@inverter/shared";
import { Snapshot } from "@inverter/shared";
import { GAUGE_FIELDS, GaugeField } from "./stats/db";
import { StatsRecorder } from "./stats/recorder";

const CONTROL_TYPES: ControlType[] = [
  "outputSourcePriority",
  "chargerSourcePriority",
  "maxChargingCurrent",
  "maxAcChargingCurrent",
  "batteryRechargeVoltage",
  "batteryRedischargeVoltage",
];

export function createServer(inverter: Inverter, cfg: Config, stats: StatsRecorder | null): http.Server {
  const app = express();
  app.use(express.json());

  const auth = new Auth(cfg.dataDir, cfg.auth.password, cfg.auth.sessionTtlDays);
  if (!auth.enabled) {
    console.log("[inverter-monitor] auth disabled (set AUTH_PASSWORD to protect the UI/API)");
  }
  const reqToken = (req: express.Request) => tokenFromCookieHeader(req.headers.cookie);

  // The UI shell redirects to the login page when there is no session; static
  // assets themselves (css/js/login page) stay open — they contain no data.
  app.get(["/", "/index.html", "/settings", "/diagnostics", "/stats"], (req, res, next) => {
    if (auth.verifyToken(reqToken(req))) return next();
    res.redirect("/login");
  });

  // Статика Next.js (web/out); extensions позволяет отдавать /settings как settings.html.
  const publicDir = path.join(__dirname, "..", "..", "web", "out");
  app.use(express.static(publicDir, { extensions: ["html"] }));

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

  // ---- Статистика (SQLite). При недоступной БД — 503, мониторинг живёт. ----
  const parseTime = (v: unknown): number | null => {
    const s = String(v ?? "");
    if (!s) return null;
    const n = Number(s);
    if (Number.isFinite(n)) return n;
    const d = Date.parse(s);
    return Number.isFinite(d) ? d : null;
  };

  app.get("/api/stats/series", (req, res) => {
    try {
      if (!stats) return res.status(503).json({ ok: false, error: "stats unavailable" });
      const fields = String(req.query.fields ?? "").split(",").filter(Boolean);
      if (!fields.length || fields.some((f) => !(GAUGE_FIELDS as readonly string[]).includes(f))) {
        return res
          .status(400)
          .json({ ok: false, error: `fields: comma list of ${GAUGE_FIELDS.join(", ")}` });
      }
      const from = parseTime(req.query.from);
      const to = parseTime(req.query.to);
      if (from === null || to === null || to <= from) {
        return res.status(400).json({ ok: false, error: "bad from/to" });
      }
      const r = String(req.query.res ?? "auto");
      const eff: "raw" | "minute" =
        r === "raw" || r === "minute"
          ? (r as "raw" | "minute")
          : to - from <= 6 * 3_600_000
            ? "raw"
            : "minute";
      res.json(stats.db.querySeries(fields as GaugeField[], from, to, eff));
    } catch (e) {
      console.error("[inverter-monitor] stats query failed:", (e as Error).message);
      res.status(503).json({ ok: false, error: "stats unavailable" });
    }
  });

  app.get("/api/stats/daily", (req, res) => {
    try {
      if (!stats) return res.status(503).json({ ok: false, error: "stats unavailable" });
      const day = /^\d{4}-\d{2}-\d{2}$/;
      const from = String(req.query.from ?? "");
      const to = String(req.query.to ?? "");
      if (!day.test(from) || !day.test(to)) {
        return res.status(400).json({ ok: false, error: "from/to must be YYYY-MM-DD" });
      }
      res.json(stats.db.queryDaily(from, to));
    } catch (e) {
      console.error("[inverter-monitor] stats query failed:", (e as Error).message);
      res.status(503).json({ ok: false, error: "stats unavailable" });
    }
  });

  app.get("/api/stats/events", (req, res) => {
    try {
      if (!stats) return res.status(503).json({ ok: false, error: "stats unavailable" });
      const from = parseTime(req.query.from) ?? undefined;
      const to = parseTime(req.query.to) ?? undefined;
      const type = req.query.type ? String(req.query.type) : undefined;
      const limit = Math.min(500, Math.max(1, Math.trunc(Number(req.query.limit) || 100)));
      const offset = Math.max(0, Math.trunc(Number(req.query.offset) || 0));
      res.json(stats.db.queryEvents({ from, to, type, limit, offset }));
    } catch (e) {
      console.error("[inverter-monitor] stats query failed:", (e as Error).message);
      res.status(503).json({ ok: false, error: "stats unavailable" });
    }
  });

  app.get("/api/stats/export.csv", (req, res) => {
    try {
      if (!stats) return res.status(503).json({ ok: false, error: "stats unavailable" });
      const from = parseTime(req.query.from);
      const to = parseTime(req.query.to);
      if (from === null || to === null || to <= from) {
        return res.status(400).json({ ok: false, error: "bad from/to" });
      }
      const kind = req.query.res === "minute" ? ("minute" as const) : ("raw" as const);
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="stats-${kind}-${from}-${to}.csv"`);
      const cols = stats.db.exportColumns(kind);
      res.write(cols.join(",") + "\n");
      // Значения — числа и имя режима (без запятых/кавычек), экранирование CSV не требуется.
      let after = from - 1;
      for (;;) {
        const chunk = stats.db.exportChunk(kind, after, to, 10_000);
        if (!chunk.length) break;
        res.write(chunk.map((r) => cols.map((c) => r[c] ?? "").join(",")).join("\n") + "\n");
        after = Number(chunk[chunk.length - 1].ts);
      }
      res.end();
    } catch (e) {
      console.error("[inverter-monitor] stats query failed:", (e as Error).message);
      if (!res.headersSent) {
        res.status(503).json({ ok: false, error: "stats unavailable" });
      } else {
        res.destroy();
      }
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
