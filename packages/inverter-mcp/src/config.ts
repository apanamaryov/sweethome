export interface StdioConfig {
  baseUrl: string;
  token: string;
  timeoutMs: number;
  readOnly: boolean;
}

/** Конфигурация stdio-входа целиком из env — как и у сервера. */
export function loadStdioConfig(env: NodeJS.ProcessEnv): StdioConfig {
  const token = env.INVERTER_MCP_TOKEN?.trim();
  if (!token) {
    throw new Error(
      "INVERTER_MCP_TOKEN is required. Issue one on the Users page or with " +
        "`DATA_DIR=data npx tsx scripts/issue-token.ts <name> --write` on the Pi."
    );
  }
  const timeout = Number(env.INVERTER_MCP_TIMEOUT_MS);
  return {
    baseUrl: env.INVERTER_MCP_URL?.trim() || "http://localhost:3000",
    token,
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 10_000,
    readOnly: /^(1|true|yes|on)$/i.test(env.INVERTER_MCP_READ_ONLY ?? ""),
  };
}
