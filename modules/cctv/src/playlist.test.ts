import { buildVodPlaylist } from "./playlist";
import type { SegmentRow } from "./index/db";

let seq = 0;
const seg = (over: Partial<SegmentRow> = {}): SegmentRow => ({
  id: ++seq,
  cam: "drive",
  initId: 1,
  path: `drive/seg_${seq}.m4s`,
  startMs: Date.UTC(2026, 7, 24, 10, 0, 0),
  durMs: 60_000,
  bytes: 4_000_000,
  ...over,
});

beforeEach(() => {
  seq = 0;
});

describe("buildVodPlaylist", () => {
  it("на пустом списке отдаёт валидный пустой VOD-плейлист", () => {
    const pl = buildVodPlaylist([]);
    expect(pl).toContain("#EXTM3U");
    expect(pl).toContain("#EXT-X-PLAYLIST-TYPE:VOD");
    expect(pl).toContain("#EXT-X-ENDLIST");
    expect(pl).not.toContain("#EXTINF");
  });

  it("перечисляет сегменты со временем, длительностью и ссылками", () => {
    const t = Date.UTC(2026, 7, 24, 10, 0, 0);
    const pl = buildVodPlaylist([
      seg({ startMs: t }),
      seg({ startMs: t + 60_000 }),
    ]);
    expect(pl).toContain('#EXT-X-MAP:URI="/api/cctv/init/1"');
    expect(pl).toContain("#EXT-X-PROGRAM-DATE-TIME:2026-08-24T10:00:00.000Z");
    expect(pl).toContain("#EXTINF:60.000,");
    expect(pl).toContain("/api/cctv/segment/1");
    expect(pl).toContain("/api/cctv/segment/2");
    expect(pl.trimEnd().endsWith("#EXT-X-ENDLIST")).toBe(true);
  });

  it("объявляет длительность самого длинного сегмента в TARGETDURATION", () => {
    const pl = buildVodPlaylist([seg({ durMs: 60_000 }), seg({ durMs: 75_400 })]);
    expect(pl).toContain("#EXT-X-TARGETDURATION:76");
  });

  it("ставит разрыв там, где записи не было", () => {
    const t = Date.UTC(2026, 7, 24, 10, 0, 0);
    const pl = buildVodPlaylist([seg({ startMs: t }), seg({ startMs: t + 600_000 })]);
    const lines = pl.split("\n");
    const idx = lines.findIndex((l: string) => l === "#EXT-X-DISCONTINUITY");
    expect(idx).toBeGreaterThan(0);
    // после разрыва обязательно новая метка времени, иначе плеер считает пропуск записанным
    expect(lines.slice(idx).some((l: string) => l.startsWith("#EXT-X-PROGRAM-DATE-TIME:"))).toBe(true);
  });

  it("не ставит разрыв на мелком зазоре в пределах допуска", () => {
    const t = Date.UTC(2026, 7, 24, 10, 0, 0);
    const pl = buildVodPlaylist([seg({ startMs: t }), seg({ startMs: t + 61_000 })]);
    expect(pl).not.toContain("#EXT-X-DISCONTINUITY");
  });

  it("ставит разрыв и новый EXT-X-MAP при смене init", () => {
    const t = Date.UTC(2026, 7, 24, 10, 0, 0);
    const pl = buildVodPlaylist([
      seg({ startMs: t, initId: 1 }),
      seg({ startMs: t + 60_000, initId: 2 }),
    ]);
    expect(pl).toContain('#EXT-X-MAP:URI="/api/cctv/init/1"');
    expect(pl).toContain('#EXT-X-MAP:URI="/api/cctv/init/2"');
    expect(pl).toContain("#EXT-X-DISCONTINUITY");
  });

  it("ссылки можно переопределить", () => {
    const pl = buildVodPlaylist([seg()], {
      segmentUrl: (id: number) => `/s/${id}`,
      initUrl: (id: number) => `/i/${id}`,
    });
    expect(pl).toContain("/s/1");
    expect(pl).toContain('#EXT-X-MAP:URI="/i/1"');
  });

  it("сортирует сегменты по времени", () => {
    const t = Date.UTC(2026, 7, 24, 10, 0, 0);
    const pl = buildVodPlaylist([seg({ startMs: t + 60_000 }), seg({ startMs: t })]);
    const first = pl.indexOf("/api/cctv/segment/2");
    const second = pl.indexOf("/api/cctv/segment/1");
    expect(first).toBeLessThan(second);
  });
});
