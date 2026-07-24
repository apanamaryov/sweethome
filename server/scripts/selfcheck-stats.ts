import assert from "assert";
import { StatsDb, SAMPLE_FIELDS, SampleRow, localDay } from "../src/stats/db";

/** Сэмпл со всеми нулями + переопределения. */
export function sample(
  ts: number,
  over: Partial<Record<(typeof SAMPLE_FIELDS)[number], number>> = {},
  mode = "Battery"
): SampleRow {
  const values = Object.fromEntries(SAMPLE_FIELDS.map((f) => [f, 0])) as SampleRow["values"];
  Object.assign(values, over);
  return { ts, mode, values };
}

const n = (rows: Array<Record<string, unknown>>) => Number(rows[0]?.n);

// ---------- 1. Схема, вставка, транзакция ----------
const db = new StatsDb(":memory:");
db.transaction(() => {
  db.insertSample(sample(60_000, { pvPower: 720, batteryCapacity: 70 }));
  db.insertSample(sample(65_000, { pvPower: 1440, batteryCapacity: 71 }));
  db.insertSample(sample(70_000, { pvPower: 2160, batteryCapacity: 72 }));
  db.insertEvent({ ts: 61_000, type: "grid-loss", detail: JSON.stringify({ gridVoltage: 12 }) });
});
assert.strictEqual(n(db.all("SELECT COUNT(*) AS n FROM samples")), 3, "3 samples inserted");
assert.strictEqual(n(db.all("SELECT COUNT(*) AS n FROM events")), 1, "1 event inserted");

// ---------- 2. querySeries: raw и прореживание ----------
const rows = db.querySeries(["pvPower"], 0, 100_000, "raw");
assert.deepStrictEqual(rows.map((r) => r.pvPower), [720, 1440, 2160], "raw series values");
assert.strictEqual(rows[0].t, 60_000, "time column is t");
const thin = db.querySeries(["pvPower"], 0, 100_000, "raw", 2);
assert.strictEqual(thin.length, 2, "downsampled to maxPoints");

// ---------- 3. meta ----------
db.setMeta("x", "1");
assert.strictEqual(db.getMeta("x"), "1");
assert.strictEqual(db.getMeta("nope"), null);

// ---------- 4. queryEvents ----------
assert.strictEqual(db.queryEvents({ limit: 10, offset: 0 }).length, 1);
assert.strictEqual(db.queryEvents({ type: "grid-loss", limit: 10, offset: 0 })[0].ts, 61_000);
assert.strictEqual(db.queryEvents({ type: "other", limit: 10, offset: 0 }).length, 0);

// ---------- 5. CSV-экспорт ----------
assert.strictEqual(db.exportColumns("raw")[0], "ts");
assert.ok(db.exportColumns("minute").includes("pv_wh"));
assert.strictEqual(db.exportChunk("raw", -1, 100_000, 10).length, 3);
assert.strictEqual(db.exportChunk("raw", 65_000, 100_000, 10).length, 1, "chunk continues after ts");

// ---------- 6. localDay ----------
assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(localDay(Date.parse("2026-07-23T12:00:00"))));
assert.strictEqual(localDay(Date.parse("2026-07-23T12:00:00")), "2026-07-23");

// ---------- 7. Поминутная свёртка ----------
// Вчера 12:00 локального времени — граница минуты (полдень: секунды = 0).
const T0 = Date.parse("2026-07-23T12:00:00");
const db2 = new StatsDb(":memory:");
db2.transaction(() => {
  for (let i = 0; i < 12; i++)
    db2.insertSample(
      sample(T0 + i * 5000, {
        pvPower: 720, // 720 Вт × 5 с = 1 Вт·ч на снапшот
        acOutputActivePower: 360,
        mainsPower: i < 6 ? 720 : -720, // в grid_wh идёт только положительное
        batteryPower: i % 2 ? 720 : -720, // поровну заряд/разряд
        batteryCapacity: 70 + i,
      })
    );
  db2.insertSample(sample(T0 + 60_000, { pvPower: 3600 })); // соседняя минута — не сворачивается
});
assert.strictEqual(db2.rollupMinutes(T0 + 90_000, 5000), 1, "one full minute rolled");
const m = db2.all("SELECT * FROM samples_minute")[0] as Record<string, number>;
assert.strictEqual(m.ts, T0);
assert.strictEqual(m.sample_count, 12);
assert.strictEqual(m.pvPower_avg, 720);
assert.strictEqual(m.pvPower_min, 720);
assert.strictEqual(m.pvPower_max, 720);
assert.strictEqual(m.batteryCapacity_min, 70);
assert.strictEqual(m.batteryCapacity_max, 81);
assert.strictEqual(m.pv_wh, 12);
assert.strictEqual(m.load_wh, 6);
assert.strictEqual(m.grid_wh, 6);
assert.strictEqual(m.batt_charge_wh, 6);
assert.strictEqual(m.batt_discharge_wh, 6);
assert.strictEqual(db2.rollupMinutes(T0 + 90_000, 5000), 0, "idempotent: watermark moved");

// ---------- 8. Суточная свёртка ----------
db2.insertEvent({ ts: T0 + 10_000, type: "grid-loss", detail: "{}" });
const NOW = Date.parse("2026-07-24T03:00:00");
assert.strictEqual(db2.rollupDaily(NOW), 1, "yesterday rolled");
const d = db2.all("SELECT * FROM daily")[0] as Record<string, unknown>;
assert.strictEqual(d.day, "2026-07-23");
assert.strictEqual(d.pv_wh, 12);
assert.strictEqual(d.soc_min, 70);
assert.strictEqual(d.soc_max, 81);
assert.strictEqual(d.grid_loss_count, 1);
assert.strictEqual(d.sample_count, 12);
assert.strictEqual(db2.rollupDaily(NOW), 0, "idempotent: no new days");

// ---------- 9. Retention ----------
db2.insertSample(sample(NOW - 40 * 86_400_000)); // сырьё старше 30 дней
db2.prune(NOW, 30, 730);
assert.strictEqual(
  n(db2.all("SELECT COUNT(*) AS n FROM samples WHERE ts < ?", NOW - 30 * 86_400_000)),
  0,
  "old raw pruned"
);
assert.strictEqual(n(db2.all("SELECT COUNT(*) AS n FROM samples")), 13, "fresh raw kept");
assert.strictEqual(n(db2.all("SELECT COUNT(*) AS n FROM samples_minute")), 1, "minutes kept");

console.log("selfcheck-stats: db core + rollups OK");
