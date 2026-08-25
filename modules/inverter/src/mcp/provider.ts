import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpSessionContext, ModuleMcpProvider } from "@sweethome/home-mcp";
import { INVERTER_INSTRUCTIONS, registerInverter } from "@sweethome/inverter-mcp";
import type { Inverter } from "../inverter";
import type { InverterConfig } from "../config";
import type { StatsRecorder } from "../stats/recorder";
import { createLocalGateway } from "./local-gateway";

const { version } = require("../../package.json") as { version: string };

export interface InverterMcpDeps {
  inverter: Inverter;
  cfg: InverterConfig;
  stats: StatsRecorder | null;
}

/**
 * Инструменты инвертора для общего сервера MCP дома.
 *
 * Шлюз создаётся на сессию, а не на процесс: набор инструментов зависит от прав
 * предъявленного токена. Ходить к себе по сети незачем — /mcp живёт в том же
 * процессе, что и Inverter, поэтому шлюз локальный, а гейты записи остаются
 * серверными (они внутри Inverter.control()/rawQuery()).
 */
export function createInverterMcpProvider(deps: InverterMcpDeps): ModuleMcpProvider {
  return {
    instructions: INVERTER_INSTRUCTIONS,
    register(server: McpServer, ctx: McpSessionContext) {
      const gateway = createLocalGateway(
        deps.inverter,
        deps.cfg,
        deps.stats,
        {
          role: ctx.role,
          scopes: ctx.scopes,
          allowControl: deps.cfg.allowControl,
          statsEnabled: deps.stats !== null,
        },
        ctx.source
      );
      const stopResources = registerInverter(server, { gateway, version });
      return () => {
        stopResources();
        gateway.close();
      };
    },
  };
}
