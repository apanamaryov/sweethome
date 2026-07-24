import { DatabaseSync, StatementSync } from "node:sqlite";
import { InverterStatus } from "@inverter/shared";

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

/** YYYY-MM-DD в локальном часовом поясе хоста. */
export function localDay(ms: number): string {
  const d = new Date(ms);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const ENERGY_COLS = ["pv_wh", "load_wh", "grid_wh", "batt_charge_wh", "batt_discharge_wh"];
const SAMPLE_COLS = ["ts", "mode", ...SAMPLE_FIELDS];
const MINUTE_COLS = [
  "ts", "sample_count",
  ...GAUGE_FIELDS.flatMap((f) => [`${f}_avg`, `${f}_min`, `${f}_max`]),
  ...ENERGY_COLS,
];
const DAY_EXPR = "strftime('%Y-%m-%d', ts / 1000, 'unixepoch', 'localtime')";

export class StatsDb {
  private db: DatabaseSync;
  private insSample!: StatementSync;
  private insEvent!: StatementSync;
  private getMetaStmt!: StatementSync;
  private setMetaStmt!: StatementSync;
  private minuteStmt!: StatementSync;
  private dailyStmt!: StatementSync;
  private dailyQueryStmt!: StatementSync;
  private exportStmt!: { raw: StatementSync; minute: StatementSync };

  constructor(file: string) {
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
    if (v >= 1) return;
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
           AND strftime('%Y-%m-%d', e.ts / 1000, 'unixepoch', 'localtime') = $day),
        sum(sample_count)
      FROM samples_minute
      WHERE ${DAY_EXPR} = $day
    `);
    this.dailyQueryStmt = this.db.prepare("SELECT * FROM daily WHERE day >= ? AND day <= ? ORDER BY day");
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
    const days = this.db
      .prepare(
        `SELECT DISTINCT ${DAY_EXPR} AS day FROM samples_minute
         WHERE ${DAY_EXPR} > ? AND ${DAY_EXPR} < ? ORDER BY 1`
      )
      .all(last, today) as Array<{ day: string }>;
    for (const { day } of days) this.dailyStmt.run({ day });
    // Идемпотентный REPLACE делает возможный DST-сдвиг «вчера» безвредным.
    this.setMeta("daily_rollup_day", localDay(nowMs - 86_400_000));
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

  /** Сырой SELECT для selfcheck и диагностики. */
  all(sql: string, ...params: Array<string | number>): Array<Record<string, unknown>> {
    return this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
  }
}
