/**
 * Unit tests for loadConfig() (server/src/config.ts) — env var parsing.
 *
 * How config.ts actually works (read from source, not assumed):
 *   - loadConfig() is the ONLY place in the codebase that reads process.env;
 *     it returns a fully-populated Config snapshot, never touching env again
 *     after that point (detect.ts etc. just consume the returned object).
 *   - envInt(name, def): process.env[name] undefined -> def; otherwise
 *     parseInt(v, 10), falling back to def if the result isn't finite (NaN).
 *   - envBool(name, def): process.env[name] undefined -> def; otherwise the
 *     regex /^(1|true|yes|on)$/i is tested against the raw string — note this
 *     means an env var that IS set but doesn't match (e.g. "false", "0",
 *     "banana", "") resolves to `false`, not to `def`. Only "unset" falls
 *     back to the default.
 *   - INVERTER_TRANSPORT is lowercased, then validated against
 *     ["auto","serial","mock"]; anything else (including unset) becomes
 *     "auto".
 *
 * Every test controls process.env directly (saved/restored around each
 * test) so this file is immune to whatever happens to be set in the real
 * shell/CI environment, and never leaks env vars to other test files.
 */

import { loadConfig } from "./config";

const ORIGINAL_ENV = process.env;

beforeEach(() => {
  process.env = {};
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
});

describe("loadConfig — defaults on empty env", () => {
  it("defaults the Modbus link fields (baud 9600, slave id 1, transport auto)", () => {
    const cfg = loadConfig();

    expect(cfg.baudRate).toBe(9600);
    expect(cfg.slaveId).toBe(1);
    expect(cfg.transport).toBe("auto");
  });

  it("defaults every other top-level field", () => {
    const cfg = loadConfig();

    expect(cfg.port).toBe(3000);
    expect(cfg.host).toBe("0.0.0.0");
    expect(cfg.serialDevice).toBeNull();
    expect(cfg.pollIntervalMs).toBe(5000);
    expect(cfg.commandTimeoutMs).toBe(3000);
    expect(cfg.allowMock).toBe(true);
    expect(cfg.allowControl).toBe(true);
    expect(cfg.startupLocked).toBe(true);
    expect(cfg.autoRelock).toBe(true);
    expect(cfg.dataDir).toBe("data");
  });

  it("defaults the nested stats/auth/mqtt groups", () => {
    const cfg = loadConfig();

    expect(cfg.stats).toEqual({
      enabled: true,
      rawDays: 30,
      minuteDays: 730,
      solarThresholdW: 200,
      solarDwellMin: 15,
    });
    expect(cfg.auth).toEqual({ sessionTtlDays: 30 });
    expect(cfg.mqtt).toEqual({
      url: null,
      username: null,
      password: null,
      baseTopic: "inverter",
      discoveryPrefix: "homeassistant",
      nodeId: "sk5500p48l",
      deviceName: "Inverter SK-5500P-48L",
      enableControl: false,
    });
  });
});

describe("loadConfig — env overrides", () => {
  it("applies INVERTER_BAUD / MODBUS_SLAVE_ID / INVERTER_TRANSPORT from env", () => {
    process.env.INVERTER_BAUD = "19200";
    process.env.MODBUS_SLAVE_ID = "5";
    process.env.INVERTER_TRANSPORT = "serial";

    const cfg = loadConfig();

    expect(cfg.baudRate).toBe(19200);
    expect(cfg.slaveId).toBe(5);
    expect(cfg.transport).toBe("serial");
  });

  it("lowercases INVERTER_TRANSPORT before validating it", () => {
    process.env.INVERTER_TRANSPORT = "MOCK";
    expect(loadConfig().transport).toBe("mock");
  });

  it("falls back to auto for an unrecognized INVERTER_TRANSPORT value", () => {
    process.env.INVERTER_TRANSPORT = "carrier-pigeon";
    expect(loadConfig().transport).toBe("auto");
  });

  it("falls back to the default integer when the env value does not parse as a number", () => {
    process.env.INVERTER_BAUD = "not-a-number";
    process.env.MODBUS_SLAVE_ID = "";
    const cfg = loadConfig();

    expect(cfg.baudRate).toBe(9600);
    // MODBUS_SLAVE_ID="" is "set" (parseInt("") -> NaN, not finite) -> default
    expect(cfg.slaveId).toBe(1);
  });

  it("applies INVERTER_SERIAL_DEVICE and DATA_DIR string overrides", () => {
    process.env.INVERTER_SERIAL_DEVICE = "/dev/ttyUSB0";
    process.env.DATA_DIR = "/var/lib/inverter";

    const cfg = loadConfig();

    expect(cfg.serialDevice).toBe("/dev/ttyUSB0");
    expect(cfg.dataDir).toBe("/var/lib/inverter");
  });

  it("applies MQTT overrides", () => {
    process.env.MQTT_URL = "mqtt://user:pass@broker:1883";
    process.env.MQTT_BASE_TOPIC = "custom/topic";
    process.env.MQTT_ENABLE_CONTROL = "true";

    const cfg = loadConfig();

    expect(cfg.mqtt.url).toBe("mqtt://user:pass@broker:1883");
    expect(cfg.mqtt.baseTopic).toBe("custom/topic");
    expect(cfg.mqtt.enableControl).toBe(true);
  });
});

describe("loadConfig — boolean flags (ALLOW_CONTROL / STARTUP_LOCKED / AUTO_RELOCK)", () => {
  it("default to true when unset", () => {
    const cfg = loadConfig();

    expect(cfg.allowControl).toBe(true);
    expect(cfg.startupLocked).toBe(true);
    expect(cfg.autoRelock).toBe(true);
  });

  it.each(["true", "1", "yes", "on", "TRUE", "On"])("parse %j as true", (v) => {
    process.env.ALLOW_CONTROL = v;
    process.env.STARTUP_LOCKED = v;
    process.env.AUTO_RELOCK = v;

    const cfg = loadConfig();

    expect(cfg.allowControl).toBe(true);
    expect(cfg.startupLocked).toBe(true);
    expect(cfg.autoRelock).toBe(true);
  });

  it.each(["false", "0", "no", "off", "banana", ""])("parse %j as false", (v) => {
    process.env.ALLOW_CONTROL = v;
    process.env.STARTUP_LOCKED = v;
    process.env.AUTO_RELOCK = v;

    const cfg = loadConfig();

    expect(cfg.allowControl).toBe(false);
    expect(cfg.startupLocked).toBe(false);
    expect(cfg.autoRelock).toBe(false);
  });

  it("MQTT_ENABLE_CONTROL defaults to false (unlike the other three flags) and parses independently", () => {
    expect(loadConfig().mqtt.enableControl).toBe(false);

    process.env.MQTT_ENABLE_CONTROL = "true";
    expect(loadConfig().mqtt.enableControl).toBe(true);
  });
});
