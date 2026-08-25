import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpSessionContext, ModuleMcpProvider } from "./types";

/** Общая часть instructions: что это за сервер вообще. */
const BASE_INSTRUCTIONS =
  "Local, cloud-free home system on a Raspberry Pi. Each subsystem contributes its own tools; " +
  "everything runs on the home network and nothing leaves it.";

export interface HomeMcpOptions {
  providers: ModuleMcpProvider[];
  ctx: McpSessionContext;
  version: string;
  /** Имя сервера в ответе initialize; меняется только в тестах. */
  name?: string;
}

/**
 * Один сервер MCP на весь дом: инвертор, камеры и всё, что появится дальше,
 * складывают инструменты в него же. Собирается на сессию, а не на процесс —
 * набор инструментов зависит от прав предъявленного токена.
 */
export function buildHomeMcpServer(opts: HomeMcpOptions): McpServer {
  const { providers, ctx, version } = opts;

  const instructions = [BASE_INSTRUCTIONS, ...providers.map((p) => p.instructions).filter(Boolean)].join(
    "\n\n"
  );

  const server = new McpServer(
    { name: opts.name ?? "sweethome", version },
    {
      capabilities: {
        resources: { subscribe: true, listChanged: true },
        logging: {},
      },
      instructions,
    }
  );

  // Модуль мог завести живое: подписку на снапшоты, открытый шлюз. Снимаем это
  // при закрытии сессии — иначе слушатели переживут её и потекут.
  const cleanups: Array<() => void> = [];
  for (const p of providers) {
    const stop = p.register(server, ctx);
    if (stop) cleanups.push(stop);
  }

  const closeServer = server.close.bind(server);
  server.close = async () => {
    for (const stop of cleanups) {
      // Один упавший модуль не должен мешать закрыться остальным и самой сессии.
      try {
        stop();
      } catch (e) {
        console.warn(`[mcp] cleanup failed: ${(e as Error).message}`);
      }
    }
    await closeServer();
  };
  return server;
}
