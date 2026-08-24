import { dayRange, offsetInSpans, ratioAt, spanBars, timeAtRatio, playlistUrl, downloadUrl } from "./cctv";

const T = new Date(2026, 7, 24, 0, 0, 0).getTime();
const H = 3_600_000;

describe("dayRange", () => {
  it("отдаёт сутки от локальной полуночи до полуночи", () => {
    const { fromMs, toMs } = dayRange(new Date(2026, 7, 24, 15, 30));
    expect(new Date(fromMs).getHours()).toBe(0);
    expect(toMs - fromMs).toBe(24 * H);
  });
});

describe("ratioAt", () => {
  it("переводит время в долю от интервала", () => {
    expect(ratioAt(T, T, T + 24 * H)).toBe(0);
    expect(ratioAt(T + 12 * H, T, T + 24 * H)).toBe(0.5);
    expect(ratioAt(T + 24 * H, T, T + 24 * H)).toBe(1);
  });

  it("зажимает выход за границы", () => {
    expect(ratioAt(T - H, T, T + 24 * H)).toBe(0);
    expect(ratioAt(T + 48 * H, T, T + 24 * H)).toBe(1);
  });

  it("вырожденный интервал не делит на ноль", () => {
    expect(ratioAt(T, T, T)).toBe(0);
  });
});

describe("timeAtRatio", () => {
  it("обратен ratioAt", () => {
    expect(timeAtRatio(0.5, T, T + 24 * H)).toBe(T + 12 * H);
    expect(timeAtRatio(0, T, T + 24 * H)).toBe(T);
    expect(timeAtRatio(1, T, T + 24 * H)).toBe(T + 24 * H);
  });

  it("зажимает долю в пределах 0..1", () => {
    expect(timeAtRatio(-1, T, T + 24 * H)).toBe(T);
    expect(timeAtRatio(2, T, T + 24 * H)).toBe(T + 24 * H);
  });
});

describe("spanBars", () => {
  it("превращает отрезки в проценты для шкалы", () => {
    const bars = spanBars([{ startMs: T + 6 * H, endMs: T + 12 * H }], T, T + 24 * H);
    expect(bars).toEqual([{ leftPct: 25, widthPct: 25 }]);
  });

  it("подрезает вылезающие за границы отрезки", () => {
    const bars = spanBars([{ startMs: T - 6 * H, endMs: T + 6 * H }], T, T + 24 * H);
    expect(bars).toEqual([{ leftPct: 0, widthPct: 25 }]);
  });

  it("выбрасывает отрезки вне интервала", () => {
    expect(spanBars([{ startMs: T + 48 * H, endMs: T + 49 * H }], T, T + 24 * H)).toEqual([]);
  });

  it("на пустом списке отдаёт пусто", () => {
    expect(spanBars([], T, T + 24 * H)).toEqual([]);
  });
});

describe("offsetInSpans", () => {
  const spans = [
    { startMs: T, endMs: T + H },              // 0..3600 с плеера
    { startMs: T + 5 * H, endMs: T + 6 * H },  // 3600..7200 с плеера
  ];

  it("переводит реальное время в позицию плеера с учётом пропусков", () => {
    expect(offsetInSpans(T, spans)).toBe(0);
    expect(offsetInSpans(T + 1800_000, spans)).toBe(1800);
    expect(offsetInSpans(T + 5 * H, spans)).toBe(3600);
    expect(offsetInSpans(T + 5.5 * H, spans)).toBe(5400);
  });

  it("для момента без записи отдаёт null", () => {
    expect(offsetInSpans(T + 3 * H, spans)).toBeNull();
    expect(offsetInSpans(T + 100 * H, spans)).toBeNull();
  });

  it("на пустой ленте отдаёт null", () => {
    expect(offsetInSpans(T, [])).toBeNull();
  });
});

describe("url helpers", () => {
  it("собирают адреса плейлиста и скачивания", () => {
    expect(playlistUrl("drive", 1, 2)).toBe("/api/cctv/playlist.m3u8?cam=drive&from=1&to=2");
    expect(downloadUrl("drive", 1, 2)).toBe("/api/cctv/download?cam=drive&from=1&to=2");
  });

  it("экранируют идентификатор камеры", () => {
    expect(playlistUrl("a b", 1, 2)).toContain("cam=a%20b");
  });
});
