import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer } from "../server";
import { createFakeGateway, FAKE_SNAPSHOT } from "../testing/fake-gateway";
import type { InverterGateway } from "../gateway/types";

async function connect(gateway: InverterGateway) {
  const server = buildMcpServer({ gateway, version: "test" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

const textOf = (r: { content: unknown }) => (r.content as Array<{ text: string }>)[0].text;

describe("read tools", () => {
  it("exposes the read tool set", async () => {
    const client = await connect(createFakeGateway());
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "get_snapshot",
        "get_settings_diff",
        "get_alarms",
        "get_meta",
        "get_health",
        "read_registers",
      ])
    );
  });

  it("get_snapshot returns structured data plus a readable summary", async () => {
    const client = await connect(createFakeGateway());
    const r = await client.callTool({ name: "get_snapshot", arguments: {} });
    const structured = r.structuredContent as { mode: string; status: { batteryCapacity: number } };
    expect(structured.mode).toBe("Battery");
    expect(structured.status.batteryCapacity).toBe(72);
    expect(textOf(r)).toContain("SOC 72%");
  });

  it("get_snapshot reports the derived power source alongside the raw mode", async () => {
    // FAKE_SNAPSHOT намеренно держит mode: "Battery" при powerSource: "Solar" —
    // так видно, что это два разных поля, а не одно продублированное.
    const client = await connect(createFakeGateway());
    const r = await client.callTool({ name: "get_snapshot", arguments: {} });
    const structured = r.structuredContent as { mode: string; powerSource: string };
    expect(structured.mode).toBe("Battery");
    expect(structured.powerSource).toBe("Solar");
    expect(textOf(r)).toContain("Mode: Battery · source: Solar");
  });

  it("get_snapshot keeps the mode and the source even under a sections filter", async () => {
    const client = await connect(createFakeGateway());
    const r = await client.callTool({ name: "get_snapshot", arguments: { sections: ["connection"] } });
    const structured = r.structuredContent as Record<string, unknown>;
    expect(structured.mode).toBe("Battery");
    expect(structured.powerSource).toBe("Solar");
  });

  it("get_snapshot honours the sections filter", async () => {
    const client = await connect(createFakeGateway());
    const r = await client.callTool({ name: "get_snapshot", arguments: { sections: ["connection"] } });
    const structured = r.structuredContent as Record<string, unknown>;
    expect(structured.connection).toBeDefined();
    expect(structured.status).toBeUndefined();
    expect(structured.settings).toBeUndefined();
  });

  it("get_settings_diff reports drift against the baseline", async () => {
    const gw = createFakeGateway();
    gw.snapshotValue = {
      ...FAKE_SNAPSHOT,
      baseline: {
        deviceId: "dev-1",
        capturedAt: 1,
        info: { ...FAKE_SNAPSHOT.info!, chargerSourcePriority: 1 },
        flags: FAKE_SNAPSHOT.flags,
      },
    };
    const client = await connect(gw);
    const r = await client.callTool({ name: "get_settings_diff", arguments: {} });
    const d = r.structuredContent as { driftCount: number; settings: Array<{ key: string; drifted: boolean }> };
    expect(d.driftCount).toBe(1);
    expect(d.settings.find((s) => s.key === "chargerSourcePriority")!.drifted).toBe(true);
    expect(textOf(r)).toContain("drifted");
  });

  it("get_alarms says so when nothing is active", async () => {
    const client = await connect(createFakeGateway());
    const r = await client.callTool({ name: "get_alarms", arguments: {} });
    expect((r.structuredContent as { count: number }).count).toBe(0);
    expect(textOf(r)).toBe("No active alarms.");
  });

  it("get_meta reports role, scopes and the master control switch", async () => {
    const client = await connect(createFakeGateway());
    const r = await client.callTool({ name: "get_meta", arguments: {} });
    expect(r.structuredContent).toMatchObject({ role: "admin", scopes: ["read", "write"], allowControl: true });
    expect(textOf(r)).toContain("writes enabled");
  });

  it("get_health surfaces transport, mock flag and snapshot age", async () => {
    const client = await connect(createFakeGateway());
    const r = await client.callTool({ name: "get_health", arguments: {} });
    const h = r.structuredContent as { connected: boolean; transport: string; mock: boolean; snapshotAgeMs: number };
    expect(h).toMatchObject({ connected: true, transport: "serial", mock: false });
    expect(typeof h.snapshotAgeMs).toBe("number");
  });

  it("get_health calls out demo data", async () => {
    const gw = createFakeGateway();
    gw.snapshotValue = {
      ...FAKE_SNAPSHOT,
      connection: { ...FAKE_SNAPSHOT.connection, mock: true, transport: "mock" },
    };
    const client = await connect(gw);
    expect(textOf(await client.callTool({ name: "get_health", arguments: {} }))).toContain("demo data");
  });

  it("read_registers passes an R command to the gateway", async () => {
    const gw = createFakeGateway();
    const client = await connect(gw);
    const r = await client.callTool({ name: "read_registers", arguments: { address: 201, count: 2 } });
    expect(gw.calls).toContainEqual({ method: "raw", args: ["R 201 2"] });
    expect((r.structuredContent as { reply: string }).reply).toContain("201");
  });

  it("reports gateway failures as tool errors instead of throwing", async () => {
    const gw = createFakeGateway({
      snapshot: async () => {
        throw new Error("Inverter service at http://pi:3000 is unreachable: ECONNREFUSED");
      },
    });
    const client = await connect(gw);
    const r = await client.callTool({ name: "get_snapshot", arguments: {} });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("unreachable");
  });
});
