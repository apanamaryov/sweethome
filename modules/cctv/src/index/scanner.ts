import { CctvDb } from "./db";
import { parseHlsPlaylist } from "./playlist-parse";

/** Минимум от `fs/promises`, который нужен сканеру. Инъекция — чтобы тесты не ходили на диск. */
export interface FsLike {
  readFile(p: string): Promise<string>;
  stat(p: string): Promise<{ size: number }>;
  readdir(p: string): Promise<string[]>;
}

/** Файла или каталога просто нет — штатная ситуация, а не поломка хранилища. */
function isMissing(e: unknown): boolean {
  return (e as NodeJS.ErrnoException)?.code === "ENOENT";
}

/** `seg_20260824_100000.m4s` → локальное время. Аварийный путь, когда плейлиста нет. */
export function timeFromSegmentName(name: string): number | null {
  const m = /^seg_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})\.m4s$/.exec(name);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number) as unknown as number[];
  return new Date(y, mo - 1, d, h, mi, s).getTime();
}

/** Время запуска записи из имени init'а (`init_<base36 от Date.now()>.mp4`). */
export function timeFromInitName(name: string): number | null {
  const m = /^init_([0-9a-z]+)\.mp4$/.exec(name);
  if (!m) return null;
  const t = parseInt(m[1], 36);
  // Отсекаем имена вроде init_run1.mp4 — из них времени не извлечь.
  return Number.isFinite(t) && t > 1_000_000_000_000 ? t : null;
}

export class Scanner {
  /**
   * Начало последнего проиндексированного сегмента, по камере (спека §7: читаем
   * только прирост).
   *
   * ffmpeg пишет плейлист с `-hls_list_size 0` и `append_list`, то есть копит в
   * нём все сегменты за всю историю и переживает перезапуски. Без этой отметки
   * каждый тик (раз в 15 с) перебирал бы весь архив; хуже — чистка удаляет
   * строку сегмента из индекса, но не из плейлиста, поэтому после первого
   * срабатывания квоты каждый вытесненный сегмент переставал бы быть «известным»
   * и получал бы `stat` по сетевому диску заново, и число таких обращений росло
   * бы на 2880 в сутки без предела. Первой от этого страдает запись.
   */
  private lastIndexedMs = new Map<string, number>();

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
    } catch (e) {
      if (isMissing(e)) return 0; // запись ещё не начиналась — это нормально
      throw e; // хранилище сломалось — пробрасываем наружу
    }

    // Первое обращение после старта процесса — отметку восстанавливаем из базы.
    let mark = this.lastIndexedMs.get(cam) ?? this.db.lastSegmentStart(cam) ?? -Infinity;

    // Множество известных путей читается лениво: на тике без новых сегментов
    // (а таких большинство) оно не нужно вовсе, а в базе их десятки тысяч.
    let known: Set<string> | null = null;
    const initIds = new Map<string, number>();
    let added = 0;
    // Отметку двигаем только по непрерывному успешному префиксу. Сегмент, который
    // сейчас не удалось проиндексировать (ffmpeg ещё дописывает файл), — это
    // всегда хвост плейлиста; но если пропуск всё же окажется в середине,
    // перескочить через него нельзя, иначе он не попадёт в индекс никогда.
    let advancing = true;

    for (const e of parseHlsPlaylist(text, this.segmentSec)) {
      if (e.startMs <= mark) continue; // уже разбирали в прошлый раз

      const relPath = `${cam}/${e.file}`;
      known ??= this.db.knownPaths(cam);
      if (known.has(relPath)) {
        if (advancing) mark = e.startMs;
        continue;
      }

      let initId = initIds.get(e.initFile);
      if (initId === undefined) {
        const resolved = await this.resolveInit(cam, e.initFile);
        if (resolved === null) {
          advancing = false; // init'а нет на диске — воспроизвести нечем, вернёмся сюда позже
          continue;
        }
        initId = resolved;
        initIds.set(e.initFile, initId);
      }

      let bytes: number;
      try {
        bytes = (await this.fs.stat(`${this.camDir(cam)}/${e.file}`)).size;
      } catch (err) {
        if (isMissing(err)) {
          advancing = false; // файл ещё не дописан — ffmpeg пишет во временный
          continue;
        }
        throw err; // хранилище сломалось
      }

      this.db.addSegment({ cam, initId, path: relPath, startMs: e.startMs, durMs: e.durMs, bytes });
      added++;
      if (advancing) mark = e.startMs;
    }

    this.lastIndexedMs.set(cam, mark);
    return added;
  }

  private async resolveInit(cam: string, initFile: string): Promise<number | null> {
    const relPath = `${cam}/${initFile}`;
    const existing = this.db.initIdByPath(cam, relPath);
    if (existing !== null) return existing;
    try {
      const st = await this.fs.stat(`${this.camDir(cam)}/${initFile}`);
      return this.db.upsertInit(cam, relPath, st.size, Date.now());
    } catch (e) {
      if (isMissing(e)) return null; // init'а нет на диске — может быть удалён или ещё не создан
      throw e; // хранилище сломалось
    }
  }

  /**
   * Аварийный путь: индекс потерян, а файлы на месте. Время берём из имени,
   * длительность — по умолчанию. Точность хуже, чем из плейлиста, но архив
   * остаётся доступным. Выбираем init, чьё время запуска не позже начала сегмента.
   */
  async rebuildCamera(cam: string): Promise<number> {
    let names: string[];
    try {
      names = await this.fs.readdir(this.camDir(cam));
    } catch (e) {
      if (isMissing(e)) return 0; // каталог камеры ещё не создан
      throw e; // хранилище сломалось
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

      // Выбираем новейший init, чьё время запуска не позже начала сегмента.
      // Если всем init'ам не удалось распознать время (нестандартные имена),
      // используем самый свежий как запасной вариант.
      let selectedInit: string | null = null;
      for (let i = inits.length - 1; i >= 0; i--) {
        const initTime = timeFromInitName(inits[i]);
        if (initTime !== null && initTime <= startMs) {
          selectedInit = inits[i];
          break;
        }
      }
      selectedInit ??= inits[inits.length - 1];

      const initId = await this.resolveInit(cam, selectedInit);
      if (initId === null) continue;

      let bytes: number;
      try {
        bytes = (await this.fs.stat(`${this.camDir(cam)}/${name}`)).size;
      } catch (err) {
        if (isMissing(err)) continue; // файл исчез или ещё не создан полностью
        throw err; // хранилище сломалось
      }
      this.db.addSegment({ cam, initId, path: relPath, startMs, durMs: this.segmentSec * 1000, bytes });
      added++;
    }
    // Восстановление добавляет сегменты в обход плейлиста, поэтому сохранённая
    // отметка после него неактуальна — пересчитаем её из базы на следующем скане.
    this.lastIndexedMs.delete(cam);
    return added;
  }
}
