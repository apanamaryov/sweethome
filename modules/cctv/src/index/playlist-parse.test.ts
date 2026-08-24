import { parseHlsPlaylist } from "./playlist-parse";

const HEAD = [
  "#EXTM3U",
  "#EXT-X-VERSION:7",
  "#EXT-X-TARGETDURATION:60",
  "#EXT-X-MEDIA-SEQUENCE:0",
  "#EXT-X-INDEPENDENT-SEGMENTS",
].join("\n");

describe("parseHlsPlaylist", () => {
  it("разбирает сегменты с временем и длительностью", () => {
    const text = [
      HEAD,
      '#EXT-X-MAP:URI="init_run1.mp4"',
      "#EXT-X-PROGRAM-DATE-TIME:2026-08-24T18:33:34.000+0000",
      "#EXTINF:60.000000,",
      "seg_20260824_183334.m4s",
      "#EXT-X-PROGRAM-DATE-TIME:2026-08-24T18:34:34.000+0000",
      "#EXTINF:59.500000,",
      "seg_20260824_183434.m4s",
      "",
    ].join("\n");

    expect(parseHlsPlaylist(text)).toEqual([
      {
        file: "seg_20260824_183334.m4s",
        initFile: "init_run1.mp4",
        startMs: Date.UTC(2026, 7, 24, 18, 33, 34),
        durMs: 60_000,
      },
      {
        file: "seg_20260824_183434.m4s",
        initFile: "init_run1.mp4",
        startMs: Date.UTC(2026, 7, 24, 18, 34, 34),
        durMs: 59_500,
      },
    ]);
  });

  it("вычисляет время сегмента, если метка времени стоит не у каждого", () => {
    const text = [
      HEAD,
      '#EXT-X-MAP:URI="init_run1.mp4"',
      "#EXT-X-PROGRAM-DATE-TIME:2026-08-24T10:00:00.000+0000",
      "#EXTINF:60.000000,",
      "a.m4s",
      "#EXTINF:60.000000,",
      "b.m4s",
      "#EXTINF:60.000000,",
      "c.m4s",
      "",
    ].join("\n");

    const rows = parseHlsPlaylist(text);
    expect(rows.map((r) => r.startMs)).toEqual([
      Date.UTC(2026, 7, 24, 10, 0, 0),
      Date.UTC(2026, 7, 24, 10, 1, 0),
      Date.UTC(2026, 7, 24, 10, 2, 0),
    ]);
  });

  it("переключает init на новый после перезапуска записи", () => {
    const text = [
      HEAD,
      '#EXT-X-MAP:URI="init_run1.mp4"',
      "#EXT-X-PROGRAM-DATE-TIME:2026-08-24T10:00:00.000+0000",
      "#EXTINF:60.000000,",
      "a.m4s",
      "#EXT-X-DISCONTINUITY",
      '#EXT-X-MAP:URI="init_run2.mp4"',
      "#EXT-X-PROGRAM-DATE-TIME:2026-08-24T10:05:00.000+0000",
      "#EXTINF:60.000000,",
      "b.m4s",
      "",
    ].join("\n");

    expect(parseHlsPlaylist(text).map((r) => [r.file, r.initFile])).toEqual([
      ["a.m4s", "init_run1.mp4"],
      ["b.m4s", "init_run2.mp4"],
    ]);
  });

  it("пропускает сегменты без известного init — их нечем воспроизводить", () => {
    const text = [
      HEAD,
      "#EXT-X-PROGRAM-DATE-TIME:2026-08-24T10:00:00.000+0000",
      "#EXTINF:60.000000,",
      "orphan.m4s",
      "",
    ].join("\n");
    expect(parseHlsPlaylist(text)).toEqual([]);
  });

  it("пропускает сегменты без известного времени", () => {
    const text = [HEAD, '#EXT-X-MAP:URI="init.mp4"', "#EXTINF:60.000000,", "a.m4s", ""].join("\n");
    expect(parseHlsPlaylist(text)).toEqual([]);
  });

  it("без EXTINF берёт длительность по умолчанию", () => {
    const text = [
      HEAD,
      '#EXT-X-MAP:URI="init.mp4"',
      "#EXT-X-PROGRAM-DATE-TIME:2026-08-24T10:00:00.000+0000",
      "a.m4s",
      "",
    ].join("\n");
    expect(parseHlsPlaylist(text, 60)).toEqual([
      { file: "a.m4s", initFile: "init.mp4", startMs: Date.UTC(2026, 7, 24, 10, 0, 0), durMs: 60_000 },
    ]);
  });

  it("терпит CRLF, пустые строки и незнакомые теги", () => {
    const text = [
      HEAD,
      "#EXT-X-SOMETHING-NEW:42",
      '#EXT-X-MAP:URI="init.mp4"',
      "",
      "#EXT-X-PROGRAM-DATE-TIME:2026-08-24T10:00:00.000+0000",
      "#EXTINF:60.000000,",
      "a.m4s",
      "",
    ].join("\r\n");
    expect(parseHlsPlaylist(text)).toHaveLength(1);
  });

  it("игнорирует незакрытый хвост: EXTINF без имени файла", () => {
    const text = [
      HEAD,
      '#EXT-X-MAP:URI="init.mp4"',
      "#EXT-X-PROGRAM-DATE-TIME:2026-08-24T10:00:00.000+0000",
      "#EXTINF:60.000000,",
      "a.m4s",
      "#EXT-X-PROGRAM-DATE-TIME:2026-08-24T10:01:00.000+0000",
      "#EXTINF:60.000000,",
      "",
    ].join("\n");
    expect(parseHlsPlaylist(text).map((r) => r.file)).toEqual(["a.m4s"]);
  });

  it("на пустом тексте и на одном заголовке отдаёт пусто", () => {
    expect(parseHlsPlaylist("")).toEqual([]);
    expect(parseHlsPlaylist(HEAD)).toEqual([]);
  });
});
