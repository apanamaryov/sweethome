import { CctvDb } from "./db";
import { parseHlsPlaylist } from "./playlist-parse";

/** Минимум от `fs/promises`, который нужен сканеру. Инъекция — чтобы тесты не ходили на диск. */
export interface FsLike {
  readFile(p: string): Promise<string>;
  stat(p: string): Promise<{ size: number }>;
  readdir(p: string): Promise<string[]>;
}

/** `seg_20260824_100000.m4s` → локальное время. Аварийный путь, когда плейлиста нет. */
export function timeFromSegmentName(name: string): number | null {
  const m = /^seg_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})\.m4s$/.exec(name);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number) as unknown as number[];
  return new Date(y, mo - 1, d, h, mi, s).getTime();
}

export class Scanner {
  constructor(
    private db: CctvDb,
    private storageDir: string,
    private fs: FsLike,
    private segmentSec = 60
  ) {}

  private camDir(cam: string): string {
    return `${this.storageDir}/${cam}`;
  }

  /** Штатный путь: дочитать плейлист ffmpeg и добавить новое. Возвращает число добавленных. */
  async scanCamera(cam: string): Promise<number> {
    let text: string;
    try {
      text = await this.fs.readFile(`${this.camDir(cam)}/live.m3u8`);
    } catch {
      return 0; // запись ещё не начиналась — это нормально
    }

    const known = this.db.knownPaths(cam);
    const initIds = new Map<string, number>();
    let added = 0;

    for (const e of parseHlsPlaylist(text, this.segmentSec)) {
      const relPath = `${cam}/${e.file}`;
      if (known.has(relPath)) continue;

      let initId = initIds.get(e.initFile);
      if (initId === undefined) {
        const resolved = await this.resolveInit(cam, e.initFile);
        if (resolved === null) continue; // init'а нет на диске — воспроизвести нечем
        initId = resolved;
        initIds.set(e.initFile, initId);
      }

      let bytes: number;
      try {
        bytes = (await this.fs.stat(`${this.camDir(cam)}/${e.file}`)).size;
      } catch {
        continue; // файл ещё не дописан
      }

      this.db.addSegment({ cam, initId, path: relPath, startMs: e.startMs, durMs: e.durMs, bytes });
      added++;
    }
    return added;
  }

  private async resolveInit(cam: string, initFile: string): Promise<number | null> {
    const relPath = `${cam}/${initFile}`;
    const existing = this.db.initIdByPath(cam, relPath);
    if (existing !== null) return existing;
    try {
      const st = await this.fs.stat(`${this.camDir(cam)}/${initFile}`);
      return this.db.upsertInit(cam, relPath, st.size, Date.now());
    } catch {
      return null;
    }
  }

  /**
   * Аварийный путь: индекс потерян, а файлы на месте. Время берём из имени,
   * длительность — по умолчанию. Точность хуже, чем из плейлиста, но архив
   * остаётся доступным.
   */
  async rebuildCamera(cam: string): Promise<number> {
    let names: string[];
    try {
      names = await this.fs.readdir(this.camDir(cam));
    } catch {
      return 0;
    }

    const inits = names.filter((n) => n.startsWith("init_") && n.endsWith(".mp4")).sort();
    if (inits.length === 0) return 0;

    const known = this.db.knownPaths(cam);
    let added = 0;
    for (const name of names.sort()) {
      const startMs = timeFromSegmentName(name);
      if (startMs === null) continue;
      const relPath = `${cam}/${name}`;
      if (known.has(relPath)) continue;

      // Ближайший по времени init: имена init'ов содержат метку запуска,
      // сортировка совпадает с хронологией.
      const initFile = inits[inits.length - 1];
      const initId = await this.resolveInit(cam, initFile);
      if (initId === null) continue;

      let bytes: number;
      try {
        bytes = (await this.fs.stat(`${this.camDir(cam)}/${name}`)).size;
      } catch {
        continue;
      }
      this.db.addSegment({ cam, initId, path: relPath, startMs, durMs: this.segmentSec * 1000, bytes });
      added++;
    }
    return added;
  }
}
