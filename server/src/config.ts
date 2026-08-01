import { envInt } from "@sweethome/shared";

export interface Config {
  port: number;
  host: string;
  /** Корень данных; модули получают свои подкаталоги (data/<module id>). */
  dataDir: string;
  auth: { sessionTtlDays: number };
}

export function loadConfig(): Config {
  return {
    port: envInt("PORT", 3000),
    host: process.env.HOST || "0.0.0.0",
    dataDir: process.env.DATA_DIR || "data",
    auth: { sessionTtlDays: envInt("AUTH_SESSION_TTL_DAYS", 30) },
  };
}
