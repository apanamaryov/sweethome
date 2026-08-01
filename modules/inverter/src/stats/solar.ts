/**
 * Устойчивое окно солнечного дня по поминутному ряду pvPower.
 * Чистая функция: без БД, сети и обращения к текущему времени (для live
 * `nowMs` передаётся аргументом). Единственный источник правды для истории
 * (свёртка в daily, бэкофилл) и для «сегодня» (эндпоинт).
 */

export type SolarState = "idle" | "active" | "ended";

export interface SolarWindow {
  start: number | null; // unix ms первого устойчивого выхода PV выше порога
  end: number | null; //   unix ms последнего такого момента (null пока «идёт»)
  state: SolarState;
}

export interface SolarParams {
  thresholdW: number; // порог мощности PV, Вт
  dwellMin: number; //   устойчивость в минутах (мин. длина прогона и величина «разрыва»)
}

export interface SolarPoint {
  ts: number; // unix ms, минутно-выровненный
  pv: number; // pvPower, Вт
}

const MIN_MS = 60_000;

interface Run {
  start: number; // ts первой надпороговой минуты прогона
  end: number; //   ts последней надпороговой минуты прогона
  count: number; // число надпороговых минут (без перешагнутых провалов)
}

export function computeSolarWindow(
  points: SolarPoint[],
  params: SolarParams,
  nowMs?: number,
): SolarWindow {
  const { thresholdW, dwellMin } = params;
  const gapMs = dwellMin * MIN_MS;

  // Склеиваем надпороговые минуты в прогоны, перешагивая провалы короче dwellMin.
  const runs: Run[] = [];
  for (const p of points) {
    if (p.pv < thresholdW) continue;
    const last = runs[runs.length - 1];
    if (last && p.ts - last.end < gapMs) {
      last.end = p.ts;
      last.count++;
    } else {
      runs.push({ start: p.ts, end: p.ts, count: 1 });
    }
  }

  // Оставляем прогоны длиной не меньше dwellMin надпороговых минут (спайки — прочь).
  const surviving = runs.filter((r) => r.count >= dwellMin);
  if (surviving.length === 0) return { start: null, end: null, state: "idle" };

  const start = surviving[0].start;
  const lastEnd = surviving[surviving.length - 1].end;

  if (nowMs === undefined) return { start, end: lastEnd, state: "ended" };
  if (nowMs - lastEnd < gapMs) return { start, end: null, state: "active" };
  return { start, end: lastEnd, state: "ended" };
}
