import { StatsDb, SAMPLE_FIELDS, SampleField, SampleRow, prevCalendarDay } from "./db";

/** Сэмпл со всеми нулевыми полями + переопределения (см. selfcheck-stats.ts). */
function sample(ts: number, over: Partial<Record<SampleField, number>> = {}, mode = "Battery"): SampleRow {
  const values = Object.fromEntries(SAMPLE_FIELDS.map((f) => [f, 0])) as SampleRow["values"];
  Object.assign(values, over);
  return { ts, mode, values };
}

/** Число из первой строки агрегатного SELECT (COUNT(*), и т.п.). */
const n = (rows: Array<Record<string, unknown>>) => Number(rows[0]?.n);

describe("StatsDb — schema", () => {
  let db: StatsDb;
  afterEach(() => db.close());

  it("creates the samples, samples_minute, daily, events tables on a fresh :memory: DB", () => {
    db = new StatsDb(":memory:");
    const tables = db
      .all("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .map((r) => r.name);
    expect(tables).toEqual(
      expect.arrayContaining(["samples", "samples_minute", "daily", "events"])
    );
  });
});

describe("StatsDb — insert samples/events", () => {
  let db: StatsDb;
  beforeEach(() => {
    db = new StatsDb(":memory:");
  });
  afterEach(() => db.close());

  it("insertSample/insertEvent inside a transaction land the expected row counts", () => {
    // Migrated 1:1 from selfcheck-stats.ts section 1.
    db.transaction(() => {
      db.insertSample(sample(60_000, { pvPower: 720, batteryCapacity: 70 }));
      db.insertSample(sample(65_000, { pvPower: 1440, batteryCapacity: 71 }));
      db.insertSample(sample(70_000, { pvPower: 2160, batteryCapacity: 72 }));
      db.insertEvent({ ts: 61_000, type: "grid-loss", detail: JSON.stringify({ gridVoltage: 12 }) });
    });
    expect(n(db.all("SELECT COUNT(*) AS n FROM samples"))).toBe(3);
    expect(n(db.all("SELECT COUNT(*) AS n FROM events"))).toBe(1);
  });
});

describe("StatsDb — rollupMinutes", () => {
  let db: StatsDb;
  afterEach(() => db.close());

  /**
   * Populates 12 raw samples spanning one full local minute (T0..T0+55s, 5s
   * cadence) plus one sample in the next minute, exactly as selfcheck-stats.ts
   * section 7 does. Returns the DB and the minute boundary T0.
   */
  function setupOneFullMinute(): { db: StatsDb; T0: number } {
    const T0 = Date.parse("2026-07-23T12:00:00"); // minute boundary: seconds = 0
    const d = new StatsDb(":memory:");
    d.transaction(() => {
      for (let i = 0; i < 12; i++)
        d.insertSample(
          sample(T0 + i * 5000, {
            pvPower: 720, // 720 W * 5s = 1 Wh per snapshot
            acOutputActivePower: 360,
            mainsPower: i < 6 ? 720 : -720, // only positive counts toward grid_wh
            batteryPower: i % 2 ? 720 : -720, // charge/discharge split evenly
            batteryCapacity: 70 + i,
          })
        );
      d.insertSample(sample(T0 + 60_000, { pvPower: 3600 })); // next minute — must not roll up yet
    });
    return { db: d, T0 };
  }

  it("rolls up one full minute into samples_minute with the expected aggregates", () => {
    const setup = setupOneFullMinute();
    db = setup.db;
    const { T0 } = setup;

    expect(db.rollupMinutes(T0 + 90_000, 5000)).toBe(1);
    const rows = db.all("SELECT * FROM samples_minute");
    expect(rows).toHaveLength(1);
    const m = rows[0] as Record<string, number>;
    // Golden values migrated 1:1 from selfcheck-stats.ts section 7.
    expect(m.ts).toBe(T0);
    expect(m.sample_count).toBe(12);
    expect(m.pvPower_avg).toBe(720);
    expect(m.pvPower_min).toBe(720);
    expect(m.pvPower_max).toBe(720);
    expect(m.batteryCapacity_min).toBe(70);
    expect(m.batteryCapacity_max).toBe(81);
    expect(m.pv_wh).toBe(12);
    expect(m.load_wh).toBe(6);
    expect(m.grid_wh).toBe(6);
    expect(m.batt_charge_wh).toBe(6);
    expect(m.batt_discharge_wh).toBe(6);
  });

  it("is idempotent: a second call after the watermark has moved rolls up nothing more", () => {
    const setup = setupOneFullMinute();
    db = setup.db;
    const { T0 } = setup;

    expect(db.rollupMinutes(T0 + 90_000, 5000)).toBe(1);
    expect(db.rollupMinutes(T0 + 90_000, 5000)).toBe(0);
    // No duplicate/overwritten row: still exactly one samples_minute row with the same values.
    const rows = db.all("SELECT * FROM samples_minute");
    expect(rows).toHaveLength(1);
    expect((rows[0] as Record<string, number>).pv_wh).toBe(12);
  });

  it("does not touch the current (not-yet-complete) minute", () => {
    const setup = setupOneFullMinute();
    db = setup.db;
    const { T0 } = setup;
    db.rollupMinutes(T0 + 90_000, 5000);
    // The lone sample at T0+60_000 belongs to the next minute, which was still open
    // at nowMs = T0+90_000 (floor to minute = T0+60_000, and rollup excludes "now"'s minute).
    expect(n(db.all("SELECT COUNT(*) AS n FROM samples_minute WHERE ts = ?", T0 + 60_000))).toBe(0);
  });
});

describe("StatsDb — rollupDaily", () => {
  let db: StatsDb;
  afterEach(() => db.close());

  /** Same one-full-minute fixture as above, already minute-rolled-up, plus one grid-loss event. */
  function setupOneRolledUpDay(): { db: StatsDb; T0: number } {
    const T0 = Date.parse("2026-07-23T12:00:00");
    const d = new StatsDb(":memory:");
    d.transaction(() => {
      for (let i = 0; i < 12; i++)
        d.insertSample(
          sample(T0 + i * 5000, {
            pvPower: 720,
            acOutputActivePower: 360,
            mainsPower: i < 6 ? 720 : -720,
            batteryPower: i % 2 ? 720 : -720,
            batteryCapacity: 70 + i,
          })
        );
      d.insertSample(sample(T0 + 60_000, { pvPower: 3600 }));
    });
    d.rollupMinutes(T0 + 90_000, 5000);
    d.insertEvent({ ts: T0 + 10_000, type: "grid-loss", detail: "{}" });
    return { db: d, T0 };
  }

  it("rolls up yesterday's completed local day into `daily` with the expected aggregates", () => {
    const setup = setupOneRolledUpDay();
    db = setup.db;
    const NOW = Date.parse("2026-07-24T03:00:00");

    expect(db.rollupDaily(NOW)).toBe(1);
    const rows = db.all("SELECT * FROM daily");
    expect(rows).toHaveLength(1);
    const d = rows[0] as Record<string, unknown>;
    // Golden values migrated 1:1 from selfcheck-stats.ts section 8.
    expect(d.day).toBe("2026-07-23");
    expect(d.pv_wh).toBe(12);
    expect(d.soc_min).toBe(70);
    expect(d.soc_max).toBe(81);
    expect(d.grid_loss_count).toBe(1);
    expect(d.sample_count).toBe(12);
  });

  it("is idempotent and advances the watermark to the calendar-yesterday of `today`", () => {
    const setup = setupOneRolledUpDay();
    db = setup.db;
    const NOW = Date.parse("2026-07-24T03:00:00");

    expect(db.rollupDaily(NOW)).toBe(1);
    expect(db.rollupDaily(NOW)).toBe(0);
    expect(n(db.all("SELECT COUNT(*) AS n FROM daily"))).toBe(1);
    expect(db.getMeta("daily_rollup_day")).toBe("2026-07-23");
  });
});

describe("StatsDb — prevCalendarDay (rollupDaily's watermark helper)", () => {
  // Pure function, no DB needed.
  it("handles month and year boundaries", () => {
    // Migrated 1:1 from selfcheck-stats.ts section 8 (DST-safe watermark logic).
    expect(prevCalendarDay("2026-03-01")).toBe("2026-02-28");
    expect(prevCalendarDay("2026-01-01")).toBe("2025-12-31");
  });
});

describe("StatsDb — retention (prune)", () => {
  let db: StatsDb;
  beforeEach(() => {
    db = new StatsDb(":memory:");
  });
  afterEach(() => db.close());

  it("removes raw samples older than rawDays and keeps fresh ones", () => {
    // Migrated 1:1 from selfcheck-stats.ts section 9 (13 fresh samples: 12 from the
    // full-minute fixture + 1 extra, then one stale sample older than 30 days).
    const T0 = Date.parse("2026-07-23T12:00:00");
    db.transaction(() => {
      for (let i = 0; i < 12; i++) db.insertSample(sample(T0 + i * 5000));
      db.insertSample(sample(T0 + 60_000));
    });
    const NOW = Date.parse("2026-07-24T03:00:00");
    db.insertSample(sample(NOW - 40 * 86_400_000)); // raw sample older than 30 days

    db.prune(NOW, 30, 730);

    expect(n(db.all("SELECT COUNT(*) AS n FROM samples WHERE ts < ?", NOW - 30 * 86_400_000))).toBe(0);
    expect(n(db.all("SELECT COUNT(*) AS n FROM samples"))).toBe(13);
  });

  it("keeps samples_minute rows produced by rollup (well within the 2-year window)", () => {
    // Migrated 1:1 from selfcheck-stats.ts section 9: after pruning raw samples,
    // the already-rolled-up minute must survive (minuteDays retention is separate/longer).
    const T0 = Date.parse("2026-07-23T12:00:00");
    db.transaction(() => {
      for (let i = 0; i < 12; i++) db.insertSample(sample(T0 + i * 5000));
    });
    db.rollupMinutes(T0 + 90_000, 5000);
    const NOW = Date.parse("2026-07-24T03:00:00");

    db.prune(NOW, 30, 730);

    expect(n(db.all("SELECT COUNT(*) AS n FROM samples_minute"))).toBe(1);
  });

  it("removes samples_minute rows older than minuteDays (2 years)", () => {
    const NOW = Date.parse("2026-07-24T03:00:00");
    const oldTs = NOW - 800 * 86_400_000; // > 730 days ago
    const freshTs = NOW - 1_000; // recent
    db.all("INSERT INTO samples_minute (ts, sample_count) VALUES (?, ?)", oldTs, 1);
    db.all("INSERT INTO samples_minute (ts, sample_count) VALUES (?, ?)", freshTs, 1);

    db.prune(NOW, 30, 730);

    expect(n(db.all("SELECT COUNT(*) AS n FROM samples_minute WHERE ts = ?", oldTs))).toBe(0);
    expect(n(db.all("SELECT COUNT(*) AS n FROM samples_minute WHERE ts = ?", freshTs))).toBe(1);
  });

  it("never removes daily or events rows, however old, regardless of rawDays/minuteDays", () => {
    // prune() has no code path touching `daily` or `events` at all — retention there
    // is indefinite by construction, not by a generous threshold.
    const NOW = Date.parse("2026-07-24T03:00:00");
    db.all("INSERT INTO daily (day, sample_count) VALUES (?, ?)", "2000-01-01", 0);
    db.insertEvent({ ts: 1, type: "grid-loss", detail: "{}" }); // unix epoch — far older than any retention window

    db.prune(NOW, 30, 730);

    expect(n(db.all("SELECT COUNT(*) AS n FROM daily"))).toBe(1);
    expect(n(db.all("SELECT COUNT(*) AS n FROM events"))).toBe(1);
  });
});
