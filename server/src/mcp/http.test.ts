import fs from "fs";
import os from "os";
import path from "path";
import http from "http";
import request from "supertest";
import { loadConfig } from "../config";
import { createServer } from "../server";
import { Auth } from "../auth/service";
import { Inverter, loadInverterConfig } from "@sweethome/inverter";

/**
 * /mcp — Streamable HTTP поверх того же гейта авторизации, что и /api. Здесь
 * проверяется именно обвязка: авторизация, сессии, лимит и выключатель; сами
 * инструменты покрыты тестами воркспейса mcp/.
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
  let inverter: Inverter;
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
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-http-test-"));
    process.env.DATA_DIR = tmp;
    delete process.env.MCP_ENABLED;
    delete process.env.MCP_MAX_SESSIONS;

    const cfg = loadConfig();
    const invCfg = loadInverterConfig(cfg.dataDir);
    inverter = new Inverter(invCfg);
    server = createServer(inverter, cfg, invCfg, null);
    token = makeToken(["read", "write"], "mcp");
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => (server.listening ? server.close(() => resolve()) : resolve()));
    inverter.removeAllListeners();
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

  it("initializes a session and reports the server identity", async () => {
    const res = await request(server)
      .post("/mcp")
      .set("Authorization", `Bearer ${token}`)
      .set("Accept", ACCEPT)
      .send(INIT);

    expect(res.status).toBe(200);
    expect(res.headers["mcp-session-id"]).toBeDefined();
    expect(res.text).toContain("inverter-monitor");
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

    expect(list.text).not.toContain("get_series"); // createServer(..., stats = null)
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
    const invCfg = loadInverterConfig(cfg.dataDir);
    const inv = new Inverter(invCfg);
    const srv = createServer(inv, cfg, invCfg, null);
    try {
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
    } finally {
      inv.removeAllListeners();
    }
  });

  it("returns 404 when MCP_ENABLED=false", async () => {
    process.env.MCP_ENABLED = "false";
    const cfg = loadConfig();
    const invCfg = loadInverterConfig(cfg.dataDir);
    const inv = new Inverter(invCfg);
    const srv = createServer(inv, cfg, invCfg, null);
    try {
      const res = await request(srv)
        .post("/mcp")
        .set("Authorization", `Bearer ${token}`)
        .set("Accept", ACCEPT)
        .send(INIT);
      expect(res.status).toBe(404);
    } finally {
      inv.removeAllListeners();
    }
  });
});
