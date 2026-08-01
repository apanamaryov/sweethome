/**
 * Вывод источника питания из телеметрии — чистый модуль.
 *
 * Зачем: у инвертора нет режима «от солнца» (регистр 201 знает только
 * PowerOn/Standby/Line/Battery/Bypass/Charging/Fault), поэтому состояние
 * приходится выводить. Здесь нет БД, сети, таймеров и Date.now() — всё
 * тестируется в отрыве, а состояние гистерезиса владелец модуля хранит сам.
 */
import type { DeviceMode, InverterStatus, PowerSource } from "./types";

/**
 * Порог выработки, ниже которого солнце источником не считается: отсекает
 * ночной ноль и шум датчика PV.
 */
export const PV_MIN_W = 50;

/**
 * Допуск по току разряда. 0.5 А на ~51 В — это ≈25 Вт, то есть шум измерения
 * регистра 232, а не осмысленная отдача батареи.
 */
export const DISCHARGE_EPS_A = 0.5;

/** Сколько подряд одинаковых замеров нужно, чтобы переключить показанное значение. */
export const SWITCH_AFTER = 2;

/**
 * Состояние гистерезиса. `shown` — то, что показывается наружу;
 * `pending`/`count` копят подряд идущие одинаковые кандидаты.
 */
export interface SourceState {
  shown: PowerSource;
  pending: PowerSource;
  count: number;
}

export function initialSourceState(shown: PowerSource = "Unknown"): SourceState {
  return { shown, pending: shown, count: 0 };
}

/**
 * Мгновенный кандидат по одному замеру, без сглаживания.
 *
 * "Solar" — только когда инвертор в автономном режиме, солнце реально даёт
 * мощность и при этом из батареи ничего не течёт: значит нагрузку тянет
 * исключительно PV. Условия записаны через отрицание (`!(a > b)`), чтобы NaN
 * в неполном замере автоматически означал «не солнце»: любое сравнение с NaN
 * даёт false.
 */
export function instantSource(mode: DeviceMode, status: InverterStatus | null): PowerSource {
  if (!status) return mode;
  if (mode !== "Battery") return mode;
  if (!(status.pvPower > PV_MIN_W)) return mode;
  if (!(status.batteryDischargeCurrent <= DISCHARGE_EPS_A)) return mode;
  return "Solar";
}

/**
 * Шаг гистерезиса: первый отличающийся кандидат только взводит ожидание,
 * второй подряд такой же — переключает. Смена кандидата на полпути начинает
 * счёт заново с 1, а кандидат, равный показанному, сбрасывает ожидание.
 */
export function stepSource(prev: SourceState, candidate: PowerSource): SourceState {
  if (candidate === prev.shown) {
    return { shown: prev.shown, pending: prev.shown, count: 0 };
  }
  const count = candidate === prev.pending ? prev.count + 1 : 1;
  if (count >= SWITCH_AFTER) {
    return { shown: candidate, pending: candidate, count: 0 };
  }
  return { shown: prev.shown, pending: candidate, count };
}
