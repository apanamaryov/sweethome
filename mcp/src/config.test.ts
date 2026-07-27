import { loadStdioConfig } from "./config";

describe("loadStdioConfig", () => {
  it("requires a token", () => {
    expect(() => loadStdioConfig({})).toThrow(/INVERTER_MCP_TOKEN/);
  });

  it("falls back to localhost and sane defaults", () => {
    expect(loadStdioConfig({ INVERTER_MCP_TOKEN: "inv_x" })).toEqual({
      baseUrl: "http://localhost:3000",
      token: "inv_x",
      timeoutMs: 10_000,
      readOnly: false,
    });
  });

  it("reads every override", () => {
    expect(
      loadStdioConfig({
        INVERTER_MCP_TOKEN: "inv_x",
        INVERTER_MCP_URL: "http://192.168.1.112:3000/",
        INVERTER_MCP_TIMEOUT_MS: "2500",
        INVERTER_MCP_READ_ONLY: "true",
      })
    ).toEqual({
      baseUrl: "http://192.168.1.112:3000/",
      token: "inv_x",
      timeoutMs: 2500,
      readOnly: true,
    });
  });

  it("ignores a non-numeric or non-positive timeout", () => {
    expect(loadStdioConfig({ INVERTER_MCP_TOKEN: "inv_x", INVERTER_MCP_TIMEOUT_MS: "soon" }).timeoutMs).toBe(10_000);
    expect(loadStdioConfig({ INVERTER_MCP_TOKEN: "inv_x", INVERTER_MCP_TIMEOUT_MS: "0" }).timeoutMs).toBe(10_000);
  });
});
