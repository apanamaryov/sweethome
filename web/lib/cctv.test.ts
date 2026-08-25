import { dayRange, offsetInSpans, ratioAt, spanBars, timeAtRatio, playlistUrl, downloadUrl, timeOfDayToMs, msToTimeOfDay } from "./cctv";

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

  /**
   * Стык суток — тот самый случай, из-за которого перемотка промахивалась.
   *
   * Сервер (см. `modules/cctv/src/router.test.ts`, тест «нуль шкалы плейлиста»)
   * на запрос суток отдаёт: `spans`, подрезанные по полуночи, и
   * `playlistStartMs` — начало ПЕРВОГО НЕПОДРЕЗАННОГО сегмента. Плейлист
   * начинается с этого же сегмента, поэтому нуль шкалы плеера — не полночь, а
   * момент на 30 секунд раньше. Цифры здесь те же, что в серверном тесте.
   */
  describe("стык суток: позиция считается в шкале плейлиста", () => {
    const midnight = T;
    const segA = midnight - 30_000; // начался вчера, доигрывает уже в новых сутках
    const segB = segA + 60_000;
    const spansFromServer = [{ startMs: midnight, endMs: segB + 60_000 }]; // подрезано по полуночи
    const playlistStartMs = segA;

    it("совпадает с положением момента в плейлисте", () => {
      const ts = midnight + 10_000;
      // Шкала плейлиста: сегмент A занимает 0..60 с, сегмент B — 60..120 с.
      // Момент ts лежит внутри A, на (ts - segA) от его начала.
      const expectedInPlaylist = (ts - segA) / 1000; // 40 секунд
      expect(offsetInSpans(ts, spansFromServer, playlistStartMs)).toBe(expectedInPlaylist);
    });

    it("во втором сегменте сдвиг тот же, а не накапливается", () => {
      const ts = segB + 15_000;
      expect(offsetInSpans(ts, spansFromServer, playlistStartMs)).toBe((ts - segA) / 1000);
    });

    it("без сдвига (плейлист начинается ровно с интервала) ничего не меняется", () => {
      const ts = midnight + 10_000;
      expect(offsetInSpans(ts, spansFromServer, midnight)).toBe(10);
      // Пустой интервал: сервер отдаёт playlistStartMs = null — считаем как раньше.
      expect(offsetInSpans(ts, spansFromServer, null)).toBe(10);
    });
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

describe("timeOfDayToMs", () => {
  const day = new Date(2026, 7, 25, 9, 41, 12); // время внутри дня роли не играет

  it("переводит время суток в момент выбранного дня", () => {
    const got = timeOfDayToMs(day, "14:30");
    expect(new Date(got!).getFullYear()).toBe(2026);
    expect(new Date(got!).getMonth()).toBe(7);
    expect(new Date(got!).getDate()).toBe(25);
    expect(new Date(got!).getHours()).toBe(14);
    expect(new Date(got!).getMinutes()).toBe(30);
    expect(new Date(got!).getSeconds()).toBe(0);
  });

  it("берёт границы суток", () => {
    expect(new Date(timeOfDayToMs(day, "00:00")!).getHours()).toBe(0);
    expect(new Date(timeOfDayToMs(day, "23:59")!).getMinutes()).toBe(59);
  });

  it("на мусоре и пустом вводе отдаёт null, а не случайный момент", () => {
    expect(timeOfDayToMs(day, "")).toBeNull();
    expect(timeOfDayToMs(day, "25:00")).toBeNull();
    expect(timeOfDayToMs(day, "12:75")).toBeNull();
    expect(timeOfDayToMs(day, "полдень")).toBeNull();
  });
});

describe("msToTimeOfDay", () => {
  it("показывает время суток с ведущими нулями", () => {
    expect(msToTimeOfDay(new Date(2026, 7, 25, 4, 5, 30).getTime())).toBe("04:05");
    expect(msToTimeOfDay(new Date(2026, 7, 25, 23, 59, 59).getTime())).toBe("23:59");
  });
});
