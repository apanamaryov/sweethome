import assert from "assert";
import http from "http";
import fs from "fs";
import os from "os";
import path from "path";
import { loadConfig } from "../src/config";
import { Inverter } from "../src/inverter";
import { createServer } from "../src/server";

/**
 * Интеграционный тест поверх РЕАЛЬНОЙ цепочки middleware в server.ts —
 * selfcheck-auth.ts проверяет только юниты (Auth/AuthDb/policy), но не
 * порядок app.use(...) и не реальный список admin-only путей. Здесь мы
 * поднимаем настоящий createServer(...) с mock-транспортом на
 * эфемерном порту и бьём по нему http-запросами, как настоящий браузер.
 */

interface Res {
  status: number;
  json: any;
  setCookie?: string;
}

async function main(): Promise<void> {
  // Env должен быть выставлен ДО loadConfig() — она читает process.env синхронно при вызове.
  process.env.INVERTER_TRANSPORT = "mock";
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "authhttp-"));
  process.env.DATA_DIR = tmp;

  const cfg = loadConfig();
  assert.strictEqual(cfg.transport, "mock", "transport forced to mock");
  assert.strictEqual(cfg.dataDir, tmp, "dataDir forced to temp dir");

  const inverter = new Inverter(cfg); // намеренно НЕ inverter.start() — избегаем poll-луп, getSnapshot() и так отдаёт дефолтный Snapshot
  const server = createServer(inverter, cfg, null);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("server did not bind to a port");
  const base = `http://127.0.0.1:${addr.port}`;

  let cookie: string | null = null;

  function request(method: string, urlPath: string, body?: unknown): Promise<Res> {
    return new Promise((resolve, reject) => {
      const data = body !== undefined ? JSON.stringify(body) : undefined;
      const headers: Record<string, string> = {};
      if (data !== undefined) {
        headers["Content-Type"] = "application/json";
        headers["Content-Length"] = String(Buffer.byteLength(data));
      }
      if (cookie) headers["Cookie"] = cookie;
      const req = http.request(base + urlPath, { method, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json: any = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            json = text;
          }
          const sc = res.headers["set-cookie"];
          resolve({ status: res.statusCode ?? 0, json, setCookie: sc ? sc[0] : undefined });
        });
      });
      req.on("error", reject);
      if (data !== undefined) req.write(data);
      req.end();
    });
  }

  try {
    // 1. Без куки — закрыто.
    let r = await request("GET", "/api/meta");
    assert.strictEqual(r.status, 401, "GET /api/meta без куки -> 401");

    // 2. Логин admin/admin (сид по умолчанию) -> 200, mustChangePassword:true, ставит куку.
    r = await request("POST", "/api/login", { username: "admin", password: "admin" });
    assert.strictEqual(r.status, 200, "admin/admin логинится");
    assert.strictEqual(r.json.ok, true, "login ok:true");
    assert.strictEqual(r.json.mustChangePassword, true, "свежий admin -> must change");
    assert.ok(r.setCookie, "login выставляет Set-Cookie");
    cookie = r.setCookie!.split(";")[0];

    // 3. С этой кукой (must_change): /api/snapshot закрыт, /api/me открыт, смена пароля проходит.
    r = await request("GET", "/api/snapshot");
    assert.strictEqual(r.status, 403, "snapshot под must_change -> 403");
    assert.strictEqual(r.json.code, "must_change_password", "код ошибки must_change_password");

    r = await request("GET", "/api/me");
    assert.strictEqual(r.status, 200, "/api/me доступен при must_change");
    assert.strictEqual(r.json.username, "admin");

    r = await request("POST", "/api/change-password", { currentPassword: "admin", newPassword: "admin123" });
    assert.strictEqual(r.status, 200, "смена пароля admin проходит");

    // 4. После смены пароля — снапшот и /api/users (admin-only) доступны.
    r = await request("GET", "/api/snapshot");
    assert.strictEqual(r.status, 200, "snapshot после смены пароля -> 200");

    r = await request("GET", "/api/users");
    assert.strictEqual(r.status, 200, "admin видит /api/users");
    assert.ok(Array.isArray(r.json), "/api/users возвращает массив");

    // 5. Логин user/user (viewer), смена пароля, проверка ограничений роли.
    cookie = null;
    r = await request("POST", "/api/login", { username: "user", password: "user" });
    assert.strictEqual(r.status, 200, "user/user логинится");
    assert.ok(r.setCookie, "login user выставляет Set-Cookie");
    cookie = r.setCookie!.split(";")[0];

    r = await request("POST", "/api/change-password", { currentPassword: "user", newPassword: "viewer1" });
    assert.strictEqual(r.status, 200, "смена пароля user проходит");

    r = await request("GET", "/api/snapshot");
    assert.strictEqual(r.status, 200, "viewer видит snapshot");

    r = await request("POST", "/api/control", { type: "outputSourcePriority", value: 0 });
    assert.strictEqual(r.status, 403, "viewer не может /api/control");

    r = await request("GET", "/api/users");
    assert.strictEqual(r.status, 403, "viewer не видит /api/users");

    console.log("selfcheck-auth-http: OK");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    inverter.removeAllListeners();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
