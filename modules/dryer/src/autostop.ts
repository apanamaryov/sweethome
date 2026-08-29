import type { AutostopSettings, AutostopStatus, NodeState } from "@sweethome/dryer-shared";

export interface AutostopInput {
  state: NodeState | null;
  runStartedAt: number;
  now: number;
  enabled: boolean;
  /** Замеры за окно [now − holdMinutes, now], по возрастанию ts (DryerStore.excessSeries). */
  series: { ts: number; excess: number | null }[];
}

export type AutostopDecision = AutostopStatus & { stop: boolean };

const fmt1 = (v: number) => String(Math.round(v * 10) / 10);

/**
 * «Продукт сухой» (спека §8): состояние drying, прошло minRunMinutes, окно удержания заполнено
 * без дыр и все точки ниже порога. Любая дыра — не останавливаем: лучше пересушить на полчаса,
 * чем остановить мокрое. Чистая функция — вся логика проверяется без брокера и железа.
 */
export function decideAutostop(input: AutostopInput, cfg: AutostopSettings, staleAfterSeconds: number): AutostopDecision {
  const base = { enabled: input.enabled, belowSince: null as number | null, gaps: false };
  if (!input.enabled) return { ...base, stop: false, reason: "автостоп выключен — остановится по таймеру" };

  const staleMs = staleAfterSeconds * 1000;
  const windowStart = input.now - cfg.holdMinutes * 60_000;
  const s = input.series;

  // Дыры: ряд должен начинаться не позже начала окна (с допуском на один интервал
  // устаревания), кончаться не раньше now − stale, и не иметь промежутков больше stale.
  let gaps = s.length === 0;
  if (!gaps) {
    if (s[0].ts > windowStart + staleMs) gaps = true;
    if (input.now - s[s.length - 1].ts > staleMs) gaps = true;
    for (let i = 1; i < s.length && !gaps; i++) if (s[i].ts - s[i - 1].ts > staleMs) gaps = true;
    if (s.some((p) => p.excess === null || !Number.isFinite(p.excess))) gaps = true;
  }

  // С какого момента избыток непрерывно ниже порога (хвост ряда).
  let belowSince: number | null = null;
  for (let i = s.length - 1; i >= 0; i--) {
    const x = s[i].excess;
    if (x === null || !(x < cfg.excessThreshold)) break;
    belowSince = s[i].ts;
  }

  if (input.state !== "drying") {
    return {
      ...base,
      belowSince,
      gaps,
      stop: false,
      reason: input.state === "heating" ? "разогрев — автостоп ждёт выхода на уставку" : "автостоп работает только во время сушки",
    };
  }
  const elapsedMin = (input.now - input.runStartedAt) / 60_000;
  if (elapsedMin < cfg.minRunMinutes) {
    return { ...base, belowSince, gaps, stop: false, reason: `минимальное время сушки ${cfg.minRunMinutes} мин ещё не прошло` };
  }
  if (gaps) return { ...base, belowSince, gaps, stop: false, reason: "автостоп ждёт непрерывных данных" };

  const last = s[s.length - 1].excess as number;
  if (belowSince === null) return { ...base, gaps, stop: false, reason: `избыток ${fmt1(last)}, ждём ниже ${cfg.excessThreshold}` };

  const coversWindow = belowSince <= windowStart + staleMs;
  if (!coversWindow) {
    const minutes = Math.round((input.now - belowSince) / 60_000);
    return { ...base, belowSince, gaps, stop: false, reason: `ниже порога уже ${minutes} мин из ${cfg.holdMinutes}` };
  }
  return {
    ...base,
    belowSince,
    gaps,
    stop: true,
    reason: `избыток влажности ниже ${cfg.excessThreshold} пунктов уже ${cfg.holdMinutes} минут`,
  };
}
