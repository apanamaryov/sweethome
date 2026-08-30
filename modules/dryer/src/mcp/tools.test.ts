import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpSessionContext } from "@sweethome/home-mcp";
import { loadDryerConfig } from "../config";
import { Dryer } from "../dryer";
import { MockNodeLink } from "../node/mock";
import { DryerStore } from "../store";
import { FakeTimers } from "../testing/fake-timers";
import { registerDryerTools } from "./tools";

const ADMIN_RW: McpSessionContext = { role: "admin", scopes: ["read", "write"], username: "alex", source: "mcp:laptop" };
const RO: McpSessionContext = { role: "admin", scopes: ["read"], username: "alex", source: "mcp:reader" };
const VIEWER: McpSessionContext = { role: "viewer", scopes: ["read", "write"], username: "guest", source: "mcp:guest" };

async function connect(ctx: McpSessionContext = ADMIN_RW) {
  const timers = new FakeTimers();
  timers.now = Date.UTC(2026, 7, 30, 12, 0, 0);
  const now = () => timers.now;
  const store = new DryerStore(":memory:");
  store.seedPresetsIfEmpty();
  const link = new MockNodeLink({ now, timers, excessTauMs: 60_000 });
  const dryer = new Dryer({ cfg: loadDryerConfig("/data", { DRYER_TRANSPORT: "mock" }), store, link, timers, now, log: () => {} });
  const server = new McpServer({ name: "test", version: "0" });
  registerDryerTools(server, { dryer, store, ctx, now });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(ct);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const text = (r.content as { type: string; text: string }[]).map((c) => c.text).join("\n");
    return { text, isError: r.isError === true, structured: r.structuredContent as Record<string, unknown> | undefined };
  };
  return { client, call, store, dryer, timers };
}

describe("dryer MCP tools", () => {
  it("набор инструментов зависит от прав: read-only и viewer не видят записи", async () => {
    const names = async (ctx: McpSessionContext) => (await (await connect(ctx)).client.listTools()).tools.map((t) => t.name).sort();
    expect(await names(ADMIN_RW)).toEqual([
      "dryer_get_run_chart", "dryer_get_runs", "dryer_get_state", "dryer_list_presets", "dryer_start", "dryer_stop", "dryer_upsert_preset",
    ]);
    expect(await names(RO)).toEqual(["dryer_get_run_chart", "dryer_get_runs", "dryer_get_state", "dryer_list_presets"]);
    expect(await names(VIEWER)).toEqual(["dryer_get_run_chart", "dryer_get_runs", "dryer_get_state", "dryer_list_presets"]);
  });

  it("dryer_get_state — текст и структура", async () => {
    const { call } = await connect();
    const r = await call("dryer_get_state");
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/^Сушилка: простой/);
    expect(r.structured).toMatchObject({ node: { state: "idle" }, run: null });
  });

  it("dryer_list_presets группирует", async () => {
    const { call } = await connect();
    const r = await call("dryer_list_presets");
    expect((r.structured!.presets as unknown[]).length).toBe(30);
    expect(r.text).toContain("fruit:");
    expect(r.text).toContain("Яблоки — 60 °C, до 14 ч 0 м");
  });

  it("dryer_start по имени пресета, состояние в тексте, started_by = source; dryer_stop", async () => {
    const { call } = await connect();
    let r = await call("dryer_start", { preset: "Яблоки" });
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/Сушилка: разогрев · «Яблоки» 60 °C/);
    expect((r.structured!.run as { startedBy: string }).startedBy).toBe("mcp:laptop");
    r = await call("dryer_start", { preset: "Яблоки" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Сушка уже идёт");
    r = await call("dryer_stop");
    expect(r.isError).toBe(false);
    expect(r.structured!.run).toBeNull();
  });

  it("dryer_start со своими параметрами; неизвестный пресет — isError, а не обрыв", async () => {
    const { call } = await connect();
    let r = await call("dryer_start", { preset: "Манго" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Пресет не найден");
    r = await call("dryer_start", { setpoint: 45, maxHours: 2, autostop: false });
    expect(r.isError).toBe(false);
    expect(r.structured!.run).toMatchObject({ setpoint: 45, maxMinutes: 120, autostopEnabled: false });
  });

  it("dryer_start: maxHours вне диапазона — isError, сушка не начинается", async () => {
    const { call, store, timers } = await connect();
    const r = await call("dryer_start", { setpoint: 60, maxHours: 10000 });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/maxHours/); // схема режет ещё до startRun; сам startRun проверяет диапазоны второй раз
    expect(store.listRuns(0, timers.now + 1)).toHaveLength(0);
  });

  it("dryer_get_runs и dryer_get_run_chart (прореживание до 200 точек)", async () => {
    const { call, dryer, timers, store } = await connect();
    await dryer.startRun({ setpoint: 60, maxMinutes: 600 }, "ui:alex");
    for (let i = 0; i < 300; i++) {
      timers.now += 10_000;
      dryer.tick();
    }
    await dryer.stopRun();
    const runId = store.listRuns(0, timers.now + 1)[0].id;
    let r = await call("dryer_get_runs", { from: "-1d", to: "now" });
    expect(r.isError).toBe(false);
    expect((r.structured!.runs as unknown[]).length).toBe(1);
    expect(r.text).toContain("остановлена");
    r = await call("dryer_get_run_chart", { runId });
    expect(r.isError).toBe(false);
    const pts = r.structured!.points as unknown[];
    expect(pts.length).toBeLessThanOrEqual(200);
    expect(pts.length).toBeGreaterThan(100);
    expect(r.text).toContain("точек");
  });

  it("dryer_upsert_preset создаёт и обновляет по имени", async () => {
    const { call, store } = await connect();
    let r = await call("dryer_upsert_preset", { name: "Инжир", group: "fruit", setpoint: 58, maxHours: 15 });
    expect(r.isError).toBe(false);
    expect(store.listPresets().find((p) => p.name === "Инжир")).toMatchObject({ setpoint: 58, maxMinutes: 900 });
    r = await call("dryer_upsert_preset", { name: "Инжир", group: "fruit", setpoint: 56, maxHours: 15 });
    expect(r.isError).toBe(false);
    expect(store.listPresets().filter((p) => p.name === "Инжир")).toHaveLength(1);
    expect(store.listPresets().find((p) => p.name === "Инжир")!.setpoint).toBe(56);
    r = await call("dryer_upsert_preset", { name: "Инжир", group: "fruit", setpoint: 90, maxHours: 15 });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("вне допустимого диапазона");
  });
});
