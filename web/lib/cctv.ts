import type { CameraInfo, Span, StorageInfo, TimelineResponse } from "@sweethome/cctv-shared";
import { getJson } from "@/lib/api";

export type { CameraInfo, Span, StorageInfo, TimelineResponse };

export async function fetchCameras(): Promise<CameraInfo[]> {
  const r = await getJson<{ cameras: CameraInfo[] }>("/api/cctv/cameras");
  return r.cameras;
}

export function fetchTimeline(cam: string, fromMs: number, toMs: number): Promise<TimelineResponse> {
  return getJson<TimelineResponse>(
    `/api/cctv/timeline?cam=${encodeURIComponent(cam)}&from=${fromMs}&to=${toMs}`
  );
}

export function fetchStorage(): Promise<StorageInfo> {
  return getJson<StorageInfo>("/api/cctv/storage");
}

export function playlistUrl(cam: string, fromMs: number, toMs: number): string {
  return `/api/cctv/playlist.m3u8?cam=${encodeURIComponent(cam)}&from=${fromMs}&to=${toMs}`;
}

export function downloadUrl(cam: string, fromMs: number, toMs: number): string {
  return `/api/cctv/download?cam=${encodeURIComponent(cam)}&from=${fromMs}&to=${toMs}`;
}

/** Сутки от локальной полуночи — архив листается по календарным дням. */
export function dayRange(day: Date): { fromMs: number; toMs: number } {
  const from = new Date(day);
  from.setHours(0, 0, 0, 0);
  const to = new Date(from);
  to.setDate(to.getDate() + 1);
  return { fromMs: from.getTime(), toMs: to.getTime() };
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

export function ratioAt(tsMs: number, fromMs: number, toMs: number): number {
  if (toMs <= fromMs) return 0;
  return clamp01((tsMs - fromMs) / (toMs - fromMs));
}

export function timeAtRatio(ratio: number, fromMs: number, toMs: number): number {
  return Math.round(fromMs + clamp01(ratio) * (toMs - fromMs));
}

/** Отрезки записи → полоски шкалы в процентах. */
export function spanBars(
  spans: Span[],
  fromMs: number,
  toMs: number
): { leftPct: number; widthPct: number }[] {
  const out: { leftPct: number; widthPct: number }[] = [];
  for (const sp of spans) {
    const left = ratioAt(sp.startMs, fromMs, toMs);
    const right = ratioAt(sp.endMs, fromMs, toMs);
    if (right <= left) continue;
    out.push({ leftPct: left * 100, widthPct: (right - left) * 100 });
  }
  return out;
}

/**
 * Реальное время → позиция внутри плейлиста (секунды).
 *
 * Плеер не знает о пропусках: в его шкале время идёт подряд, поэтому позицию
 * приходится считать как сумму длительностей предыдущих отрезков. Момент, когда
 * записи не было, спозиционировать нельзя — отсюда null.
 */
export function offsetInSpans(tsMs: number, spans: Span[]): number | null {
  let acc = 0;
  for (const sp of spans) {
    if (tsMs < sp.startMs) return null;
    if (tsMs < sp.endMs) return Math.round((acc + (tsMs - sp.startMs)) / 1000);
    acc += sp.endMs - sp.startMs;
  }
  return null;
}
