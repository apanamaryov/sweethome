/** Whitelist управляющих команд, доступный API/UI. */
export type ControlType =
  | "outputSourcePriority"
  | "chargerSourcePriority"
  | "maxChargingCurrent"
  | "maxAcChargingCurrent"
  | "batteryRechargeVoltage"
  | "batteryRedischargeVoltage";

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

/** Допустимый общий ток заряда (А) на этих аппаратах. */
export const ALLOWED_MAX_CHARGE_CURRENT = [10, 20, 30, 40, 50, 60, 70, 80];
/** Допустимый ток заряда от сети (А). */
export const ALLOWED_MAX_AC_CHARGE_CURRENT = [2, 10, 20, 30, 40, 50, 60];

/** Ответ GET /api/meta. */
export interface ApiMeta {
  authEnabled: boolean;
  allowControl: boolean;
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
