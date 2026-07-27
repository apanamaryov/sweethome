import type { DailyRow } from "./stats";
import { formatDuration, formatMinutesOfDay, minutesOfDay, summarizeSolarDays } from "./solar";

/** Локальная метка времени — тесты не должны зависеть от таймзоны машины. */
const at = (day: string, h: number, m: number): number => {
  const [y, mo, d] = day.split("-").map(Number);
  return new Date(y, mo - 1, d, h, m, 0, 0).getTime();
};

const row = (day: string, start: number | null, end: number | null): DailyRow => ({
  day,
  pv_wh: 1000,
  load_wh: 900,
  grid_wh: 10,
  batt_charge_wh: 100,
  batt_discharge_wh: 90,
  solar_start_ts: start,
  solar_end_ts: end,
  soc_min: 50,
  soc_max: 100,
  grid_loss_count: 0,
  sample_count: 100,
});

describe("minutesOfDay", () => {
  it("counts from local midnight of that very day", () => {
    expect(minutesOfDay(at("2026-07-26", 8, 9))).toBe(8 * 60 + 9);
    expect(minutesOfDay(at("2026-01-05", 0, 0))).toBe(0);
    expect(minutesOfDay(at("2026-01-05", 23, 59))).toBe(23 * 60 + 59);
  });
});

describe("summarizeSolarDays", () => {
  it("returns the earliest start, the latest end and the average length", () => {
    const s = summarizeSolarDays([
      row("2026-07-24", at("2026-07-24", 8, 0), at("2026-07-24", 19, 0)), // 11 ч
      row("2026-07-25", at("2026-07-25", 7, 30), at("2026-07-25", 18, 0)), // 10.5 ч
      row("2026-07-26", at("2026-07-26", 9, 0), at("2026-07-26", 20, 30)), // 11.5 ч
    ])!;

    expect(formatMinutesOfDay(s.earliestStartMin)).toBe("7:30");
    expect(formatMinutesOfDay(s.latestEndMin)).toBe("20:30");
    expect(s.avgDurationMin).toBe(11 * 60); // (660 + 630 + 690) / 3
    expect(s.days).toBe(3);
  });

  it("skips days without a closed window", () => {
    const s = summarizeSolarDays([
      row("2026-07-24", at("2026-07-24", 8, 0), at("2026-07-24", 19, 0)),
      row("2026-07-25", null, null), // тёмный день
      row("2026-07-26", at("2026-07-26", 9, 0), null), // ещё идёт
    ])!;

    expect(s.days).toBe(1);
    expect(formatMinutesOfDay(s.earliestStartMin)).toBe("8:00");
  });

  it("returns null when no day has a window", () => {
    expect(summarizeSolarDays([row("2026-07-25", null, null)])).toBeNull();
    expect(summarizeSolarDays([])).toBeNull();
  });
});

describe("formatMinutesOfDay", () => {
  it("pads the minutes", () => {
    expect(formatMinutesOfDay(0)).toBe("0:00");
    expect(formatMinutesOfDay(9 * 60 + 5)).toBe("9:05");
    expect(formatMinutesOfDay(20 * 60 + 30)).toBe("20:30");
  });
});

describe("formatDuration", () => {
  it("drops the hours part below an hour", () => {
    expect(formatDuration(45, "ч", "мин")).toBe("45 мин");
    expect(formatDuration(0, "ч", "мин")).toBe("0 мин");
  });

  it("renders hours and minutes", () => {
    expect(formatDuration(11 * 60, "ч", "мин")).toBe("11 ч 0 мин");
    expect(formatDuration(7 * 60 + 12, "h", "min")).toBe("7 h 12 min");
  });
});
