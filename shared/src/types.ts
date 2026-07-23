/**
 * Данные инвертора семейства ISolar/EASUN SMG II (наш SK-5500P-48L).
 * Источник — holding-регистры Modbus RTU; карта регистров сверена с
 * syssi/esphome-smg-ii и живым устройством.
 */

/** Живой статус (регистры 201–234). */
export interface InverterStatus {
  gridVoltage: number; // V      (202 ×0.1)
  gridFrequency: number; // Hz   (203 ×0.01)
  mainsPower: number; // W       (204) средняя мощность от сети
  inverterPower: number; // W    (208) + выдача, − потребление
  acOutputVoltage: number; // V  (210 ×0.1)
  acOutputFrequency: number; // Hz (212 ×0.01)
  acOutputActivePower: number; // W  (213)
  acOutputApparentPower: number; // VA (214)
  outputLoadPercent: number; // %   (225)
  batteryVoltage: number; // V   (215 ×0.1)
  batteryPower: number; // W     (217) + заряд, − разряд
  batteryChargingCurrent: number; // A (из 232 ×0.1, положительная часть)
  batteryDischargeCurrent: number; // A (из 232 ×0.1, отрицательная часть)
  batteryCapacity: number; // % SOC (229)
  pvInputVoltage: number; // V   (219 ×0.1)
  pvInputCurrent: number; // A   (220 ×0.1)
  pvPower: number; // W          (223) вся выработка PV
  pvChargingPower: number; // W  (224) PV-мощность, идущая в заряд
  dcdcTemperature: number; // °C (226)
  heatSinkTemperature: number; // °C (227) температура инвертора
  raw: string; // дамп прочитанных регистров "адрес=значение …"
}

/** Текущие настройки (регистры 300–343, 643). */
export interface InverterRatedInfo {
  outputMode: number; // 300: 0 Single, 1 Parallel, 2..4 3-Phase P1..P3
  outputSourcePriority: number; // 301: 0 UTI, 1 SOL, 2 SBU, 3 SUB
  inputVoltageRange: number; // 302: 0 Wide, 1 Narrow
  buzzerMode: number; // 303: 0..3
  lcdBacklight: number; // 305: 0 Timed off, 1 Always on
  acOutputRatingVoltage: number; // V (320 ×0.1)
  acOutputRatingFrequency: number; // Hz (321 ×0.01)
  batteryType: number; // 322: 0 AGM, 1 FLD, 2 USER, 3..6 Li1..Li4, 8 Lib
  batteryOverVoltage: number; // V (323 ×0.1) защита от перенапряжения
  batteryBulkVoltage: number; // V (324 ×0.1) макс. напряжение заряда (C.V.)
  batteryFloatVoltage: number; // V (325 ×0.1)
  batteryRedischargeVoltage: number; // V (326 ×0.1) возврат на батарею (recovery)
  batteryRechargeVoltage: number; // V (327 ×0.1) переход на сеть (low-voltage protection, mains)
  batteryUnderVoltage: number; // V (329 ×0.1) отсечка в автономном режиме
  chargerSourcePriority: number; // 331: 0 Utility, 1 PV, 2 PV=Utility, 3 Only PV
  maxChargingCurrent: number; // A (332 ×0.1)
  maxAcChargingCurrent: number; // A (333 ×0.1)
  eqChargingVoltage: number; // V (334 ×0.1)
  socBackToUtility: number; // % (341) SOC перехода на сеть
  socBackToBattery: number; // % (342) SOC возврата на батарею
  socLowCutoff: number; // % (343) SOC-отсечка
  acOutputRatingActivePower: number; // W (643) номинал
  raw: string;
}

export interface InverterWarnings {
  active: string[]; // английские имена битов fault (100) + warning (108)
  raw: string; // "fault=0x… warning=0x…"
}

/** Вкл/выкл-функции (однобитные R/W-регистры 306–313). */
export interface InverterFlag {
  key: string; // семантический ключ (см. FLAG_DEFS в протоколе)
  name: string; // человекочитаемое имя (фолбэк, локализуется в web)
  enabled: boolean;
}
export interface InverterFlags {
  flags: InverterFlag[];
  raw: string;
}

/**
 * The "as-found" settings captured once when a device first connects. Persisted
 * to disk and keyed by device id so a new/real inverter recaptures its own.
 */
export interface Baseline {
  deviceId: string;
  capturedAt: number;
  info: InverterRatedInfo | null;
  flags: InverterFlags | null;
}

/** Регистр 201. */
export type DeviceMode =
  | "PowerOn" // 0
  | "Standby" // 1
  | "Line" // 2 Mains
  | "Battery" // 3 Off-Grid
  | "Bypass" // 4
  | "Charging" // 5
  | "Fault" // 6
  | "Unknown";

/** Full snapshot broadcast to clients. */
export interface Snapshot {
  timestamp: number;
  connection: {
    connected: boolean;
    transport: string; // "serial" | "mock" | "none"
    device: string | null;
    deviceId: string | null;
    mock: boolean;
    lastError: string | null;
  };
  control: {
    allowControl: boolean; // hard master switch (ALLOW_CONTROL)
    locked: boolean; // runtime read-only lock; writes rejected while true
  };
  mode: DeviceMode;
  status: InverterStatus | null;
  info: InverterRatedInfo | null;
  flags: InverterFlags | null;
  warnings: InverterWarnings | null;
  baseline: Baseline | null;
}
