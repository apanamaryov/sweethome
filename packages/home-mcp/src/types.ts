import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Role, TokenScope } from "@sweethome/shared";

/**
 * Кто пришёл в сессию MCP. Считается один раз при её открытии: набор
 * инструментов зависит от прав предъявленного токена, а не от каждого вызова.
 */
export interface McpSessionContext {
  role: Role;
  scopes: TokenScope[];
  username: string;
  /** Кто именно пишет — в журнал модуля: `ui:alex` или `token:laptop`. */
  source: string;
}

/** Что модуль отдаёт общему серверу MCP. */
export interface ModuleMcpProvider {
  /**
   * Строка-другая в instructions сервера: что этот модуль умеет и чего нельзя.
   * Агент читает их до первого вызова, поэтому здесь место предупреждениям.
   */
  instructions?: string;
  /**
   * Регистрирует инструменты, ресурсы и подсказки модуля в сессии.
   * Возвращает очистку, если модуль завёл что-то живое (подписку, шлюз).
   */
  register(server: McpServer, ctx: McpSessionContext): (() => void) | void;
}

/**
 * Модуль дома, который умеет в MCP. Хост собирает из таких один сервер, поэтому
 * модулю не нужно ни монтировать свой эндпоинт, ни знать про сессии и транспорт.
 */
export interface McpCapable {
  mcp: ModuleMcpProvider;
}

export function isMcpCapable<T extends object>(module: T): module is T & McpCapable {
  const mcp = (module as Partial<McpCapable>).mcp;
  return !!mcp && typeof mcp.register === "function";
}
