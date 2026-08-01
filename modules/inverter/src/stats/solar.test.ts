import { computeSolarWindow, SolarParams, SolarPoint } from "./solar";

const P: SolarParams = { thresholdW: 200, dwellMin: 15 };
const MIN = 60_000;

/** Ряд поминутных точек: с ts0, по одной на минуту, значения pv из массива. */
function series(ts0: number, pv: number[]): SolarPoint[] {
  return pv.map((v, i) => ({ ts: ts0 + i * MIN, pv: v }));
}
/** Прямоугольный «прогон»: n минут подряд со значением v, начиная с ts0. */
function run(ts0: number, n: number, v: number): SolarPoint[] {
  return series(ts0, Array(n).fill(v));
}

describe("computeSolarWindow", () => {
  it("пустой ряд → idle, null/null", () => {
    expect(computeSolarWindow([], P)).toEqual({ start: null, end: null, state: "idle" });
  });

  it("полностью тёмный день (всё ниже порога) → idle", () => {
    expect(computeSolarWindow(run(0, 600, 50), P)).toEqual({ start: null, end: null, state: "idle" });
  });

  it("нормальный день: 07:00–19:00 выше порога → start=07:00, end=19:00, ended", () => {
    const day0 = new Date(2026, 0, 15, 0, 0, 0).getTime();
    const t7 = day0 + 7 * 60 * MIN;
    const pts = run(t7, 12 * 60 + 1, 800); // 07:00..19:00 включительно
    const w = computeSolarWindow(pts, P);
    expect(w.state).toBe("ended");
    expect(w.start).toBe(t7);
    expect(w.end).toBe(t7 + 12 * 60 * MIN);
  });

  it("рассветный всплеск (5 мин) отфильтровывается — начало у реального прогона", () => {
    const spike = run(0, 5, 900);              // 00:00..00:04 — 5 надпороговых минут < 15
    const real = run(60 * MIN, 120, 800);      // 01:00.. — 120 минут
    const w = computeSolarWindow([...spike, ...real], P);
    expect(w.start).toBe(60 * MIN);
    expect(w.end).toBe(60 * MIN + 119 * MIN);
  });

  it("закатный всплеск (5 мин) отфильтровывается — конец у реального прогона", () => {
    const real = run(0, 120, 800);                     // 00:00.. 120 минут
    const spike = run(300 * MIN, 5, 900);              // много позже, изолирован >15 мин тьмы
    const w = computeSolarWindow([...real, ...spike], P);
    expect(w.start).toBe(0);
    expect(w.end).toBe(119 * MIN);
  });

  it("длинное облако среди дня (30 мин ниже порога) — одна пара, конец у последнего прогона", () => {
    const morning = run(0, 120, 800);                          // 00:00..01:59
    const cloud = run(120 * MIN, 30, 0);                       // 30 мин тьмы (>15 → разрыв)
    const afternoon = run(150 * MIN, 120, 800);                // 02:30..04:29
    const w = computeSolarWindow([...morning, ...cloud, ...afternoon], P);
    expect(w.state).toBe("ended");
    expect(w.start).toBe(0);
    expect(w.end).toBe(150 * MIN + 119 * MIN);
  });

  it("короткое облако (10 мин < dwell) НЕ рвёт прогон", () => {
    const a = run(0, 60, 800);
    const gap = run(60 * MIN, 10, 0);          // 10 мин < 15 → мост
    const b = run(70 * MIN, 60, 800);
    const w = computeSolarWindow([...a, ...gap, ...b], P);
    expect(w.start).toBe(0);
    expect(w.end).toBe(70 * MIN + 59 * MIN);
  });

  it("граница: прогон ровно 15 надпороговых минут — засчитывается", () => {
    const w = computeSolarWindow(run(0, 15, 800), P);
    expect(w.state).toBe("ended");
    expect(w.start).toBe(0);
  });

  it("граница: прогон 14 минут — отбрасывается (idle)", () => {
    expect(computeSolarWindow(run(0, 14, 800), P).state).toBe("idle");
  });

  it("live: последний надпороговый ~5 мин назад → active, end=null", () => {
    const pts = run(0, 120, 800);              // до 01:59
    const now = 120 * MIN + 5 * MIN;           // 02:04
    const w = computeSolarWindow(pts, P, now);
    expect(w.state).toBe("active");
    expect(w.start).toBe(0);
    expect(w.end).toBeNull();
  });

  it("live: последний надпороговый >15 мин назад → ended, end проставлен", () => {
    const pts = run(0, 120, 800);              // до 01:59
    const now = 120 * MIN + 30 * MIN;          // 02:29
    const w = computeSolarWindow(pts, P, now);
    expect(w.state).toBe("ended");
    expect(w.start).toBe(0);
    expect(w.end).toBe(119 * MIN);
  });

  it("live без единого прогона → idle", () => {
    const w = computeSolarWindow(run(0, 10, 800), P, 100 * MIN);
    expect(w).toEqual({ start: null, end: null, state: "idle" });
  });
});
