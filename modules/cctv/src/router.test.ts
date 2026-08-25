import express from "express";
import { Readable } from "stream";
import request from "supertest";
import type { CameraInfo } from "@sweethome/cctv-shared";
import { loadCctvConfig } from "./config";
import { CctvDb } from "./index/db";
import { createCctvRouter, type OpenRead } from "./router";

/** Ответ супертеста как сырые байты: /download отдаёт видео, а не JSON. */
const asBuffer = (r: request.Test) =>
  r.buffer(true).parse((res, cb) => {
    const chunks: Buffer[] = [];
    res.on("data", (c: Buffer) => chunks.push(Buffer.from(c)));
    res.on("end", () => cb(null, Buffer.concat(chunks)));
  });

function app(
  db: CctvDb,
  over: {
    cameras?: CameraInfo[];
    storage?: boolean;
    /** Содержимое «диска»: абсолютный путь → байты файла. */
    files?: Record<string, string>;
    openRead?: OpenRead;
  } = {}
) {
  const sent: string[] = [];
  const reads: string[] = [];
  const files = over.files ?? {};
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
      openRead:
        over.openRead ??
        ((abs) => {
          reads.push(abs);
          const content = files[abs];
          if (content === undefined) {
            return Readable.from(
              (async function* () {
                throw Object.assign(new Error(`ENOENT: ${abs}`), { code: "ENOENT" });
              })()
            );
          }
          // Двумя кусками — чтобы склейка проверялась на потоке, а не на одном
          // удачно целиком прочитанном буфере.
          const mid = Math.ceil(content.length / 2);
          return Readable.from([Buffer.from(content.slice(0, mid)), Buffer.from(content.slice(mid))]);
        }),
    })
  );
  return { a, sent, reads };
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

  // Стык суток: сегмент начался до полуночи и продолжается внутрь суток. Полосы
  // на ленте подрезаны по границе запроса, а плейлист начинается с целого
  // сегмента — обе стороны должны договориться о нуле шкалы, иначе перемотка
  // промахивается на «хвост» первого сегмента (тут — на 30 секунд).
  it("GET /timeline отдаёт нуль шкалы плейлиста — начало неподрезанного сегмента", async () => {
    const midnight = Date.UTC(2026, 7, 24, 0, 0, 0);
    const firstStart = midnight - 30_000; // начался вчера, доиграет уже в новых сутках
    const initId = db.upsertInit("drive", "drive/init_run1.mp4", 800, firstStart);
    db.addSegment({
      cam: "drive", initId, path: "drive/seg_a.m4s",
      startMs: firstStart, durMs: 60_000, bytes: 10,
    });
    db.addSegment({
      cam: "drive", initId, path: "drive/seg_b.m4s",
      startMs: firstStart + 60_000, durMs: 60_000, bytes: 10,
    });

    const { a } = app(db);
    const res = await request(a)
      .get(`/api/cctv/timeline?cam=drive&from=${midnight}&to=${midnight + 86_400_000}`)
      .expect(200);

    // Полосы ленты подрезаны по запросу — это правильно и остаётся как было.
    expect(res.body.spans[0].startMs).toBe(midnight);
    // А нуль шкалы плеера — начало сегмента ДО подрезки.
    expect(res.body.playlistStartMs).toBe(firstStart);

    // Плейлист построен из той же выборки: его первый сегмент — тот самый,
    // с которого начинается шкала.
    const pl = await request(a)
      .get(`/api/cctv/playlist.m3u8?cam=drive&from=${midnight}&to=${midnight + 86_400_000}`)
      .expect(200);
    expect(pl.text).toContain(`#EXT-X-PROGRAM-DATE-TIME:${new Date(firstStart).toISOString()}`);
  });

  it("GET /timeline на пустом интервале отдаёт нуль шкалы null", async () => {
    seed(db);
    const { a } = app(db);
    const res = await request(a)
      .get(`/api/cctv/timeline?cam=drive&from=${T + 10_000_000}&to=${T + 10_060_000}`)
      .expect(200);
    expect(res.body.playlistStartMs).toBeNull();
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

  it("сегмент и init отдаются с приватным кэшем: это видео из частного дома", async () => {
    const { initId, ids } = seed(db);
    const { a } = app(db);
    for (const url of [`/api/cctv/segment/${ids[0]}`, `/api/cctv/init/${initId}`]) {
      const res = await request(a).get(url).expect(200);
      // public разрешил бы кэшировать запись общим прокси и CDN.
      expect(res.headers["cache-control"]).toContain("private");
      expect(res.headers["cache-control"]).not.toContain("public");
      expect(res.headers["cache-control"]).toContain("immutable");
    }
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

  it("GET /download склеивает init и сегменты побайтово, по порядку", async () => {
    const { ids } = seed(db);
    const files = {
      "/st/drive/init_run1.mp4": "INIT",
      "/st/drive/seg_0.m4s": "AAAA",
      "/st/drive/seg_1.m4s": "BBBB",
    };
    const { a, reads } = app(db, { files });
    const res = await asBuffer(request(a).get(`/api/cctv/download?cam=drive&from=${T}&to=${T + 120_000}`)).expect(
      200
    );

    expect(res.headers["content-type"]).toContain("video/mp4");
    expect(res.headers["content-disposition"]).toContain("attachment");
    expect(res.headers["content-disposition"]).toMatch(/drive_\d{8}_\d{6}\.mp4/);
    // Сначала заголовок потока, затем сегменты в порядке времени и целиком.
    expect((res.body as Buffer).toString()).toBe("INITAAAABBBB");
    expect(reads).toEqual(["/st/drive/init_run1.mp4", "/st/drive/seg_0.m4s", "/st/drive/seg_1.m4s"]);
    expect(ids).toHaveLength(3);
  });

  it("GET /download: интервал через перезапуск записи → 400, а не битый файл", async () => {
    // Два прогона записи — два разных заголовка потока. Побайтовая склейка
    // такого диапазона нерабочая в принципе, поэтому отвечаем ошибкой.
    const init1 = db.upsertInit("drive", "drive/init_run1.mp4", 800, T);
    const init2 = db.upsertInit("drive", "drive/init_run2.mp4", 800, T + 60_000);
    db.addSegment({ cam: "drive", initId: init1, path: "drive/a.m4s", startMs: T, durMs: 60_000, bytes: 1 });
    db.addSegment({
      cam: "drive", initId: init2, path: "drive/b.m4s",
      startMs: T + 60_000, durMs: 60_000, bytes: 1,
    });

    const { a, reads } = app(db, {
      files: { "/st/drive/init_run1.mp4": "I1", "/st/drive/a.m4s": "A", "/st/drive/b.m4s": "B" },
    });
    const res = await request(a).get(`/api/cctv/download?cam=drive&from=${T}&to=${T + 120_000}`).expect(400);
    expect(res.body.ok).toBe(false);
    expect(String(res.body.error)).toContain("restart");
    expect(reads).toEqual([]); // ни одного файла не читали
  });

  it("GET /download внутри одного прогона отдаёт кусок, даже если рядом есть другой init", async () => {
    const init1 = db.upsertInit("drive", "drive/init_run1.mp4", 800, T);
    const init2 = db.upsertInit("drive", "drive/init_run2.mp4", 800, T + 60_000);
    db.addSegment({ cam: "drive", initId: init1, path: "drive/a.m4s", startMs: T, durMs: 60_000, bytes: 1 });
    db.addSegment({
      cam: "drive", initId: init2, path: "drive/b.m4s",
      startMs: T + 60_000, durMs: 60_000, bytes: 1,
    });

    const { a } = app(db, { files: { "/st/drive/init_run2.mp4": "I2", "/st/drive/b.m4s": "B" } });
    const res = await asBuffer(
      request(a).get(`/api/cctv/download?cam=drive&from=${T + 60_000}&to=${T + 120_000}`)
    ).expect(200);
    expect((res.body as Buffer).toString()).toBe("I2B");
  });

  it("GET /download отказывает на слишком длинном интервале", async () => {
    seed(db);
    const { a, reads } = app(db);
    await request(a)
      .get(`/api/cctv/download?cam=drive&from=${T}&to=${T + 31 * 60_000}`)
      .expect(413);
    // Регрессия: если проверку интервала переставят после начала выдачи,
    // счётчик чтений это поймает раньше, чем кто-то заметит по логам.
    expect(reads).toEqual([]);
  });

  it("GET /download на пустом интервале → 404", async () => {
    seed(db);
    const { a, reads } = app(db);
    await request(a)
      .get(`/api/cctv/download?cam=drive&from=${T + 10_000_000}&to=${T + 10_060_000}`)
      .expect(404);
    expect(reads).toEqual([]);
  });

  it("GET /download: отсутствующий в индексе init → 500, файлы не читаются", async () => {
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
    const { a, reads } = app(fakeDb);
    const res = await request(a)
      .get(`/api/cctv/download?cam=drive&from=${T}&to=${T + 60_000}`)
      .expect(500);
    expect(res.body.ok).toBe(false);
    expect(reads).toEqual([]);
  });

  it("GET /download: файл не открылся до первого байта → 500 JSON, а не .mp4 с ошибкой внутри", async () => {
    seed(db);
    const { a } = app(db, { files: {} }); // на «диске» нет ничего — падаем на init'е
    const res = await request(a).get(`/api/cctv/download?cam=drive&from=${T}&to=${T + 120_000}`);
    expect(res.status).toBe(500);
    // Заголовки видео выставлены до чтения — без явного сброса браузер сохранил
    // бы JSON-ошибку под именем "….mp4".
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.headers["content-disposition"]).toBeUndefined();
    expect(res.body.ok).toBe(false);
  });

  it("GET /download: обрыв чтения на середине рвёт ответ, а не дописывает тишину", async () => {
    seed(db);
    // init и первый сегмент читаются, второй ломается на середине — клиент
    // должен увидеть незавершённую загрузку, а не «успешный» обрезанный файл.
    const { a } = app(db, {
      files: { "/st/drive/init_run1.mp4": "INIT", "/st/drive/seg_0.m4s": "AAAA" },
    });
    const err = await asBuffer(request(a).get(`/api/cctv/download?cam=drive&from=${T}&to=${T + 120_000}`)).then(
      () => null,
      (e: Error) => e
    );
    expect(err).not.toBeNull();
  });
});
