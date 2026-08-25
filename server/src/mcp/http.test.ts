import fs from "fs";
import os from "os";
import path from "path";
import http from "http";
import request from "supertest";
import { loadConfig } from "../config";
import { createServer } from "../server";
import { ModuleHost } from "../host";
import { Auth } from "../auth/service";
import { createInverterModule } from "@sweethome/inverter";
import { createCctvModule } from "@sweethome/cctv";

/**
 * /mcp — Streamable HTTP поверх того же гейта авторизации, что и /api. Здесь
 * проверяется именно обвязка: авторизация, сессии, лимит, выключатель и то, что
 * эндпоинт один на весь дом; сами инструменты покрыты тестами своих воркспейсов.
 * STATS_ENABLED=false воспроизводит прежний `stats = null`, который раньше
 * передавался в createServer(...) явно — теперь stats создаётся внутри
 * createInverterModule по конфигу.
 */

const INIT = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
};

const ACCEPT = "application/json, text/event-stream";

describe("/mcp endpoint", () => {
  let tmp: string;
  let server: http.Server;
  let token: string;

  const makeToken = (scopes: Array<"read" | "write">, name: string): string => {
    const a = new Auth(tmp, 30);
    const u = a.db.getByUsername("admin")!;
    a.db.setPassword(u.id, "secret1", false, Date.now());
    const t = a.issueToken(name, u.id, scopes).token;
    a.db.close();
    return t;
  };

  beforeEach(() => {
    process.env.INVERTER_TRANSPORT = "mock";
    process.env.STATS_ENABLED = "false";
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-http-test-"));
    process.env.DATA_DIR = tmp;
    delete process.env.MCP_ENABLED;
    delete process.env.MCP_MAX_SESSIONS;
    delete process.env.CCTV_CAMERAS;
    delete process.env.CCTV_STORAGE_DIR;

    const cfg = loadConfig();
    const host = new ModuleHost([createInverterModule(cfg.dataDir)]);
    server = createServer(host, cfg);
    token = makeToken(["read", "write"], "mcp");
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => (server.listening ? server.close(() => resolve()) : resolve()));
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  /** initialize + notifications/initialized; возвращает id сессии. */
  async function openSession(srv: http.Server, bearer: string): Promise<string> {
    const init = await request(srv)
      .post("/mcp")
      .set("Authorization", `Bearer ${bearer}`)
      .set("Accept", ACCEPT)
      .send(INIT);
    expect(init.status).toBe(200);
    const sid = init.headers["mcp-session-id"] as string;
    await request(srv)
      .post("/mcp")
      .set("Authorization", `Bearer ${bearer}`)
      .set("Accept", ACCEPT)
      .set("Mcp-Session-Id", sid)
      .send({ jsonrpc: "2.0", method: "notifications/initialized" });
    return sid;
  }

  it("rejects unauthenticated requests", async () => {
    const res = await request(server).post("/mcp").set("Accept", ACCEPT).send(INIT);
    expect(res.status).toBe(401);
  });

  it("initializes a session and reports the home, not one of its modules", async () => {
    const res = await request(server)
      .post("/mcp")
      .set("Authorization", `Bearer ${token}`)
      .set("Accept", ACCEPT)
      .send(INIT);

    expect(res.status).toBe(200);
    expect(res.headers["mcp-session-id"]).toBeDefined();
    // Эндпоинт общий: инвертор, камеры и всё, что появится дальше, живут в одном сервере.
    expect(res.text).toContain("sweethome");
  });

  it("lists tools within an initialized session", async () => {
    const sid = await openSession(server, token);
    const list = await request(server)
      .post("/mcp")
      .set("Authorization", `Bearer ${token}`)
      .set("Accept", ACCEPT)
      .set("Mcp-Session-Id", sid)
      .send({ jsonrpc: "2.0", id: 2, method: "tools/list" });

    expect(list.status).toBe(200);
    expect(list.text).toContain("get_snapshot");
    expect(list.text).toContain("set_control"); // токен со скоупом write
  });

  it("serves a snapshot through the local gateway", async () => {
    const sid = await openSession(server, token);
    const call = await request(server)
      .post("/mcp")
      .set("Authorization", `Bearer ${token}`)
      .set("Accept", ACCEPT)
      .set("Mcp-Session-Id", sid)
      .send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_health", arguments: {} } });

    expect(call.status).toBe(200);
    expect(call.text).toContain("serviceReachable");
  });

  it("hides write tools from a read-only token", async () => {
    const readToken = makeToken(["read"], "ro");
    const sid = await openSession(server, readToken);
    const list = await request(server)
      .post("/mcp")
      .set("Authorization", `Bearer ${readToken}`)
      .set("Accept", ACCEPT)
      .set("Mcp-Session-Id", sid)
      .send({ jsonrpc: "2.0", id: 2, method: "tools/list" });

    expect(list.text).toContain("get_snapshot");
    expect(list.text).not.toContain("set_control");
  });

  it("omits statistics tools when the stats database is unavailable", async () => {
    const sid = await openSession(server, token);
    const list = await request(server)
      .post("/mcp")
      .set("Authorization", `Bearer ${token}`)
      .set("Accept", ACCEPT)
      .set("Mcp-Session-Id", sid)
      .send({ jsonrpc: "2.0", id: 2, method: "tools/list" });

    expect(list.text).not.toContain("get_series"); // STATS_ENABLED=false → createInverterModule builds stats = null
  });

  it("отдаёт инструменты всех модулей дома в одной сессии", async () => {
    // Ради этого точка входа и переехала из модуля инвертора в хост: агент
    // подключается один раз и видит и инвертор, и камеры.
    process.env.CCTV_CAMERAS = "drive=10.0.0.9";
    process.env.CCTV_STORAGE_DIR = path.join(tmp, "video");
    const cfg = loadConfig();
    const host = new ModuleHost([createInverterModule(cfg.dataDir), createCctvModule(cfg.dataDir)]);
    const srv = createServer(host, cfg);

    const sid = await openSession(srv, token);
    const list = await request(srv)
      .post("/mcp")
      .set("Authorization", `Bearer ${token}`)
      .set("Accept", ACCEPT)
      .set("Mcp-Session-Id", sid)
      .send({ jsonrpc: "2.0", id: 2, method: "tools/list" });

    expect(list.text).toContain("get_snapshot"); // инвертор
    expect(list.text).toContain("cctv_get_cameras"); // камеры
    expect(list.text).toContain("cctv_snapshot");
  });

  it("answers 404 for an unknown session id", async () => {
    const res = await request(server)
      .post("/mcp")
      .set("Authorization", `Bearer ${token}`)
      .set("Accept", ACCEPT)
      .set("Mcp-Session-Id", "does-not-exist")
      .send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(res.status).toBe(404);
  });

  it("refuses more sessions than MCP_MAX_SESSIONS", async () => {
    process.env.MCP_MAX_SESSIONS = "1";
    const cfg = loadConfig();
    const host = new ModuleHost([createInverterModule(cfg.dataDir)]);
    const srv = createServer(host, cfg);
    const first = await request(srv)
      .post("/mcp")
      .set("Authorization", `Bearer ${token}`)
      .set("Accept", ACCEPT)
      .send(INIT);
    expect(first.status).toBe(200);

    const second = await request(srv)
      .post("/mcp")
      .set("Authorization", `Bearer ${token}`)
      .set("Accept", ACCEPT)
      .send(INIT);
    expect(second.status).toBe(503);
    expect(second.body.error.message).toContain("MCP_MAX_SESSIONS");
  });

  it("returns 404 when MCP_ENABLED=false", async () => {
    process.env.MCP_ENABLED = "false";
    const cfg = loadConfig();
    const host = new ModuleHost([createInverterModule(cfg.dataDir)]);
    const srv = createServer(host, cfg);
    const res = await request(srv)
      .post("/mcp")
      .set("Authorization", `Bearer ${token}`)
      .set("Accept", ACCEPT)
      .send(INIT);
    expect(res.status).toBe(404);
  });
});
