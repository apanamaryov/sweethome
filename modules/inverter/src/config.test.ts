/**
 * Unit tests for loadInverterConfig() (modules/inverter/src/config.ts) — env
 * var parsing for everything the inverter module owns.
 *
 * Split off from the pre-extraction server/src/config.test.ts: port/host/auth
 * stayed with the host (server/src/config.test.ts); everything else — the
 * Modbus link, polling/timeouts, control gates, stats, mcp, mqtt — moved here
 * verbatim, plus a new case for how `dataDir` is now derived (composed from
 * the host's data root via `path.join(rootDataDir, "inverter")` instead of
 * read directly off DATA_DIR).
 *
 * How config.ts actually works (read from source, not assumed):
 *   - loadInverterConfig(rootDataDir) takes the host's already-resolved data
 *     root as a parameter — it never reads DATA_DIR itself; `dataDir` in the
 *     returned config is always `path.join(rootDataDir, "inverter")`.
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

import path from "path";
import { loadInverterConfig } from "./config";

const ORIGINAL_ENV = process.env;

beforeEach(() => {
  process.env = {};
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
});

describe("loadInverterConfig — defaults on empty env", () => {
  it("defaults the Modbus link fields (baud 9600, slave id 1, transport auto)", () => {
    const cfg = loadInverterConfig("data");

    expect(cfg.baudRate).toBe(9600);
    expect(cfg.slaveId).toBe(1);
    expect(cfg.transport).toBe("auto");
  });

  it("defaults every other top-level field", () => {
    const cfg = loadInverterConfig("data");

    expect(cfg.serialDevice).toBeNull();
    expect(cfg.pollIntervalMs).toBe(5000);
    expect(cfg.commandTimeoutMs).toBe(3000);
    expect(cfg.allowMock).toBe(true);
    expect(cfg.allowControl).toBe(true);
    expect(cfg.startupLocked).toBe(true);
    expect(cfg.autoRelock).toBe(true);
  });

  it("defaults the nested stats/mqtt groups", () => {
    const cfg = loadInverterConfig("data");

    expect(cfg.stats).toEqual({
      enabled: true,
      rawDays: 30,
      minuteDays: 730,
      solarThresholdW: 200,
      solarDwellMin: 15,
    });
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

describe("loadInverterConfig — dataDir composition", () => {
  it("joins the given root data dir with 'inverter'", () => {
    expect(loadInverterConfig("data").dataDir).toBe(path.join("data", "inverter"));
  });

  it("composes dataDir under whatever root data dir the host passes in", () => {
    expect(loadInverterConfig("/var/lib/inverter-monitor").dataDir).toBe(
      path.join("/var/lib/inverter-monitor", "inverter")
    );
  });
});

describe("loadInverterConfig — env overrides", () => {
  it("applies INVERTER_BAUD / MODBUS_SLAVE_ID / INVERTER_TRANSPORT from env", () => {
    process.env.INVERTER_BAUD = "19200";
    process.env.MODBUS_SLAVE_ID = "5";
    process.env.INVERTER_TRANSPORT = "serial";

    const cfg = loadInverterConfig("data");

    expect(cfg.baudRate).toBe(19200);
    expect(cfg.slaveId).toBe(5);
    expect(cfg.transport).toBe("serial");
  });

  it("lowercases INVERTER_TRANSPORT before validating it", () => {
    process.env.INVERTER_TRANSPORT = "MOCK";
    expect(loadInverterConfig("data").transport).toBe("mock");
  });

  it("falls back to auto for an unrecognized INVERTER_TRANSPORT value", () => {
    process.env.INVERTER_TRANSPORT = "carrier-pigeon";
    expect(loadInverterConfig("data").transport).toBe("auto");
  });

  it("falls back to the default integer when the env value does not parse as a number", () => {
    process.env.INVERTER_BAUD = "not-a-number";
    process.env.MODBUS_SLAVE_ID = "";
    const cfg = loadInverterConfig("data");

    expect(cfg.baudRate).toBe(9600);
    // MODBUS_SLAVE_ID="" is "set" (parseInt("") -> NaN, not finite) -> default
    expect(cfg.slaveId).toBe(1);
  });

  it("applies the INVERTER_SERIAL_DEVICE string override", () => {
    process.env.INVERTER_SERIAL_DEVICE = "/dev/ttyUSB0";

    const cfg = loadInverterConfig("data");

    expect(cfg.serialDevice).toBe("/dev/ttyUSB0");
  });

  it("applies MQTT overrides", () => {
    process.env.MQTT_URL = "mqtt://user:pass@broker:1883";
    process.env.MQTT_BASE_TOPIC = "custom/topic";
    process.env.MQTT_ENABLE_CONTROL = "true";

    const cfg = loadInverterConfig("data");

    expect(cfg.mqtt.url).toBe("mqtt://user:pass@broker:1883");
    expect(cfg.mqtt.baseTopic).toBe("custom/topic");
    expect(cfg.mqtt.enableControl).toBe(true);
  });
});

describe("loadInverterConfig — boolean flags (ALLOW_CONTROL / STARTUP_LOCKED / AUTO_RELOCK)", () => {
  it("default to true when unset", () => {
    const cfg = loadInverterConfig("data");

    expect(cfg.allowControl).toBe(true);
    expect(cfg.startupLocked).toBe(true);
    expect(cfg.autoRelock).toBe(true);
  });

  it.each(["true", "1", "yes", "on", "TRUE", "On"])("parse %j as true", (v) => {
    process.env.ALLOW_CONTROL = v;
    process.env.STARTUP_LOCKED = v;
    process.env.AUTO_RELOCK = v;

    const cfg = loadInverterConfig("data");

    expect(cfg.allowControl).toBe(true);
    expect(cfg.startupLocked).toBe(true);
    expect(cfg.autoRelock).toBe(true);
  });

  it.each(["false", "0", "no", "off", "banana", ""])("parse %j as false", (v) => {
    process.env.ALLOW_CONTROL = v;
    process.env.STARTUP_LOCKED = v;
    process.env.AUTO_RELOCK = v;

    const cfg = loadInverterConfig("data");

    expect(cfg.allowControl).toBe(false);
    expect(cfg.startupLocked).toBe(false);
    expect(cfg.autoRelock).toBe(false);
  });

  it("MQTT_ENABLE_CONTROL defaults to false (unlike the other three flags) and parses independently", () => {
    expect(loadInverterConfig("data").mqtt.enableControl).toBe(false);

    process.env.MQTT_ENABLE_CONTROL = "true";
    expect(loadInverterConfig("data").mqtt.enableControl).toBe(true);
  });
});
