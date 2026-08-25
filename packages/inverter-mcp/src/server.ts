import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { InverterGateway } from "./gateway/types";
import { registerReadTools } from "./tools/read";
import { registerStatsTools } from "./tools/stats";
import { registerControlTools } from "./tools/control";
import { registerResources } from "./resources";
import { registerPrompts } from "./prompts";
import { createLogger } from "./logging";

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

/** Что агент должен знать про инвертор до первого вызова. */
export const INVERTER_INSTRUCTIONS =
  "Inverter: monitoring and control of an ISolar/EASUN SMG II hybrid inverter (SK-5500P-48L) " +
  "over Modbus RTU. Reads are always safe. Writes change battery and charging behaviour: " +
  "preview first, keep one change at a time, and read inverter://docs/control-contract before writing.";

/**
 * Инструменты, подсказки и ресурсы инвертора в уже готовом сервере MCP.
 * Возвращает очистку: ресурсы держат подписку на снапшоты, и она обязана
 * сниматься вместе с сессией.
 *
 * Отдельно от buildMcpServer, потому что сервером владеет либо stdio-бинарник
 * (там инвертор один), либо хост (там он сосед камер и всего остального).
 */
export function registerInverter(server: McpServer, ctx: McpContext): () => void {
  const logger = createLogger(server);
  registerReadTools(server, ctx, logger);
  registerStatsTools(server, ctx, logger);
  registerControlTools(server, ctx, logger);
  registerPrompts(server, ctx);
  return registerResources(server, ctx);
}

/** Сервер только с инвертором — для stdio-бинарника. */
export function buildMcpServer(ctx: McpContext): McpServer {
  const server = new McpServer(
    { name: "inverter-monitor", version: ctx.version },
    {
      capabilities: {
        resources: { subscribe: true, listChanged: true },
        logging: {},
      },
      instructions: INVERTER_INSTRUCTIONS,
    }
  );

  // Подписки держат слушателя у шлюза — снимаем его при закрытии сервера.
  const stopResources = registerInverter(server, ctx);
  const closeServer = server.close.bind(server);
  server.close = async () => {
    stopResources();
    await closeServer();
  };
  return server;
}
