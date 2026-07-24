import assert from "assert";
import { StatsDb, SAMPLE_FIELDS, SampleRow, localDay, prevCalendarDay } from "../src/stats/db";

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
assert.strictEqual(db2.getMeta("daily_rollup_day"), "2026-07-23", "watermark = календарное вчера");
assert.strictEqual(prevCalendarDay("2026-03-01"), "2026-02-28", "prevCalendarDay: граница месяца");
assert.strictEqual(prevCalendarDay("2026-01-01"), "2025-12-31", "prevCalendarDay: граница года");

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

// ---------- 10. Recorder: буфер, события, идемпотентный флаш ----------
import { StatsRecorder } from "../src/stats/recorder";
import { FAULTS } from "../src/protocol/smg";
import { DeviceMode, InverterStatus, Snapshot } from "@inverter/shared";

function snap(
  ts: number,
  over: {
    connected?: boolean;
    mode?: DeviceMode;
    grid?: number;
    warnings?: string[];
    status?: Partial<InverterStatus>;
    deviceId?: string;
  } = {}
): Snapshot {
  const connected = over.connected ?? true;
  const base = Object.fromEntries(SAMPLE_FIELDS.map((f) => [f, 0])) as unknown as InverterStatus;
  const status: InverterStatus | null = connected
    ? { ...base, raw: "", gridVoltage: over.grid ?? 230, ...over.status }
    : null;
  return {
    timestamp: ts,
    connection: {
      connected,
      transport: connected ? "serial" : "none",
      device: "/dev/ttyUSB0",
      deviceId: connected ? (over.deviceId ?? "smg-test") : null,
      mock: false,
      lastError: connected ? null : "read timeout",
    },
    control: { allowControl: true, locked: true },
    mode: over.mode ?? "Line",
    status,
    info: null,
    flags: null,
    warnings: connected ? { active: over.warnings ?? [], raw: "" } : null,
    baseline: null,
  };
}

const db3 = new StatsDb(":memory:");
const rec = new StatsRecorder(db3, { pollIntervalMs: 5000, rawDays: 30, minuteDays: 730 });
const B = Date.parse("2026-07-24T10:00:00");
rec.handleSnapshot(snap(B)); //                                       первый — событий нет
rec.handleSnapshot(snap(B + 5000, { mode: "Battery", grid: 12 })); // mode-change + grid-loss
rec.handleSnapshot(snap(B + 10000, { mode: "Battery", grid: 12, warnings: ["Battery low"] })); // warning-set
rec.handleSnapshot(
  snap(B + 15000, { mode: "Battery", grid: 12, warnings: ["Battery low", FAULTS[0]] })
); //                                                                 fault-set
rec.handleSnapshot(snap(B + 20000, { connected: false })); //         conn-lost
rec.handleSnapshot(snap(B + 25000)); //                               conn-restored, без ложных диффов
rec.flush(B + 26_000);

assert.strictEqual(n(db3.all("SELECT COUNT(*) AS n FROM samples")), 5, "disconnected snapshot not sampled");
const types = db3.queryEvents({ limit: 100, offset: 0 }).map((e) => e.type).sort();
assert.deepStrictEqual(
  types,
  ["conn-lost", "conn-restored", "fault-set", "grid-loss", "mode-change", "warning-set"].sort()
);
const mc = db3.queryEvents({ type: "mode-change", limit: 10, offset: 0 })[0];
assert.deepStrictEqual(JSON.parse(mc.detail), { from: "Line", to: "Battery" });

rec.flush(B + 27_000); // повторный флаш ничего не дублирует
assert.strictEqual(n(db3.all("SELECT COUNT(*) AS n FROM samples")), 5);
assert.strictEqual(n(db3.all("SELECT COUNT(*) AS n FROM events")), 6);

// ---------- 11. Потолок pending-событий ----------
// pollIntervalMs=600000 → maxBuffered=1: из трёх mode-change выживает последний.
const db4 = new StatsDb(":memory:");
const rec2 = new StatsRecorder(db4, { pollIntervalMs: 600_000, rawDays: 30, minuteDays: 730 });
const C = Date.parse("2026-07-24T12:00:00");
rec2.handleSnapshot(snap(C));
rec2.handleSnapshot(snap(C + 5000, { mode: "Battery" }));
rec2.handleSnapshot(snap(C + 10000, { mode: "Line" }));
rec2.handleSnapshot(snap(C + 15000, { mode: "Battery" }));
rec2.flush(C + 16_000);
assert.strictEqual(n(db4.all("SELECT COUNT(*) AS n FROM events")), 1, "pending capped at maxBuffered");
assert.strictEqual(
  JSON.parse(db4.queryEvents({ limit: 1, offset: 0 })[0].detail).to,
  "Battery",
  "выжило последнее событие"
);

// ---------- 12. device-changed между рестартами через meta.device_id ----------
const db5 = new StatsDb(":memory:");
db5.setMeta("device_id", "old-dev");
const rec3 = new StatsRecorder(db5, { pollIntervalMs: 5000, rawDays: 30, minuteDays: 730 });
const D = Date.parse("2026-07-24T14:00:00");
rec3.handleSnapshot(snap(D));
rec3.flush(D + 1000);
const dc = db5.queryEvents({ type: "device-changed", limit: 10, offset: 0 });
assert.strictEqual(dc.length, 1, "device-changed после «рестарта» с другим устройством");
assert.deepStrictEqual(JSON.parse(dc[0].detail), { from: "old-dev", to: "smg-test" });
assert.strictEqual(db5.getMeta("device_id"), "smg-test", "meta.device_id обновлён");

// ---------- 13. queryEnergy: корзины по часам и по суткам ----------
const db6 = new StatsDb(":memory:");
const H = (s: string) => Date.parse(s); // локальное время окружения
// 720 Вт × (5000 мс / 3.6e6) = 1 Вт·ч на снапшот; по одному снапшоту в минуту.
const eSample = (ts: number) => sample(ts, { pvPower: 720, mainsPower: 720 });
db6.transaction(() => {
  // День 1, час 10 — 3 минуты; час 11 — 2 минуты.
  db6.insertSample(eSample(H("2026-07-23T10:00:00")));
  db6.insertSample(eSample(H("2026-07-23T10:01:00")));
  db6.insertSample(eSample(H("2026-07-23T10:02:00")));
  db6.insertSample(eSample(H("2026-07-23T11:00:00")));
  db6.insertSample(eSample(H("2026-07-23T11:05:00")));
  // День 2, час 10 — 4 минуты.
  db6.insertSample(eSample(H("2026-07-24T10:00:00")));
  db6.insertSample(eSample(H("2026-07-24T10:01:00")));
  db6.insertSample(eSample(H("2026-07-24T10:02:00")));
  db6.insertSample(eSample(H("2026-07-24T10:03:00")));
});
db6.rollupMinutes(H("2026-07-24T12:00:00"), 5000);

const eFrom = H("2026-07-23T00:00:00");
const eTo = H("2026-07-24T23:59:59");
const r3 = (x: number) => Number(x.toFixed(3));

const hrs = db6.queryEnergy(eFrom, eTo, "hour");
assert.strictEqual(hrs.length, 3, "три часовые корзины");
assert.strictEqual(r3(hrs.reduce((s, b) => s + b.pv_wh, 0)), 9, "часы: сумма pv_wh");
assert.strictEqual(r3(hrs.reduce((s, b) => s + b.grid_wh, 0)), 9, "часы: сумма grid_wh");
assert.strictEqual(
  hrs[0].t,
  Math.floor(H("2026-07-23T10:00:00") / 3_600_000) * 3_600_000,
  "часовая корзина выровнена по началу часа"
);

const days = db6.queryEnergy(eFrom, eTo, "day");
assert.strictEqual(days.length, 2, "две суточные корзины");
assert.strictEqual(r3(days[0].pv_wh), 5, "сутки 1: pv_wh (3+2)");
assert.strictEqual(r3(days[1].pv_wh), 4, "сутки 2: pv_wh");
assert.strictEqual(days[0].t, new Date(2026, 6, 23).getTime(), "суточная корзина = локальная полночь дня 1");
assert.strictEqual(days[1].t, new Date(2026, 6, 24).getTime(), "суточная корзина = локальная полночь дня 2");

console.log("selfcheck-stats: db + rollups + recorder + energy OK");
