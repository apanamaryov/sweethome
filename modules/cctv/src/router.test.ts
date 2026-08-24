import express from "express";
import request from "supertest";
import type { CameraInfo } from "@sweethome/cctv-shared";
import { loadCctvConfig } from "./config";
import { CctvDb } from "./index/db";
import { createCctvRouter } from "./router";

function app(db: CctvDb, over: { cameras?: CameraInfo[]; storage?: boolean } = {}) {
  const sent: string[] = [];
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
    })
  );
  return { a, sent };
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
});
