import http from "http";
import path from "path";
import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import { Inverter } from "./inverter";
import { Config } from "./config";
import { Auth, tokenFromCookieHeader, bearerFromHeader } from "./auth/service";
import { canAccess } from "@sweethome/shared";
import "@sweethome/shared/module"; // augments express-serve-static-core with req.user/req.auth
import { normalizeUsername } from "./auth/db";
import { validatePassword } from "./auth/hash";
import {
  OUTPUT_SOURCE_PRIORITY,
  CHARGER_SOURCE_PRIORITY,
  ALLOWED_MAX_CHARGE_CURRENT,
  ALLOWED_MAX_AC_CHARGE_CURRENT,
  ControlType,
} from "@sweethome/inverter-shared";
import { Snapshot } from "@sweethome/inverter-shared";
import type { TokenScope } from "@sweethome/inverter-shared";
import { GAUGE_FIELDS, GaugeField, localDay } from "./stats/db";
import { StatsRecorder } from "./stats/recorder";
import { mountMcp } from "./mcp/http";

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
  app.set("trust proxy", 1); // ровно один прокси-хоп — Caddy на Pi (см. CLAUDE.md); dev без прокси не мешает
  app.use(express.json());

  const auth = new Auth(cfg.dataDir, cfg.auth.sessionTtlDays);
  const reqToken = (req: express.Request) => tokenFromCookieHeader(req.headers.cookie);

  // Страничные редиректы: без сессии → /login; must_change → /change-password;
  // admin-страницы для viewer → /. Статика (css/js/страницы) отдаётся свободно —
  // данные защищены на уровне /api.
  const ADMIN_PAGES = new Set(["/settings", "/diagnostics", "/users"]);
  app.get(
    ["/", "/index.html", "/settings", "/diagnostics", "/stats", "/users", "/change-password"],
    (req, res, next) => {
      const u = auth.verify(reqToken(req));
      if (!u) return res.redirect("/login");
      if (u.mustChangePassword) {
        return req.path === "/change-password" ? next() : res.redirect("/change-password");
      }
      if (ADMIN_PAGES.has(req.path) && u.role !== "admin") return res.redirect("/");
      next();
    }
  );

  // Статика Next.js (web/out); extensions отдаёт /settings как settings.html.
  const publicDir = path.join(__dirname, "..", "..", "web", "out");
  app.use(express.static(publicDir, { extensions: ["html"] }));

  app.post("/api/login", (req, res) => {
    const { username, password } = req.body ?? {};
    if (typeof username !== "string" || typeof password !== "string") {
      return res.status(400).json({ ok: false, error: "username and password must be strings" });
    }
    try {
      const result = auth.login(username, password, req.ip ?? "unknown");
      if (!result) {
        return res.status(401).json({ ok: false, code: "bad_password", error: "Wrong credentials" });
      }
      res.setHeader("Set-Cookie", auth.cookie(result.token, req.secure));
      res.json({ ok: true, role: result.user.role, mustChangePassword: result.user.mustChangePassword });
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

  // Зона авторизации: cookie-сессия из UI либо API-токен (Authorization: Bearer).
  const SESSION_SCOPES: TokenScope[] = ["read", "write"];
  const authenticate: express.RequestHandler = (req, res, next) => {
    const s = auth.verify(reqToken(req));
    if (s) {
      req.user = s;
      req.auth = { kind: "session", scopes: SESSION_SCOPES };
      return next();
    }
    const t = auth.verifyToken(bearerFromHeader(req.headers.authorization));
    if (t) {
      req.user = {
        userId: t.userId,
        username: t.username,
        role: t.role,
        mustChangePassword: false, // verifyToken уже отсёк владельцев под форсом
        expiresAt: t.expiresAt ?? Number.MAX_SAFE_INTEGER,
      };
      req.auth = { kind: "token", scopes: t.scopes, tokenName: t.name };
      return next();
    }
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  };
  app.use("/api", authenticate);

  // Доступны даже при must_change (иначе смену пароля не выполнить).
  app.get("/api/me", (req, res) => {
    const u = req.user!;
    res.json({
      username: u.username,
      role: u.role,
      mustChangePassword: u.mustChangePassword,
      auth: req.auth!.kind,
      scopes: req.auth!.scopes,
    });
  });

  app.post("/api/change-password", (req, res) => {
    try {
      const { currentPassword, newPassword } = req.body ?? {};
      if (typeof currentPassword !== "string" || typeof newPassword !== "string") {
        return res.status(400).json({ ok: false, error: "currentPassword and newPassword required" });
      }
      auth.changePassword(reqToken(req)!, currentPassword, newPassword);
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ ok: false, error: (e as Error).message });
    }
  });

  // Форс смены пароля: до смены всё остальное под /api закрыто.
  app.use("/api", (req, res, next) => {
    if (req.user!.mustChangePassword) {
      return res.status(403).json({ ok: false, code: "must_change_password", error: "Password change required" });
    }
    next();
  });

  // Admin-only зона.
  app.use(
    ["/api/control", "/api/lock", "/api/raw", "/api/baseline", "/api/baseline/recapture", "/api/users", "/api/tokens"],
    (req, res, next) => {
      if (!canAccess(req.user!.role, "admin")) {
        return res.status(403).json({ ok: false, code: "forbidden", error: "Admins only" });
      }
      next();
    }
  );

  // Управление пользователями и токенами — только из UI-сессии, никогда по токену.
  app.use(["/api/users", "/api/tokens"], (req, res, next) => {
    if (req.auth?.kind === "token") {
      return res
        .status(403)
        .json({ ok: false, code: "session_required", error: "Not available for API tokens" });
    }
    next();
  });

  /** Кто именно пишет — попадает в журнал событий (тип `control`). */
  const writeSource = (req: express.Request): string =>
    req.auth?.kind === "token" ? `token:${req.auth.tokenName ?? "?"}` : `ui:${req.user?.username ?? "?"}`;

  /** Скоуп write обязателен для токенов; cookie-сессия из UI им обладает всегда. */
  const denyWithoutWrite = (req: express.Request, res: express.Response): boolean => {
    if (req.auth?.kind === "token" && !req.auth.scopes.includes("write")) {
      res.status(403).json({ ok: false, code: "scope_required", error: "Token lacks the 'write' scope" });
      return true;
    }
    return false;
  };

  app.get("/api/users", (_req, res) => {
    res.json(auth.db.listUsers());
  });

  app.post("/api/users", (req, res) => {
    try {
      const { username, role, password } = req.body ?? {};
      if (role !== "admin" && role !== "viewer") {
        return res.status(400).json({ ok: false, error: "role must be admin or viewer" });
      }
      if (typeof password !== "string") {
        return res.status(400).json({ ok: false, error: "password required" });
      }
      validatePassword(password);
      const uname = normalizeUsername(String(username ?? ""));
      if (auth.db.getByUsername(uname)) {
        return res.status(409).json({ ok: false, code: "exists", error: "Username already exists" });
      }
      const user = auth.db.createUser(uname, password, role, true, Date.now());
      res.json({ ok: true, user });
    } catch (e) {
      res.status(400).json({ ok: false, error: (e as Error).message });
    }
  });

  app.patch("/api/users/:id", (req, res) => {
    try {
      const id = Number(req.params.id);
      const { role } = req.body ?? {};
      if (role !== "admin" && role !== "viewer") {
        return res.status(400).json({ ok: false, error: "role must be admin or viewer" });
      }
      const target = auth.db.getById(id);
      if (!target) return res.status(404).json({ ok: false, error: "User not found" });
      // Нельзя понизить последнего админа.
      if (target.role === "admin" && role === "viewer" && auth.db.countAdmins() <= 1) {
        return res.status(409).json({ ok: false, code: "last_admin", error: "Cannot demote the last admin" });
      }
      auth.db.updateRole(id, role, Date.now());
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ ok: false, error: (e as Error).message });
    }
  });

  app.post("/api/users/:id/reset-password", (req, res) => {
    try {
      const id = Number(req.params.id);
      const { newPassword } = req.body ?? {};
      if (typeof newPassword !== "string") {
        return res.status(400).json({ ok: false, error: "newPassword required" });
      }
      validatePassword(newPassword);
      const target = auth.db.getById(id);
      if (!target) return res.status(404).json({ ok: false, error: "User not found" });
      auth.db.setPassword(id, newPassword, true, Date.now());
      auth.db.deleteSessionsForUser(id, null); // разлогинить пользователя
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ ok: false, error: (e as Error).message });
    }
  });

  app.delete("/api/users/:id", (req, res) => {
    try {
      const id = Number(req.params.id);
      const target = auth.db.getById(id);
      if (!target) return res.status(404).json({ ok: false, error: "User not found" });
      if (id === req.user!.userId) {
        return res.status(409).json({ ok: false, code: "self_delete", error: "Cannot delete yourself" });
      }
      if (target.role === "admin" && auth.db.countAdmins() <= 1) {
        return res.status(409).json({ ok: false, code: "last_admin", error: "Cannot delete the last admin" });
      }
      auth.db.deleteUser(id);
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ ok: false, error: (e as Error).message });
    }
  });

  app.get("/api/tokens", (_req, res) => {
    res.json(auth.listTokens());
  });

  app.post("/api/tokens", (req, res) => {
    try {
      const { name, scopes, expiresInDays } = req.body ?? {};
      if (!Array.isArray(scopes)) {
        return res.status(400).json({ ok: false, error: "scopes must be an array" });
      }
      const days =
        expiresInDays === undefined || expiresInDays === null ? undefined : Number(expiresInDays);
      if (days !== undefined && (!Number.isFinite(days) || days <= 0)) {
        return res.status(400).json({ ok: false, error: "expiresInDays must be a positive number" });
      }
      const { token, record } = auth.issueToken(String(name ?? ""), req.user!.userId, scopes, days);
      res.json({ ok: true, token, record });
    } catch (e) {
      res.status(400).json({ ok: false, error: (e as Error).message });
    }
  });

  app.delete("/api/tokens/:id", (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: "bad id" });
    auth.revokeToken(id);
    res.json({ ok: true });
  });

  app.get("/api/health", (_req, res) => res.json({ ok: true }));

  app.get("/api/snapshot", (_req, res) => res.json(inverter.getSnapshot()));

  app.get("/api/meta", (req, res) => {
    const u = req.user!;
    res.json({
      session: { username: u.username, role: u.role, mustChangePassword: u.mustChangePassword },
      allowControl: cfg.allowControl,
      outputSourcePriority: OUTPUT_SOURCE_PRIORITY,
      chargerSourcePriority: CHARGER_SOURCE_PRIORITY,
      maxChargingCurrent: ALLOWED_MAX_CHARGE_CURRENT,
      maxAcChargingCurrent: ALLOWED_MAX_AC_CHARGE_CURRENT,
    });
  });

  app.post("/api/control", async (req, res) => {
    try {
      const { type, value, preview } = req.body ?? {};
      if (!CONTROL_TYPES.includes(type)) {
        return res.status(400).json({ ok: false, error: `Unknown control type: ${type}` });
      }
      const numValue = Number(value);
      if (!Number.isFinite(numValue)) {
        return res.status(400).json({ ok: false, error: "value must be a number" });
      }
      if (preview === true) {
        // Предпросмотр — это чтение: доступен и при включённой блокировке, и без скоупа write.
        const p = await inverter.previewControl(type as ControlType, numValue);
        return res.json({ ok: true, preview: true, ...p });
      }
      if (denyWithoutWrite(req, res)) return;
      const result = await inverter.control(type as ControlType, numValue, { source: writeSource(req) });
      res.json(result);
    } catch (e) {
      res.status(400).json({ ok: false, error: (e as Error).message });
    }
  });

  app.post("/api/lock", (req, res) => {
    try {
      if (denyWithoutWrite(req, res)) return;
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

  app.post("/api/baseline/recapture", async (req, res) => {
    try {
      if (denyWithoutWrite(req, res)) return;
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

  app.get("/api/stats/solar-window", (req, res) => {
    try {
      if (!stats) return res.status(503).json({ ok: false, error: "stats unavailable" });
      const dayRe = /^\d{4}-\d{2}-\d{2}$/;
      const now = Date.now();
      const today = localDay(now);
      const day = req.query.day ? String(req.query.day) : today;
      if (!dayRe.test(day)) {
        return res.status(400).json({ ok: false, error: "day must be YYYY-MM-DD" });
      }
      const win = stats.db.querySolarWindow(day, day === today ? now : undefined);
      res.json({ day, ...win });
    } catch (e) {
      console.error("[inverter-monitor] stats query failed:", (e as Error).message);
      res.status(503).json({ ok: false, error: "stats unavailable" });
    }
  });

  app.get("/api/stats/energy", (req, res) => {
    try {
      if (!stats) return res.status(503).json({ ok: false, error: "stats unavailable" });
      const from = parseTime(req.query.from);
      const to = parseTime(req.query.to);
      if (from === null || to === null || to <= from) {
        return res.status(400).json({ ok: false, error: "bad from/to" });
      }
      const bucket = req.query.bucket === "hour" ? ("hour" as const) : ("day" as const);
      res.json(stats.db.queryEnergy(from, to, bucket));
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
      // Чтение (R) доступно любому токену; запись (W) — только со скоупом write.
      if (/^\s*W/i.test(command) && denyWithoutWrite(req, res)) return;
      const reply = await inverter.rawQuery(command, { source: writeSource(req) });
      res.json({ ok: true, command, reply });
    } catch (e) {
      res.status(400).json({ ok: false, error: (e as Error).message });
    }
  });

  // MCP для агентов — под тем же гейтом авторизации, что и /api.
  mountMcp(app, { inverter, cfg, stats, authenticate });

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
    const s = auth.verify(tokenFromCookieHeader(req.headers.cookie));
    const authorized =
      (!!s && !s.mustChangePassword) || !!auth.verifyToken(bearerFromHeader(req.headers.authorization));
    if (!authorized) {
      ws.close(4401, "Unauthorized");
      return;
    }
    ws.send(JSON.stringify({ type: "snapshot", data: inverter.getSnapshot() }));
  });

  return server;
}
