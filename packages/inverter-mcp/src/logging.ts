import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export interface Logger {
  info(logger: string, data: unknown): void;
  error(logger: string, data: unknown): void;
}

/**
 * Логирование в клиента. Отправка «в никуда» (клиент не запросил уровень или уже
 * отключился) не должна ронять инструмент — все ошибки глотаем.
 */
export function createLogger(server: McpServer): Logger {
  const send = (level: "info" | "error", logger: string, data: unknown) => {
    void server.server.sendLoggingMessage({ level, logger, data }).catch(() => undefined);
  };
  return {
    info: (logger, data) => send("info", logger, data),
    error: (logger, data) => send("error", logger, data),
  };
}

/** Логгер-пустышка: удобно в тестах и когда логирование не подключено. */
export const NOOP_LOGGER: Logger = { info: () => undefined, error: () => undefined };
