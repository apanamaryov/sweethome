import { CctvDb } from "./db";
import { Scanner, type FsLike } from "./scanner";

const PLAYLIST = [
  "#EXTM3U",
  "#EXT-X-VERSION:7",
  '#EXT-X-MAP:URI="init_run1.mp4"',
  "#EXT-X-PROGRAM-DATE-TIME:2026-08-24T10:00:00.000+0000",
  "#EXTINF:60.000000,",
  "seg_20260824_100000.m4s",
  "#EXT-X-PROGRAM-DATE-TIME:2026-08-24T10:01:00.000+0000",
  "#EXTINF:60.000000,",
  "seg_20260824_100100.m4s",
  "",
].join("\n");

function fakeFs(files: Record<string, string>, sizes: Record<string, number> = {}): FsLike {
  return {
    async readFile(p) {
      if (!(p in files)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return files[p];
    },
    async stat(p) {
      if (p in sizes) return { size: sizes[p] };
      if (p in files) return { size: files[p].length };
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
    async readdir(p) {
      const prefix = p.endsWith("/") ? p : p + "/";
      return Object.keys({ ...files, ...sizes })
        .filter((f) => f.startsWith(prefix))
        .map((f) => f.slice(prefix.length))
        .filter((f) => !f.includes("/"));
    },
  };
}

describe("Scanner", () => {
  let db: CctvDb;
  beforeEach(() => {
    db = new CctvDb(":memory:");
  });
  afterEach(() => db.close());

  it("добавляет сегменты из плейлиста вместе с init", async () => {
    const fs = fakeFs(
      { "/st/drive/live.m3u8": PLAYLIST },
      {
        "/st/drive/init_run1.mp4": 800,
        "/st/drive/seg_20260824_100000.m4s": 4_000_000,
        "/st/drive/seg_20260824_100100.m4s": 3_900_000,
      }
    );
    const sc = new Scanner(db, "/st", fs);
    expect(await sc.scanCamera("drive")).toBe(2);

    const rows = db.segmentsBetween("drive", 0, Date.UTC(2026, 7, 25));
    expect(rows.map((r) => r.path)).toEqual([
      "drive/seg_20260824_100000.m4s",
      "drive/seg_20260824_100100.m4s",
    ]);
    expect(rows[0].bytes).toBe(4_000_000);
    expect(rows[0].startMs).toBe(Date.UTC(2026, 7, 24, 10, 0, 0));
    expect(db.initIdByPath("drive", "drive/init_run1.mp4")).toBe(rows[0].initId);
  });

  it("повторный проход не добавляет ничего нового", async () => {
    const fs = fakeFs({ "/st/drive/live.m3u8": PLAYLIST }, {
      "/st/drive/init_run1.mp4": 800,
      "/st/drive/seg_20260824_100000.m4s": 10,
      "/st/drive/seg_20260824_100100.m4s": 10,
    });
    const sc = new Scanner(db, "/st", fs);
    expect(await sc.scanCamera("drive")).toBe(2);
    expect(await sc.scanCamera("drive")).toBe(0);
    expect(db.totals().count).toBe(2);
  });

  it("подхватывает дописанный хвост плейлиста", async () => {
    const files: Record<string, string> = { "/st/drive/live.m3u8": PLAYLIST };
    const sizes: Record<string, number> = {
      "/st/drive/init_run1.mp4": 800,
      "/st/drive/seg_20260824_100000.m4s": 10,
      "/st/drive/seg_20260824_100100.m4s": 10,
      "/st/drive/seg_20260824_100200.m4s": 10,
    };
    const sc = new Scanner(db, "/st", fakeFs(files, sizes));
    await sc.scanCamera("drive");

    files["/st/drive/live.m3u8"] = PLAYLIST +
      ["#EXT-X-PROGRAM-DATE-TIME:2026-08-24T10:02:00.000+0000", "#EXTINF:60.000000,", "seg_20260824_100200.m4s", ""].join("\n");
    expect(await sc.scanCamera("drive")).toBe(1);
    expect(db.totals().count).toBe(3);
  });

  it("пропускает сегмент, файла которого ещё нет на диске", async () => {
    const fs = fakeFs({ "/st/drive/live.m3u8": PLAYLIST }, {
      "/st/drive/init_run1.mp4": 800,
      "/st/drive/seg_20260824_100000.m4s": 10,
      // второго файла нет — ffmpeg ещё пишет его во временный
    });
    const sc = new Scanner(db, "/st", fs);
    expect(await sc.scanCamera("drive")).toBe(1);
    expect(db.totals().count).toBe(1);
  });

  it("отсутствие плейлиста — не ошибка, просто ноль", async () => {
    const sc = new Scanner(db, "/st", fakeFs({}));
    expect(await sc.scanCamera("drive")).toBe(0);
  });

  it("пропускает сегмент, init которого нет на диске", async () => {
    const fs = fakeFs({ "/st/drive/live.m3u8": PLAYLIST }, {
      "/st/drive/seg_20260824_100000.m4s": 10,
      "/st/drive/seg_20260824_100100.m4s": 10,
    });
    const sc = new Scanner(db, "/st", fs);
    expect(await sc.scanCamera("drive")).toBe(0);
  });

  it("восстанавливает индекс обходом каталога, когда плейлист потерян", async () => {
    const fs = fakeFs({}, {
      "/st/drive/init_run1.mp4": 800,
      "/st/drive/seg_20260824_100000.m4s": 4_000_000,
      "/st/drive/seg_20260824_100100.m4s": 3_900_000,
      "/st/drive/мусор.txt": 5,
    });
    const sc = new Scanner(db, "/st", fs);
    expect(await sc.rebuildCamera("drive")).toBe(2);

    const rows = db.segmentsBetween("drive", 0, Date.UTC(2026, 7, 25));
    expect(rows).toHaveLength(2);
    expect(rows[0].startMs).toBe(new Date(2026, 7, 24, 10, 0, 0).getTime()); // локальное время из имени
    expect(rows[0].durMs).toBe(60_000); // длительность по умолчанию
  });

  it("восстановление не дублирует уже известное", async () => {
    const fs = fakeFs({ "/st/drive/live.m3u8": PLAYLIST }, {
      "/st/drive/init_run1.mp4": 800,
      "/st/drive/seg_20260824_100000.m4s": 10,
      "/st/drive/seg_20260824_100100.m4s": 10,
    });
    const sc = new Scanner(db, "/st", fs);
    await sc.scanCamera("drive");
    expect(await sc.rebuildCamera("drive")).toBe(0);
  });
});
