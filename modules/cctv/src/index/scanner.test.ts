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

/** Та же поддельная ФС, но со счётчиком `stat` — для тестов про повторные проходы. */
function countingFs(
  files: Record<string, string>,
  sizes: Record<string, number> = {}
): FsLike & { stats: string[] } {
  const base = fakeFs(files, sizes);
  const stats: string[] = [];
  return {
    stats,
    readFile: (p) => base.readFile(p),
    readdir: (p) => base.readdir(p),
    stat: (p) => {
      stats.push(p);
      return base.stat(p);
    },
  };
}

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

  it("повторный проход не трогает диск по уже известным сегментам", async () => {
    const fs = countingFs({ "/st/drive/live.m3u8": PLAYLIST }, {
      "/st/drive/init_run1.mp4": 800,
      "/st/drive/seg_20260824_100000.m4s": 10,
      "/st/drive/seg_20260824_100100.m4s": 10,
    });
    const sc = new Scanner(db, "/st", fs);
    await sc.scanCamera("drive");
    fs.stats.length = 0;

    expect(await sc.scanCamera("drive")).toBe(0);
    expect(fs.stats).toEqual([]);
  });

  it("вытесненные чисткой сегменты не обходятся заново", async () => {
    // Плейлист ffmpeg пишется с append_list и хранит всю историю; чистка удаляет
    // строку сегмента из индекса, но не из плейлиста. Без отметки «докуда
    // разобрано» сканер бесконечно ходил бы stat'ом по уже вытесненному — по
    // сетевому диску, каждые 15 секунд, и число обращений росло бы без предела.
    const fs = countingFs({ "/st/drive/live.m3u8": PLAYLIST }, {
      "/st/drive/init_run1.mp4": 800,
      "/st/drive/seg_20260824_100000.m4s": 10,
      "/st/drive/seg_20260824_100100.m4s": 10,
    });
    const sc = new Scanner(db, "/st", fs);
    expect(await sc.scanCamera("drive")).toBe(2);

    for (const row of db.oldestSegments(10)) db.deleteSegment(row.id); // как после квоты
    fs.stats.length = 0;

    expect(await sc.scanCamera("drive")).toBe(0);
    expect(fs.stats).toEqual([]);
    expect(db.totals().count).toBe(0); // и не воскресили удалённое
  });

  it("новый init в хвосте плейлиста привязывается, хотя ранние записи пропущены", async () => {
    const files: Record<string, string> = { "/st/drive/live.m3u8": PLAYLIST };
    const sizes: Record<string, number> = {
      "/st/drive/init_run1.mp4": 800,
      "/st/drive/init_run2.mp4": 810,
      "/st/drive/seg_20260824_100000.m4s": 10,
      "/st/drive/seg_20260824_100100.m4s": 10,
      "/st/drive/seg_20260824_100200.m4s": 10,
    };
    const sc = new Scanner(db, "/st", fakeFs(files, sizes));
    await sc.scanCamera("drive");

    // Перезапуск записи: у хвоста свой init, а ранние строки плейлиста будут
    // пропущены по отметке — привязка нового init'а от этого страдать не должна.
    files["/st/drive/live.m3u8"] =
      PLAYLIST +
      [
        "#EXT-X-DISCONTINUITY",
        '#EXT-X-MAP:URI="init_run2.mp4"',
        "#EXT-X-PROGRAM-DATE-TIME:2026-08-24T10:02:00.000+0000",
        "#EXTINF:60.000000,",
        "seg_20260824_100200.m4s",
        "",
      ].join("\n");

    expect(await sc.scanCamera("drive")).toBe(1);
    const rows = db.segmentsBetween("drive", 0, Date.UTC(2026, 7, 25));
    const tail = rows.find((r) => r.path === "drive/seg_20260824_100200.m4s");
    expect(tail?.initId).toBe(db.initIdByPath("drive", "drive/init_run2.mp4"));
    expect(tail?.initId).not.toBe(db.initIdByPath("drive", "drive/init_run1.mp4"));
  });

  it("сегмент, файла которого ещё не было, доиндексируется следующим проходом", async () => {
    const sizes: Record<string, number> = {
      "/st/drive/init_run1.mp4": 800,
      "/st/drive/seg_20260824_100000.m4s": 10,
      // второго файла пока нет — ffmpeg дописывает его во временный
    };
    const sc = new Scanner(db, "/st", fakeFs({ "/st/drive/live.m3u8": PLAYLIST }, sizes));
    expect(await sc.scanCamera("drive")).toBe(1);

    sizes["/st/drive/seg_20260824_100100.m4s"] = 10;
    // Отметка не должна была перепрыгнуть через пропущенный сегмент.
    expect(await sc.scanCamera("drive")).toBe(1);
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

  it("rebuildCamera выбирает init по времени его запуска", async () => {
    const t1 = new Date(2026, 7, 24, 9, 0, 0).getTime(); // 9:00
    const t2 = new Date(2026, 7, 24, 10, 0, 0).getTime(); // 10:00

    const init1Name = `init_${t1.toString(36)}.mp4`;
    const init2Name = `init_${t2.toString(36)}.mp4`;

    const sizes: Record<string, number> = {};
    sizes[`/st/drive/${init1Name}`] = 800;
    sizes[`/st/drive/${init2Name}`] = 800;
    sizes["/st/drive/seg_20260824_085000.m4s"] = 1000; // до обоих init'ов
    sizes["/st/drive/seg_20260824_093000.m4s"] = 1000; // между init1 и init2
    sizes["/st/drive/seg_20260824_100500.m4s"] = 1000; // после init2
    sizes["/st/drive/seg_20260824_110000.m4s"] = 1000; // далеко после init2

    const fs = fakeFs({}, sizes);
    const sc = new Scanner(db, "/st", fs);
    expect(await sc.rebuildCamera("drive")).toBe(4);

    const rows = db.segmentsBetween("drive", 0, Date.UTC(2026, 7, 25));
    expect(rows).toHaveLength(4);

    const seg1 = rows.find((r) => r.path === "drive/seg_20260824_085000.m4s");
    const seg2 = rows.find((r) => r.path === "drive/seg_20260824_093000.m4s");
    const seg3 = rows.find((r) => r.path === "drive/seg_20260824_100500.m4s");
    const seg4 = rows.find((r) => r.path === "drive/seg_20260824_110000.m4s");

    const init1Id = db.initIdByPath("drive", `drive/${init1Name}`);
    const init2Id = db.initIdByPath("drive", `drive/${init2Name}`);

    // seg1 (85:00) — до всех init'ов, используется самый свежий (init2)
    expect(seg1?.initId).toBe(init2Id);
    // seg2 (93:00) — между init1 и init2, используется init1
    expect(seg2?.initId).toBe(init1Id);
    // seg3 (100:30) — после init2, используется init2
    expect(seg3?.initId).toBe(init2Id);
    // seg4 (110:00) — далеко после init2, используется init2
    expect(seg4?.initId).toBe(init2Id);
  });

  it("scanCamera пробрасывает не-ENOENT ошибки", async () => {
    const fs: FsLike = {
      async readFile() {
        throw Object.assign(new Error("I/O error"), { code: "EIO" });
      },
      async stat() {
        throw new Error("unreachable");
      },
      async readdir() {
        throw new Error("unreachable");
      },
    };
    const sc = new Scanner(db, "/st", fs);
    await expect(sc.scanCamera("drive")).rejects.toThrow("I/O error");
  });
});
