import { StatsDb, SAMPLE_FIELDS, SampleField, SampleRow, prevCalendarDay, dayStartMs } from "./db";

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

describe("StatsDb — querySeries", () => {
  // Same 3-sample fixture as the "insert samples/events" test above
  // (selfcheck-stats.ts section 1), reused here for section 2.
  let db: StatsDb;
  beforeEach(() => {
    db = new StatsDb(":memory:");
    db.transaction(() => {
      db.insertSample(sample(60_000, { pvPower: 720, batteryCapacity: 70 }));
      db.insertSample(sample(65_000, { pvPower: 1440, batteryCapacity: 71 }));
      db.insertSample(sample(70_000, { pvPower: 2160, batteryCapacity: 72 }));
    });
  });
  afterEach(() => db.close());

  it("returns raw series values in time order, aliasing the time column as `t`", () => {
    // Migrated 1:1 from selfcheck-stats.ts section 2.
    const rows = db.querySeries(["pvPower"], 0, 100_000, "raw");
    expect(rows.map((r) => r.pvPower)).toEqual([720, 1440, 2160]);
    expect(rows[0].t).toBe(60_000);
  });

  it("downsamples to maxPoints when the raw series has more rows than requested", () => {
    // Migrated 1:1 from selfcheck-stats.ts section 2.
    const thin = db.querySeries(["pvPower"], 0, 100_000, "raw", 2);
    expect(thin).toHaveLength(2);
  });
});

describe("StatsDb — queryEvents", () => {
  // Same fixture as above, plus the section-1 grid-loss event at ts=61_000.
  let db: StatsDb;
  beforeEach(() => {
    db = new StatsDb(":memory:");
    db.transaction(() => {
      db.insertSample(sample(60_000, { pvPower: 720, batteryCapacity: 70 }));
      db.insertSample(sample(65_000, { pvPower: 1440, batteryCapacity: 71 }));
      db.insertSample(sample(70_000, { pvPower: 2160, batteryCapacity: 72 }));
      db.insertEvent({ ts: 61_000, type: "grid-loss", detail: JSON.stringify({ gridVoltage: 12 }) });
    });
  });
  afterEach(() => db.close());

  it("returns all events within limit/offset when no filter is given", () => {
    // Migrated 1:1 from selfcheck-stats.ts section 4.
    expect(db.queryEvents({ limit: 10, offset: 0 })).toHaveLength(1);
  });

  it("filters by type", () => {
    // Migrated 1:1 from selfcheck-stats.ts section 4.
    expect(db.queryEvents({ type: "grid-loss", limit: 10, offset: 0 })[0].ts).toBe(61_000);
  });

  it("returns nothing for a type that matches no event", () => {
    // Migrated 1:1 from selfcheck-stats.ts section 4.
    expect(db.queryEvents({ type: "other", limit: 10, offset: 0 })).toHaveLength(0);
  });
});

describe("StatsDb — CSV export (exportColumns/exportChunk)", () => {
  // Same 3-sample fixture as the querySeries block above (selfcheck-stats.ts section 5).
  let db: StatsDb;
  beforeEach(() => {
    db = new StatsDb(":memory:");
    db.transaction(() => {
      db.insertSample(sample(60_000, { pvPower: 720, batteryCapacity: 70 }));
      db.insertSample(sample(65_000, { pvPower: 1440, batteryCapacity: 71 }));
      db.insertSample(sample(70_000, { pvPower: 2160, batteryCapacity: 72 }));
    });
  });
  afterEach(() => db.close());

  it("exportColumns lists `ts` first for raw and includes `pv_wh` for minute", () => {
    // Migrated 1:1 from selfcheck-stats.ts section 5.
    expect(db.exportColumns("raw")[0]).toBe("ts");
    expect(db.exportColumns("minute")).toContain("pv_wh");
  });

  it("exportChunk returns every row when afterTs is before all samples", () => {
    // Migrated 1:1 from selfcheck-stats.ts section 5.
    expect(db.exportChunk("raw", -1, 100_000, 10)).toHaveLength(3);
  });

  it("exportChunk continues strictly after afterTs (exclusive lower bound)", () => {
    // Migrated 1:1 from selfcheck-stats.ts section 5.
    expect(db.exportChunk("raw", 65_000, 100_000, 10)).toHaveLength(1);
  });
});

describe("StatsDb — queryEnergy (hour/day buckets)", () => {
  let db: StatsDb;
  afterEach(() => db.close());

  it("buckets energy by hour and by local day, matching the hand-computed golden sums", () => {
    // Migrated 1:1 from selfcheck-stats.ts section 13.
    db = new StatsDb(":memory:");
    const H = (s: string) => Date.parse(s); // local time of the test environment
    // 720 W * (5000ms / 3.6e6) = 1 Wh per snapshot; one snapshot per minute.
    const eSample = (ts: number) => sample(ts, { pvPower: 720, mainsPower: 720 });
    db.transaction(() => {
      // Day 1, hour 10 — 3 minutes; hour 11 — 2 minutes.
      db.insertSample(eSample(H("2026-07-23T10:00:00")));
      db.insertSample(eSample(H("2026-07-23T10:01:00")));
      db.insertSample(eSample(H("2026-07-23T10:02:00")));
      db.insertSample(eSample(H("2026-07-23T11:00:00")));
      db.insertSample(eSample(H("2026-07-23T11:05:00")));
      // Day 2, hour 10 — 4 minutes.
      db.insertSample(eSample(H("2026-07-24T10:00:00")));
      db.insertSample(eSample(H("2026-07-24T10:01:00")));
      db.insertSample(eSample(H("2026-07-24T10:02:00")));
      db.insertSample(eSample(H("2026-07-24T10:03:00")));
    });
    db.rollupMinutes(H("2026-07-24T12:00:00"), 5000);

    const from = H("2026-07-23T00:00:00");
    const to = H("2026-07-24T23:59:59");
    const r3 = (x: number) => Number(x.toFixed(3));

    const hrs = db.queryEnergy(from, to, "hour");
    expect(hrs).toHaveLength(3);
    expect(r3(hrs.reduce((s, b) => s + b.pv_wh, 0))).toBe(9);
    expect(r3(hrs.reduce((s, b) => s + b.grid_wh, 0))).toBe(9);
    expect(hrs[0].t).toBe(Math.floor(H("2026-07-23T10:00:00") / 3_600_000) * 3_600_000);

    const days = db.queryEnergy(from, to, "day");
    expect(days).toHaveLength(2);
    expect(r3(days[0].pv_wh)).toBe(5);
    expect(r3(days[1].pv_wh)).toBe(4);
    expect(days[0].t).toBe(new Date(2026, 6, 23).getTime());
    expect(days[1].t).toBe(new Date(2026, 6, 24).getTime());
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

describe("StatsDb — окно солнечного дня", () => {
  let db: StatsDb;
  afterEach(() => db.close());

  const MIN = 60_000;

  /** Залить N минут подряд с заданным pvPower, начиная с ts0 (по одному сэмплу на минуту). */
  function seedMinutes(d: StatsDb, ts0: number, n: number, pv: number) {
    d.transaction(() => {
      for (let i = 0; i < n; i++) d.insertSample(sample(ts0 + i * MIN, { pvPower: pv }));
    });
  }

  it("свежая БД: таблица daily имеет столбцы solar_start_ts / solar_end_ts", () => {
    db = new StatsDb(":memory:");
    const cols = db.all("PRAGMA table_info(daily)").map((r) => r.name);
    expect(cols).toEqual(expect.arrayContaining(["solar_start_ts", "solar_end_ts"]));
  });

  it("querySolarWindow (ретроспектива): 16-минутный прогон → ended, start/end по минутам", () => {
    db = new StatsDb(":memory:", { thresholdW: 200, dwellMin: 15 });
    const day = "2026-01-15";
    const t8 = dayStartMs(day) + 8 * 60 * MIN;
    seedMinutes(db, t8, 16, 800); // 16 надпороговых минут ≥ dwell
    db.rollupMinutes(t8 + 60 * MIN, 60_000); // свернуть в samples_minute
    const w = db.querySolarWindow(day);
    expect(w.state).toBe("ended");
    expect(w.start).toBe(t8);
    expect(w.end).toBe(t8 + 15 * MIN);
  });

  it("querySolarWindow (live): передан nowMs вскоре после последней минуты → active", () => {
    db = new StatsDb(":memory:", { thresholdW: 200, dwellMin: 15 });
    const day = "2026-01-15";
    const t8 = dayStartMs(day) + 8 * 60 * MIN;
    seedMinutes(db, t8, 20, 800);
    const upto = t8 + 20 * MIN;
    db.rollupMinutes(upto, 60_000);
    const w = db.querySolarWindow(day, upto + 5 * MIN); // 5 мин после последней минуты
    expect(w.state).toBe("active");
    expect(w.start).toBe(t8);
    expect(w.end).toBeNull();
  });

  it("querySolarWindow: тёмный день → idle", () => {
    db = new StatsDb(":memory:", { thresholdW: 200, dwellMin: 15 });
    const day = "2026-01-15";
    const t8 = dayStartMs(day) + 8 * 60 * MIN;
    seedMinutes(db, t8, 30, 50); // всё ниже порога
    db.rollupMinutes(t8 + 60 * MIN, 60_000);
    expect(db.querySolarWindow(day)).toEqual({ start: null, end: null, state: "idle" });
  });

  it("rollupDaily пишет solar_start_ts / solar_end_ts в строку daily", () => {
    db = new StatsDb(":memory:", { thresholdW: 200, dwellMin: 15 });
    const day = "2026-01-15";
    const t8 = dayStartMs(day) + 8 * 60 * MIN;
    seedMinutes(db, t8, 16, 800);
    db.rollupMinutes(t8 + 60 * MIN, 60_000);
    db.rollupDaily(dayStartMs("2026-01-17")); // «сейчас» — позже, чтобы day был закрыт
    const row = db.all("SELECT solar_start_ts, solar_end_ts FROM daily WHERE day = ?", day)[0];
    expect(Number(row.solar_start_ts)).toBe(t8);
    expect(Number(row.solar_end_ts)).toBe(t8 + 15 * MIN);
  });
});
