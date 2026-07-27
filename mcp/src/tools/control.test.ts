import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer } from "../server";
import { createFakeGateway } from "../testing/fake-gateway";
import type { InverterGateway } from "../gateway/types";

const WRITE_TOOLS = ["set_control", "set_lock", "recapture_baseline", "write_register"];

async function connect(gateway: InverterGateway, readOnly = false) {
  const server = buildMcpServer({ gateway, version: "test", readOnly });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
}

async function toolNames(client: Client): Promise<string[]> {
  return (await client.listTools()).tools.map((t) => t.name);
}

const textOf = (r: { content: unknown }) => (r.content as Array<{ text: string }>)[0].text;

describe("control tools visibility", () => {
  it("exposes write tools to an admin token with the write scope", async () => {
    const names = await toolNames(await connect(createFakeGateway()));
    expect(names).toEqual(expect.arrayContaining(WRITE_TOOLS));
  });

  it("hides write tools from a viewer", async () => {
    const client = await connect(createFakeGateway({ caps: { role: "viewer", scopes: ["read"] } }));
    const names = await toolNames(client);
    for (const n of WRITE_TOOLS) expect(names).not.toContain(n);
    expect(names).toContain("get_snapshot");
  });

  it("hides write tools from an admin token without the write scope", async () => {
    const names = await toolNames(await connect(createFakeGateway({ caps: { scopes: ["read"] } })));
    for (const n of WRITE_TOOLS) expect(names).not.toContain(n);
  });

  it("hides write tools when ALLOW_CONTROL is off on the server", async () => {
    const names = await toolNames(await connect(createFakeGateway({ caps: { allowControl: false } })));
    for (const n of WRITE_TOOLS) expect(names).not.toContain(n);
  });

  it("hides write tools when the local read-only switch is on", async () => {
    const names = await toolNames(await connect(createFakeGateway(), true));
    for (const n of WRITE_TOOLS) expect(names).not.toContain(n);
  });
});

describe("control tools behaviour", () => {
  it("set_control with preview does not write", async () => {
    const gw = createFakeGateway();
    const client = await connect(gw);
    const r = await client.callTool({
      name: "set_control",
      arguments: { type: "chargerSourcePriority", value: 3, preview: true },
    });
    expect(gw.calls.some((c) => c.method === "control")).toBe(false);
    expect(gw.calls).toContainEqual({ method: "previewControl", args: ["chargerSourcePriority", 3] });
    expect((r.structuredContent as { register: number }).register).toBe(331);
    expect(textOf(r)).toContain("Nothing was written");
  });

  it("set_control writes when not previewing", async () => {
    const gw = createFakeGateway();
    const client = await connect(gw);
    const r = await client.callTool({ name: "set_control", arguments: { type: "chargerSourcePriority", value: 3 } });
    expect(gw.calls).toContainEqual({ method: "control", args: ["chargerSourcePriority", 3] });
    expect((r.structuredContent as { ok: boolean }).ok).toBe(true);
  });

  it("turns a locked-inverter error into a hint about set_lock", async () => {
    const gw = createFakeGateway({
      control: async () => {
        throw new Error("Settings are locked (read-only). Unlock control before writing.");
      },
    });
    const client = await connect(gw);
    const r = await client.callTool({ name: "set_control", arguments: { type: "chargerSourcePriority", value: 3 } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("set_lock");
  });

  it("set_lock toggles the write lock", async () => {
    const gw = createFakeGateway();
    const client = await connect(gw);
    const r = await client.callTool({ name: "set_lock", arguments: { locked: false } });
    expect(gw.calls).toContainEqual({ method: "setLock", args: [false] });
    expect((r.structuredContent as { locked: boolean }).locked).toBe(false);
    expect(textOf(r)).toContain("released");
  });

  it("recapture_baseline reports the captured device", async () => {
    const gw = createFakeGateway();
    const client = await connect(gw);
    const r = await client.callTool({ name: "recapture_baseline", arguments: {} });
    expect(gw.calls).toContainEqual({ method: "recaptureBaseline", args: [] });
    expect(textOf(r)).toContain("dev-1");
  });

  it("write_register previews by reading the current value", async () => {
    const gw = createFakeGateway();
    const client = await connect(gw);
    const r = await client.callTool({ name: "write_register", arguments: { address: 331, value: 3, preview: true } });
    expect(gw.calls).toContainEqual({ method: "raw", args: ["R 331 1"] });
    expect(gw.calls.some((c) => c.method === "raw" && String(c.args[0]).startsWith("W"))).toBe(false);
    expect((r.structuredContent as { preview: boolean }).preview).toBe(true);
  });

  it("write_register writes a raw value", async () => {
    const gw = createFakeGateway();
    const client = await connect(gw);
    await client.callTool({ name: "write_register", arguments: { address: 331, value: 3 } });
    expect(gw.calls).toContainEqual({ method: "raw", args: ["W 331 3"] });
  });

  it("marks write tools as destructive in their annotations", async () => {
    const client = await connect(createFakeGateway());
    const tools = (await client.listTools()).tools;
    const setControl = tools.find((t) => t.name === "set_control")!;
    expect(setControl.annotations).toMatchObject({ destructiveHint: true, readOnlyHint: false });
  });
});
