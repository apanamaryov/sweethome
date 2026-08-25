import { buildSpans, clampSpans, GAP_TOLERANCE_MS } from "./spans";

const s = (startMs: number, durMs = 60_000) => ({ startMs, durMs });

describe("buildSpans", () => {
  it("на пустом списке отдаёт пустой результат", () => {
    expect(buildSpans([])).toEqual([]);
  });

  it("склеивает идущие подряд сегменты в один отрезок", () => {
    expect(buildSpans([s(0), s(60_000), s(120_000)])).toEqual([{ startMs: 0, endMs: 180_000 }]);
  });

  it("терпит мелкие зазоры внутри допуска", () => {
    expect(buildSpans([s(0), s(61_000)])).toEqual([{ startMs: 0, endMs: 121_000 }]);
  });

  it("разрывает отрезок, когда зазор больше допуска", () => {
    expect(buildSpans([s(0), s(65_000)])).toEqual([
      { startMs: 0, endMs: 60_000 },
      { startMs: 65_000, endMs: 125_000 },
    ]);
  });

  it("допуск настраивается", () => {
    expect(buildSpans([s(0), s(65_000)], 10_000)).toEqual([{ startMs: 0, endMs: 125_000 }]);
    expect(GAP_TOLERANCE_MS).toBe(2000);
  });

  it("не ломается на пересекающихся сегментах — конец только растёт", () => {
    expect(buildSpans([s(0, 60_000), s(30_000, 60_000)])).toEqual([{ startMs: 0, endMs: 90_000 }]);
    expect(buildSpans([s(0, 90_000), s(30_000, 10_000)])).toEqual([{ startMs: 0, endMs: 90_000 }]);
  });

  it("сортирует вход сама, а не полагается на порядок", () => {
    expect(buildSpans([s(120_000), s(0), s(60_000)])).toEqual([{ startMs: 0, endMs: 180_000 }]);
  });

  it("несколько разрывов дают несколько отрезков", () => {
    expect(buildSpans([s(0), s(600_000), s(660_000), s(2_000_000)])).toEqual([
      { startMs: 0, endMs: 60_000 },
      { startMs: 600_000, endMs: 720_000 },
      { startMs: 2_000_000, endMs: 2_060_000 },
    ]);
  });
});

describe("clampSpans", () => {
  it("подрезает отрезки по границам запроса", () => {
    const spans = [{ startMs: 0, endMs: 100 }, { startMs: 200, endMs: 300 }];
    expect(clampSpans(spans, 50, 250)).toEqual([
      { startMs: 50, endMs: 100 },
      { startMs: 200, endMs: 250 },
    ]);
  });

  it("выбрасывает отрезки целиком вне интервала", () => {
    const spans = [{ startMs: 0, endMs: 100 }, { startMs: 500, endMs: 600 }];
    expect(clampSpans(spans, 400, 700)).toEqual([{ startMs: 500, endMs: 600 }]);
  });

  it("выбрасывает отрезки, вырожденные после подрезки", () => {
    expect(clampSpans([{ startMs: 0, endMs: 100 }], 100, 200)).toEqual([]);
  });
});
