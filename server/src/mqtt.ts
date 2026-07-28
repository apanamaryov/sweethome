import { Config } from "./config";
import { Inverter } from "./inverter";
import {
  Snapshot,
  ControlType,
  OUTPUT_SOURCE_PRIORITY,
  CHARGER_SOURCE_PRIORITY,
  ALLOWED_MAX_CHARGE_CURRENT,
  ALLOWED_MAX_AC_CHARGE_CURRENT,
} from "@inverter/shared";

interface SensorDef {
  key: string;
  name: string;
  unit?: string;
  deviceClass?: string;
  stateClass?: string;
  icon?: string;
}

// Live telemetry — always exposed as read-only sensors.
const SENSORS: SensorDef[] = [
  { key: "pv_w", name: "PV мощность", unit: "W", deviceClass: "power", stateClass: "measurement" },
  { key: "pv_v", name: "PV напряжение", unit: "V", deviceClass: "voltage", stateClass: "measurement" },
  { key: "pv_a", name: "PV ток", unit: "A", deviceClass: "current", stateClass: "measurement" },
  { key: "soc", name: "Заряд батареи", unit: "%", deviceClass: "battery", stateClass: "measurement" },
  { key: "batt_v", name: "Напряжение батареи", unit: "V", deviceClass: "voltage", stateClass: "measurement" },
  { key: "charge_a", name: "Ток заряда", unit: "A", deviceClass: "current", stateClass: "measurement" },
  { key: "discharge_a", name: "Ток разряда", unit: "A", deviceClass: "current", stateClass: "measurement" },
  { key: "load_w", name: "Нагрузка", unit: "W", deviceClass: "power", stateClass: "measurement" },
  { key: "load_va", name: "Нагрузка (полная)", unit: "VA", deviceClass: "apparent_power", stateClass: "measurement" },
  { key: "load_pct", name: "Загрузка", unit: "%", stateClass: "measurement", icon: "mdi:gauge" },
  { key: "out_v", name: "Выходное напряжение", unit: "V", deviceClass: "voltage", stateClass: "measurement" },
  { key: "out_hz", name: "Выходная частота", unit: "Hz", deviceClass: "frequency", stateClass: "measurement" },
  { key: "grid_v", name: "Напряжение сети", unit: "V", deviceClass: "voltage", stateClass: "measurement" },
  { key: "grid_hz", name: "Частота сети", unit: "Hz", deviceClass: "frequency", stateClass: "measurement" },
  { key: "temp", name: "Температура", unit: "°C", deviceClass: "temperature", stateClass: "measurement" },
  { key: "mode", name: "Режим", icon: "mdi:power-settings" },
  { key: "power_source", name: "Источник питания", icon: "mdi:solar-power-variant" },
  { key: "warnings", name: "Предупреждения", icon: "mdi:alert" },
];

// Settings — read-only sensors, or read/write selects when control is enabled.
interface SettingDef {
  key: string;
  controlType: ControlType;
  name: string;
  options: string[]; // HA select options (strings)
  unit?: string;
}
const SETTINGS: SettingDef[] = [
  {
    key: "outputSourcePriority",
    controlType: "outputSourcePriority",
    name: "Приоритет источника выхода",
    options: Object.values(OUTPUT_SOURCE_PRIORITY),
  },
  {
    key: "chargerSourcePriority",
    controlType: "chargerSourcePriority",
    name: "Приоритет источника заряда",
    options: Object.values(CHARGER_SOURCE_PRIORITY),
  },
  {
    key: "maxChargingCurrent",
    controlType: "maxChargingCurrent",
    name: "Макс. ток заряда",
    options: ALLOWED_MAX_CHARGE_CURRENT.map(String),
    unit: "A",
  },
  {
    key: "maxAcChargingCurrent",
    controlType: "maxAcChargingCurrent",
    name: "Макс. ток заряда от сети",
    options: ALLOWED_MAX_AC_CHARGE_CURRENT.map(String),
    unit: "A",
  },
];

export class HaMqtt {
  private cfg: Config;
  private inverter: Inverter;
  private client: any = null;
  private base: string;
  private stateTopic: string;
  private availTopic: string;
  private cmdRoot: string;

  constructor(cfg: Config, inverter: Inverter) {
    this.cfg = cfg;
    this.inverter = inverter;
    const { baseTopic, nodeId } = cfg.mqtt;
    this.base = `${baseTopic}/${nodeId}`;
    this.stateTopic = `${this.base}/state`;
    this.availTopic = `${this.base}/availability`;
    this.cmdRoot = `${this.base}/set`;
  }

  start(): void {
    if (!this.cfg.mqtt.url) {
      console.log("[inverter-monitor] MQTT disabled (set MQTT_URL to enable Home Assistant integration)");
      return;
    }
    let mqtt: any;
    try {
      mqtt = require("mqtt");
    } catch {
      console.error("[inverter-monitor] MQTT_URL set but 'mqtt' package is not installed");
      return;
    }

    const opts: any = {
      username: this.cfg.mqtt.username ?? undefined,
      password: this.cfg.mqtt.password ?? undefined,
      will: { topic: this.availTopic, payload: "offline", qos: 1, retain: true },
      reconnectPeriod: 5000,
    };
    this.client = mqtt.connect(this.cfg.mqtt.url, opts);

    this.client.on("connect", () => {
      console.log(`[inverter-monitor] MQTT connected to ${this.cfg.mqtt.url}`);
      this.client.publish(this.availTopic, "online", { qos: 1, retain: true });
      this.publishDiscovery();
      if (this.cfg.mqtt.enableControl) {
        this.client.subscribe(`${this.cmdRoot}/#`, { qos: 1 });
      }
      this.publishState(this.inverter.getSnapshot());
    });

    this.client.on("message", (topic: string, payload: Buffer) => {
      void this.onCommand(topic, payload.toString());
    });

    this.client.on("error", (e: Error) => console.error("[inverter-monitor] MQTT error:", e.message));

    this.inverter.on("snapshot", (snap: Snapshot) => this.publishState(snap));
  }

  private device() {
    return {
      identifiers: [this.cfg.mqtt.nodeId],
      name: this.cfg.mqtt.deviceName,
      manufacturer: "ISolar / EASUN (SMG II)",
      model: "SK-5500P-48L",
      sw_version: "inverter-monitor",
    };
  }

  private publishConfig(component: string, key: string, config: object): void {
    const topic = `${this.cfg.mqtt.discoveryPrefix}/${component}/${this.cfg.mqtt.nodeId}/${key}/config`;
    this.client.publish(topic, JSON.stringify(config), { qos: 1, retain: true });
  }

  private publishDiscovery(): void {
    const device = this.device();
    const availability = [{ topic: this.availTopic }];

    for (const s of SENSORS) {
      this.publishConfig("sensor", s.key, {
        name: s.name,
        unique_id: `${this.cfg.mqtt.nodeId}_${s.key}`,
        state_topic: this.stateTopic,
        value_template: `{{ value_json.${s.key} }}`,
        ...(s.unit ? { unit_of_measurement: s.unit } : {}),
        ...(s.deviceClass ? { device_class: s.deviceClass } : {}),
        ...(s.stateClass ? { state_class: s.stateClass } : {}),
        ...(s.icon ? { icon: s.icon } : {}),
        availability,
        device,
      });
    }

    // Binary sensors
    this.publishConfig("binary_sensor", "connected", {
      name: "Инвертор на связи",
      unique_id: `${this.cfg.mqtt.nodeId}_connected`,
      state_topic: this.stateTopic,
      value_template: "{{ value_json.connected }}",
      payload_on: "ON",
      payload_off: "OFF",
      device_class: "connectivity",
      availability,
      device,
    });
    this.publishConfig("binary_sensor", "problem", {
      name: "Авария/предупреждение",
      unique_id: `${this.cfg.mqtt.nodeId}_problem`,
      state_topic: this.stateTopic,
      value_template: "{{ value_json.problem }}",
      payload_on: "ON",
      payload_off: "OFF",
      device_class: "problem",
      availability,
      device,
    });
    this.publishConfig("binary_sensor", "locked", {
      name: "Запись заблокирована",
      unique_id: `${this.cfg.mqtt.nodeId}_locked`,
      state_topic: this.stateTopic,
      value_template: "{{ value_json.locked }}",
      payload_on: "ON",
      payload_off: "OFF",
      // No device_class: HA's "lock" class inverts semantics (ON = unlocked),
      // which would display the opposite of reality for this sensor.
      icon: "mdi:lock",
      availability,
      device,
    });

    // Settings: selects if control enabled, otherwise read-only sensors.
    for (const s of SETTINGS) {
      if (this.cfg.mqtt.enableControl) {
        this.publishConfig("select", s.key, {
          name: s.name,
          unique_id: `${this.cfg.mqtt.nodeId}_${s.key}`,
          state_topic: this.stateTopic,
          value_template: `{{ value_json.${s.key}_label }}`,
          command_topic: `${this.cmdRoot}/${s.key}`,
          options: s.options,
          availability,
          device,
        });
      } else {
        this.publishConfig("sensor", s.key, {
          name: s.name,
          unique_id: `${this.cfg.mqtt.nodeId}_${s.key}`,
          state_topic: this.stateTopic,
          value_template: `{{ value_json.${s.key}_label }}`,
          availability,
          device,
        });
      }
    }
  }

  private publishState(snap: Snapshot): void {
    if (!this.client || !this.client.connected) return;
    const st = snap.status;
    const info = snap.info;
    const warns = snap.warnings?.active ?? [];

    const ospVal = info?.outputSourcePriority;
    const cspVal = info?.chargerSourcePriority;

    const payload: Record<string, unknown> = {
      pv_w: st?.pvPower ?? null,
      pv_v: st?.pvInputVoltage ?? null,
      pv_a: st?.pvInputCurrent ?? null,
      soc: st?.batteryCapacity ?? null,
      batt_v: st?.batteryVoltage ?? null,
      charge_a: st?.batteryChargingCurrent ?? null,
      discharge_a: st?.batteryDischargeCurrent ?? null,
      load_w: st?.acOutputActivePower ?? null,
      load_va: st?.acOutputApparentPower ?? null,
      load_pct: st?.outputLoadPercent ?? null,
      out_v: st?.acOutputVoltage ?? null,
      out_hz: st?.acOutputFrequency ?? null,
      grid_v: st?.gridVoltage ?? null,
      grid_hz: st?.gridFrequency ?? null,
      temp: st?.heatSinkTemperature ?? null,
      mode: snap.mode,
      power_source: snap.powerSource,
      warnings: warns.length ? warns.join("; ") : "OK",
      problem: warns.length ? "ON" : "OFF",
      connected: snap.connection.connected ? "ON" : "OFF",
      locked: snap.control.locked ? "ON" : "OFF",
      outputSourcePriority: ospVal ?? null,
      outputSourcePriority_label:
        ospVal !== undefined && Number.isFinite(ospVal) ? OUTPUT_SOURCE_PRIORITY[ospVal] ?? String(ospVal) : null,
      chargerSourcePriority: cspVal ?? null,
      chargerSourcePriority_label:
        cspVal !== undefined && Number.isFinite(cspVal) ? CHARGER_SOURCE_PRIORITY[cspVal] ?? String(cspVal) : null,
      maxChargingCurrent: info?.maxChargingCurrent ?? null,
      maxChargingCurrent_label: Number.isFinite(info?.maxChargingCurrent) ? String(info!.maxChargingCurrent) : null,
      maxAcChargingCurrent: info?.maxAcChargingCurrent ?? null,
      maxAcChargingCurrent_label: Number.isFinite(info?.maxAcChargingCurrent) ? String(info!.maxAcChargingCurrent) : null,
    };

    // Replace NaN with null so the JSON is valid for HA templates.
    for (const k of Object.keys(payload)) {
      if (typeof payload[k] === "number" && Number.isNaN(payload[k] as number)) payload[k] = null;
    }
    this.client.publish(this.stateTopic, JSON.stringify(payload), { qos: 0, retain: true });
  }

  private async onCommand(topic: string, value: string): Promise<void> {
    if (!this.cfg.mqtt.enableControl) return;
    const key = topic.slice(this.cmdRoot.length + 1);
    const setting = SETTINGS.find((s) => s.key === key);
    if (!setting) {
      console.error(`[inverter-monitor] MQTT command for unknown setting: ${key}`);
      return;
    }
    // Map incoming value: for priorities the payload is a label → find its code.
    let numeric: number;
    if (setting.controlType === "outputSourcePriority") {
      numeric = Number(Object.keys(OUTPUT_SOURCE_PRIORITY).find((k) => OUTPUT_SOURCE_PRIORITY[Number(k)] === value));
    } else if (setting.controlType === "chargerSourcePriority") {
      numeric = Number(Object.keys(CHARGER_SOURCE_PRIORITY).find((k) => CHARGER_SOURCE_PRIORITY[Number(k)] === value));
    } else {
      numeric = Number(value);
    }
    if (!Number.isFinite(numeric)) {
      console.error(`[inverter-monitor] MQTT command bad value for ${key}: ${value}`);
      return;
    }
    try {
      const res = await this.inverter.control(setting.controlType, numeric, { bypassLock: true, source: "mqtt" });
      console.log(`[inverter-monitor] MQTT control ${key}=${value} -> ${res.command} ${res.reply}`);
    } catch (e) {
      console.error(`[inverter-monitor] MQTT control ${key} failed:`, (e as Error).message);
    }
  }

  stop(): void {
    const client = this.client;
    if (!client) return;
    this.client = null;
    try {
      // Publish "offline" and let it flush before closing; end(true) here could
      // drop the message and leave a stale retained "online" in the broker.
      client.publish(this.availTopic, "offline", { qos: 1, retain: true }, () => client.end());
      const t = setTimeout(() => client.end(true), 1000);
      t.unref?.();
    } catch {
      try {
        client.end(true);
      } catch {
        /* ignore */
      }
    }
  }
}
