import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { LoggingMessageNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { buildMcpServer } from "./server";
import { createFakeGateway, type FakeGateway } from "./testing/fake-gateway";

async function connect(gateway: FakeGateway = createFakeGateway()) {
  const server = buildMcpServer({ gateway, version: "test" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: { logging: {} } });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return { client, gateway };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("MCP logging", () => {
  it("advertises the logging capability", async () => {
    const { client } = await connect();
    expect(client.getServerCapabilities()?.logging).toBeDefined();
  });

  it("logs a write at info level under the control logger", async () => {
    const messages: Array<{ level: string; logger?: string; data: unknown }> = [];
    const { client } = await connect();
    client.setNotificationHandler(LoggingMessageNotificationSchema, (n) => messages.push(n.params));
    await client.setLoggingLevel("info");

    await client.callTool({ name: "set_control", arguments: { type: "chargerSourcePriority", value: 3 } });
    await sleep(50);

    const write = messages.find((m) => m.logger === "control");
    expect(write).toBeDefined();
    expect(write!.level).toBe("info");
    expect(JSON.stringify(write!.data)).toContain("reg 331");
  });

  it("logs gateway failures at error level", async () => {
    const gw = createFakeGateway({
      snapshot: async () => {
        throw new Error("service unreachable");
      },
    });
    const messages: Array<{ level: string; data: unknown }> = [];
    const { client } = await connect(gw);
    client.setNotificationHandler(LoggingMessageNotificationSchema, (n) => messages.push(n.params));
    await client.setLoggingLevel("error");

    await client.callTool({ name: "get_snapshot", arguments: {} });
    await sleep(50);

    expect(messages.some((m) => m.level === "error" && JSON.stringify(m.data).includes("unreachable"))).toBe(true);
  });

  it("keeps working when the client never asked for logs", async () => {
    const { client } = await connect();
    const r = await client.callTool({ name: "get_snapshot", arguments: {} });
    expect(r.isError).toBeFalsy();
  });
});
