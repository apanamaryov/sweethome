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

console.log("selfcheck-stats: db core OK");
