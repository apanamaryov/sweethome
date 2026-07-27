import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer } from "../server";
import { createFakeGateway } from "../testing/fake-gateway";
import type { InverterGateway } from "../gateway/types";

const STATS_TOOLS = [
  "get_series",
  "get_daily",
  "get_energy",
  "get_events",
  "get_solar_window",
  "summarize_period",
  "export_csv",
];

async function connect(gateway: InverterGateway) {
  const server = buildMcpServer({ gateway, version: "test" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
}

const textOf = (r: { content: unknown }) => (r.content as Array<{ text: string }>)[0].text;

describe("stats tools", () => {
  it("registers the stats tool set when statistics are available", async () => {
    const client = await connect(createFakeGateway());
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(STATS_TOOLS));
  });

  it("omits every stats tool when statistics are disabled", async () => {
    const client = await connect(createFakeGateway({ stats: null, caps: { statsEnabled: false } }));
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const n of STATS_TOOLS) expect(names).not.toContain(n);
    expect(names).toContain("get_snapshot"); // чтение остаётся
  });

  it("get_series resolves relative time and asks the gateway for the right window", async () => {
    const gw = createFakeGateway();
    const client = await connect(gw);
    await client.callTool({ name: "get_series", arguments: { fields: ["pvPower"], from: "-1h", to: "now" } });

    const call = gw.calls.find((c) => c.method === "series")!;
    const q = call.args[0] as { fields: string[]; from: number; to: number; res: string };
    expect(q.fields).toEqual(["pvPower"]);
    expect(q.to - q.from).toBe(3_600_000);
    expect(q.res).toBe("raw"); // окно ≤ 6 ч
  });

  it("get_series picks minute resolution for long windows and reports downsampling", async () => {
    const many = Array.from({ length: 5000 }, (_, i) => ({ t: i, pvPower: i }));
    const gw = createFakeGateway();
    gw.stats!.series = async () => many;
    const client = await connect(gw);

    const r = await client.callTool({
      name: "get_series",
      arguments: { fields: ["pvPower"], from: "-7d", to: "now", maxPoints: 100 },
    });
    const s = r.structuredContent as { downsampled: boolean; sourcePoints: number; points: unknown[]; res: string };
    expect(s.res).toBe("minute");
    expect(s.downsampled).toBe(true);
    expect(s.sourcePoints).toBe(5000);
    expect(s.points.length).toBeLessThanOrEqual(101);
    expect(textOf(r)).toContain("downsampled");
  });

  it("get_series rejects an inverted window", async () => {
    const client = await connect(createFakeGateway());
    const r = await client.callTool({ name: "get_series", arguments: { fields: ["pvPower"], from: "now", to: "-1h" } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("later than");
  });

  it("get_daily accepts day keywords", async () => {
    const gw = createFakeGateway();
    const client = await connect(gw);
    await client.callTool({ name: "get_daily", arguments: { from: "-1d", to: "today" } });
    const call = gw.calls.find((c) => c.method === "daily")!;
    expect(String(call.args[0])).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(String(call.args[1])).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("get_events flags truncation at the limit", async () => {
    const gw = createFakeGateway();
    gw.stats!.events = async () =>
      Array.from({ length: 5 }, (_, i) => ({ id: i, ts: i, type: "mode-change", detail: "{}" }));
    const client = await connect(gw);
    const r = await client.callTool({ name: "get_events", arguments: { limit: 5 } });
    expect((r.structuredContent as { truncated: boolean }).truncated).toBe(true);
    expect(textOf(r)).toContain("limit was reached");
  });

  it("get_solar_window renders an in-progress window", async () => {
    const client = await connect(createFakeGateway());
    const r = await client.callTool({ name: "get_solar_window", arguments: { day: "today" } });
    expect((r.structuredContent as { state: string }).state).toBe("active");
    expect(textOf(r)).toContain("running since");
  });

  it("summarize_period aggregates energy, SOC and alarms in one call", async () => {
    const client = await connect(createFakeGateway());
    const r = await client.callTool({ name: "summarize_period", arguments: { from: "-1d", to: "now" } });
    const s = r.structuredContent as {
      pvKwh: number;
      loadKwh: number;
      gridKwh: number;
      socMin: number | null;
      socMax: number | null;
      alarmCount: number;
    };
    expect(s.pvKwh).toBeCloseTo(8);
    expect(s.loadKwh).toBeCloseTo(5);
    expect(s.socMin).toBe(40);
    expect(s.socMax).toBe(100);
    expect(s.alarmCount).toBe(0);
    expect(textOf(r)).toContain("PV 8.00 kWh");
  });

  it("export_csv returns a resource link instead of the payload", async () => {
    const client = await connect(createFakeGateway());
    const r = await client.callTool({ name: "export_csv", arguments: { from: 1000, to: 2000, res: "minute" } });
    const link = (r.content as Array<{ type: string; uri?: string }>).find((c) => c.type === "resource_link");
    expect(link?.uri).toBe("inverter://stats/export/minute/1000/2000.csv");
  });
});
