import path from "path";
import { envInt, envBool } from "@sweethome/shared";

export interface InverterConfig {
  transport: "auto" | "serial" | "mock";
  serialDevice: string | null;
  baudRate: number;
  /** Modbus slave id инвертора (настройка №25 в меню, по умолчанию 1). */
  slaveId: number;
  pollIntervalMs: number;
  commandTimeoutMs: number;
  allowMock: boolean;
  /** Пик PV-массива, Вт (для % выработки на карточке обзора); 0 = не задан. */
  pvPeakW: number;
  /** Master switch: when false, all setter/control commands are rejected. */
  allowControl: boolean;
  /** Start in read-only (locked) mode; writes require an explicit unlock. */
  startupLocked: boolean;
  /** Re-engage the lock automatically after each successful write. */
  autoRelock: boolean;
  /** Where to persist the settings baseline — the module's own subdirectory of the host's data root. */
  dataDir: string;
  /** Статистика/история в SQLite. */
  stats: {
    enabled: boolean;
    rawDays: number; //    retention сырых 5-сек снапшотов
    minuteDays: number; // retention поминутных агрегатов
    solarThresholdW: number; // порог PV (Вт) для окна солнечного дня
    solarDwellMin: number; //  устойчивость окна, мин
  };
  /** MQTT / Home Assistant integration. */
  mqtt: {
    url: string | null; // e.g. mqtt://user:pass@broker-host:1883 ; null disables MQTT
    username: string | null;
    password: string | null;
    baseTopic: string; // state/command topic root
    discoveryPrefix: string; // HA discovery prefix (default "homeassistant")
    nodeId: string; // stable device node id used in topics/unique_ids
    deviceName: string;
    enableControl: boolean; // expose HA select/number controls (bypass UI lock)
  };
}

export function loadInverterConfig(rootDataDir: string): InverterConfig {
  const transport = (process.env.INVERTER_TRANSPORT || "auto").toLowerCase();
  return {
    transport: (["auto", "serial", "mock"].includes(transport) ? transport : "auto") as InverterConfig["transport"],
    serialDevice: process.env.INVERTER_SERIAL_DEVICE || null,
    baudRate: envInt("INVERTER_BAUD", 9600),
    slaveId: envInt("MODBUS_SLAVE_ID", 1),
    pollIntervalMs: envInt("POLL_INTERVAL_MS", 5000),
    commandTimeoutMs: envInt("COMMAND_TIMEOUT_MS", 3000),
    allowMock: envBool("ALLOW_MOCK", true),
    pvPeakW: envInt("INVERTER_PV_PEAK_W", 0),
    allowControl: envBool("ALLOW_CONTROL", true),
    startupLocked: envBool("STARTUP_LOCKED", true),
    autoRelock: envBool("AUTO_RELOCK", true),
    dataDir: path.join(rootDataDir, "inverter"),
    stats: {
      enabled: envBool("STATS_ENABLED", true),
      rawDays: envInt("STATS_RAW_DAYS", 30),
      minuteDays: envInt("STATS_MINUTE_DAYS", 730),
      solarThresholdW: envInt("STATS_SOLAR_THRESHOLD_W", 200),
      solarDwellMin: envInt("STATS_SOLAR_DWELL_MIN", 15),
    },
    mqtt: {
      url: process.env.MQTT_URL || null,
      username: process.env.MQTT_USERNAME || null,
      password: process.env.MQTT_PASSWORD || null,
      baseTopic: process.env.MQTT_BASE_TOPIC || "inverter",
      discoveryPrefix: process.env.MQTT_DISCOVERY_PREFIX || "homeassistant",
      nodeId: process.env.MQTT_NODE_ID || "sk5500p48l",
      deviceName: process.env.MQTT_DEVICE_NAME || "Inverter SK-5500P-48L",
      enableControl: envBool("MQTT_ENABLE_CONTROL", false),
    },
  };
}
