import fs from "fs";
import os from "os";
import path from "path";
import http from "http";
import request from "supertest";
import { WebSocket } from "ws";
import { loadConfig } from "./config";
import { createServer } from "./server";
import { ModuleHost } from "./host";
import { Auth } from "./auth/service";
import { createInverterModule } from "@sweethome/inverter";

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
 * DATA_DIR. INVERTER_TRANSPORT=mock avoids needing real hardware; the inverter module
 * is built but never start()-ed (matches selfcheck-auth-http.ts) so there's no poll
 * loop to clean up — getSnapshot() still returns the default Snapshot object
 * synchronously. STATS_ENABLED=false keeps this host-level suite from creating a real
 * stats.db per test — the inverter-specific /api/inverter/stats/* routes and their
 * 503-when-disabled behavior are covered by modules/inverter/src/router.test.ts.
 *
 * Gates that are now the inverter module's own concern (admin-role and write-scope
 * checks on control/lock/raw/baseline) moved to router.test.ts along with them; this
 * file keeps only host-level concerns — login/session/must_change/users/tokens — plus
 * a couple of smoke cases proving an inverter route sits behind the general /api auth.
 */

describe("server.ts (HTTP integration via supertest)", () => {
  let tmp: string;
  let server: http.Server;

  beforeEach(() => {
    // env must be set before loadConfig() — it reads process.env synchronously.
    process.env.INVERTER_TRANSPORT = "mock";
    process.env.STATS_ENABLED = "false";
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "server-http-test-"));
    process.env.DATA_DIR = tmp;

    const cfg = loadConfig();
    const host = new ModuleHost([createInverterModule(cfg.dataDir)]);
    server = createServer(host, cfg);
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      if (server.listening) server.close(() => resolve());
      else resolve();
    });
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
    it("GET /api/inverter/snapshot -> 401 Unauthorized (inverter route behind the general /api auth)", async () => {
      const res = await request(server).get("/api/inverter/snapshot");
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

    it("grants admin routes access once the password has been changed (200 on /api/inverter/snapshot)", async () => {
      const cookie = await freshSessionCookie("admin", "admin", "admin123");

      const users = await request(server).get("/api/users").set("Cookie", cookie);
      expect(users.status).toBe(200);
      expect(Array.isArray(users.body)).toBe(true);

      const snapshot = await request(server).get("/api/inverter/snapshot").set("Cookie", cookie);
      expect(snapshot.status).toBe(200);
    });
  });

  describe("GET /api/health", () => {
    it("401s without a session, same as any other /api route (deploy.sh/uptime-kuma treat this as \"alive\")", async () => {
      const res = await request(server).get("/api/health");
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ ok: false, error: "Unauthorized" });
    });

    it("aggregates module health under host.health() once authenticated", async () => {
      const cookie = await freshSessionCookie("admin", "admin", "admin123");
      const res = await request(server).get("/api/health").set("Cookie", cookie);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, modules: { inverter: expect.objectContaining({ ok: true }) } });
    });
  });

  describe("must_change_password gate", () => {
    it("blocks /api/inverter/snapshot and /api/inverter/control but allows me/change-password/logout", async () => {
      const cookie = await loginAs("admin", "admin");

      let res = await request(server).get("/api/inverter/snapshot").set("Cookie", cookie);
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ ok: false, code: "must_change_password", error: "Password change required" });

      res = await request(server)
        .post("/api/inverter/control")
        .set("Cookie", cookie)
        .send({ type: "outputSourcePriority", value: 0 });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("must_change_password");

      res = await request(server).get("/api/me").set("Cookie", cookie);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        username: "admin",
        role: "admin",
        mustChangePassword: true,
        auth: "session",
        scopes: ["read", "write"],
      });

      res = await request(server)
        .post("/api/change-password")
        .set("Cookie", cookie)
        .send({ currentPassword: "admin", newPassword: "admin123" });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });

      // Gate lifts once the password is actually changed.
      res = await request(server).get("/api/inverter/snapshot").set("Cookie", cookie);
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
    it("gets 403 on /api/users (admin-only, host-level gate)", async () => {
      const cookie = await freshSessionCookie("user", "user", "viewer1");

      const res = await request(server).get("/api/users").set("Cookie", cookie);
      expect(res.status).toBe(403);
    });

    it("gets 200 on / and /inverter/stats pages, and can read /api/inverter/snapshot", async () => {
      const cookie = await freshSessionCookie("user", "user", "viewer1");

      let res = await request(server).get("/").set("Cookie", cookie);
      expect(res.status).toBe(200);

      res = await request(server).get("/inverter/stats").set("Cookie", cookie);
      expect(res.status).toBe(200);

      res = await request(server).get("/api/inverter/snapshot").set("Cookie", cookie);
      expect(res.status).toBe(200);
    });

    it("redirects away from admin-only pages (e.g. /inverter/settings) to /", async () => {
      const cookie = await freshSessionCookie("user", "user", "viewer1");

      const res = await request(server).get("/inverter/settings").set("Cookie", cookie);
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe("/");
    });
  });

  describe("legacy page redirects (moved under /inverter)", () => {
    it("redirects legacy page urls to the inverter section", async () => {
      for (const [from, to] of [
        ["/stats", "/inverter/stats"],
        ["/settings", "/inverter/settings"],
        ["/diagnostics", "/inverter/diagnostics"],
      ] as const) {
        const res = await request(server).get(from);
        expect(res.status).toBe(301);
        expect(res.headers.location).toBe(to);
      }
    });
  });

  describe("GET /inverter (a page with nested child routes)", () => {
    it("serves the page itself with 200, not a broken directory redirect", async () => {
      // Next's static export puts both inverter.html and an inverter/ directory
      // (holding stats.html/settings.html/diagnostics.html) side by side on disk;
      // express.static's own directory-redirect would otherwise shadow the flat
      // file and send the browser into a "/inverter/" 404 dead end.
      const cookie = await freshSessionCookie("admin", "admin", "admin123");

      const res = await request(server).get("/inverter").set("Cookie", cookie);
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch(/html/);
    });
  });

  describe("GET /cctv, /cctv/archive (open to viewer, same nested-route case as /inverter)", () => {
    it("viewer has access to the camera pages", async () => {
      const cookie = await freshSessionCookie("user", "user", "viewer1");

      let res = await request(server).get("/cctv").set("Cookie", cookie);
      expect(res.status).toBe(200);

      res = await request(server).get("/cctv/archive").set("Cookie", cookie);
      expect(res.status).toBe(200);
    });

    it("redirects to /login without a session", async () => {
      const res = await request(server).get("/cctv");
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe("/login");
    });
  });

  describe("GET /dryer, /dryer/history, /dryer/settings (test server built without the dryer module — page gates don't depend on modules)", () => {
    it("viewer has access to /dryer and /dryer/history, but is redirected away from /dryer/settings", async () => {
      const cookie = await freshSessionCookie("user", "user", "viewer1");

      let res = await request(server).get("/dryer").set("Cookie", cookie);
      expect(res.status).toBe(200);

      res = await request(server).get("/dryer/history").set("Cookie", cookie);
      expect(res.status).toBe(200);

      res = await request(server).get("/dryer/settings").set("Cookie", cookie);
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe("/");
    });

    it("admin has access to /dryer/settings", async () => {
      const cookie = await freshSessionCookie("admin", "admin", "admin123");

      const res = await request(server).get("/dryer/settings").set("Cookie", cookie);
      expect(res.status).toBe(200);
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

  describe("WebSocket /ws/inverter", () => {
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

      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/inverter`, { headers: { Cookie: cookie } });
      const raw = await waitForEvent<Buffer>(ws, "message");
      const msg = JSON.parse(raw.toString());

      expect(msg.type).toBe("snapshot");
      expect(msg.data).toBeDefined();
      expect(msg.data.mode).toBe("Unknown"); // default Snapshot — the inverter module was never start()-ed

      await closeClient(ws);
    });

    it("closes the connection with code 4401 when there is no valid session", async () => {
      const port = await listen();

      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/inverter`);
      const code = await waitForEvent<number>(ws, "close");

      expect(code).toBe(4401);
      await closeClient(ws);
    });

    it("closes the connection with code 4401 while must_change_password is still set", async () => {
      const port = await listen();
      const cookie = await loginAs("admin", "admin"); // fresh seed, must_change_password still true

      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/inverter`, { headers: { Cookie: cookie } });
      const code = await waitForEvent<number>(ws, "close");

      expect(code).toBe(4401);
      await closeClient(ws);
    });

    it("accepts a handshake authorized by a Bearer token", async () => {
      const port = await listen();
      const token = issue(["read"]);

      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/inverter`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const raw = await waitForEvent<Buffer>(ws, "message");
      expect(JSON.parse(raw.toString()).type).toBe("snapshot");

      await closeClient(ws);
    });

    it("closes with 4401 for a bogus Bearer token", async () => {
      const port = await listen();

      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/inverter`, {
        headers: { Authorization: "Bearer inv_nope" },
      });
      const code = await waitForEvent<number>(ws, "close");
      expect(code).toBe(4401);
      await closeClient(ws);
    });

    it("does not hand out a connection for an upgrade to an unknown module path", async () => {
      const port = await listen();
      const cookie = await freshSessionCookie("admin", "admin", "admin123");

      // Одиночный WebSocketServer({noServer:true}) диспетчит по pathname; для
      // неизвестного /ws/nope ожидаем socket.destroy() — никакого upgrade-хендшейка
      // (никакой message-снапшот не придёт), а голый сокет со стороны клиента
      // оборвётся ошибкой/закрытием без валидного WS-рукопожатия.
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/nope`, { headers: { Cookie: cookie } });
      const outcome = await new Promise<"error" | "close" | "message">((resolve) => {
        ws.once("error", () => resolve("error"));
        ws.once("close", () => resolve("close"));
        ws.once("message", () => resolve("message"));
      });

      expect(outcome).not.toBe("message");
      await closeClient(ws).catch(() => {});
    });
  });

  /** Выдать токен через тот же auth.db, который использует сервер. */
  function issue(scopes: Array<"read" | "write">, username = "admin"): string {
    const a = new Auth(tmp, 30);
    const u = a.db.getByUsername(username)!;
    a.db.setPassword(u.id, "secret1", false, Date.now()); // снять форс смены пароля
    const { token } = a.issueToken(`test-${scopes.join("-")}-${Date.now()}`, u.id, scopes);
    a.db.close();
    return token;
  }

  describe("Bearer tokens", () => {
    it("accepts a valid token on read endpoints and reports auth kind in /api/me", async () => {
      const token = issue(["read"]);
      const res = await request(server).get("/api/me").set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ username: "admin", role: "admin", auth: "token", scopes: ["read"] });

      const snap = await request(server).get("/api/inverter/snapshot").set("Authorization", `Bearer ${token}`);
      expect(snap.status).toBe(200);
    });

    it("reports session auth with full scopes for cookie logins", async () => {
      const cookie = await freshSessionCookie("admin", "admin", "secret1");
      const res = await request(server).get("/api/me").set("Cookie", cookie);
      expect(res.body).toMatchObject({ auth: "session", scopes: ["read", "write"] });
    });

    it("rejects a missing or bogus token with 401", async () => {
      expect((await request(server).get("/api/inverter/snapshot")).status).toBe(401);
      const res = await request(server).get("/api/inverter/snapshot").set("Authorization", "Bearer inv_nope");
      expect(res.status).toBe(401);
    });

    it("never lets a token reach user or token management", async () => {
      const token = issue(["read", "write"]);
      for (const p of ["/api/users", "/api/tokens"]) {
        const res = await request(server).get(p).set("Authorization", `Bearer ${token}`);
        expect(res.status).toBe(403);
        expect(res.body.code).toBe("session_required");
      }
    });
  });

  describe("/api/tokens", () => {
    it("creates, lists and revokes tokens from an admin session", async () => {
      const cookie = await freshSessionCookie("admin", "admin", "secret1");

      const created = await request(server)
        .post("/api/tokens")
        .set("Cookie", cookie)
        .send({ name: "mcp", scopes: ["read", "write"], expiresInDays: 30 });
      expect(created.status).toBe(200);
      expect(created.body.token).toMatch(/^inv_/);
      expect(created.body.record).toMatchObject({ name: "mcp", scopes: ["read", "write"] });
      expect(created.body.record.expiresAt).toBeGreaterThan(Date.now());

      const list = await request(server).get("/api/tokens").set("Cookie", cookie);
      expect(list.status).toBe(200);
      expect(list.body).toHaveLength(1);
      expect(list.body[0].token).toBeUndefined(); // значение не хранится и не отдаётся
      expect(list.body[0].prefix).toBe(created.body.token.slice(0, 12));

      const del = await request(server)
        .delete(`/api/tokens/${created.body.record.id}`)
        .set("Cookie", cookie);
      expect(del.status).toBe(200);
      expect((await request(server).get("/api/tokens").set("Cookie", cookie)).body).toEqual([]);

      // отозванный токен больше не работает
      const after = await request(server)
        .get("/api/inverter/snapshot")
        .set("Authorization", `Bearer ${created.body.token}`);
      expect(after.status).toBe(401);
    });

    it("validates the payload", async () => {
      const cookie = await freshSessionCookie("admin", "admin", "secret1");
      const noName = await request(server).post("/api/tokens").set("Cookie", cookie).send({ scopes: ["read"] });
      expect(noName.status).toBe(400);

      const badScope = await request(server)
        .post("/api/tokens")
        .set("Cookie", cookie)
        .send({ name: "x", scopes: ["admin"] });
      expect(badScope.status).toBe(400);
    });

    it("is admin-only", async () => {
      const cookie = await freshSessionCookie("user", "user", "secret1");
      const res = await request(server).get("/api/tokens").set("Cookie", cookie);
      expect(res.status).toBe(403);
    });
  });
});
