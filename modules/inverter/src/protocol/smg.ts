import {
  InverterStatus,
  InverterRatedInfo,
  InverterWarnings,
  InverterFlags,
  DeviceMode,
  ControlType,
  OUTPUT_SOURCE_PRIORITY,
  CHARGER_SOURCE_PRIORITY,
  ALLOWED_MAX_CHARGE_CURRENT,
  ALLOWED_MAX_AC_CHARGE_CURRENT,
} from "@sweethome/inverter-shared";
import { toSigned } from "./modbus";

/**
 * Карта holding-регистров инвертора ISolar/EASUN SMG II (SK-5500P-48L).
 * Источник: syssi/esphome-smg-ii + живое устройство. Масштабы: напряжения ×0.1,
 * частоты ×0.01, токи ×0.1; мощности и проценты — как есть (S_WORD со знаком).
 */

/** Блоки чтения статуса — только документированные диапазоны, без «дыр». */
export const STATUS_BLOCKS: Array<[number, number]> = [
  [201, 17], // 201 mode … 217 battery power
  [219, 2], //  219 PV V, 220 PV A
  [223, 5], //  223 PV W, 224 PV chg W, 225 load %, 226 DCDC °C, 227 inv °C
  [229, 1], //  229 SOC
  [232, 3], //  232 batt A (±), 233 inv chg A, 234 PV chg A
];

/** Fault (32 бита) + warning (32 бита). */
export const ALARM_BLOCKS: Array<[number, number]> = [
  [100, 2],
  [108, 2],
];

/** Настройки. 306–310, 313 — однобитные «флаги», см. FLAG_DEFS. */
export const SETTINGS_BLOCKS: Array<[number, number]> = [
  [300, 11], // 300 output mode … 310 overload bypass
  [313, 1], //  313 battery Eq enable
  [320, 10], // 320 out V … 329 off-grid cutoff
  [331, 7], //  331 charge priority … 337 eq interval
  [341, 3], //  341..343 SOC-пороги
  [643, 1], //  rated power
];

/** Регистры, прочитанные блоками, в виде адрес → u16. */
export type RegisterMap = Map<number, number>;

const s = (regs: RegisterMap, addr: number): number => {
  const v = regs.get(addr);
  return v === undefined ? NaN : toSigned(v);
};
const u = (regs: RegisterMap, addr: number): number => {
  const v = regs.get(addr);
  return v === undefined ? NaN : v;
};

function dumpRegs(regs: RegisterMap): string {
  return [...regs.entries()].map(([a, v]) => `${a}=${v}`).join(" ");
}

export function decodeMode(reg201: number): DeviceMode {
  switch (reg201) {
    case 0:
      return "PowerOn";
    case 1:
      return "Standby";
    case 2:
      return "Line";
    case 3:
      return "Battery";
    case 4:
      return "Bypass";
    case 5:
      return "Charging";
    case 6:
      return "Fault";
    default:
      return "Unknown";
  }
}

export function decodeStatus(regs: RegisterMap): InverterStatus {
  const battA = s(regs, 232) / 10; // + заряд, − разряд
  return {
    gridVoltage: s(regs, 202) / 10,
    gridFrequency: s(regs, 203) / 100,
    mainsPower: s(regs, 204),
    inverterPower: s(regs, 208),
    acOutputVoltage: s(regs, 210) / 10,
    acOutputFrequency: s(regs, 212) / 100,
    acOutputActivePower: s(regs, 213),
    acOutputApparentPower: s(regs, 214),
    outputLoadPercent: s(regs, 225),
    batteryVoltage: s(regs, 215) / 10,
    batteryPower: s(regs, 217),
    batteryChargingCurrent: Number.isNaN(battA) ? NaN : Math.max(0, battA),
    batteryDischargeCurrent: Number.isNaN(battA) ? NaN : Math.max(0, -battA),
    batteryCapacity: u(regs, 229),
    pvInputVoltage: s(regs, 219) / 10,
    pvInputCurrent: s(regs, 220) / 10,
    pvPower: s(regs, 223),
    pvChargingPower: s(regs, 224),
    dcdcTemperature: s(regs, 226),
    heatSinkTemperature: s(regs, 227),
    raw: dumpRegs(regs),
  };
}

export function decodeSettings(regs: RegisterMap): InverterRatedInfo {
  return {
    outputMode: u(regs, 300),
    outputSourcePriority: u(regs, 301),
    inputVoltageRange: u(regs, 302),
    buzzerMode: u(regs, 303),
    lcdBacklight: u(regs, 305),
    acOutputRatingVoltage: u(regs, 320) / 10,
    acOutputRatingFrequency: u(regs, 321) / 100,
    batteryType: u(regs, 322),
    batteryOverVoltage: u(regs, 323) / 10,
    batteryBulkVoltage: u(regs, 324) / 10,
    batteryFloatVoltage: u(regs, 325) / 10,
    batteryRedischargeVoltage: u(regs, 326) / 10,
    batteryRechargeVoltage: u(regs, 327) / 10,
    batteryUnderVoltage: u(regs, 329) / 10,
    chargerSourcePriority: u(regs, 331),
    maxChargingCurrent: u(regs, 332) / 10,
    maxAcChargingCurrent: u(regs, 333) / 10,
    eqChargingVoltage: u(regs, 334) / 10,
    socBackToUtility: u(regs, 341),
    socBackToBattery: u(regs, 342),
    socLowCutoff: u(regs, 343),
    acOutputRatingActivePower: u(regs, 643),
    raw: dumpRegs(regs),
  };
}

/** Однобитные функции-переключатели. Ключи локализуются в web (dict.flags). */
const FLAG_DEFS: Array<{ addr: number; key: string; name: string }> = [
  { addr: 306, key: "lcdHome", name: "Возврат LCD на главный экран через 1 мин" },
  { addr: 307, key: "ecoMode", name: "Энергосбережение" },
  { addr: 308, key: "overloadRestart", name: "Перезапуск после перегрузки" },
  { addr: 309, key: "overTempRestart", name: "Перезапуск после перегрева" },
  { addr: 310, key: "overloadBypass", name: "Обход при перегрузке (bypass)" },
  { addr: 313, key: "batteryEq", name: "Выравнивающий заряд (Eq)" },
];

export function decodeFlags(regs: RegisterMap): InverterFlags {
  const flags = FLAG_DEFS.filter((d) => regs.get(d.addr) !== undefined).map((d) => ({
    key: d.key,
    name: d.name,
    enabled: (regs.get(d.addr)! & 1) === 1,
  }));
  return { flags, raw: FLAG_DEFS.map((d) => `${d.addr}=${regs.get(d.addr) ?? "?"}`).join(" ") };
}

/** Биты регистра fault (100–101). Имена — как в esphome-smg-ii (ключи локализации). */
export const FAULTS: string[] = [
  "Over temperature of inverter module",
  "Over temperature of DCDC module",
  "Battery over voltage",
  "PV module over temperature",
  "Output short circuit",
  "Inverter over voltage",
  "Output over load",
  "Bus over voltage",
  "Bus soft start timed out",
  "PV over current",
  "PV over voltage",
  "Battery over current",
  "Inverter over current",
  "Bus low voltage",
  "Reserve (Bit 15)",
  "Inverter DC component is too high",
  "Reserve (Bit 17)",
  "The zero bias of output current is too large",
  "The zero bias of inverter current is too large",
  "The zero bias of battery current is too large",
  "The zero bias of PV current is too large",
  "Inverter low voltage",
  "Inverter negative power protection",
  "The host in the parallel system is lost",
  "Synchronization signal abnormal in the parallel system",
  "The battery type is incompatible",
  "Parallel versions are incompatible",
];

/** Биты регистра warning (108–109). */
const WARNINGS: string[] = [
  "Reserve (Bit 0)",
  "Mains waveform abnormal",
  "Reserve (Bit 2)",
  "Mains low voltage",
  "Mains over frequency",
  "Mains low frequency",
  "PV low voltage",
  "Over temperature",
  "Battery low voltage",
  "Battery is not connected",
  "Overload",
  "Battery Eq charging",
  "Battery undervoltage",
  "Output power derating",
  "Fan blocked",
  "PV energy is too low to be use",
  "Parallel communication interrupted",
  "Output mode of Single and Parallel systems inconsistent",
  "Battery voltage difference of parallel system is too large",
];

/** Регистры 100–101 и 108–109 — по 32-битной маске (hi, lo — big-endian). */
export function decodeAlarms(regs: RegisterMap): InverterWarnings {
  const dword = (addr: number): number => {
    const hi = regs.get(addr);
    const lo = regs.get(addr + 1);
    if (hi === undefined || lo === undefined) return 0;
    return hi * 0x10000 + lo;
  };
  const fault = dword(100);
  const warning = dword(108);
  const active: string[] = [];
  for (let i = 0; i < FAULTS.length; i++) if (fault & (1 << i)) active.push(FAULTS[i]);
  for (let i = 0; i < WARNINGS.length; i++) if (warning & (1 << i)) active.push(WARNINGS[i]);
  return { active, raw: `fault=0x${fault.toString(16)} warning=0x${warning.toString(16)}` };
}

/* ------------------------------------------------------------------ *
 * Запись настроек. Каждый ControlType — один регистр; значение из UI
 * (человеческие единицы) переводится в сырое значение регистра.
 * ------------------------------------------------------------------ */

export interface ControlWrite {
  register: number;
  /** Сырое значение регистра (уже в масштабе устройства). */
  rawValue: number;
  /** Человекочитаемое описание для логов/ответа API. */
  label: string;
}

export function buildControlWrite(type: ControlType, value: number): ControlWrite {
  switch (type) {
    case "outputSourcePriority":
      if (!(value in OUTPUT_SOURCE_PRIORITY)) throw new Error("Invalid output source priority");
      return { register: 301, rawValue: value, label: `output priority = ${OUTPUT_SOURCE_PRIORITY[value]}` };
    case "chargerSourcePriority":
      if (!(value in CHARGER_SOURCE_PRIORITY)) throw new Error("Invalid charger source priority");
      return { register: 331, rawValue: value, label: `charger priority = ${CHARGER_SOURCE_PRIORITY[value]}` };
    case "maxChargingCurrent":
      if (!ALLOWED_MAX_CHARGE_CURRENT.includes(value)) {
        throw new Error(`Max charging current must be one of ${ALLOWED_MAX_CHARGE_CURRENT.join(", ")}`);
      }
      return { register: 332, rawValue: Math.round(value * 10), label: `max charging current = ${value} A` };
    case "maxAcChargingCurrent":
      if (!ALLOWED_MAX_AC_CHARGE_CURRENT.includes(value)) {
        throw new Error(`Max AC charging current must be one of ${ALLOWED_MAX_AC_CHARGE_CURRENT.join(", ")}`);
      }
      return { register: 333, rawValue: Math.round(value * 10), label: `max AC charging current = ${value} A` };
    case "batteryRechargeVoltage":
      // Переход на сеть при разряде (low-voltage protection, mains mode).
      if (value < 40 || value > 60) throw new Error("Recharge voltage out of range (40-60V)");
      return { register: 327, rawValue: Math.round(value * 10), label: `back-to-grid voltage = ${value} V` };
    case "batteryRedischargeVoltage":
      // Возврат на батарею после заряда (discharge recovery, mains mode).
      if (value < 40 || value > 60) throw new Error("Redischarge voltage out of range (40-60V)");
      return { register: 326, rawValue: Math.round(value * 10), label: `back-to-battery voltage = ${value} V` };
    default:
      throw new Error(`Unknown control type: ${type}`);
  }
}
