import path from "path";
import { envBool, envInt } from "@sweethome/shared";

export type DryerTransport = "mqtt" | "mock";

export interface DryerConfig {
  enabled: boolean;
  transport: DryerTransport;
  mqttUrl: string;
  mqttUser: string | null;
  mqttPass: string | null;
  /** Префикс топиков без хвостового слэша (спека §5: `dryer`). */
  prefix: string;
  dataDir: string;
  /** Период тика модуля; 10 с в бою, меньше — только в тестах. */
  tickMs: number;
}

export function loadDryerConfig(rootDataDir: string, env: NodeJS.ProcessEnv = process.env): DryerConfig {
  const prev = process.env;
  process.env = env; // envInt/envBool читают process.env — подменяем на время разбора
  try {
    const transport = env.DRYER_TRANSPORT === "mock" ? "mock" : "mqtt";
    return {
      enabled: envBool("DRYER_ENABLED", true),
      transport,
      mqttUrl: env.DRYER_MQTT_URL || "mqtt://127.0.0.1:1883",
      mqttUser: env.DRYER_MQTT_USER || null,
      mqttPass: env.DRYER_MQTT_PASS || null,
      prefix: (env.DRYER_MQTT_PREFIX || "dryer").replace(/\/+$/, ""),
      dataDir: path.join(rootDataDir, "dryer"),
      tickMs: envInt("DRYER_TICK_MS", 10_000),
    };
  } finally {
    process.env = prev;
  }
}
