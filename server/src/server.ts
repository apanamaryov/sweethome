import http from "http";
import path from "path";
import express from "express";
import { WebSocketServer } from "ws";
import { Config } from "./config";
import { Auth, tokenFromCookieHeader, bearerFromHeader } from "./auth/service";
import { canAccess, type TokenScope } from "@sweethome/shared";
import "@sweethome/shared/module"; // augments express-serve-static-core with req.user/req.auth
import { normalizeUsername } from "./auth/db";
import { validatePassword } from "./auth/hash";
import { ModuleHost } from "./host";
import { mountMcp } from "./mcp/http";

export function createServer(host: ModuleHost, cfg: Config): http.Server {
  const app = express();
  app.set("trust proxy", 1); // ровно один прокси-хоп — Caddy на Pi (см. CLAUDE.md); dev без прокси не мешает
  app.use(express.json());

  const auth = new Auth(cfg.dataDir, cfg.auth.sessionTtlDays);
  const reqToken = (req: express.Request) => tokenFromCookieHeader(req.headers.cookie);

  // Совместимость закладок: страницы инвертора переехали под /inverter.
  const LEGACY_PAGES: Record<string, string> = {
    "/stats": "/inverter/stats",
    "/settings": "/inverter/settings",
    "/diagnostics": "/inverter/diagnostics",
  };
  app.get(Object.keys(LEGACY_PAGES), (req, res) => res.redirect(301, LEGACY_PAGES[req.path]));

  // Страничные редиректы: без сессии → /login; must_change → /change-password;
  // admin-страницы для viewer → /. Статика (css/js/страницы) отдаётся свободно —
  // данные защищены на уровне /api.
  const ADMIN_PAGES = new Set(["/inverter/settings", "/inverter/diagnostics", "/users"]);
  app.get(
    [
      "/",
      "/index.html",
      "/inverter",
      "/inverter/stats",
      "/inverter/settings",
      "/inverter/diagnostics",
      "/users",
      "/change-password",
      "/cctv",
      "/cctv/archive",
    ],
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

  // /inverter одновременно и страница (inverter.html), и родитель вложенных
  // маршрутов (inverter/stats.html и т.п.) — статический экспорт Next кладёт
  // и файл inverter.html, и каталог inverter/ рядом. express.static, наткнувшись
  // на путь, который на диске оказывается каталогом, сам 301-редиректит на
  // "/inverter/" ещё до того, как пробует расширение из `extensions` — и тот
  // редирект ведёт в никуда (внутри inverter/ нет index.html). Отдаём файл
  // явно, до общего static-миддлвара.
  app.get("/inverter", (_req, res) => res.sendFile(path.join(publicDir, "inverter.html")));

  // /cctv — тот же случай: и страница (cctv.html), и родитель /cctv/archive
  // (cctv/archive.html) рядом на диске. Без явной отдачи файла express.static
  // увёл бы в такой же бессмысленный редирект на "/cctv/".
  app.get("/cctv", (_req, res) => res.sendFile(path.join(publicDir, "cctv.html")));

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

  // Liveness — за тем же гейтом, что и остальной /api (401 без сессии = «жив», как и раньше;
  // deploy.sh/uptime-kuma принимают и 200, и 401). res.json(host.health()) сам по себе всегда 200.
  app.get("/api/health", (_req, res) => res.json(host.health()));

  // Admin-only зона.
  app.use(["/api/users", "/api/tokens"], (req, res, next) => {
    if (!canAccess(req.user!.role, "admin")) {
      return res.status(403).json({ ok: false, code: "forbidden", error: "Admins only" });
    }
    next();
  });

  // Управление пользователями и токенами — только из UI-сессии, никогда по токену.
  app.use(["/api/users", "/api/tokens"], (req, res, next) => {
    if (req.auth?.kind === "token") {
      return res
        .status(403)
        .json({ ok: false, code: "session_required", error: "Not available for API tokens" });
    }
    next();
  });

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

  for (const m of host.modules) app.use(`/api/${m.id}`, m.apiRouter);
  for (const m of host.modules) m.attachHttp?.(app, { authenticate });

  // Один /mcp на весь дом: инструменты приносят сами модули.
  mountMcp(app, {
    modules: host.modules,
    authenticate,
    enabled: cfg.mcp.enabled,
    maxSessions: cfg.mcp.maxSessions,
  });

  const server = http.createServer(app);

  // Один WebSocketServer на всех модулей: несколько `new WebSocketServer({server, path})`
  // вешают свои собственные upgrade-listener'ы на один http.Server, и каждый отвечает
  // abortHandshake(400) на путь чужого модуля — с двумя WS-модулями они бьют друг друга.
  // noServer + единый server.on("upgrade", ...) с ручным диспетчем по pathname.
  const wsModules = new Map<string, (typeof host.modules)[number]>(
    host.modules.filter((m) => m.ws).map((m) => [`/ws/${m.id}`, m])
  );
  if (wsModules.size) {
    const wss = new WebSocketServer({ noServer: true });
    server.on("upgrade", (req, socket, head) => {
      const { pathname } = new URL(req.url ?? "", "http://internal");
      const mod = wsModules.get(pathname);
      if (!mod) {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        const s = auth.verify(tokenFromCookieHeader(req.headers.cookie));
        const authorized =
          (!!s && !s.mustChangePassword) || !!auth.verifyToken(bearerFromHeader(req.headers.authorization));
        if (!authorized) {
          ws.close(4401, "Unauthorized");
          return;
        }
        mod.ws!.onConnection(ws);
      });
    });
  }

  return server;
}
