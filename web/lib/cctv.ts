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
 *
 * `playlistStartMs` (поле ответа `/timeline`) — начало первого неподрезанного
 * сегмента, то есть настоящий нуль шкалы плеера. Отрезки в `spans` подрезаны по
 * границам запроса, а плейлист начинается с сегмента, стартовавшего ДО них:
 * без этой поправки позиция уезжала бы в прошлое ровно на длину этого «хвоста»
 * (до минуты при минутных сегментах).
 */
export function offsetInSpans(
  tsMs: number,
  spans: Span[],
  playlistStartMs?: number | null
): number | null {
  let acc = 0;
  if (spans.length > 0 && playlistStartMs != null && playlistStartMs < spans[0].startMs) {
    acc = spans[0].startMs - playlistStartMs;
  }
  for (const sp of spans) {
    if (tsMs < sp.startMs) return null;
    if (tsMs < sp.endMs) return Math.round((acc + (tsMs - sp.startMs)) / 1000);
    acc += sp.endMs - sp.startMs;
  }
  return null;
}

/**
 * «14:30» + выбранный день → момент этих суток. Ввод пользовательский, поэтому
 * всё, что не похоже на время, отбрасывается: лучше ничего не сделать, чем
 * увезти зрителя в случайную точку архива.
 */
export function timeOfDayToMs(day: Date, hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  const d = new Date(day);
  d.setHours(h, min, 0, 0);
  return d.getTime();
}

/** Момент → «ЧЧ:ММ» для поля ввода времени (оно требует ведущих нулей). */
export function msToTimeOfDay(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}
