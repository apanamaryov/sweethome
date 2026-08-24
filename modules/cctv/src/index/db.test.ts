import { CctvDb, type SegmentRow } from "./db";

const seg = (over: Partial<Omit<SegmentRow, "id">> = {}): Omit<SegmentRow, "id"> => ({
  cam: "drive",
  initId: 1,
  path: "drive/seg_20260824_100000.m4s",
  startMs: 1_000_000,
  durMs: 60_000,
  bytes: 4_000_000,
  ...over,
});

describe("CctvDb", () => {
  let db: CctvDb;
  beforeEach(() => {
    db = new CctvDb(":memory:");
  });
  afterEach(() => db.close());

  it("создаёт init и возвращает его id повторно, а не дубль", () => {
    const a = db.upsertInit("drive", "drive/init_1.mp4", 800, 1_000);
    const b = db.upsertInit("drive", "drive/init_1.mp4", 800, 1_000);
    expect(a).toBe(b);
    expect(db.initIdByPath("drive", "drive/init_1.mp4")).toBe(a);
    expect(db.initIdByPath("drive", "drive/nope.mp4")).toBeNull();
  });

  it("добавляет сегмент и находит его по интервалу", () => {
    const init = db.upsertInit("drive", "drive/init_1.mp4", 800, 1_000);
    const id = db.addSegment(seg({ initId: init }));
    const rows = db.segmentsBetween("drive", 0, 2_000_000);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id, cam: "drive", startMs: 1_000_000, durMs: 60_000 });
    expect(db.segmentById(id)).toMatchObject({ path: seg().path });
    expect(db.segmentById(999)).toBeNull();
  });

  it("повторная вставка того же пути не создаёт дубль", () => {
    const init = db.upsertInit("drive", "drive/init_1.mp4", 800, 1_000);
    const a = db.addSegment(seg({ initId: init }));
    const b = db.addSegment(seg({ initId: init, bytes: 4_100_000 }));
    expect(b).toBe(a);
    expect(db.segmentsBetween("drive", 0, 9_000_000)).toHaveLength(1);
  });

  it("в интервал попадают сегменты, пересекающиеся с ним, а не только целиком внутри", () => {
    const init = db.upsertInit("drive", "drive/init_1.mp4", 800, 1_000);
    db.addSegment(seg({ initId: init, path: "a", startMs: 0, durMs: 60_000 }));       // 0..60000
    db.addSegment(seg({ initId: init, path: "b", startMs: 60_000, durMs: 60_000 }));  // 60000..120000
    db.addSegment(seg({ initId: init, path: "c", startMs: 600_000, durMs: 60_000 })); // далеко
    const rows = db.segmentsBetween("drive", 30_000, 70_000);
    expect(rows.map((r) => r.path)).toEqual(["a", "b"]);
  });

  it("отдаёт сегменты по возрастанию времени и только своей камеры", () => {
    const init = db.upsertInit("drive", "drive/init_1.mp4", 800, 1_000);
    const init2 = db.upsertInit("yard", "yard/init_1.mp4", 800, 1_000);
    db.addSegment(seg({ initId: init, path: "d2", startMs: 200_000 }));
    db.addSegment(seg({ initId: init, path: "d1", startMs: 100_000 }));
    db.addSegment(seg({ cam: "yard", initId: init2, path: "y1", startMs: 150_000 }));
    expect(db.segmentsBetween("drive", 0, 9_000_000).map((r) => r.path)).toEqual(["d1", "d2"]);
    expect(db.segmentsBetween("yard", 0, 9_000_000).map((r) => r.path)).toEqual(["y1"]);
  });

  it("считает суммы, границы архива и последний сегмент камеры", () => {
    const init = db.upsertInit("drive", "drive/init_1.mp4", 800, 1_000);
    db.addSegment(seg({ initId: init, path: "a", startMs: 100_000, durMs: 60_000, bytes: 1_000 }));
    db.addSegment(seg({ initId: init, path: "b", startMs: 200_000, durMs: 60_000, bytes: 2_000 }));
    expect(db.totals()).toEqual({ bytes: 3_000, count: 2, oldestMs: 100_000, newestMs: 260_000 });
    expect(db.lastSegmentStart("drive")).toBe(200_000);
    expect(db.lastSegmentStart("yard")).toBeNull();
  });

  it("на пустой базе суммы нулевые, а границы null", () => {
    expect(db.totals()).toEqual({ bytes: 0, count: 0, oldestMs: null, newestMs: null });
  });

  it("отдаёт самые старые сегменты и удаляет их", () => {
    const init = db.upsertInit("drive", "drive/init_1.mp4", 800, 1_000);
    db.addSegment(seg({ initId: init, path: "a", startMs: 300_000 }));
    db.addSegment(seg({ initId: init, path: "b", startMs: 100_000 }));
    db.addSegment(seg({ initId: init, path: "c", startMs: 200_000 }));
    const old = db.oldestSegments(2);
    expect(old.map((r) => r.path)).toEqual(["b", "c"]);
    db.deleteSegment(old[0].id);
    expect(db.segmentsBetween("drive", 0, 9_000_000).map((r) => r.path)).toEqual(["c", "a"]);
  });

  it("находит init'ы, на которые больше нет ссылок, и удаляет их", () => {
    const init = db.upsertInit("drive", "drive/init_1.mp4", 800, 1_000);
    const used = db.upsertInit("drive", "drive/init_2.mp4", 800, 2_000);
    const id = db.addSegment(seg({ initId: used, path: "a" }));
    expect(db.orphanInits().map((r) => r.path)).toEqual(["drive/init_1.mp4"]);
    db.deleteSegment(id);
    expect(db.orphanInits().map((r) => r.path).sort()).toEqual(["drive/init_1.mp4", "drive/init_2.mp4"]);
    db.deleteInit(init);
    expect(db.orphanInits().map((r) => r.path)).toEqual(["drive/init_2.mp4"]);
  });

  it("возвращает путь init'а по id — для отдачи файла", () => {
    const init = db.upsertInit("drive", "drive/init_1.mp4", 800, 1_000);
    expect(db.initPathById(init)).toEqual({ cam: "drive", path: "drive/init_1.mp4" });
    expect(db.initPathById(404)).toBeNull();
  });

  it("пишет и читает метки движения по интервалу", () => {
    db.addMotion("drive", 1_500, "motion");
    db.addMotion("drive", 5_500, "motion");
    db.addMotion("yard", 1_600, "motion");
    expect(db.motionBetween("drive", 1_000, 2_000)).toEqual([{ tsMs: 1_500, kind: "motion" }]);
    expect(db.motionBetween("drive", 0, 9_000)).toHaveLength(2);
    expect(db.motionBetween("nobody", 0, 9_000)).toEqual([]);
  });

  it("отдаёт множество известных путей камеры — для сканера", () => {
    const init = db.upsertInit("drive", "drive/init_1.mp4", 800, 1_000);
    db.addSegment(seg({ initId: init, path: "drive/a.m4s" }));
    db.addSegment(seg({ initId: init, path: "drive/b.m4s" }));
    const known = db.knownPaths("drive");
    expect(known.has("drive/a.m4s")).toBe(true);
    expect(known.has("drive/zzz.m4s")).toBe(false);
    expect(known.size).toBe(2);
  });
});
