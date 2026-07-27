/**
 * Unit tests for HaMqtt (server/src/mqtt.ts) — MQTT state publish, Home
 * Assistant autodiscovery, and the MQTT control gate.
 *
 * How mqtt.ts actually works (read from source, not assumed):
 *   - `new HaMqtt(cfg, inverter).start()`: if `cfg.mqtt.url` is falsy, it logs
 *     "MQTT disabled" and returns WITHOUT ever `require("mqtt")`-ing,
 *     calling `mqtt.connect()`, or subscribing to the inverter's "snapshot"
 *     event — the whole module stays inert.
 *   - Otherwise it lazily `require("mqtt")`s (never a top-level `import`,
 *     always a plain CommonJS `require` call inside `start()`) and calls
 *     `mqtt.connect(url, opts)`, keeping the returned client on
 *     `this.client`. `jest.mock("mqtt", factory)` intercepts this exactly
 *     the way transport/serial.test.ts and transport/detect.test.ts
 *     intercept `require("serialport")`.
 *   - On the client's "connect" event it: publishes "online" (retained) to
 *     the availability topic, calls `publishDiscovery()` (one retained HA
 *     config topic per sensor/binary_sensor/select), subscribes to
 *     `${cmdRoot}/#` ONLY when `cfg.mqtt.enableControl` is true, then
 *     publishes the current `inverter.getSnapshot()` to the state topic.
 *   - `publishState()` is a no-op unless `this.client.connected` is true
 *     (`if (!this.client || !this.client.connected) return;`) — real
 *     mqtt.js sets `.connected = true` once the transport is up, so the
 *     fake client must mirror that or every publish after "connect" would
 *     silently no-op.
 *   - It also does `this.inverter.on("snapshot", (snap) => this.publishState(snap))`,
 *     so every inverter snapshot re-publishes state (again gated on
 *     `client.connected`).
 *   - HA discovery: the 4 whitelisted SETTINGS are published as HA "select"
 *     entities (with a `command_topic`) when `enableControl` is true, or as
 *     read-only "sensor" entities (no `command_topic`) when false — this is
 *     the literal HA-facing manifestation of the MQTT control gate.
 *   - Control gate: incoming client "message" events go through
 *     `onCommand()`, which returns immediately (never calling
 *     `inverter.control`) unless `cfg.mqtt.enableControl` is true. When
 *     enabled, it maps the topic's trailing segment to a SETTINGS entry,
 *     decodes the payload (a label -> numeric code for the two priority
 *     selects, `Number(value)` for the two current selects), and calls
 *     `inverter.control(type, value, { bypassLock: true, source: "mqtt" })` —
 *     `bypassLock: true` is the deliberate, hard-coded authorization for the
 *     MQTT path; it never reads or toggles the UI lock.
 *   - Because `onCommand` is an `async` function, the call to
 *     `inverter.control(...)` happens synchronously (a function call always
 *     runs before its own first `await` suspends), so assertions on the
 *     `control` mock can run immediately after `client.emit("message", ...)`
 *     with no extra flush/await needed.
 */

import { EventEmitter } from "events";
import {
  Snapshot,
  InverterStatus,
  InverterRatedInfo,
  OUTPUT_SOURCE_PRIORITY,
  CHARGER_SOURCE_PRIORITY,
} from "@inverter/shared";
import { Config } from "./config";
import { Inverter } from "./inverter";

jest.mock("mqtt", () => ({ connect: jest.fn() }));

import { HaMqtt } from "./mqtt";

const mqttMock = jest.requireMock("mqtt") as { connect: jest.Mock };

/** A fake mqtt.js client: EventEmitter + the surface HaMqtt actually touches. */
function fakeMqttClient() {
  const client = new EventEmitter() as EventEmitter & {
    publish: jest.Mock;
    subscribe: jest.Mock;
    end: jest.Mock;
    connected: boolean;
  };
  client.publish = jest.fn();
  client.subscribe = jest.fn();
  client.end = jest.fn();
  client.connected = false; // real mqtt.js clients flip this true once transport is up
  return client;
}

/** A fake "Inverter": EventEmitter + spies on the methods HaMqtt calls
 * (getSnapshot/control), plus rawQuery — HaMqtt never calls rawQuery, kept
 * here only to prove the control-gate tests don't accidentally reach it. */
function fakeInverter(snapshot: Snapshot) {
  const emitter = new EventEmitter() as EventEmitter & {
    getSnapshot: jest.Mock;
    control: jest.Mock;
    rawQuery: jest.Mock;
  };
  emitter.getSnapshot = jest.fn(() => snapshot);
  emitter.control = jest.fn().mockResolvedValue({ ok: true, command: "cmd", reply: "ACK" });
  emitter.rawQuery = jest.fn();
  return emitter;
}

/** A complete, valid Config; only cfg.mqtt varies test to test in this file. */
function baseConfig(mqttOverrides: Partial<Config["mqtt"]> = {}): Config {
  return {
    port: 3000,
    host: "0.0.0.0",
    transport: "mock",
    serialDevice: null,
    baudRate: 9600,
    slaveId: 1,
    pollIntervalMs: 5000,
    commandTimeoutMs: 3000,
    allowMock: true,
    allowControl: true,
    startupLocked: true,
    autoRelock: true,
    dataDir: "data",
    stats: { enabled: true, rawDays: 30, minuteDays: 730, solarThresholdW: 200, solarDwellMin: 15 },
    auth: { sessionTtlDays: 30 },
    mcp: { enabled: false, maxSessions: 8 },
    mqtt: {
      url: "mqtt://broker:1883",
      username: null,
      password: null,
      baseTopic: "inverter",
      discoveryPrefix: "homeassistant",
      nodeId: "test-node",
      deviceName: "Test Inverter",
      enableControl: false,
      ...mqttOverrides,
    },
  };
}

function fullStatus(over: Partial<InverterStatus> = {}): InverterStatus {
  return {
    gridVoltage: 0,
    gridFrequency: 0,
    mainsPower: 0,
    inverterPower: 0,
    acOutputVoltage: 0,
    acOutputFrequency: 0,
    acOutputActivePower: 0,
    acOutputApparentPower: 0,
    outputLoadPercent: 0,
    batteryVoltage: 0,
    batteryPower: 0,
    batteryChargingCurrent: 0,
    batteryDischargeCurrent: 0,
    batteryCapacity: 0,
    pvInputVoltage: 0,
    pvInputCurrent: 0,
    pvPower: 0,
    pvChargingPower: 0,
    dcdcTemperature: 0,
    heatSinkTemperature: 0,
    raw: "",
    ...over,
  };
}

function fullInfo(over: Partial<InverterRatedInfo> = {}): InverterRatedInfo {
  return {
    outputMode: 0,
    outputSourcePriority: 0,
    inputVoltageRange: 0,
    buzzerMode: 0,
    lcdBacklight: 0,
    acOutputRatingVoltage: 0,
    acOutputRatingFrequency: 0,
    batteryType: 0,
    batteryOverVoltage: 0,
    batteryBulkVoltage: 0,
    batteryFloatVoltage: 0,
    batteryRedischargeVoltage: 0,
    batteryRechargeVoltage: 0,
    batteryUnderVoltage: 0,
    chargerSourcePriority: 0,
    maxChargingCurrent: 0,
    maxAcChargingCurrent: 0,
    eqChargingVoltage: 0,
    socBackToUtility: 0,
    socBackToBattery: 0,
    socLowCutoff: 0,
    acOutputRatingActivePower: 0,
    raw: "",
    ...over,
  };
}

/** A complete, connected Snapshot with overridable status/info/mode/warnings/locked. */
function makeSnapshot(
  opts: {
    status?: Partial<InverterStatus>;
    info?: Partial<InverterRatedInfo>;
    mode?: Snapshot["mode"];
    warnings?: string[];
    connected?: boolean;
    locked?: boolean;
  } = {}
): Snapshot {
  const connected = opts.connected ?? true;
  return {
    timestamp: 1_000,
    connection: { connected, transport: "mock", device: null, deviceId: "dev-1", mock: true, lastError: null },
    control: { allowControl: true, locked: opts.locked ?? false },
    mode: opts.mode ?? "Battery",
    status: fullStatus(opts.status),
    info: fullInfo(opts.info),
    flags: null,
    warnings: { active: opts.warnings ?? [], raw: "" },
    baseline: null,
  };
}

/** Starts HaMqtt against a fresh fake client and drives it through "connect"
 * (marking the client as connected first, mirroring real mqtt.js). This is
 * what fires the availability publish, HA discovery, and the initial state
 * publish from inverter.getSnapshot(). */
function startConnected(cfg: Config, inverter: ReturnType<typeof fakeInverter>) {
  const haMqtt = new HaMqtt(cfg, inverter as unknown as Inverter);
  const client = fakeMqttClient();
  mqttMock.connect.mockReturnValue(client);
  haMqtt.start();
  client.connected = true;
  client.emit("connect");
  return { haMqtt, client };
}

describe("HaMqtt — disabled when MQTT_URL is empty", () => {
  it("never connects to mqtt and never subscribes to inverter snapshots", () => {
    const cfg = baseConfig({ url: null });
    const inverter = fakeInverter(makeSnapshot());
    const haMqtt = new HaMqtt(cfg, inverter as unknown as Inverter);

    haMqtt.start();

    expect(mqttMock.connect).not.toHaveBeenCalled();
    expect(inverter.listenerCount("snapshot")).toBe(0);

    // Confirm this is truly inert (no client at all), not just "nothing
    // asserted yet": emitting a snapshot must be a silent no-op.
    expect(() => inverter.emit("snapshot", makeSnapshot())).not.toThrow();
  });
});

describe("HaMqtt — connects and publishes state to the correct topics", () => {
  it("calls mqtt.connect with the configured URL and a last-will on the availability topic", () => {
    const cfg = baseConfig({ url: "mqtt://broker:1883", baseTopic: "inverter", nodeId: "test-node" });
    const inverter = fakeInverter(makeSnapshot());
    const haMqtt = new HaMqtt(cfg, inverter as unknown as Inverter);
    mqttMock.connect.mockReturnValue(fakeMqttClient());

    haMqtt.start();

    expect(mqttMock.connect).toHaveBeenCalledWith(
      "mqtt://broker:1883",
      expect.objectContaining({
        will: { topic: "inverter/test-node/availability", payload: "offline", qos: 1, retain: true },
        reconnectPeriod: 5000,
      })
    );
  });

  it("publishes 'online' (retained) and the initial snapshot to state on connect", () => {
    const cfg = baseConfig({ baseTopic: "inverter", nodeId: "test-node" });
    const inverter = fakeInverter(makeSnapshot({ status: { pvPower: 111 } }));

    const { client } = startConnected(cfg, inverter);

    expect(client.publish).toHaveBeenCalledWith("inverter/test-node/availability", "online", {
      qos: 1,
      retain: true,
    });

    const stateCall = client.publish.mock.calls.find(([topic]) => topic === "inverter/test-node/state");
    expect(stateCall).toBeDefined();
    expect(JSON.parse(stateCall![1])).toEqual(expect.objectContaining({ pv_w: 111 }));
    expect(stateCall![2]).toEqual({ qos: 0, retain: true });
  });

  it("re-publishes state to the same topic whenever the inverter emits a new snapshot", () => {
    const cfg = baseConfig({ baseTopic: "inverter", nodeId: "test-node" });
    const inverter = fakeInverter(makeSnapshot());
    const { client } = startConnected(cfg, inverter);
    client.publish.mockClear(); // isolate from the connect-time availability/discovery/initial-state noise

    inverter.emit(
      "snapshot",
      makeSnapshot({
        status: { pvPower: 555, batteryCapacity: 42 },
        mode: "Line",
        warnings: ["Battery over voltage"],
        connected: true,
        locked: true,
        info: { outputSourcePriority: 1, chargerSourcePriority: 2, maxChargingCurrent: 30, maxAcChargingCurrent: 20 },
      })
    );

    expect(client.publish).toHaveBeenCalledTimes(1);
    const [topic, payloadStr, opts] = client.publish.mock.calls[0];
    expect(topic).toBe("inverter/test-node/state");
    expect(opts).toEqual({ qos: 0, retain: true });
    expect(JSON.parse(payloadStr)).toEqual(
      expect.objectContaining({
        pv_w: 555,
        soc: 42,
        mode: "Line",
        warnings: "Battery over voltage",
        problem: "ON",
        connected: "ON",
        locked: "ON",
        outputSourcePriority: 1,
        outputSourcePriority_label: OUTPUT_SOURCE_PRIORITY[1],
        chargerSourcePriority: 2,
        chargerSourcePriority_label: CHARGER_SOURCE_PRIORITY[2],
        maxChargingCurrent: 30,
        maxChargingCurrent_label: "30",
        maxAcChargingCurrent: 20,
        maxAcChargingCurrent_label: "20",
      })
    );
  });

  it("does not publish state while the client has not (yet) reported connected", () => {
    const cfg = baseConfig({ baseTopic: "inverter", nodeId: "test-node" });
    const inverter = fakeInverter(makeSnapshot());
    const haMqtt = new HaMqtt(cfg, inverter as unknown as Inverter);
    const client = fakeMqttClient(); // connected stays false; "connect" is never emitted
    mqttMock.connect.mockReturnValue(client);
    haMqtt.start();

    inverter.emit("snapshot", makeSnapshot({ status: { pvPower: 999 } }));

    expect(client.publish).not.toHaveBeenCalled();
  });
});

describe("HaMqtt — Home Assistant autodiscovery", () => {
  function configTopics(client: ReturnType<typeof fakeMqttClient>) {
    return client.publish.mock.calls.filter(([topic]) => (topic as string).endsWith("/config"));
  }

  it("publishes one retained config topic per sensor/binary_sensor, and settings as read-only sensors when control is disabled", () => {
    const cfg = baseConfig({ enableControl: false });
    const inverter = fakeInverter(makeSnapshot());
    const { client } = startConnected(cfg, inverter);

    const configs = configTopics(client);
    // 17 telemetry sensors + 3 binary_sensor (connected/problem/locked) + 4 settings-as-sensor.
    expect(configs).toHaveLength(24);

    const pvCall = configs.find(([topic]) => topic === "homeassistant/sensor/test-node/pv_w/config")!;
    expect(pvCall).toBeDefined();
    expect(JSON.parse(pvCall[1])).toEqual(
      expect.objectContaining({
        name: "PV мощность",
        unique_id: "test-node_pv_w",
        state_topic: "inverter/test-node/state",
        value_template: "{{ value_json.pv_w }}",
        unit_of_measurement: "W",
        device_class: "power",
        state_class: "measurement",
        device: {
          identifiers: ["test-node"],
          name: "Test Inverter",
          manufacturer: "ISolar / EASUN (SMG II)",
          model: "SK-5500P-48L",
          sw_version: "inverter-monitor",
        },
      })
    );
    expect(pvCall[2]).toEqual({ qos: 1, retain: true });

    const lockedCall = configs.find(([topic]) => topic === "homeassistant/binary_sensor/test-node/locked/config")!;
    const lockedPayload = JSON.parse(lockedCall[1]);
    expect(lockedPayload.device_class).toBeUndefined(); // HA's "lock" class would invert ON/OFF semantics
    expect(lockedPayload.icon).toBe("mdi:lock");

    const settingCall = configs.find(
      ([topic]) => topic === "homeassistant/sensor/test-node/maxChargingCurrent/config"
    )!;
    const settingPayload = JSON.parse(settingCall[1]);
    expect(settingPayload.command_topic).toBeUndefined();
    expect(settingPayload.value_template).toBe("{{ value_json.maxChargingCurrent_label }}");

    expect(client.subscribe).not.toHaveBeenCalled();
  });

  it("publishes settings as writable HA selects and subscribes to the command root when control is enabled", () => {
    const cfg = baseConfig({ enableControl: true });
    const inverter = fakeInverter(makeSnapshot());
    const { client } = startConnected(cfg, inverter);

    const configs = configTopics(client);
    expect(configs).toHaveLength(24); // same total; settings are "select" instead of "sensor"

    const selectCall = configs.find(
      ([topic]) => topic === "homeassistant/select/test-node/outputSourcePriority/config"
    )!;
    expect(selectCall).toBeDefined();
    const payload = JSON.parse(selectCall[1]);
    expect(payload.command_topic).toBe("inverter/test-node/set/outputSourcePriority");
    expect(payload.options).toEqual(Object.values(OUTPUT_SOURCE_PRIORITY));

    // The plain read-only sensor form must not also be published for this setting.
    expect(configs.some(([topic]) => topic === "homeassistant/sensor/test-node/outputSourcePriority/config")).toBe(
      false
    );

    expect(client.subscribe).toHaveBeenCalledWith("inverter/test-node/set/#", { qos: 1 });
  });
});

describe("HaMqtt — MQTT control gate (MQTT_ENABLE_CONTROL)", () => {
  function startAndGetClient(cfg: Config, inverter: ReturnType<typeof fakeInverter>) {
    const haMqtt = new HaMqtt(cfg, inverter as unknown as Inverter);
    const client = fakeMqttClient();
    mqttMock.connect.mockReturnValue(client);
    haMqtt.start();
    return { haMqtt, client };
  }

  it("ignores an incoming control message when MQTT_ENABLE_CONTROL=false (no inverter.control call)", () => {
    const cfg = baseConfig({ enableControl: false });
    const inverter = fakeInverter(makeSnapshot());
    const { client } = startAndGetClient(cfg, inverter);

    client.emit("message", "inverter/test-node/set/maxChargingCurrent", Buffer.from("30"));

    expect(inverter.control).not.toHaveBeenCalled();
    expect(inverter.rawQuery).not.toHaveBeenCalled();
  });

  it("applies an incoming control message via inverter.control(type, value, { bypassLock: true }) when enabled", () => {
    const cfg = baseConfig({ enableControl: true });
    const inverter = fakeInverter(makeSnapshot());
    const { client } = startAndGetClient(cfg, inverter);

    client.emit("message", "inverter/test-node/set/maxChargingCurrent", Buffer.from("30"));

    expect(inverter.control).toHaveBeenCalledWith("maxChargingCurrent", 30, { bypassLock: true, source: "mqtt" });
    expect(inverter.rawQuery).not.toHaveBeenCalled();
  });

  it("maps an HA select's label payload back to its numeric code for priority settings", () => {
    const cfg = baseConfig({ enableControl: true });
    const inverter = fakeInverter(makeSnapshot());
    const { client } = startAndGetClient(cfg, inverter);

    client.emit("message", "inverter/test-node/set/outputSourcePriority", Buffer.from(OUTPUT_SOURCE_PRIORITY[1]));

    expect(inverter.control).toHaveBeenCalledWith("outputSourcePriority", 1, { bypassLock: true, source: "mqtt" });
  });

  it("ignores a message for a setting key outside the whitelist, even when control is enabled", () => {
    const cfg = baseConfig({ enableControl: true });
    const inverter = fakeInverter(makeSnapshot());
    const { client } = startAndGetClient(cfg, inverter);

    client.emit("message", "inverter/test-node/set/bogusSetting", Buffer.from("1"));

    expect(inverter.control).not.toHaveBeenCalled();
  });

  it("ignores a message whose value does not parse to a finite number, even when control is enabled", () => {
    const cfg = baseConfig({ enableControl: true });
    const inverter = fakeInverter(makeSnapshot());
    const { client } = startAndGetClient(cfg, inverter);

    client.emit("message", "inverter/test-node/set/maxChargingCurrent", Buffer.from("not-a-number"));

    expect(inverter.control).not.toHaveBeenCalled();
  });
});
