import { DatabaseSync, StatementSync } from "node:sqlite";
import { InverterStatus } from "@sweethome/inverter-shared";
import { computeSolarWindow, SolarParams, SolarWindow } from "./solar";

/** Числовые поля InverterStatus в сырой таблице (порядок = порядок колонок). */
export const SAMPLE_FIELDS = [
  "gridVoltage", "gridFrequency", "mainsPower", "inverterPower",
  "acOutputVoltage", "acOutputFrequency", "acOutputActivePower", "acOutputApparentPower",
  "outputLoadPercent", "batteryVoltage", "batteryPower", "batteryChargingCurrent",
  "batteryDischargeCurrent", "batteryCapacity", "pvInputVoltage", "pvInputCurrent",
  "pvPower", "pvChargingPower", "dcdcTemperature", "heatSinkTemperature",
] as const satisfies readonly (keyof InverterStatus)[];
export type SampleField = (typeof SAMPLE_FIELDS)[number];

/** Величины, сворачиваемые в samples_minute и доступные в /api/stats/series. */
export const GAUGE_FIELDS = [
  "pvPower", "acOutputActivePower", "mainsPower", "batteryPower", "batteryVoltage",
  "batteryCapacity", "gridVoltage", "outputLoadPercent", "dcdcTemperature", "heatSinkTemperature",
] as const satisfies readonly SampleField[];
export type GaugeField = (typeof GAUGE_FIELDS)[number];

export interface SampleRow {
  ts: number; // unix ms UTC
  mode: string; // DeviceMode как текст
  values: Record<SampleField, number>;
}
export interface StatsEventRow {
  ts: number;
  type: string;
  detail: string; // JSON
}

/** Энергия (Вт·ч) за одну корзину времени. `t` — начало корзины, unix ms. */
export interface EnergyBucket {
  t: number;
  pv_wh: number;
  load_wh: number;
  grid_wh: number;
  batt_charge_wh: number;
  batt_discharge_wh: number;
}

/** YYYY-MM-DD в локальном часовом поясе хоста. */
export function localDay(ms: number): string {
  const d = new Date(ms);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Календарный день перед `day` (YYYY-MM-DD) — через полдень, безопасно к DST. */
export function prevCalendarDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return localDay(new Date(y, m - 1, d - 1, 12).getTime());
}

/** Unix ms локальной полуночи дня `day` (YYYY-MM-DD). */
export function dayStartMs(day: string): number {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d, 0).getTime();
}

/** Unix ms локальной полуночи дня, СЛЕДУЮЩЕГО за `day`. DST-безопасно (компонентная арифметика). */
export function nextDayStartMs(day: string): number {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d + 1, 0).getTime();
}

const ENERGY_COLS = ["pv_wh", "load_wh", "grid_wh", "batt_charge_wh", "batt_discharge_wh"];
const SAMPLE_COLS = ["ts", "mode", ...SAMPLE_FIELDS];
const MINUTE_COLS = [
  "ts", "sample_count",
  ...GAUGE_FIELDS.flatMap((f) => [`${f}_avg`, `${f}_min`, `${f}_max`]),
  ...ENERGY_COLS,
];
const DAY_EXPR = "strftime('%Y-%m-%d', ts / 1000, 'unixepoch', 'localtime')";

const DEFAULT_SOLAR: SolarParams = { thresholdW: 200, dwellMin: 15 };

export class StatsDb {
  private db: DatabaseSync;
  private solar: SolarParams;
  private insSample!: StatementSync;
  private insEvent!: StatementSync;
  private getMetaStmt!: StatementSync;
  private setMetaStmt!: StatementSync;
  private minuteStmt!: StatementSync;
  private dailyStmt!: StatementSync;
  private dailyQueryStmt!: StatementSync;
  private exportStmt!: { raw: StatementSync; minute: StatementSync };
  private solarUpdStmt!: StatementSync;

  constructor(file: string, solar: SolarParams = DEFAULT_SOLAR) {
    this.solar = solar;
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.migrate();
    this.prepare();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    const v = (this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    if (v < 1) {
      this.db.exec(`
        CREATE TABLE samples (
          ts INTEGER PRIMARY KEY,
          mode TEXT NOT NULL,
          ${SAMPLE_FIELDS.map((f) => `${f} REAL`).join(",\n        ")}
        );
        CREATE TABLE samples_minute (
          ts INTEGER PRIMARY KEY,
          sample_count INTEGER NOT NULL,
          ${GAUGE_FIELDS.map((f) => `${f}_avg REAL, ${f}_min REAL, ${f}_max REAL`).join(",\n        ")},
          ${ENERGY_COLS.map((c) => `${c} REAL`).join(", ")}
        );
        CREATE TABLE daily (
          day TEXT PRIMARY KEY,
          ${ENERGY_COLS.map((c) => `${c} REAL`).join(", ")},
          soc_min REAL, soc_max REAL, grid_loss_count INTEGER, sample_count INTEGER
        );
        CREATE TABLE events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts INTEGER NOT NULL,
          type TEXT NOT NULL,
          detail TEXT NOT NULL
        );
        CREATE INDEX idx_events_ts ON events(ts);
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        PRAGMA user_version = 1;
      `);
    }
    if (v < 2) this.migrateV2();
  }

  /** v1→v2: столбцы окна солнечного дня + разовый бэкофилл истории из samples_minute.
   *  Вся миграция — в одной транзакции: при обрыве процесса между ALTER и
   *  PRAGMA user_version откат вернёт схему к v1 целиком, и следующий старт
   *  чисто повторит миграцию (без «duplicate column name» на повторном ALTER). */
  private migrateV2(): void {
    this.transaction(() => {
      this.db.exec(`
        ALTER TABLE daily ADD COLUMN solar_start_ts INTEGER;
        ALTER TABLE daily ADD COLUMN solar_end_ts INTEGER;
      `);
      const days = this.db
        .prepare(`SELECT DISTINCT ${DAY_EXPR} AS day FROM samples_minute ORDER BY 1`)
        .all() as Array<{ day: string }>;
      const upd = this.db.prepare(
        "UPDATE daily SET solar_start_ts = ?, solar_end_ts = ? WHERE day = ?"
      );
      for (const { day } of days) {
        const w = this.windowForDay(day);
        upd.run(w.start, w.end, day);
      }
      this.db.exec("PRAGMA user_version = 2");
    });
  }

  private prepare(): void {
    this.insSample = this.db.prepare(
      `INSERT OR REPLACE INTO samples (${SAMPLE_COLS.join(", ")})
       VALUES (${SAMPLE_COLS.map(() => "?").join(", ")})`
    );
    this.insEvent = this.db.prepare("INSERT INTO events (ts, type, detail) VALUES (?, ?, ?)");
    this.getMetaStmt = this.db.prepare("SELECT value FROM meta WHERE key = ?");
    this.setMetaStmt = this.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)");
    // Поминутная свёртка: сырьё [from, upto) группируется по минутам.
    // 5 параметров ? — коэффициент Вт → Вт·ч на один снапшот (pollIntervalMs / 3 600 000).
    this.minuteStmt = this.db.prepare(`
      INSERT OR REPLACE INTO samples_minute (${MINUTE_COLS.join(", ")})
      SELECT (ts / 60000) * 60000, COUNT(*),
        ${GAUGE_FIELDS.map((f) => `avg(${f}), min(${f}), max(${f})`).join(",\n        ")},
        sum(pvPower) * ?,
        sum(acOutputActivePower) * ?,
        sum(CASE WHEN mainsPower > 0 THEN mainsPower ELSE 0 END) * ?,
        sum(CASE WHEN batteryPower > 0 THEN batteryPower ELSE 0 END) * ?,
        sum(CASE WHEN batteryPower < 0 THEN -batteryPower ELSE 0 END) * ?
      FROM samples WHERE ts >= ? AND ts < ?
      GROUP BY ts / 60000
    `);
    this.dailyStmt = this.db.prepare(`
      INSERT OR REPLACE INTO daily
        (day, ${ENERGY_COLS.join(", ")}, soc_min, soc_max, grid_loss_count, sample_count)
      SELECT $day, ${ENERGY_COLS.map((c) => `sum(${c})`).join(", ")},
        min(batteryCapacity_min), max(batteryCapacity_max),
        (SELECT COUNT(*) FROM events e WHERE e.type = 'grid-loss'
           AND e.ts >= $dayStart AND e.ts < $dayEnd
           AND strftime('%Y-%m-%d', e.ts / 1000, 'unixepoch', 'localtime') = $day),
        sum(sample_count)
      FROM samples_minute
      WHERE ts >= $dayStart AND ts < $dayEnd AND ${DAY_EXPR} = $day
    `);
    this.dailyQueryStmt = this.db.prepare("SELECT * FROM daily WHERE day >= ? AND day <= ? ORDER BY day");
    this.solarUpdStmt = this.db.prepare(
      "UPDATE daily SET solar_start_ts = ?, solar_end_ts = ? WHERE day = ?"
    );
    this.exportStmt = {
      raw: this.db.prepare(`SELECT ${SAMPLE_COLS.join(", ")} FROM samples WHERE ts > ? AND ts <= ? ORDER BY ts LIMIT ?`),
      minute: this.db.prepare(`SELECT ${MINUTE_COLS.join(", ")} FROM samples_minute WHERE ts > ? AND ts <= ? ORDER BY ts LIMIT ?`),
    };
  }

  transaction(fn: () => void): void {
    this.db.exec("BEGIN");
    try {
      fn();
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  insertSample(row: SampleRow): void {
    this.insSample.run(row.ts, row.mode, ...SAMPLE_FIELDS.map((f) => row.values[f]));
  }

  insertEvent(ev: StatsEventRow): void {
    this.insEvent.run(ev.ts, ev.type, ev.detail);
  }

  getMeta(key: string): string | null {
    const r = this.getMetaStmt.get(key) as { value: string } | undefined;
    return r ? r.value : null;
  }

  setMeta(key: string, value: string): void {
    this.setMetaStmt.run(key, value);
  }

  /** Свернуть полностью прошедшие минуты. Возвращает число вставленных строк. */
  rollupMinutes(nowMs: number, pollIntervalMs: number): number {
    const upto = Math.floor(nowMs / 60_000) * 60_000; // текущая минута не трогается
    const from = Number(this.getMeta("minute_rollup_ts") ?? 0);
    if (upto <= from) return 0;
    const k = pollIntervalMs / 3_600_000; // Вт → Вт·ч на один снапшот
    const info = this.minuteStmt.run(k, k, k, k, k, from, upto);
    this.setMeta("minute_rollup_ts", String(upto));
    return Number(info.changes);
  }

  /** Свернуть завершённые локальные дни. Возвращает число свёрнутых дней. */
  rollupDaily(nowMs: number): number {
    const today = localDay(nowMs);
    const last = this.getMeta("daily_rollup_day") ?? "";
    const minTs = last ? nextDayStartMs(last) : 0;
    const days = this.db
      .prepare(
        `SELECT DISTINCT ${DAY_EXPR} AS day FROM samples_minute
         WHERE ts >= ? AND ${DAY_EXPR} > ? AND ${DAY_EXPR} < ? ORDER BY 1`
      )
      .all(minTs, last, today) as Array<{ day: string }>;
    for (const { day } of days) {
      this.dailyStmt.run({ day, dayStart: dayStartMs(day), dayEnd: nextDayStartMs(day) });
      const w = this.windowForDay(day); // закрытый день → ретроспектива
      this.solarUpdStmt.run(w.start, w.end, day);
    }
    // Watermark — календарное «вчера» от today (не now-24ч: на 25-часовом дне
    // осеннего перевода это выражение может вернуть сам today и навсегда
    // пропустить его свёртку).
    this.setMeta("daily_rollup_day", prevCalendarDay(today));
    return days.length;
  }

  /** Удалить сырьё старше rawDays и поминутки старше minuteDays. */
  prune(nowMs: number, rawDays: number, minuteDays: number): void {
    this.db.prepare("DELETE FROM samples WHERE ts < ?").run(nowMs - rawDays * 86_400_000);
    this.db.prepare("DELETE FROM samples_minute WHERE ts < ?").run(nowMs - minuteDays * 86_400_000);
  }

  querySeries(
    fields: GaugeField[],
    from: number,
    to: number,
    res: "raw" | "minute",
    maxPoints = 2000
  ): Array<Record<string, number | null>> {
    const cols =
      res === "raw" ? fields.join(", ") : fields.map((f) => `${f}_avg AS ${f}`).join(", ");
    const table = res === "raw" ? "samples" : "samples_minute";
    // SQL динамический (состав полей) — кэшировать statement нецелесообразно
    const rows = this.db
      .prepare(`SELECT ts AS t, ${cols} FROM ${table} WHERE ts >= ? AND ts <= ? ORDER BY ts`)
      .all(from, to) as Array<Record<string, number | null>>;
    if (rows.length <= maxPoints) return rows;
    const step = Math.ceil(rows.length / maxPoints);
    return rows.filter((_, i) => i % step === 0);
  }

  queryDaily(fromDay: string, toDay: string): Array<Record<string, unknown>> {
    return this.dailyQueryStmt.all(fromDay, toDay) as Array<Record<string, unknown>>;
  }

  /** Окно солнечного дня по минуткам локального дня `day`. Общий движок для
   *  свёртки, бэкофилла и live-запроса. `nowMs` задаётся только для «сегодня». */
  private windowForDay(day: string, nowMs?: number): SolarWindow {
    const rows = this.db
      .prepare(
        "SELECT ts, pvPower_avg AS pv FROM samples_minute WHERE ts >= ? AND ts < ? ORDER BY ts"
      )
      .all(dayStartMs(day), nextDayStartMs(day)) as Array<{ ts: number; pv: number | null }>;
    const points = rows.map((r) => ({ ts: Number(r.ts), pv: Number(r.pv) || 0 }));
    return computeSolarWindow(points, this.solar, nowMs);
  }

  querySolarWindow(day: string, nowMs?: number): SolarWindow {
    return this.windowForDay(day, nowMs);
  }

  /**
   * Энергия (Вт·ч) по корзинам из samples_minute — включает текущую незакрытую
   * корзину (в отличие от таблицы daily). `bucket="hour"` — по часам (для вида
   * «день»), `"day"` — по локальным суткам (для «недели»/«месяца»). Диапазон
   * ограничен по ts (PK-индекс), без полного скана.
   */
  queryEnergy(from: number, to: number, bucket: "hour" | "day"): EnergyBucket[] {
    const sums = ENERGY_COLS.map((c) => `sum(${c}) AS ${c}`).join(", ");
    // SQL статичен для каждого bucket, но набор из двух вариантов мал — не кэшируем.
    const rows =
      bucket === "hour"
        ? (this.db
            .prepare(
              `SELECT (ts / 3600000) * 3600000 AS bucket, ${sums}
               FROM samples_minute WHERE ts >= ? AND ts <= ? GROUP BY ts / 3600000 ORDER BY bucket`
            )
            .all(from, to) as Array<Record<string, number>>)
        : (this.db
            .prepare(
              `SELECT ${DAY_EXPR} AS bucket, ${sums}
               FROM samples_minute WHERE ts >= ? AND ts <= ? GROUP BY ${DAY_EXPR} ORDER BY bucket`
            )
            .all(from, to) as Array<Record<string, string | number>>);
    return rows.map((r) => ({
      // Дневная корзина: начало суток считаем в JS от строки дня (DST-безопасно).
      t: bucket === "hour" ? Number(r.bucket) : dayStartMs(String(r.bucket)),
      pv_wh: Number(r.pv_wh) || 0,
      load_wh: Number(r.load_wh) || 0,
      grid_wh: Number(r.grid_wh) || 0,
      batt_charge_wh: Number(r.batt_charge_wh) || 0,
      batt_discharge_wh: Number(r.batt_discharge_wh) || 0,
    }));
  }

  queryEvents(opts: {
    from?: number;
    to?: number;
    type?: string;
    limit: number;
    offset: number;
  }): Array<{ id: number; ts: number; type: string; detail: string }> {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (opts.from !== undefined) { where.push("ts >= ?"); params.push(opts.from); }
    if (opts.to !== undefined) { where.push("ts <= ?"); params.push(opts.to); }
    if (opts.type) { where.push("type = ?"); params.push(opts.type); }
    // SQL динамический (WHERE-условия) — кэшировать statement нецелесообразно
    const sql = `SELECT id, ts, type, detail FROM events
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?`;
    return this.db.prepare(sql).all(...params, opts.limit, opts.offset) as Array<{
      id: number; ts: number; type: string; detail: string;
    }>;
  }

  exportColumns(kind: "raw" | "minute"): string[] {
    return kind === "raw" ? [...SAMPLE_COLS] : [...MINUTE_COLS];
  }

  /** Порция строк для потокового CSV: ts > afterTs, до `to`, максимум `limit`. */
  exportChunk(
    kind: "raw" | "minute",
    afterTs: number,
    to: number,
    limit: number
  ): Array<Record<string, unknown>> {
    return this.exportStmt[kind].all(afterTs, to, limit) as Array<Record<string, unknown>>;
  }

  /** Сырой SELECT для тестов и диагностики. */
  all(sql: string, ...params: Array<string | number>): Array<Record<string, unknown>> {
    return this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
  }
}
