import { DatabaseSync, StatementSync } from "node:sqlite";
import {
  DEFAULT_SETTINGS,
  LIMITS,
  PRESET_GROUPS,
  type DryerEvent,
  type DryerSettings,
  type EndReason,
  type EventKind,
  type NodeState,
  type Preset,
  type PresetGroup,
  type PresetInput,
  type Run,
  type Sample,
  type SettingsPatch,
  type StopReason,
} from "@sweethome/dryer-shared";

/** Стартовые пресеты (спека §8). Названия — пользовательские данные, не переводятся. */
export const SEED_PRESETS: ReadonlyArray<PresetInput> = [
  { name: "Яблоки", group: "fruit", setpoint: 60, maxMinutes: 14 * 60, autostop: true },
  { name: "Груши", group: "fruit", setpoint: 60, maxMinutes: 16 * 60, autostop: true },
  { name: "Сливы / чернослив", group: "fruit", setpoint: 60, maxMinutes: 24 * 60, autostop: true },
  { name: "Абрикосы / курага", group: "fruit", setpoint: 60, maxMinutes: 24 * 60, autostop: true },
  { name: "Вишня, черешня", group: "fruit", setpoint: 60, maxMinutes: 24 * 60, autostop: true },
  { name: "Виноград / изюм", group: "fruit", setpoint: 60, maxMinutes: 48 * 60, autostop: true },
  { name: "Клубника", group: "fruit", setpoint: 57, maxMinutes: 14 * 60, autostop: true },
  { name: "Малина, смородина", group: "fruit", setpoint: 57, maxMinutes: 18 * 60, autostop: true },
  { name: "Бананы", group: "fruit", setpoint: 57, maxMinutes: 12 * 60, autostop: true },
  { name: "Цитрусы дольками", group: "fruit", setpoint: 55, maxMinutes: 12 * 60, autostop: true },
  { name: "Шиповник, боярышник", group: "fruit", setpoint: 60, maxMinutes: 14 * 60, autostop: true },
  { name: "Пастила", group: "fruit", setpoint: 60, maxMinutes: 14 * 60, autostop: true },
  { name: "Томаты", group: "vegetable", setpoint: 60, maxMinutes: 14 * 60, autostop: true },
  { name: "Перец болгарский", group: "vegetable", setpoint: 55, maxMinutes: 12 * 60, autostop: true },
  { name: "Перец острый", group: "vegetable", setpoint: 55, maxMinutes: 12 * 60, autostop: true },
  { name: "Морковь", group: "vegetable", setpoint: 52, maxMinutes: 10 * 60, autostop: true },
  { name: "Свёкла", group: "vegetable", setpoint: 52, maxMinutes: 12 * 60, autostop: true },
  { name: "Лук", group: "vegetable", setpoint: 52, maxMinutes: 12 * 60, autostop: true },
  { name: "Чеснок", group: "vegetable", setpoint: 50, maxMinutes: 10 * 60, autostop: true },
  { name: "Кабачки / цукини чипсами", group: "vegetable", setpoint: 52, maxMinutes: 10 * 60, autostop: true },
  { name: "Баклажаны", group: "vegetable", setpoint: 52, maxMinutes: 12 * 60, autostop: true },
  { name: "Тыква", group: "vegetable", setpoint: 55, maxMinutes: 14 * 60, autostop: true },
  { name: "Кукуруза", group: "vegetable", setpoint: 52, maxMinutes: 12 * 60, autostop: true },
  { name: "Стручковая фасоль, горошек", group: "vegetable", setpoint: 52, maxMinutes: 14 * 60, autostop: true },
  { name: "Капуста", group: "vegetable", setpoint: 52, maxMinutes: 12 * 60, autostop: true },
  { name: "Картофель (бланшированный)", group: "vegetable", setpoint: 52, maxMinutes: 12 * 60, autostop: true },
  { name: "Грибы", group: "other", setpoint: 48, maxMinutes: 10 * 60, autostop: true },
  { name: "Травы и зелень", group: "other", setpoint: 38, maxMinutes: 6 * 60, autostop: true },
  { name: "Орехи (просушка)", group: "other", setpoint: 42, maxMinutes: 24 * 60, autostop: true },
  { name: "Джерки (мясо)", group: "other", setpoint: 70, maxMinutes: 8 * 60, autostop: true },
];

export interface OpenRunInput {
  startedAt: number;
  presetName: string | null;
  setpoint: number;
  maxMinutes: number;
  startedBy: string;
  autostopEnabled: boolean;
}

interface PresetSql { id: number; name: string; grp: string; setpoint: number; max_minutes: number; autostop: number; sort: number }
interface RunSql {
  id: number; started_at: number; ended_at: number | null; preset_name: string | null; setpoint: number;
  max_minutes: number; started_by: string; end_reason: string | null; restarts: number; autostop_enabled: number;
}
interface SampleSql {
  ts: number; run_id: number | null; chamber_temp: number | null; chamber_rh: number | null; ambient_temp: number | null;
  ambient_rh: number | null; plate_temp: number | null; excess: number | null; heater_duty: number | null;
  exhaust_duty: number | null; exhaust_rpm: number | null; state: string;
}
interface EventSql { id: number; ts: number; run_id: number | null; kind: string; text: string; seen: number }

const toPreset = (r: PresetSql): Preset => ({
  id: r.id, name: r.name, group: r.grp as PresetGroup, setpoint: r.setpoint, maxMinutes: r.max_minutes,
  autostop: r.autostop === 1, sort: r.sort,
});
const toRun = (r: RunSql): Run => ({
  id: r.id, startedAt: r.started_at, endedAt: r.ended_at, presetName: r.preset_name, setpoint: r.setpoint,
  maxMinutes: r.max_minutes, startedBy: r.started_by, endReason: r.end_reason as EndReason | null,
  restarts: r.restarts, autostopEnabled: r.autostop_enabled === 1,
});
const toSample = (r: SampleSql): Sample => ({
  ts: r.ts, runId: r.run_id, chamberTemp: r.chamber_temp, chamberRh: r.chamber_rh, ambientTemp: r.ambient_temp,
  ambientRh: r.ambient_rh, plateTemp: r.plate_temp, excess: r.excess, heaterDuty: r.heater_duty,
  exhaustDuty: r.exhaust_duty, exhaustRpm: r.exhaust_rpm, state: r.state as NodeState,
});
const toEvent = (r: EventSql): DryerEvent => ({
  id: r.id, ts: r.ts, runId: r.run_id, kind: r.kind as EventKind, text: r.text, seen: r.seen === 1,
});

/** Сколько непрочитанных событий уезжает в снапшот (спека §9: список короткий). */
const MAX_UNSEEN_EVENTS = 50;

const inRange = (v: unknown, r: { min: number; max: number }): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= r.min && v <= r.max;

export class DryerStore {
  private db!: DatabaseSync;
  private stmt!: {
    insPreset: StatementSync; getPreset: StatementSync; listPresets: StatementSync; maxSort: StatementSync;
    updPreset: StatementSync; delPreset: StatementSync; countPresets: StatementSync;
    insRun: StatementSync; curRun: StatementSync; getRun: StatementSync; closeRun: StatementSync;
    bumpRestarts: StatementSync; listRuns: StatementSync;
    insSample: StatementSync; samplesForRun: StatementSync; excessSeries: StatementSync; excessSeriesRun: StatementSync;
    prune: StatementSync;
    insEvent: StatementSync; getEvent: StatementSync; unseen: StatementSync; markSeen: StatementSync; pruneEvents: StatementSync;
    getSetting: StatementSync; setSetting: StatementSync;
  };

  constructor(file: string) {
    this.open(file);
  }

  private open(file: string): void {
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.migrate();
    this.prepare();
  }

  /** Как у CctvDb: владелец закрывает в stop() и переоткрывает в start() поверх того же объекта. */
  reopen(file: string): void {
    this.open(file);
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    const v = (this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    if (v < 1) {
      this.db.exec(`
        CREATE TABLE presets (
          id          INTEGER PRIMARY KEY,
          name        TEXT    NOT NULL UNIQUE,
          grp         TEXT    NOT NULL,
          setpoint    REAL    NOT NULL,
          max_minutes INTEGER NOT NULL,
          autostop    INTEGER NOT NULL DEFAULT 1,
          sort        INTEGER NOT NULL
        );
        CREATE TABLE runs (
          id               INTEGER PRIMARY KEY,
          started_at       INTEGER NOT NULL,
          ended_at         INTEGER,
          preset_name      TEXT,
          setpoint         REAL    NOT NULL,
          max_minutes      INTEGER NOT NULL,
          started_by       TEXT    NOT NULL,
          end_reason       TEXT,
          restarts         INTEGER NOT NULL DEFAULT 0,
          autostop_enabled INTEGER NOT NULL
        );
        CREATE INDEX idx_runs_started ON runs(started_at);
        CREATE TABLE samples (
          ts           INTEGER PRIMARY KEY,
          run_id       INTEGER,
          chamber_temp REAL, chamber_rh REAL,
          ambient_temp REAL, ambient_rh REAL,
          plate_temp   REAL, excess REAL,
          heater_duty  REAL, exhaust_duty REAL, exhaust_rpm REAL,
          state        TEXT NOT NULL
        );
        CREATE INDEX idx_samples_run ON samples(run_id);
        CREATE TABLE events (
          id     INTEGER PRIMARY KEY,
          ts     INTEGER NOT NULL,
          run_id INTEGER,
          kind   TEXT    NOT NULL,
          text   TEXT    NOT NULL,
          seen   INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        PRAGMA user_version = 1;
      `);
    }
  }

  private prepare(): void {
    const p = (sql: string) => this.db.prepare(sql);
    this.stmt = {
      insPreset: p("INSERT INTO presets(name, grp, setpoint, max_minutes, autostop, sort) VALUES (?, ?, ?, ?, ?, ?)"),
      getPreset: p("SELECT * FROM presets WHERE id = ?"),
      listPresets: p("SELECT * FROM presets ORDER BY sort, id"),
      maxSort: p("SELECT COALESCE(MAX(sort), 0) AS m FROM presets"),
      updPreset: p("UPDATE presets SET name = ?, grp = ?, setpoint = ?, max_minutes = ?, autostop = ? WHERE id = ?"),
      delPreset: p("DELETE FROM presets WHERE id = ?"),
      countPresets: p("SELECT COUNT(*) AS n FROM presets"),
      insRun: p(
        "INSERT INTO runs(started_at, preset_name, setpoint, max_minutes, started_by, autostop_enabled) VALUES (?, ?, ?, ?, ?, ?)"
      ),
      curRun: p("SELECT * FROM runs WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1"),
      getRun: p("SELECT * FROM runs WHERE id = ?"),
      closeRun: p("UPDATE runs SET ended_at = ?, end_reason = ? WHERE id = ? AND ended_at IS NULL"),
      bumpRestarts: p("UPDATE runs SET restarts = restarts + 1 WHERE id = ?"),
      listRuns: p("SELECT * FROM runs WHERE started_at >= ? AND started_at < ? ORDER BY started_at DESC"),
      insSample: p(
        "INSERT OR REPLACE INTO samples(ts, run_id, chamber_temp, chamber_rh, ambient_temp, ambient_rh, plate_temp, excess, " +
          "heater_duty, exhaust_duty, exhaust_rpm, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ),
      samplesForRun: p("SELECT * FROM samples WHERE run_id = ? ORDER BY ts"),
      excessSeries: p("SELECT ts, excess FROM samples WHERE ts >= ? AND ts <= ? ORDER BY ts"),
      excessSeriesRun: p("SELECT ts, excess FROM samples WHERE ts >= ? AND ts <= ? AND run_id = ? ORDER BY ts"),
      prune: p("DELETE FROM samples WHERE ts < ?"),
      insEvent: p("INSERT INTO events(ts, run_id, kind, text) VALUES (?, ?, ?, ?)"),
      getEvent: p("SELECT * FROM events WHERE id = ?"),
      // LIMIT: непрочитанные уезжают в каждый снапшот и в каждый кадр WS — на мигающем
      // Wi-Fi пары node_offline/node_online копятся, и без границы кадр рос бы без предела.
      unseen: p(`SELECT * FROM events WHERE seen = 0 ORDER BY ts DESC, id DESC LIMIT ${MAX_UNSEEN_EVENTS}`),
      markSeen: p("UPDATE events SET seen = 1 WHERE id = ? AND seen = 0"),
      pruneEvents: p("DELETE FROM events WHERE ts < ?"),
      getSetting: p("SELECT value FROM settings WHERE key = ?"),
      setSetting: p("INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)"),
    };
  }

  // --- presets ---

  seedPresetsIfEmpty(): number {
    const n = (this.stmt.countPresets.get() as { n: number }).n;
    if (n > 0) return 0;
    let sort = 0;
    for (const pr of SEED_PRESETS) {
      this.stmt.insPreset.run(pr.name, pr.group, pr.setpoint, pr.maxMinutes, pr.autostop ? 1 : 0, ++sort);
    }
    return SEED_PRESETS.length;
  }

  listPresets(): Preset[] {
    return (this.stmt.listPresets.all() as unknown as PresetSql[]).map(toPreset);
  }

  getPreset(id: number): Preset | null {
    const r = this.stmt.getPreset.get(id) as PresetSql | undefined;
    return r ? toPreset(r) : null;
  }

  createPreset(pr: PresetInput): Preset {
    const sort = (this.stmt.maxSort.get() as { m: number }).m + 1;
    try {
      const res = this.stmt.insPreset.run(pr.name, pr.group, pr.setpoint, pr.maxMinutes, pr.autostop ? 1 : 0, sort);
      return this.getPreset(Number(res.lastInsertRowid))!;
    } catch (e) {
      if (/UNIQUE constraint failed/.test((e as Error).message)) throw new Error("Пресет с таким названием уже есть");
      throw e;
    }
  }

  updatePreset(id: number, patch: Partial<PresetInput>): Preset | null {
    const cur = this.getPreset(id);
    if (!cur) return null;
    const next = { ...cur, ...patch };
    try {
      this.stmt.updPreset.run(next.name, next.group, next.setpoint, next.maxMinutes, next.autostop ? 1 : 0, id);
    } catch (e) {
      if (/UNIQUE constraint failed/.test((e as Error).message)) throw new Error("Пресет с таким названием уже есть");
      throw e;
    }
    return this.getPreset(id);
  }

  deletePreset(id: number): boolean {
    return Number(this.stmt.delPreset.run(id).changes) > 0;
  }

  // --- runs ---

  openRun(r: OpenRunInput): Run {
    const res = this.stmt.insRun.run(r.startedAt, r.presetName, r.setpoint, r.maxMinutes, r.startedBy, r.autostopEnabled ? 1 : 0);
    return this.getRun(Number(res.lastInsertRowid))!;
  }

  currentRun(): Run | null {
    const r = this.stmt.curRun.get() as RunSql | undefined;
    return r ? toRun(r) : null;
  }

  getRun(id: number): Run | null {
    const r = this.stmt.getRun.get(id) as RunSql | undefined;
    return r ? toRun(r) : null;
  }

  closeRun(id: number, endedAt: number, endReason: EndReason): void {
    this.stmt.closeRun.run(endedAt, endReason, id);
  }

  bumpRestarts(id: number): number {
    this.stmt.bumpRestarts.run(id);
    return this.getRun(id)?.restarts ?? 0;
  }

  listRuns(fromMs: number, toMs: number): Run[] {
    return (this.stmt.listRuns.all(fromMs, toMs) as unknown as RunSql[]).map(toRun);
  }

  // --- samples ---

  addSample(s: Sample): void {
    this.stmt.insSample.run(
      s.ts, s.runId, s.chamberTemp, s.chamberRh, s.ambientTemp, s.ambientRh, s.plateTemp, s.excess,
      s.heaterDuty, s.exhaustDuty, s.exhaustRpm, s.state
    );
  }

  samplesForRun(runId: number): Sample[] {
    return (this.stmt.samplesForRun.all(runId) as unknown as SampleSql[]).map(toSample);
  }

  /**
   * Ряд избытка за [fromMs, toMs] — вход decideAutostop (Task 6). С runId — только замеры
   * этой сушки: иначе в окно попадает сухой хвост прошлой партии и остывания, и молодая
   * сушка останавливается по чужим данным.
   */
  excessSeries(fromMs: number, toMs: number, runId?: number): { ts: number; excess: number | null }[] {
    const rows = (runId === undefined
      ? this.stmt.excessSeries.all(fromMs, toMs)
      : this.stmt.excessSeriesRun.all(fromMs, toMs, runId)) as unknown as { ts: number; excess: number | null }[];
    return rows.map((r) => ({ ts: r.ts, excess: r.excess }));
  }

  pruneSamples(olderThanMs: number): number {
    return Number(this.stmt.prune.run(olderThanMs).changes);
  }

  // --- events ---

  addEvent(ts: number, kind: EventKind, text: string, runId: number | null): DryerEvent {
    const res = this.stmt.insEvent.run(ts, runId, kind, text);
    return toEvent(this.stmt.getEvent.get(Number(res.lastInsertRowid)) as unknown as EventSql);
  }

  unseenEvents(): DryerEvent[] {
    return (this.stmt.unseen.all() as unknown as EventSql[]).map(toEvent);
  }

  markSeen(id: number): boolean {
    return Number(this.stmt.markSeen.run(id).changes) > 0;
  }

  pruneEvents(olderThanMs: number): number {
    return Number(this.stmt.pruneEvents.run(olderThanMs).changes);
  }

  // --- settings ---

  /** Для тестов порчи данных: записать сырую строку под ключ. */
  rawSetSetting(key: string, raw: string): void {
    this.stmt.setSetting.run(key, raw);
  }

  private readJson(key: string): unknown {
    const r = this.stmt.getSetting.get(key) as { value: string } | undefined;
    if (!r) return undefined;
    try {
      return JSON.parse(r.value);
    } catch {
      return undefined;
    }
  }

  /**
   * Каждое поле читается отдельно: битое или вне диапазона — откатывается на дефолт,
   * остальные применяются (спека §8: потерять всё из-за одного ключа было бы глупо).
   */
  getSettings(): DryerSettings {
    const d = DEFAULT_SETTINGS;
    const a = this.readJson("autostop");
    const ao = a && typeof a === "object" ? (a as Record<string, unknown>) : {};
    const em = this.readJson("exhaustMin");
    const eg = this.readJson("exhaustGain");
    const st = this.readJson("staleAfterSeconds");
    return {
      autostop: {
        excessThreshold: inRange(ao.excessThreshold, LIMITS.excessThreshold) ? ao.excessThreshold : d.autostop.excessThreshold,
        holdMinutes: inRange(ao.holdMinutes, LIMITS.holdMinutes) ? ao.holdMinutes : d.autostop.holdMinutes,
        minRunMinutes: inRange(ao.minRunMinutes, LIMITS.minRunMinutes) ? ao.minRunMinutes : d.autostop.minRunMinutes,
      },
      exhaustMin: inRange(em, LIMITS.exhaustMin) ? em : d.exhaustMin,
      exhaustGain: inRange(eg, LIMITS.exhaustGain) ? eg : d.exhaustGain,
      staleAfterSeconds: inRange(st, LIMITS.staleAfterSeconds) ? st : d.staleAfterSeconds,
    };
  }

  /** Патч уже проверен validateSettingsPatch — здесь только слияние и запись. */
  updateSettings(patch: SettingsPatch): DryerSettings {
    const cur = this.getSettings();
    const next: DryerSettings = {
      autostop: { ...cur.autostop, ...(patch.autostop ?? {}) },
      exhaustMin: patch.exhaustMin ?? cur.exhaustMin,
      exhaustGain: patch.exhaustGain ?? cur.exhaustGain,
      staleAfterSeconds: patch.staleAfterSeconds ?? cur.staleAfterSeconds,
    };
    this.stmt.setSetting.run("autostop", JSON.stringify(next.autostop));
    this.stmt.setSetting.run("exhaustMin", JSON.stringify(next.exhaustMin));
    this.stmt.setSetting.run("exhaustGain", JSON.stringify(next.exhaustGain));
    this.stmt.setSetting.run("staleAfterSeconds", JSON.stringify(next.staleAfterSeconds));
    return next;
  }
}

export type { StopReason };
