#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadStdioConfig } from "../config";
import { createHttpGateway } from "../gateway/http";
import { buildMcpServer } from "../server";

// Версия пакета — в отчёте клиенту; читаем из собственного package.json.
const { version } = require("../../package.json") as { version: string };

async function main(): Promise<void> {
  const cfg = loadStdioConfig(process.env);
  const gateway = await createHttpGateway({
    baseUrl: cfg.baseUrl,
    token: cfg.token,
    timeoutMs: cfg.timeoutMs,
  });

  const caps = gateway.capabilities();
  const writes = !cfg.readOnly && caps.allowControl && caps.scopes.includes("write");
  // stderr — единственный безопасный канал: stdout занят протоколом.
  console.error(
    `[inverter-mcp] connected to ${cfg.baseUrl} as ${caps.role} ` +
      `[${caps.scopes.join(", ") || "no scopes"}]; ` +
      `writes ${writes ? "available" : "hidden"}; stats ${caps.statsEnabled ? "on" : "off"}`
  );

  const server = buildMcpServer({ gateway, version, readOnly: cfg.readOnly });
  await server.connect(new StdioServerTransport());

  const shutdown = async () => {
    await server.close();
    gateway.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((e) => {
  console.error(`[inverter-mcp] fatal: ${(e as Error).message}`);
  process.exit(1);
});
