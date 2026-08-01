import type { SessionUser } from "@sweethome/shared";

/** Whitelist управляющих команд, доступный API/UI. */
export type ControlType =
  | "outputSourcePriority"
  | "chargerSourcePriority"
  | "maxChargingCurrent"
  | "maxAcChargingCurrent"
  | "batteryRechargeVoltage"
  | "batteryRedischargeVoltage";

/** Регистр 301 (output priority), значения SMG II. */
export const OUTPUT_SOURCE_PRIORITY: Record<number, string> = {
  0: "Utility → PV → Battery (UTI)",
  1: "PV → Utility → Battery (SOL)",
  2: "PV → Battery → Utility (SBU)",
  3: "PV → Utility → Battery (SUB)",
};

/** Регистр 331 (battery charging priority). */
export const CHARGER_SOURCE_PRIORITY: Record<number, string> = {
  0: "Utility first",
  1: "PV first",
  2: "PV and Utility",
  3: "Only PV",
};

/** Общий ток заряда, А (регистр 332, шаг устройства 0.1 А, диапазон 0–100). */
export const ALLOWED_MAX_CHARGE_CURRENT = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
/** Ток заряда от сети, А (регистр 333). */
export const ALLOWED_MAX_AC_CHARGE_CURRENT = [10, 20, 30, 40, 50, 60, 70, 80];

/** Ответ GET /api/meta. */
export interface ApiMeta {
  session: SessionUser;
  allowControl: boolean;
  /** Пик PV-массива, Вт (INVERTER_PV_PEAK_W); отсутствует, если не задан. */
  pvPeakW?: number;
  outputSourcePriority: Record<number, string>;
  chargerSourcePriority: Record<number, string>;
  maxChargingCurrent: number[];
  maxAcChargingCurrent: number[];
}

/** Ответ POST /api/control (и форма ошибок остальных POST). */
export interface ControlResponse {
  ok: boolean;
  command?: string;
  reply?: string;
  error?: string;
}

/** Машиночитаемые коды ошибок POST /api/login. */
export type LoginErrorCode = "bad_password" | "rate_limited";
