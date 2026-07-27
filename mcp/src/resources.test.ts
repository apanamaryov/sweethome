import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { buildMcpServer } from "./server";
import { createFakeGateway, FAKE_SNAPSHOT } from "./testing/fake-gateway";
import type { InverterGateway } from "./gateway/types";

async function connect(gateway: InverterGateway) {
  const server = buildMcpServer({ gateway, version: "test" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return { client, server };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("resources", () => {
  it("lists the static resources", async () => {
    const { client } = await connect(createFakeGateway());
    const uris = (await client.listResources()).resources.map((r) => r.uri);
    expect(uris).toEqual(
      expect.arrayContaining([
        "inverter://snapshot",
        "inverter://settings",
        "inverter://baseline",
        "inverter://alarms",
        "inverter://events/recent",
        "inverter://registers/map",
        "inverter://docs/control-contract",
      ])
    );
  });

  it("reads the snapshot resource as JSON", async () => {
    const { client } = await connect(createFakeGateway());
    const r = await client.readResource({ uri: "inverter://snapshot" });
    expect(r.contents[0].mimeType).toBe("application/json");
    expect(JSON.parse(String(r.contents[0].text)).mode).toBe("Battery");
  });

  it("renders the register map as markdown with real addresses", async () => {
    const { client } = await connect(createFakeGateway());
    const r = await client.readResource({ uri: "inverter://registers/map" });
    expect(r.contents[0].mimeType).toBe("text/markdown");
    const text = String(r.contents[0].text);
    expect(text).toContain("| 202 |");
    expect(text).toContain("gridVoltage");
  });

  it("documents the control contract with allowed values and warnings", async () => {
    const { client } = await connect(createFakeGateway());
    const text = String((await client.readResource({ uri: "inverter://docs/control-contract" })).contents[0].text);
    expect(text).toContain("chargerSourcePriority");
    expect(text).toContain("331");
    expect(text).toMatch(/battery/i);
  });

  it("omits stats-backed resources when statistics are disabled", async () => {
    const { client } = await connect(createFakeGateway({ stats: null, caps: { statsEnabled: false } }));
    const uris = (await client.listResources()).resources.map((r) => r.uri);
    expect(uris).not.toContain("inverter://events/recent");
    const templates = (await client.listResourceTemplates()).resourceTemplates.map((t) => t.uriTemplate);
    expect(templates).toEqual([]);
  });

  it("serves the daily template", async () => {
    const gw = createFakeGateway();
    const { client } = await connect(gw);
    const r = await client.readResource({ uri: "inverter://stats/daily/2026-07-26" });
    expect(JSON.parse(String(r.contents[0].text))).toHaveLength(1);
    expect(gw.calls).toContainEqual({ method: "daily", args: ["2026-07-26", "2026-07-26"] });
  });

  it("serves the CSV export template", async () => {
    const { client } = await connect(createFakeGateway());
    const r = await client.readResource({ uri: "inverter://stats/export/minute/1000/2000.csv" });
    expect(r.contents[0].mimeType).toBe("text/csv");
    expect(String(r.contents[0].text)).toContain("ts,mode");
  });

  it("refuses a CSV export that exceeds the size cap instead of truncating it", async () => {
    const gw = createFakeGateway();
    gw.stats!.exportCsv = async () => ({ csv: "x", truncated: true });
    const { client } = await connect(gw);
    await expect(client.readResource({ uri: "inverter://stats/export/raw/1/2.csv" })).rejects.toThrow(/5 MB/);
  });

  it("advertises subscribe support and notifies on new snapshots", async () => {
    const gw = createFakeGateway();
    const { client } = await connect(gw);
    expect(client.getServerCapabilities()?.resources?.subscribe).toBe(true);

    const updates: string[] = [];
    client.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => {
      updates.push(n.params.uri);
    });

    await client.subscribeResource({ uri: "inverter://snapshot" });
    gw.emitSnapshot({ ...FAKE_SNAPSHOT, timestamp: Date.now() });
    await sleep(50);
    expect(updates).toContain("inverter://snapshot");

    await client.unsubscribeResource({ uri: "inverter://snapshot" });
    updates.length = 0;
    gw.emitSnapshot({ ...FAKE_SNAPSHOT, timestamp: Date.now() });
    await sleep(50);
    expect(updates).toEqual([]);
  });

  it("throttles snapshot notifications to one per interval", async () => {
    const gw = createFakeGateway();
    const { client } = await connect(gw);
    const updates: string[] = [];
    client.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => updates.push(n.params.uri));

    await client.subscribeResource({ uri: "inverter://snapshot" });
    for (let i = 0; i < 5; i++) gw.emitSnapshot({ ...FAKE_SNAPSHOT, timestamp: Date.now() + i });
    await sleep(50);
    expect(updates).toHaveLength(1);
  });
});
