import { envBool, envInt } from "@sweethome/shared";

export interface Config {
  port: number;
  host: string;
  /** Корень данных; модули получают свои подкаталоги (data/<module id>). */
  dataDir: string;
  auth: { sessionTtlDays: number };
  /** Общий эндпоинт MCP для агентов (/mcp); инструменты приносят модули. */
  mcp: { enabled: boolean; maxSessions: number };
}

export function loadConfig(): Config {
  return {
    port: envInt("PORT", 3000),
    host: process.env.HOST || "0.0.0.0",
    dataDir: process.env.DATA_DIR || "data",
    auth: { sessionTtlDays: envInt("AUTH_SESSION_TTL_DAYS", 30) },
    mcp: {
      enabled: envBool("MCP_ENABLED", true),
      // Pi 3B — не сервер приложений: потолок низкий намеренно.
      maxSessions: envInt("MCP_MAX_SESSIONS", 8),
    },
  };
}
