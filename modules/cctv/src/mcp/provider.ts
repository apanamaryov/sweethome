import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ModuleMcpProvider } from "@sweethome/home-mcp";
import { CCTV_INSTRUCTIONS, registerCctvTools, type CctvMcpDeps } from "./tools";

/**
 * Инструменты камер для общего сервера MCP дома.
 *
 * Прав сессии не смотрим намеренно: здесь всё только читается, а смотреть и
 * перематывать архив разрешено и viewer'у — ровно как на страницах (спека §13).
 */
export function createCctvMcpProvider(deps: CctvMcpDeps): ModuleMcpProvider {
  return {
    instructions: CCTV_INSTRUCTIONS,
    register(server: McpServer) {
      registerCctvTools(server, deps);
    },
  };
}
