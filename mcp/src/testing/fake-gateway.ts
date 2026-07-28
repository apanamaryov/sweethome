import type { ApiMeta, Baseline, ControlResponse, ControlType, Snapshot } from "@inverter/shared";
import type { ControlPreview, GatewayCapabilities, InverterGateway, StatsGateway } from "../gateway/types";

/** Ин-мемори шлюз для тестов ядра: пишет все вызовы в `calls`. */

export const FAKE_SNAPSHOT: Snapshot = {
  timestamp: 1_700_000_000_000,
  connection: {
    connected: true,
    transport: "serial",
    device: "/dev/ttyUSB0",
    deviceId: "dev-1",
    mock: false,
    lastError: null,
  },
  control: { allowControl: true, locked: true },
  mode: "Battery",
  // Расхождение с mode — намеренное, не «опечатка фикстуры»: инвертор в
  // автономе всегда рапортует Battery, а "Solar" сервер выводит из телеметрии
  // (shared/src/source.ts). На этой паре тесты и проверяют, что это два разных
  // поля, а не одно продублированное. Не «исправлять».
  powerSource: "Solar",
  status: {
    gridVoltage: 232.7, gridFrequency: 50, mainsPower: 0, inverterPower: 430,
    acOutputVoltage: 230, acOutputFrequency: 50, acOutputActivePower: 430, acOutputApparentPower: 500,
    outputLoadPercent: 8, batteryVoltage: 52.2, batteryPower: -400, batteryChargingCurrent: 0,
    batteryDischargeCurrent: 7.7, batteryCapacity: 72, pvInputVoltage: 310, pvInputCurrent: 4,
    pvPower: 1240, pvChargingPower: 800, dcdcTemperature: 35, heatSinkTemperature: 41,
    raw: "201=3 202=2327",
  },
  info: {
    outputMode: 0, outputSourcePriority: 2, inputVoltageRange: 0, buzzerMode: 0, lcdBacklight: 1,
    acOutputRatingVoltage: 230, acOutputRatingFrequency: 50, batteryType: 3, batteryOverVoltage: 60,
    batteryBulkVoltage: 56.4, batteryFloatVoltage: 54, batteryRedischargeVoltage: 52,
    batteryRechargeVoltage: 48, batteryUnderVoltage: 46, chargerSourcePriority: 3,
    maxChargingCurrent: 60, maxAcChargingCurrent: 30, eqChargingVoltage: 56.4,
    socBackToUtility: 20, socBackToBattery: 80, socLowCutoff: 10,
    acOutputRatingActivePower: 5500, raw: "",
  },
  flags: { flags: [{ key: "ecoMode", name: "Eco mode", enabled: true }], raw: "" },
  warnings: { active: [], raw: "fault=0x0 warning=0x0" },
  baseline: null,
};

export const FAKE_META: ApiMeta = {
  session: { username: "bot", role: "admin", mustChangePassword: false },
  allowControl: true,
  outputSourcePriority: { 0: "UTI", 1: "SOL", 2: "SBU", 3: "SUB" },
  chargerSourcePriority: { 0: "Utility first", 1: "PV first", 2: "PV and Utility", 3: "Only PV" },
  maxChargingCurrent: [10, 20, 30, 40, 50, 60],
  maxAcChargingCurrent: [10, 20, 30],
};

export interface FakeGateway extends InverterGateway {
  calls: Array<{ method: string; args: unknown[] }>;
  emitSnapshot(s: Snapshot): void;
  snapshotValue: Snapshot;
}

export type FakeOverrides = Partial<InverterGateway> & { caps?: Partial<GatewayCapabilities> };

export function createFakeGateway(overrides: FakeOverrides = {}): FakeGateway {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const listeners = new Set<(s: Snapshot) => void>();
  const record = (method: string, ...args: unknown[]) => calls.push({ method, args });

  const caps: GatewayCapabilities = {
    role: "admin",
    scopes: ["read", "write"],
    allowControl: true,
    statsEnabled: true,
    ...overrides.caps,
  };
  const { caps: _caps, ...rest } = overrides;

  const stats: StatsGateway = {
    async series(q) {
      record("series", q);
      return [
        { t: 1, pvPower: 100 },
        { t: 2, pvPower: 200 },
      ];
    },
    async daily(from, to) {
      record("daily", from, to);
      // Схема ровно как в таблице `daily` сервера (см. server/src/stats/db.ts):
      // SOC-колонки называются soc_min/soc_max, а не batteryCapacity_*.
      return [
        {
          day: "2026-07-26", pv_wh: 8000, load_wh: 5000, grid_wh: 1000,
          batt_charge_wh: 3000, batt_discharge_wh: 2500,
          soc_min: 40, soc_max: 100, grid_loss_count: 0, sample_count: 6500,
          solar_start_ts: 1, solar_end_ts: 2,
        },
      ];
    },
    async energy(from, to, bucket) {
      record("energy", from, to, bucket);
      return [{ t: 1, pv_wh: 100, load_wh: 90, grid_wh: 10, batt_charge_wh: 5, batt_discharge_wh: 4 }];
    },
    async events(q) {
      record("events", q);
      return [
        { id: 1, ts: 5, type: "mode-change", detail: '{"from":"Line","to":"Battery"}' },
        { id: 2, ts: 6, type: "warning-set", detail: '{"bit":"PV low voltage"}' },
        { id: 3, ts: 7, type: "warning-clear", detail: '{"bit":"PV low voltage"}' },
      ];
    },
    async solarWindow(day) {
      record("solarWindow", day);
      return { day: day ?? "2026-07-27", start: 10, end: null, state: "active" as const };
    },
    async exportCsv(q) {
      record("exportCsv", q);
      return { csv: "ts,mode\n1,Battery\n", truncated: false };
    },
  };

  const gw: FakeGateway = {
    calls,
    snapshotValue: FAKE_SNAPSHOT,
    async snapshot() {
      record("snapshot");
      return gw.snapshotValue;
    },
    async meta() {
      record("meta");
      return FAKE_META;
    },
    async baseline() {
      record("baseline");
      return gw.snapshotValue.baseline;
    },
    async control(type: ControlType, value: number) {
      record("control", type, value);
      return { ok: true, command: `reg 331 := ${value}`, reply: "ACK" } as ControlResponse;
    },
    async previewControl(type: ControlType, value: number) {
      record("previewControl", type, value);
      return {
        register: 331,
        rawValue: value,
        label: "Only PV",
        currentValue: 1,
        baselineValue: 1,
      } as ControlPreview;
    },
    async setLock(locked: boolean) {
      record("setLock", locked);
      return { locked };
    },
    async recaptureBaseline() {
      record("recaptureBaseline");
      return {
        deviceId: "dev-1",
        capturedAt: 1,
        info: FAKE_SNAPSHOT.info,
        flags: FAKE_SNAPSHOT.flags,
      } as Baseline;
    },
    async raw(command: string) {
      record("raw", command);
      return "201 = 3 (0x0003)";
    },
    stats: caps.statsEnabled ? stats : null,
    onSnapshot(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    capabilities() {
      return caps;
    },
    close() {
      record("close");
    },
    emitSnapshot(s: Snapshot) {
      for (const cb of listeners) cb(s);
    },
    ...rest,
  };
  return gw;
}
