import express from "express";
import request from "supertest";
import type { CameraInfo } from "@sweethome/cctv-shared";
import { loadCctvConfig } from "./config";
import { CctvDb } from "./index/db";
import { createCctvRouter } from "./router";

type FakeSpawn = (
  cmd: string,
  args: string[]
) => {
  stdout: { pipe(dest: unknown): void } | null;
  on(ev: "exit" | "error", cb: (arg?: unknown) => void): void;
  kill(sig?: string): void;
};

type FakeTmpFile = (content: string) => Promise<{ path: string; cleanup: () => Promise<void> }>;

function app(
  db: CctvDb,
  over: {
    cameras?: CameraInfo[];
    storage?: boolean;
    spawns?: { cmd: string; args: string[] }[];
    spawn?: FakeSpawn;
    tmpFile?: FakeTmpFile;
  } = {}
) {
  const sent: string[] = [];
  const spawns = over.spawns ?? [];
  const cfg = loadCctvConfig("/data", { CCTV_CAMERAS: "drive=10.0.0.1", CCTV_STORAGE_DIR: "/st" });
  const a = express();
  a.use(
    "/api/cctv",
    createCctvRouter({
      cfg,
      db,
      manager: {
        cameras: () =>
          over.cameras ?? [{ id: "drive", name: "drive", recording: true, lastSegmentMs: 1000, restarts: 0 }],
        storageAvailable: () => over.storage ?? true,
      },
      sendFile: (res, abs) => {
        sent.push(abs);
        res.status(200).end();
      },
      spawn:
        over.spawn ??
        ((cmd, args) => {
          spawns.push({ cmd, args });
          return {
            stdout: { pipe: (dest: unknown) => (dest as { end(): void }).end() },
            on: (ev: "exit" | "error", cb: (arg?: unknown) => void) => {
              if (ev === "exit") setImmediate(() => cb(0));
            },
            kill: () => {},
          };
        }),
      tmpFile: over.tmpFile ?? (async () => ({ path: "/tmp/list.txt", cleanup: async () => {} })),
    })
  );
  return { a, sent, spawns };
}

const T = Date.UTC(2026, 7, 24, 10, 0, 0);

function seed(db: CctvDb): { initId: number; ids: number[] } {
  const initId = db.upsertInit("drive", "drive/init_run1.mp4", 800, T);
  const ids = [0, 1, 2].map((i) =>
    db.addSegment({
      cam: "drive", initId, path: `drive/seg_${i}.m4s`,
      startMs: T + i * 60_000, durMs: 60_000, bytes: 4_000_000,
    })
  );
  return { initId, ids };
}

describe("cctv router", () => {
  let db: CctvDb;
  beforeEach(() => {
    db = new CctvDb(":memory:");
  });
  afterEach(() => db.close());

  it("GET /cameras отдаёт список из менеджера", async () => {
    const { a } = app(db);
    const res = await request(a).get("/api/cctv/cameras").expect(200);
    expect(res.body).toEqual({
      cameras: [{ id: "drive", name: "drive", recording: true, lastSegmentMs: 1000, restarts: 0 }],
    });
  });

  it("GET /timeline отдаёт отрезки, метки и суммы", async () => {
    seed(db);
    db.addMotion("drive", T + 30_000, "motion");
    const { a } = app(db);
    const res = await request(a)
      .get(`/api/cctv/timeline?cam=drive&from=${T}&to=${T + 180_000}`)
      .expect(200);

    expect(res.body.cam).toBe("drive");
    expect(res.body.spans).toEqual([{ startMs: T, endMs: T + 180_000 }]);
    expect(res.body.marks).toEqual([{ tsMs: T + 30_000, kind: "motion" }]);
    expect(res.body.segments).toBe(3);
    expect(res.body.bytes).toBe(12_000_000);
  });

  it("GET /timeline показывает разрыв как разрыв", async () => {
    const initId = db.upsertInit("drive", "drive/init_run1.mp4", 800, T);
    db.addSegment({ cam: "drive", initId, path: "a", startMs: T, durMs: 60_000, bytes: 1 });
    db.addSegment({ cam: "drive", initId, path: "b", startMs: T + 600_000, durMs: 60_000, bytes: 1 });
    const { a } = app(db);
    const res = await request(a).get(`/api/cctv/timeline?cam=drive&from=${T}&to=${T + 900_000}`).expect(200);
    expect(res.body.spans).toEqual([
      { startMs: T, endMs: T + 60_000 },
      { startMs: T + 600_000, endMs: T + 660_000 },
    ]);
  });

  it("GET /timeline подрезает отрезки по границам запроса", async () => {
    seed(db);
    const { a } = app(db);
    const res = await request(a)
      .get(`/api/cctv/timeline?cam=drive&from=${T + 30_000}&to=${T + 90_000}`)
      .expect(200);
    expect(res.body.spans).toEqual([{ startMs: T + 30_000, endMs: T + 90_000 }]);
  });

  it("GET /timeline требует корректных параметров", async () => {
    const { a } = app(db);
    await request(a).get("/api/cctv/timeline").expect(400);
    await request(a).get("/api/cctv/timeline?cam=drive").expect(400);
    await request(a).get(`/api/cctv/timeline?cam=drive&from=abc&to=${T}`).expect(400);
    await request(a).get(`/api/cctv/timeline?cam=drive&from=${T}&to=${T - 1}`).expect(400);
  });

  it("GET /timeline не знает такой камеры → 404", async () => {
    const { a } = app(db);
    await request(a).get(`/api/cctv/timeline?cam=nope&from=${T}&to=${T + 1000}`).expect(404);
  });

  it("GET /playlist.m3u8 отдаёт плейлист с правильным типом содержимого", async () => {
    seed(db);
    const { a } = app(db);
    const res = await request(a)
      .get(`/api/cctv/playlist.m3u8?cam=drive&from=${T}&to=${T + 180_000}`)
      .expect(200);
    expect(res.headers["content-type"]).toContain("application/vnd.apple.mpegurl");
    expect(res.text).toContain("#EXT-X-PLAYLIST-TYPE:VOD");
    expect(res.text).toContain("/api/cctv/segment/");
    expect(res.text).toContain("#EXT-X-ENDLIST");
  });

  it("GET /playlist.m3u8 на пустом интервале отдаёт пустой плейлист, а не ошибку", async () => {
    seed(db);
    const { a } = app(db);
    const res = await request(a)
      .get(`/api/cctv/playlist.m3u8?cam=drive&from=${T + 10_000_000}&to=${T + 10_060_000}`)
      .expect(200);
    expect(res.text).not.toContain("#EXTINF");
  });

  it("GET /segment/:id отдаёт файл по пути из индекса", async () => {
    const { ids } = seed(db);
    const { a, sent } = app(db);
    await request(a).get(`/api/cctv/segment/${ids[0]}`).expect(200);
    expect(sent).toEqual(["/st/drive/seg_0.m4s"]);
  });

  it("GET /init/:id отдаёт init-сегмент", async () => {
    const { initId } = seed(db);
    const { a, sent } = app(db);
    await request(a).get(`/api/cctv/init/${initId}`).expect(200);
    expect(sent).toEqual(["/st/drive/init_run1.mp4"]);
  });

  it("несуществующий id → 404, нечисловой → 400", async () => {
    const { a } = app(db);
    await request(a).get("/api/cctv/segment/999999").expect(404);
    await request(a).get("/api/cctv/init/999999").expect(404);
    await request(a).get("/api/cctv/segment/abc").expect(400);
  });

  it("обход каталога невозможен: путь берётся из индекса, а не из запроса", async () => {
    const { a, sent } = app(db);
    await request(a).get("/api/cctv/segment/..%2F..%2Fetc%2Fpasswd").expect(400);
    expect(sent).toEqual([]);
  });

  it("GET /storage отдаёт занятое, квоту и оценку глубины", async () => {
    seed(db);
    const { a } = app(db);
    const res = await request(a).get("/api/cctv/storage").expect(200);
    expect(res.body.available).toBe(true);
    expect(res.body.usedBytes).toBe(12_000_000);
    expect(res.body.quotaBytes).toBe(500 * 1024 ** 3);
    expect(res.body.oldestMs).toBe(T);
    expect(res.body.newestMs).toBe(T + 180_000);
  });

  it("GET /storage сообщает о недоступном хранилище", async () => {
    const { a } = app(db, { storage: false });
    const res = await request(a).get("/api/cctv/storage").expect(200);
    expect(res.body.available).toBe(false);
  });

  it("GET /storage на пустом архиве не делит на ноль", async () => {
    const { a } = app(db);
    const res = await request(a).get("/api/cctv/storage").expect(200);
    expect(res.body.usedBytes).toBe(0);
    expect(res.body.depthDays).toBeNull();
  });

  it("GET /download отдаёт файл с нужными заголовками", async () => {
    seed(db);
    const spawns: { cmd: string; args: string[] }[] = [];
    const { a } = app(db, { spawns });
    const res = await request(a)
      .get(`/api/cctv/download?cam=drive&from=${T}&to=${T + 120_000}`)
      .expect(200);
    expect(res.headers["content-type"]).toContain("video/mp4");
    expect(res.headers["content-disposition"]).toContain("attachment");
    expect(res.headers["content-disposition"]).toMatch(/drive_\d{8}_\d{6}\.mp4/);
    expect(spawns).toHaveLength(1);
    expect(spawns[0].args.join(" ")).toContain("-f concat");
  });

  it("GET /download отказывает на слишком длинном интервале", async () => {
    seed(db);
    const { a, spawns } = app(db);
    await request(a)
      .get(`/api/cctv/download?cam=drive&from=${T}&to=${T + 31 * 60_000}`)
      .expect(413);
    // Регрессия: если проверку интервала переставят после запуска ffmpeg,
    // счётчик спавнов это поймает раньше, чем кто-то заметит по логам.
    expect(spawns).toHaveLength(0);
  });

  it("GET /download на пустом интервале → 404", async () => {
    seed(db);
    const { a, spawns } = app(db);
    await request(a)
      .get(`/api/cctv/download?cam=drive&from=${T + 10_000_000}&to=${T + 10_060_000}`)
      .expect(404);
    expect(spawns).toHaveLength(0);
  });

  it("GET /download: отсутствующий в индексе init → 500, ffmpeg не запускается", async () => {
    // node:sqlite держит PRAGMA foreign_keys = ON, поэтому через настоящий
    // CctvDb сегмент с несуществующим initId не создать — сама база не даёт
    // дойти до рассогласования. Подставляем минимальный фейковый индекс, чтобы
    // проверить именно реакцию роутера на такое рассогласование данных.
    const fakeDb = {
      segmentsBetween: () => [
        { id: 1, cam: "drive", initId: 9999, path: "drive/seg_0.m4s", startMs: T, durMs: 60_000, bytes: 1 },
      ],
      initPathById: () => null,
    } as unknown as CctvDb;
    const { a, spawns } = app(fakeDb);
    const res = await request(a)
      .get(`/api/cctv/download?cam=drive&from=${T}&to=${T + 60_000}`)
      .expect(500);
    expect(res.body.ok).toBe(false);
    expect(spawns).toHaveLength(0);
  });

  it("GET /download: синхронный сбой spawn не роняет процесс, отдаёт 500 и убирает временный файл", async () => {
    seed(db);
    let cleaned = false;
    const { a } = app(db, {
      spawn: () => {
        throw new Error("ffmpeg binary not found");
      },
      tmpFile: async () => ({
        path: "/tmp/list.txt",
        cleanup: async () => {
          cleaned = true;
        },
      }),
    });
    const res = await request(a)
      .get(`/api/cctv/download?cam=drive&from=${T}&to=${T + 120_000}`)
      .expect(500);
    expect(res.body.ok).toBe(false);
    expect(cleaned).toBe(true);
  });

  it("GET /download: событие error от ffmpeg обрабатывается, не роняя процесс", async () => {
    seed(db);
    let cleaned = false;
    const { a } = app(db, {
      spawn: () => ({
        stdout: { pipe: () => {} },
        on: (ev, cb) => {
          // Реальный ChildProcess эмитит "error" асинхронно (spawn ENOENT и
          // подобные) — setImmediate воспроизводит эту асинхронность.
          if (ev === "error") setImmediate(() => cb(new Error("ffmpeg crashed")));
        },
        kill: () => {},
      }),
      tmpFile: async () => ({
        path: "/tmp/list.txt",
        cleanup: async () => {
          cleaned = true;
        },
      }),
    });
    // Само по себе отсутствие необработанного исключения (и незавершившийся
    // процесс jest) — уже доказательство того, что "error" обработан.
    const res = await request(a).get(`/api/cctv/download?cam=drive&from=${T}&to=${T + 120_000}`);
    expect(res.status).toBe(500);
    expect(cleaned).toBe(true);
  });
});
