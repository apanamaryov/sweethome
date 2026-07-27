import type { DailyRow } from "./stats";

/**
 * Сводка солнечных окон за диапазон дней. Считается из уже загруженной
 * суточной таблицы (`solar_start_ts`/`solar_end_ts`), без запросов к API.
 *
 * Время суток берётся от локальной полуночи каждого дня, а не от абсолютной
 * метки: сравнивать «во сколько началось» между разными датами иначе нельзя.
 */
export interface SolarSummary {
  /** Самое раннее начало, минут от полуночи. */
  earliestStartMin: number;
  /** Самый поздний конец, минут от полуночи. */
  latestEndMin: number;
  /** Средняя длительность окна, минут. */
  avgDurationMin: number;
  /** Сколько дней диапазона дали пригодную пару начало/конец. */
  days: number;
}

/** Минуты от локальной полуночи того дня, к которому относится метка. */
export function minutesOfDay(ms: number): number {
  const d = new Date(ms);
  return d.getHours() * 60 + d.getMinutes();
}

export function summarizeSolarDays(rows: DailyRow[]): SolarSummary | null {
  const closed = rows.filter(
    (r) => typeof r.solar_start_ts === "number" && typeof r.solar_end_ts === "number"
  ) as Array<DailyRow & { solar_start_ts: number; solar_end_ts: number }>;
  if (!closed.length) return null;

  const starts = closed.map((r) => minutesOfDay(r.solar_start_ts));
  const ends = closed.map((r) => minutesOfDay(r.solar_end_ts));
  const durations = closed.map((r) => Math.max(0, Math.round((r.solar_end_ts - r.solar_start_ts) / 60_000)));

  return {
    earliestStartMin: Math.min(...starts),
    latestEndMin: Math.max(...ends),
    avgDurationMin: Math.round(durations.reduce((a, b) => a + b, 0) / durations.length),
    days: closed.length,
  };
}

/** «7:12» — часы и минуты от полуночи, всегда с ведущим нулём у минут. */
export function formatMinutesOfDay(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${h}:${String(m).padStart(2, "0")}`;
}

/** «7 h 12 min» в единицах локали вызывающего. */
export function formatDuration(min: number, unitHour: string, unitMinute: string): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? `${h} ${unitHour} ${m} ${unitMinute}` : `${m} ${unitMinute}`;
}
