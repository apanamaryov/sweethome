import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpSessionContext } from "@sweethome/home-mcp";
import { loadDryerConfig } from "../config";
import { Dryer } from "../dryer";
import { MockNodeLink } from "../node/mock";
import { DryerStore } from "../store";
import { FakeTimers } from "../testing/fake-timers";
import { createDryerMcpProvider } from "./provider";
import { DRYER_INSTRUCTIONS } from "./tools";

const CTX: McpSessionContext = { role: "admin", scopes: ["read", "write"], username: "alex", source: "mcp:laptop" };
const DAY_MS = 24 * 3600_000;

function makeDryer() {
  const timers = new FakeTimers();
  timers.now = Date.UTC(2026, 7, 30, 12, 0, 0);
  const now = () => timers.now;
  const store = new DryerStore(":memory:");
  store.seedPresetsIfEmpty();
  const link = new MockNodeLink({ now, timers, excessTauMs: 60_000 });
  const dryer = new Dryer({ cfg: loadDryerConfig("/data", { DRYER_TRANSPORT: "mock" }), store, link, timers, now, log: () => {} });
  return { store, dryer, timers, now };
}

async function connect(ctx: McpSessionContext = CTX) {
  const { store, dryer, timers, now } = makeDryer();
  const provider = createDryerMcpProvider({ dryer, store, now });
  const server = new McpServer({ name: "test", version: "0" });
  provider.register(server, ctx);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(ct);
  return { client, store, dryer, timers, provider };
}

describe("dryer MCP provider — resources and prompt", () => {
  it("lists dryer://state and dryer://runs/recent", async () => {
    const { client } = await connect();
    const uris = (await client.listResources()).resources.map((r) => r.uri);
    expect(uris).toEqual(expect.arrayContaining(["dryer://state", "dryer://runs/recent"]));
  });

  it("dryer://state reads the current snapshot as JSON", async () => {
    const { client } = await connect();
    const r = await client.readResource({ uri: "dryer://state" });
    expect(r.contents).toHaveLength(1);
    expect(r.contents[0].mimeType).toBe("application/json");
    const parsed = JSON.parse(String((r.contents[0] as { text: string }).text));
    expect(parsed.node.state).toBe("idle");
    expect(parsed.run).toBeNull();
  });

  it("dryer://runs/recent returns 20 newest runs within 90 days, oldest excluded", async () => {
    const { client, store, timers } = await connect();
    const now = timers.now;
    for (let i = 0; i < 25; i++) {
      const startedAt = now - Math.floor((i * 30 * DAY_MS) / 24);
      const run = store.openRun({ startedAt, presetName: null, setpoint: 60, maxMinutes: 60, startedBy: "ui:alex", autostopEnabled: true });
      store.closeRun(run.id, startedAt + 3600_000, "stopped");
    }
    const oldStartedAt = now - 100 * DAY_MS;
    const oldRun = store.openRun({ startedAt: oldStartedAt, presetName: null, setpoint: 60, maxMinutes: 60, startedBy: "ui:alex", autostopEnabled: true });
    store.closeRun(oldRun.id, oldStartedAt + 3600_000, "stopped");

    const r = await client.readResource({ uri: "dryer://runs/recent" });
    expect(r.contents[0].mimeType).toBe("application/json");
    const { runs } = JSON.parse(String((r.contents[0] as { text: string }).text)) as {
      runs: Array<{ id: number; startedAt: number }>;
    };
    expect(runs).toHaveLength(20);
    for (let i = 1; i < runs.length; i++) expect(runs[i].startedAt).toBeLessThanOrEqual(runs[i - 1].startedAt);
    expect(runs.every((x) => now - x.startedAt <= 90 * DAY_MS)).toBe(true);
    expect(runs.some((x) => x.id === oldRun.id)).toBe(false);
  });

  it("lists dryer-report and reports on the last run, or its absence", async () => {
    const { client, store, timers } = await connect();
    const names = (await client.listPrompts()).prompts.map((p) => p.name);
    expect(names).toContain("dryer-report");

    let r = await client.getPrompt({ name: "dryer-report", arguments: {} });
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0].role).toBe("user");
    expect(String((r.messages[0].content as { text: string }).text)).toContain("Сушек ещё не было");

    const run = store.openRun({ startedAt: timers.now - 3600_000, presetName: "Яблоки", setpoint: 60, maxMinutes: 120, startedBy: "ui:alex", autostopEnabled: true });
    store.closeRun(run.id, timers.now, "stopped");

    r = await client.getPrompt({ name: "dryer-report", arguments: {} });
    const text = String((r.messages[0].content as { text: string }).text);
    expect(text).toContain(`runId=${run.id}`);
    expect(text).toContain("dryer_get_run_chart");
  });

  it("instructions match DRYER_INSTRUCTIONS and mention the 220 V heater", () => {
    const { store, dryer, now } = makeDryer();
    const provider = createDryerMcpProvider({ dryer, store, now });
    expect(provider.instructions).toBe(DRYER_INSTRUCTIONS);
    expect(provider.instructions).toContain("220 V");
  });
});
