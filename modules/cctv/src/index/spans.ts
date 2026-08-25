import type { Span } from "@sweethome/cctv-shared";

/**
 * Допуск на зазор между сегментами. Камера отдаёт ~14 fps без своих временных
 * метоk, поэтому длительности слегка «плавают»; зазор в пределах двух секунд —
 * это та же непрерывная запись, а не разрыв.
 */
export const GAP_TOLERANCE_MS = 2000;

/** Сегменты → непрерывные отрезки записи. Вход сортируется внутри. */
export function buildSpans(
  segs: { startMs: number; durMs: number }[],
  gapToleranceMs: number = GAP_TOLERANCE_MS
): Span[] {
  if (segs.length === 0) return [];
  const sorted = [...segs].sort((a, b) => a.startMs - b.startMs);
  const out: Span[] = [];
  let cur: Span = { startMs: sorted[0].startMs, endMs: sorted[0].startMs + sorted[0].durMs };
  for (const seg of sorted.slice(1)) {
    const end = seg.startMs + seg.durMs;
    if (seg.startMs - cur.endMs <= gapToleranceMs) {
      if (end > cur.endMs) cur.endMs = end; // вложенный сегмент не должен укорачивать отрезок
    } else {
      out.push(cur);
      cur = { startMs: seg.startMs, endMs: end };
    }
  }
  out.push(cur);
  return out;
}

/** Подрезка отрезков по границам запрошенного интервала. */
export function clampSpans(spans: Span[], fromMs: number, toMs: number): Span[] {
  const out: Span[] = [];
  for (const sp of spans) {
    const startMs = Math.max(sp.startMs, fromMs);
    const endMs = Math.min(sp.endMs, toMs);
    if (endMs > startMs) out.push({ startMs, endMs });
  }
  return out;
}
