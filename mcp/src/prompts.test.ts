import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer } from "./server";
import { createFakeGateway } from "./testing/fake-gateway";
import type { InverterGateway } from "./gateway/types";

async function connect(gateway: InverterGateway) {
  const server = buildMcpServer({ gateway, version: "test" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
}

const joined = (r: { messages: Array<{ content: unknown }> }) =>
  r.messages.map((m) => (m.content as { text: string }).text).join("\n");

describe("prompts", () => {
  it("lists the prompt set", async () => {
    const client = await connect(createFakeGateway());
    const names = (await client.listPrompts()).prompts.map((p) => p.name);
    expect(names).toEqual(
      expect.arrayContaining(["diagnose-connection", "daily-report", "battery-health-check", "plan-setting-change"])
    );
  });

  it("diagnose-connection walks through the hardware checklist", async () => {
    const client = await connect(createFakeGateway());
    const text = joined(await client.getPrompt({ name: "diagnose-connection", arguments: {} }));
    expect(text).toContain("get_health");
    expect(text).toMatch(/Modbus ID/i);
    expect(text).toMatch(/RS232/i);
  });

  it("daily-report resolves the day argument", async () => {
    const client = await connect(createFakeGateway());
    const text = joined(await client.getPrompt({ name: "daily-report", arguments: { day: "2026-07-26" } }));
    expect(text).toContain("2026-07-26");
    expect(text).toContain("get_daily");
  });

  it("completes the day argument from available days", async () => {
    const client = await connect(createFakeGateway());
    const r = await client.complete({
      ref: { type: "ref/prompt", name: "daily-report" },
      argument: { name: "day", value: "2026" },
    });
    expect(r.completion.values).toContain("2026-07-26");
  });

  it("completes the setting type argument", async () => {
    const client = await connect(createFakeGateway());
    const r = await client.complete({
      ref: { type: "ref/prompt", name: "plan-setting-change" },
      argument: { name: "type", value: "charger" },
    });
    expect(r.completion.values).toEqual(["chargerSourcePriority"]);
  });

  it("plan-setting-change refuses to write and says so", async () => {
    const client = await connect(createFakeGateway());
    const text = joined(await client.getPrompt({ name: "plan-setting-change", arguments: { type: "maxChargingCurrent" } }));
    expect(text).toContain("maxChargingCurrent");
    expect(text).toMatch(/do not write|without writing/i);
  });

  it("battery-health-check names the lithium SOC caveat", async () => {
    const client = await connect(createFakeGateway());
    const text = joined(await client.getPrompt({ name: "battery-health-check", arguments: {} }));
    expect(text).toMatch(/Li1/);
    expect(text).toContain("socLowCutoff");
  });

  it("omits daily-report when statistics are unavailable", async () => {
    const client = await connect(createFakeGateway({ stats: null, caps: { statsEnabled: false } }));
    const names = (await client.listPrompts()).prompts.map((p) => p.name);
    expect(names).not.toContain("daily-report");
    expect(names).toContain("diagnose-connection");
  });
});
