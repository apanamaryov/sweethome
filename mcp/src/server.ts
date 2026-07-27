import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { InverterGateway } from "./gateway/types";
import { registerReadTools } from "./tools/read";
import { registerStatsTools } from "./tools/stats";
import { registerControlTools } from "./tools/control";

export interface McpContext {
  gateway: InverterGateway;
  /** Локальный тумблер: скрыть инструменты записи даже у write-токена. */
  readOnly?: boolean;
  version: string;
}

/** Права на запись: роль, скоуп, мастер-выключатель сервиса и локальный тумблер. */
export function canWrite(ctx: McpContext): boolean {
  const caps = ctx.gateway.capabilities();
  return !ctx.readOnly && caps.role === "admin" && caps.scopes.includes("write") && caps.allowControl;
}

export function buildMcpServer(ctx: McpContext): McpServer {
  const server = new McpServer(
    { name: "inverter-monitor", version: ctx.version },
    {
      capabilities: {
        resources: { subscribe: true, listChanged: true },
        logging: {},
      },
      instructions:
        "Local monitoring and control of an ISolar/EASUN SMG II hybrid inverter (SK-5500P-48L) " +
        "over Modbus RTU. Reads are always safe. Writes change battery and charging behaviour: " +
        "preview first, keep one change at a time, and read inverter://docs/control-contract before writing.",
    }
  );

  registerReadTools(server, ctx);
  registerStatsTools(server, ctx);
  registerControlTools(server, ctx);
  return server;
}
