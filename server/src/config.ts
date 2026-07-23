export interface Config {
  port: number;
  host: string;
  transport: "auto" | "serial" | "mock";
  serialDevice: string | null;
  baudRate: number;
  /** Modbus slave id инвертора (настройка №25 в меню, по умолчанию 1). */
  slaveId: number;
  pollIntervalMs: number;
  commandTimeoutMs: number;
  allowMock: boolean;
  /** Master switch: when false, all setter/control commands are rejected. */
  allowControl: boolean;
  /** Start in read-only (locked) mode; writes require an explicit unlock. */
  startupLocked: boolean;
  /** Re-engage the lock automatically after each successful write. */
  autoRelock: boolean;
  /** Where to persist the settings baseline. */
  dataDir: string;
  /** Web/API authentication. */
  auth: {
    password: string | null; // null = auth disabled (open LAN mode)
    sessionTtlDays: number;
  };
  /** MQTT / Home Assistant integration. */
  mqtt: {
    url: string | null; // e.g. mqtt://user:pass@192.168.1.112:1883 ; null disables MQTT
    username: string | null;
    password: string | null;
    baseTopic: string; // state/command topic root
    discoveryPrefix: string; // HA discovery prefix (default "homeassistant")
    nodeId: string; // stable device node id used in topics/unique_ids
    deviceName: string;
    enableControl: boolean; // expose HA select/number controls (bypass UI lock)
  };
}

function envInt(name: string, def: number): number {
  const v = process.env[name];
  if (v === undefined) return def;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

function envBool(name: string, def: boolean): boolean {
  const v = process.env[name];
  if (v === undefined) return def;
  return /^(1|true|yes|on)$/i.test(v);
}

export function loadConfig(): Config {
  const transport = (process.env.INVERTER_TRANSPORT || "auto").toLowerCase();
  return {
    port: envInt("PORT", 3000),
    host: process.env.HOST || "0.0.0.0",
    transport: (["auto", "serial", "mock"].includes(transport) ? transport : "auto") as Config["transport"],
    serialDevice: process.env.INVERTER_SERIAL_DEVICE || null,
    baudRate: envInt("INVERTER_BAUD", 9600),
    slaveId: envInt("MODBUS_SLAVE_ID", 1),
    pollIntervalMs: envInt("POLL_INTERVAL_MS", 5000),
    commandTimeoutMs: envInt("COMMAND_TIMEOUT_MS", 3000),
    allowMock: envBool("ALLOW_MOCK", true),
    allowControl: envBool("ALLOW_CONTROL", true),
    startupLocked: envBool("STARTUP_LOCKED", true),
    autoRelock: envBool("AUTO_RELOCK", true),
    dataDir: process.env.DATA_DIR || "data",
    auth: {
      password: process.env.AUTH_PASSWORD || null,
      sessionTtlDays: envInt("AUTH_SESSION_TTL_DAYS", 30),
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
