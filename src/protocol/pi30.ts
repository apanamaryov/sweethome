import {
  InverterStatus,
  InverterRatedInfo,
  InverterWarnings,
  InverterFlags,
  DeviceMode,
} from "./types";

/**
 * PI30 ("HS") protocol helpers for Voltronic-based inverters
 * (SmartESS / WatchPower family, e.g. SK-5500P-48L).
 *
 * Query commands are plain ASCII; the transport layer adds CRC + CR.
 * Response payloads are space-separated fields; we map them by position and
 * always keep the raw string so nothing is lost if a field is model-specific.
 */

export const QUERY = {
  STATUS: "QPIGS",
  MODE: "QMOD",
  RATED: "QPIRI",
  WARNINGS: "QPIWS",
  FLAGS: "QFLAG",
  ID: "QID",
  FIRMWARE: "QVFW",
} as const;

/** QFLAG single-letter function codes → human-readable names. */
const FLAG_NAMES: Record<string, string> = {
  a: "Звуковой сигнал (buzzer)",
  b: "Обход при перегрузке (overload bypass)",
  j: "Энергосбережение (power saving)",
  k: "Возврат LCD на главный экран через 1 мин",
  u: "Перезапуск после перегрузки",
  v: "Перезапуск после перегрева",
  x: "Подсветка LCD",
  y: "Сигнал при пропадании основного источника",
  z: "Запись кодов ошибок",
};

/**
 * QFLAG format: "E<letters>D<letters>" — letters after 'E' are enabled
 * functions, letters after 'D' are disabled.
 */
export function parseFlags(payload: string): InverterFlags {
  const p = payload.trim();
  const flags: InverterFlags["flags"] = [];
  let mode: "E" | "D" | null = null;
  for (const ch of p) {
    if (ch === "E") mode = "E";
    else if (ch === "D") mode = "D";
    else if (mode) {
      const lc = ch.toLowerCase();
      flags.push({ key: lc, name: FLAG_NAMES[lc] ?? `Флаг ${lc}`, enabled: mode === "E" });
    }
  }
  return { flags, raw: payload };
}

/** QID / QVFW responses are opaque strings; expose them cleaned up. */
export function parseId(payload: string): string {
  return payload.trim();
}

function num(v: string | undefined): number {
  if (v === undefined) return NaN;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : NaN;
}

export function parseStatus(payload: string): InverterStatus {
  const f = payload.trim().split(/\s+/);
  return {
    gridVoltage: num(f[0]),
    gridFrequency: num(f[1]),
    acOutputVoltage: num(f[2]),
    acOutputFrequency: num(f[3]),
    acOutputApparentPower: num(f[4]),
    acOutputActivePower: num(f[5]),
    outputLoadPercent: num(f[6]),
    busVoltage: num(f[7]),
    batteryVoltage: num(f[8]),
    batteryChargingCurrent: num(f[9]),
    batteryCapacity: num(f[10]),
    heatSinkTemperature: num(f[11]),
    pvInputCurrent: num(f[12]),
    pvInputVoltage: num(f[13]),
    batteryVoltageFromScc: num(f[14]),
    batteryDischargeCurrent: num(f[15]),
    deviceStatus: f[16] ?? "",
    pvChargingPower: num(f[19]),
    raw: payload,
  };
}

export function parseMode(payload: string): DeviceMode {
  const c = payload.trim().charAt(0).toUpperCase();
  switch (c) {
    case "P":
      return "PowerOn";
    case "S":
      return "Standby";
    case "L":
      return "Line";
    case "B":
      return "Battery";
    case "F":
      return "Fault";
    case "H":
      return "PowerSaving";
    case "D":
      return "Shutdown";
    default:
      return "Unknown";
  }
}

export function parseRatedInfo(payload: string): InverterRatedInfo {
  const f = payload.trim().split(/\s+/);
  return {
    gridRatingVoltage: num(f[0]),
    gridRatingCurrent: num(f[1]),
    acOutputRatingVoltage: num(f[2]),
    acOutputRatingFrequency: num(f[3]),
    acOutputRatingCurrent: num(f[4]),
    acOutputRatingApparentPower: num(f[5]),
    acOutputRatingActivePower: num(f[6]),
    batteryRatingVoltage: num(f[7]),
    batteryRechargeVoltage: num(f[8]),
    batteryUnderVoltage: num(f[9]),
    batteryBulkVoltage: num(f[10]),
    batteryFloatVoltage: num(f[11]),
    batteryType: num(f[12]),
    maxAcChargingCurrent: num(f[13]),
    maxChargingCurrent: num(f[14]),
    inputVoltageRange: num(f[15]),
    outputSourcePriority: num(f[16]),
    chargerSourcePriority: num(f[17]),
    parallelMaxNum: num(f[18]),
    machineType: f[19] ?? "",
    topology: num(f[20]),
    outputMode: num(f[21]),
    batteryRedischargeVoltage: num(f[22]),
    raw: payload,
  };
}

/**
 * QPIWS warning bit map. The response is a string of '0'/'1' flags; index maps
 * to a named warning/fault. Names follow the Voltronic HS spec; unmapped bits
 * are surfaced generically so nothing important is silently dropped.
 */
const WARNING_BITS: Record<number, string> = {
  // a0 reserved
  1: "Inverter fault",
  2: "Bus over voltage",
  3: "Bus under voltage",
  4: "Bus soft-start failed",
  5: "Line fail (no utility)",
  6: "Output short circuit",
  7: "Inverter voltage too low",
  8: "Inverter voltage too high",
  9: "Over temperature",
  10: "Fan locked",
  11: "Battery voltage too high",
  12: "Battery low alarm",
  // a13 reserved
  14: "Battery under shutdown",
  // a15 reserved
  16: "Overload",
  17: "EEPROM fault",
  18: "Inverter over current",
  19: "Inverter soft-start failed",
  20: "Self-test failed",
  21: "OP DC voltage over",
  22: "Battery open",
  23: "Current sensor failed",
  24: "Battery short",
  25: "Power limit",
  26: "PV voltage high",
  27: "MPPT overload fault",
  28: "MPPT overload warning",
  29: "Battery too low to charge",
};

export function parseWarnings(payload: string): InverterWarnings {
  const bits = payload.trim();
  const active: string[] = [];
  for (let i = 0; i < bits.length; i++) {
    if (bits[i] === "1") {
      active.push(WARNING_BITS[i] ?? `Warning bit ${i}`);
    }
  }
  return { active, raw: payload };
}

export function isAck(payload: string): boolean {
  return payload.trim().toUpperCase() === "ACK";
}

/* ------------------------------------------------------------------ *
 * Control (setter) commands.
 * Each returns the raw ASCII command; the transport adds CRC + CR.
 * The inverter replies "(ACK" on success or "(NAK" on rejection.
 * ------------------------------------------------------------------ */

export const OUTPUT_SOURCE_PRIORITY: Record<number, string> = {
  0: "Utility first",
  1: "Solar first",
  2: "Solar → Battery → Utility (SBU)",
};

export const CHARGER_SOURCE_PRIORITY: Record<number, string> = {
  0: "Utility first",
  1: "Solar first",
  2: "Solar and Utility",
  3: "Only Solar",
};

export function setOutputSourcePriority(value: number): string {
  if (!(value in OUTPUT_SOURCE_PRIORITY)) throw new Error("Invalid output source priority");
  return `POP0${value}`;
}

export function setChargerSourcePriority(value: number): string {
  if (!(value in CHARGER_SOURCE_PRIORITY)) throw new Error("Invalid charger source priority");
  return `PCP0${value}`;
}

/** Max total charging current (A). Common allowed set on these units. */
export const ALLOWED_MAX_CHARGE_CURRENT = [10, 20, 30, 40, 50, 60, 70, 80];
export function setMaxChargingCurrent(amps: number): string {
  if (!ALLOWED_MAX_CHARGE_CURRENT.includes(amps)) {
    throw new Error(`Max charging current must be one of ${ALLOWED_MAX_CHARGE_CURRENT.join(", ")}`);
  }
  // Format MCHGC<m><nn>: machine number (0) + 2-digit current; zero-padding a
  // 2-digit current to 3 chars yields exactly that ("MCHGC060" = machine 0, 60A).
  return `MCHGC${String(amps).padStart(3, "0")}`;
}

/** Max utility (AC) charging current (A). */
export const ALLOWED_MAX_AC_CHARGE_CURRENT = [2, 10, 20, 30, 40, 50, 60];
export function setMaxAcChargingCurrent(amps: number): string {
  if (!ALLOWED_MAX_AC_CHARGE_CURRENT.includes(amps)) {
    throw new Error(`Max AC charging current must be one of ${ALLOWED_MAX_AC_CHARGE_CURRENT.join(", ")}`);
  }
  return `MUCHGC${String(amps).padStart(3, "0")}`;
}

/**
 * Battery re-charge (utility comeback) voltage, in volts.
 * PI30 format uses a decimal point: PBCV<nn.n>, e.g. "PBCV46.0" (per the Axpert
 * HS protocol doc and mpp-solar), NOT tenths-of-volt integers.
 */
export function setBatteryRechargeVoltage(volts: number): string {
  if (volts < 40 || volts > 60) throw new Error("Recharge voltage out of range (40-60V)");
  return `PBCV${volts.toFixed(1).padStart(4, "0")}`;
}

/** Battery re-discharge (back-to-battery) voltage, in volts. 0 = full ("00.0"). */
export function setBatteryRedischargeVoltage(volts: number): string {
  if (volts !== 0 && (volts < 48 || volts > 62)) throw new Error("Redischarge voltage out of range");
  return `PBDV${volts.toFixed(1).padStart(4, "0")}`;
}

/** A curated, whitelisted control surface exposed to the API/UI. */
export type ControlType =
  | "outputSourcePriority"
  | "chargerSourcePriority"
  | "maxChargingCurrent"
  | "maxAcChargingCurrent"
  | "batteryRechargeVoltage"
  | "batteryRedischargeVoltage";

export function buildControlCommand(type: ControlType, value: number): string {
  switch (type) {
    case "outputSourcePriority":
      return setOutputSourcePriority(value);
    case "chargerSourcePriority":
      return setChargerSourcePriority(value);
    case "maxChargingCurrent":
      return setMaxChargingCurrent(value);
    case "maxAcChargingCurrent":
      return setMaxAcChargingCurrent(value);
    case "batteryRechargeVoltage":
      return setBatteryRechargeVoltage(value);
    case "batteryRedischargeVoltage":
      return setBatteryRedischargeVoltage(value);
    default:
      throw new Error(`Unknown control type: ${type}`);
  }
}
