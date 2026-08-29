import type { AutostopSettings } from "@sweethome/dryer-shared";
import { decideAutostop, type AutostopInput } from "./autostop";

const CFG: AutostopSettings = { excessThreshold: 3, holdMinutes: 30, minRunMinutes: 60 };
const STALE = 60;
const NOW = Date.UTC(2026, 7, 30, 12, 0, 0);
const MIN = 60_000;

/** Ряд с шагом 10 с за последние `minutes` минут; excess — функция от возраста точки в минутах. */
function series(minutes: number, excessAt: (ageMin: number) => number | null, step = 10_000) {
  const out: { ts: number; excess: number | null }[] = [];
  for (let ts = NOW - minutes * MIN; ts <= NOW; ts += step) out.push({ ts, excess: excessAt((NOW - ts) / MIN) });
  return out;
}

const input = (over: Partial<AutostopInput> = {}): AutostopInput => ({
  state: "drying",
  runStartedAt: NOW - 5 * 3600_000,
  now: NOW,
  enabled: true,
  series: series(30, () => 1),
  ...over,
});

describe("decideAutostop", () => {
  it("останавливает: drying, время прошло, окно заполнено, всё ниже порога", () => {
    const d = decideAutostop(input(), CFG, STALE);
    expect(d.stop).toBe(true);
    expect(d.gaps).toBe(false);
    expect(d.belowSince).toBe(NOW - 30 * MIN);
    expect(d.reason).toBe("избыток влажности ниже 3 пунктов уже 30 минут");
  });

  it("выключенный автостоп никогда не останавливает", () => {
    const d = decideAutostop(input({ enabled: false }), CFG, STALE);
    expect(d).toEqual({ stop: false, enabled: false, belowSince: null, gaps: false, reason: "автостоп выключен — остановится по таймеру" });
  });

  it("в разогреве и в других состояниях не решает", () => {
    expect(decideAutostop(input({ state: "heating" }), CFG, STALE)).toMatchObject({
      stop: false,
      reason: "разогрев — автостоп ждёт выхода на уставку",
    });
    expect(decideAutostop(input({ state: "cooldown" }), CFG, STALE)).toMatchObject({
      stop: false,
      reason: "автостоп работает только во время сушки",
    });
    expect(decideAutostop(input({ state: null }), CFG, STALE).stop).toBe(false);
  });

  it("минимальное время сушки ещё не прошло", () => {
    const d = decideAutostop(input({ runStartedAt: NOW - 40 * MIN }), CFG, STALE);
    expect(d.stop).toBe(false);
    expect(d.reason).toBe("минимальное время сушки 60 мин ещё не прошло");
  });

  it("дыра в данных внутри окна → не останавливать, gaps=true", () => {
    const s = series(30, () => 1).filter((p) => !(p.ts > NOW - 20 * MIN && p.ts < NOW - 17 * MIN));
    const d = decideAutostop(input({ series: s }), CFG, STALE);
    expect(d.stop).toBe(false);
    expect(d.gaps).toBe(true);
    expect(d.reason).toBe("автостоп ждёт непрерывных данных");
  });

  it("ряд начинается позже начала окна или кончается слишком давно — тоже дыра", () => {
    expect(decideAutostop(input({ series: series(20, () => 1) }), CFG, STALE).gaps).toBe(true);
    const old = series(30, () => 1).filter((p) => p.ts < NOW - 2 * MIN);
    expect(decideAutostop(input({ series: old }), CFG, STALE).gaps).toBe(true);
    expect(decideAutostop(input({ series: [] }), CFG, STALE).gaps).toBe(true);
  });

  it("null в избытке — дыра", () => {
    const s = series(30, (age) => (age > 10 && age < 11 ? null : 1));
    expect(decideAutostop(input({ series: s }), CFG, STALE).gaps).toBe(true);
  });

  it("избыток ещё высокий — говорим, чего ждём", () => {
    const d = decideAutostop(input({ series: series(30, () => 6.24) }), CFG, STALE);
    expect(d.stop).toBe(false);
    expect(d.belowSince).toBeNull();
    expect(d.reason).toBe("избыток 6.2, ждём ниже 3");
  });

  it("ниже порога только часть окна — считаем минуты", () => {
    const s = series(30, (age) => (age <= 12 ? 1 : 10));
    const d = decideAutostop(input({ series: s }), CFG, STALE);
    expect(d.stop).toBe(false);
    expect(d.belowSince).toBe(NOW - 12 * MIN);
    expect(d.reason).toBe("ниже порога уже 12 мин из 30");
  });

  it("порог — строго ниже: ровно 3 ещё не «ниже»", () => {
    expect(decideAutostop(input({ series: series(30, () => 3) }), CFG, STALE).stop).toBe(false);
  });
});
