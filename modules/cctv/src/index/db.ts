import { DatabaseSync, StatementSync } from "node:sqlite";

export interface SegmentRow {
  id: number;
  cam: string;
  initId: number;
  path: string;
  startMs: number;
  durMs: number;
  bytes: number;
}

interface SegSql {
  id: number; cam: string; init_id: number; path: string;
  start_ms: number; dur_ms: number; bytes: number;
}

const toRow = (r: SegSql): SegmentRow => ({
  id: r.id, cam: r.cam, initId: r.init_id, path: r.path,
  startMs: r.start_ms, durMs: r.dur_ms, bytes: r.bytes,
});

/**
 * Индекс записей. Поиск по времени идёт здесь, а не обходом каталога:
 * хранилище — SMB через Wi-Fi, listing по нему стоит дорого.
 */
export class CctvDb {
  // Присваивается не в конструкторе напрямую, а через open() (нужно для reopen()
  // ниже) — компилятору это не видно статически, отсюда "!".
  private db!: DatabaseSync;
  private stmt!: {
    insInit: StatementSync; getInit: StatementSync; getInitById: StatementSync;
    insSeg: StatementSync; getSegById: StatementSync; getSegPath: StatementSync;
    between: StatementSync; lastStart: StatementSync; totals: StatementSync;
    oldest: StatementSync; delSeg: StatementSync; orphans: StatementSync;
    delInit: StatementSync; insMotion: StatementSync; motion: StatementSync;
    paths: StatementSync;
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

  /**
   * Переоткрывает соединение поверх того же файла. Нужно только владельцу базы,
   * закрывшему её в stop() и затем перезапускающемуся (start() после stop()) —
   * тот же объект CctvDb остаётся в работе, поэтому роутеру и RecorderManager,
   * уже держащим ссылку на него, не нужно ничего пересобирать.
   */
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
        CREATE TABLE inits (
          id      INTEGER PRIMARY KEY,
          cam     TEXT NOT NULL,
          path    TEXT NOT NULL UNIQUE,
          bytes   INTEGER NOT NULL,
          created INTEGER NOT NULL
        );
        CREATE TABLE segments (
          id       INTEGER PRIMARY KEY,
          cam      TEXT NOT NULL,
          init_id  INTEGER NOT NULL REFERENCES inits(id),
          path     TEXT NOT NULL UNIQUE,
          start_ms INTEGER NOT NULL,
          dur_ms   INTEGER NOT NULL,
          bytes    INTEGER NOT NULL
        );
        CREATE INDEX idx_seg_cam_start ON segments(cam, start_ms);
        CREATE TABLE motion (
          id    INTEGER PRIMARY KEY,
          cam   TEXT NOT NULL,
          ts_ms INTEGER NOT NULL,
          kind  TEXT NOT NULL
        );
        CREATE INDEX idx_motion_cam_ts ON motion(cam, ts_ms);
        PRAGMA user_version = 1;
      `);
    }
  }

  private prepare(): void {
    const p = (sql: string) => this.db.prepare(sql);
    this.stmt = {
      insInit: p("INSERT OR IGNORE INTO inits(cam, path, bytes, created) VALUES (?, ?, ?, ?)"),
      getInit: p("SELECT id FROM inits WHERE cam = ? AND path = ?"),
      getInitById: p("SELECT cam, path FROM inits WHERE id = ?"),
      insSeg: p(
        "INSERT OR IGNORE INTO segments(cam, init_id, path, start_ms, dur_ms, bytes) VALUES (?, ?, ?, ?, ?, ?)"
      ),
      getSegById: p("SELECT * FROM segments WHERE id = ?"),
      getSegPath: p("SELECT id FROM segments WHERE path = ?"),
      // Пересечение с интервалом, а не вложенность: сегмент, начавшийся до `from`
      // и продолжающийся внутрь, нужен — иначе плеер стартует с дыркой.
      between: p(
        "SELECT * FROM segments WHERE cam = ? AND start_ms + dur_ms > ? AND start_ms < ? ORDER BY start_ms"
      ),
      lastStart: p("SELECT MAX(start_ms) AS m FROM segments WHERE cam = ?"),
      totals: p(
        "SELECT COALESCE(SUM(bytes),0) AS bytes, COUNT(*) AS count, MIN(start_ms) AS oldest, MAX(start_ms + dur_ms) AS newest FROM segments"
      ),
      oldest: p("SELECT * FROM segments ORDER BY start_ms LIMIT ?"),
      delSeg: p("DELETE FROM segments WHERE id = ?"),
      orphans: p("SELECT id, cam, path FROM inits WHERE id NOT IN (SELECT DISTINCT init_id FROM segments)"),
      delInit: p("DELETE FROM inits WHERE id = ?"),
      insMotion: p("INSERT INTO motion(cam, ts_ms, kind) VALUES (?, ?, ?)"),
      motion: p("SELECT ts_ms, kind FROM motion WHERE cam = ? AND ts_ms >= ? AND ts_ms < ? ORDER BY ts_ms"),
      paths: p("SELECT path FROM segments WHERE cam = ?"),
    };
  }

  upsertInit(cam: string, relPath: string, bytes: number, createdMs: number): number {
    this.stmt.insInit.run(cam, relPath, bytes, createdMs);
    return (this.stmt.getInit.get(cam, relPath) as { id: number }).id;
  }

  initIdByPath(cam: string, relPath: string): number | null {
    const r = this.stmt.getInit.get(cam, relPath) as { id: number } | undefined;
    return r ? r.id : null;
  }

  initPathById(id: number): { cam: string; path: string } | null {
    const r = this.stmt.getInitById.get(id) as { cam: string; path: string } | undefined;
    return r ?? null;
  }

  addSegment(row: Omit<SegmentRow, "id">): number {
    this.stmt.insSeg.run(row.cam, row.initId, row.path, row.startMs, row.durMs, row.bytes);
    return (this.stmt.getSegPath.get(row.path) as { id: number }).id;
  }

  segmentsBetween(cam: string, fromMs: number, toMs: number): SegmentRow[] {
    return (this.stmt.between.all(cam, fromMs, toMs) as unknown as SegSql[]).map(toRow);
  }

  segmentById(id: number): SegmentRow | null {
    const r = this.stmt.getSegById.get(id) as SegSql | undefined;
    return r ? toRow(r) : null;
  }

  lastSegmentStart(cam: string): number | null {
    const r = this.stmt.lastStart.get(cam) as { m: number | null };
    return r.m ?? null;
  }

  totals(): { bytes: number; count: number; oldestMs: number | null; newestMs: number | null } {
    const r = this.stmt.totals.get() as {
      bytes: number; count: number; oldest: number | null; newest: number | null;
    };
    return { bytes: r.bytes, count: r.count, oldestMs: r.oldest ?? null, newestMs: r.newest ?? null };
  }

  oldestSegments(limit: number): SegmentRow[] {
    return (this.stmt.oldest.all(limit) as unknown as SegSql[]).map(toRow);
  }

  deleteSegment(id: number): void {
    this.stmt.delSeg.run(id);
  }

  orphanInits(): { id: number; cam: string; path: string }[] {
    return this.stmt.orphans.all() as { id: number; cam: string; path: string }[];
  }

  deleteInit(id: number): void {
    this.stmt.delInit.run(id);
  }

  addMotion(cam: string, tsMs: number, kind: string): void {
    this.stmt.insMotion.run(cam, tsMs, kind);
  }

  motionBetween(cam: string, fromMs: number, toMs: number): { tsMs: number; kind: string }[] {
    return (this.stmt.motion.all(cam, fromMs, toMs) as { ts_ms: number; kind: string }[]).map((r) => ({
      tsMs: r.ts_ms,
      kind: r.kind,
    }));
  }

  knownPaths(cam: string): Set<string> {
    return new Set((this.stmt.paths.all(cam) as { path: string }[]).map((r) => r.path));
  }
}
