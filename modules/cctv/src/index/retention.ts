import { CctvDb } from "./db";

/** Начинаем чистить на 98% квоты и чистим до 95% — чтобы не дёргать диск каждую минуту. */
export const EVICT_HIGH_RATIO = 0.98;
export const EVICT_TARGET_RATIO = 0.95;

/** Минимум от `fs/promises` для чистки. */
export interface UnlinkFs {
  unlink(p: string): Promise<void>;
}

/**
 * Какие сегменты удалить. Кандидаты должны идти от старых к новым;
 * функция чистая — вся арифметика порогов проверяется тестами без диска.
 */
export function planEviction(
  totalBytes: number,
  quotaBytes: number,
  candidates: { id: number; bytes: number }[],
  highRatio: number = EVICT_HIGH_RATIO,
  targetRatio: number = EVICT_TARGET_RATIO
): number[] {
  if (totalBytes <= quotaBytes * highRatio) return [];
  let need = totalBytes - quotaBytes * targetRatio;
  const out: number[] = [];
  for (const c of candidates) {
    if (need <= 0) break;
    out.push(c.id);
    need -= c.bytes;
  }
  return out;
}

/** Сколько сегментов рассматривать за один проход. Минутные сегменты: 720 ≈ 12 часов записи. */
const BATCH = 720;

export class Retention {
  constructor(
    private db: CctvDb,
    private storageDir: string,
    private fs: UnlinkFs,
    private quotaBytes: number
  ) {}

  async runOnce(): Promise<{ removed: number; freedBytes: number }> {
    const { bytes } = this.db.totals();
    const candidates = this.db.oldestSegments(BATCH);
    const victims = new Set(planEviction(bytes, this.quotaBytes, candidates));
    if (victims.size === 0) return { removed: 0, freedBytes: 0 };

    let removed = 0;
    let freedBytes = 0;
    for (const seg of candidates) {
      if (!victims.has(seg.id)) continue;
      await this.tryUnlink(seg.path);
      // Запись удаляем независимо от судьбы файла: иначе индекс навсегда
      // разойдётся с диском и чистка встанет.
      this.db.deleteSegment(seg.id);
      removed++;
      freedBytes += seg.bytes;
    }

    for (const orphan of this.db.orphanInits()) {
      await this.tryUnlink(orphan.path);
      this.db.deleteInit(orphan.id);
    }

    return { removed, freedBytes };
  }

  private async tryUnlink(relPath: string): Promise<void> {
    try {
      await this.fs.unlink(`${this.storageDir}/${relPath}`);
    } catch {
      // файла нет или диск недоступен — не повод останавливать чистку
    }
  }
}
