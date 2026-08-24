import { CctvDb } from "./db";
import { planEviction, Retention, EVICT_HIGH_RATIO, EVICT_TARGET_RATIO, type UnlinkFs } from "./retention";

describe("planEviction", () => {
  const cands = [{ id: 1, bytes: 100 }, { id: 2, bytes: 100 }, { id: 3, bytes: 100 }];

  it("ничего не удаляет, пока не достигнут верхний порог", () => {
    expect(planEviction(970, 1000, cands)).toEqual([]); // 97% < 98%
  });

  it("удаляет самые старые до целевого уровня", () => {
    // 100% → цель 95%: нужно освободить 50, хватает одного кандидата
    expect(planEviction(1000, 1000, cands)).toEqual([1]);
  });

  it("берёт столько кандидатов, сколько нужно", () => {
    // 120% → цель 95%: освободить 250 — три кандидата
    expect(planEviction(1200, 1000, cands)).toEqual([1, 2, 3]);
  });

  it("не уходит в минус, если кандидатов не хватает", () => {
    expect(planEviction(5000, 1000, cands)).toEqual([1, 2, 3]);
  });

  it("на пустом списке кандидатов отдаёт пусто", () => {
    expect(planEviction(5000, 1000, [])).toEqual([]);
  });

  it("пороги вынесены в константы и настраиваются", () => {
    expect(EVICT_HIGH_RATIO).toBe(0.98);
    expect(EVICT_TARGET_RATIO).toBe(0.95);
    expect(planEviction(500, 1000, cands, 0.4, 0.2)).toEqual([1, 2, 3]);
  });
});

describe("Retention", () => {
  let db: CctvDb;
  let unlinked: string[];
  const fs: UnlinkFs = {
    async unlink(p) {
      unlinked.push(p);
    },
  };

  beforeEach(() => {
    db = new CctvDb(":memory:");
    unlinked = [];
  });
  afterEach(() => db.close());

  const fill = (n: number, bytes: number) => {
    const init = db.upsertInit("drive", "drive/init_1.mp4", 800, 0);
    for (let i = 0; i < n; i++) {
      db.addSegment({
        cam: "drive", initId: init, path: `drive/seg_${i}.m4s`,
        startMs: i * 60_000, durMs: 60_000, bytes,
      });
    }
  };

  it("не трогает ничего, пока места хватает", async () => {
    fill(3, 100);
    const r = new Retention(db, "/st", fs, 10_000);
    expect(await r.runOnce()).toEqual({ removed: 0, freedBytes: 0, unlinkFailures: 0 });
    expect(unlinked).toEqual([]);
    expect(db.totals().count).toBe(3);
  });

  it("удаляет старейшие файлы и записи при переполнении", async () => {
    fill(10, 100); // 1000 байт при квоте 1000 → чистим до 950
    const r = new Retention(db, "/st", fs, 1000);
    const res = await r.runOnce();
    expect(res.removed).toBe(1);
    expect(res.freedBytes).toBe(100);
    expect(unlinked).toEqual(["/st/drive/seg_0.m4s"]);
    expect(db.totals().count).toBe(9);
  });

  it("удаляет init без ссылок вместе с последним его сегментом", async () => {
    const init = db.upsertInit("drive", "drive/init_1.mp4", 800, 0);
    db.addSegment({ cam: "drive", initId: init, path: "drive/only.m4s", startMs: 0, durMs: 60_000, bytes: 1000 });
    const r = new Retention(db, "/st", fs, 500);
    await r.runOnce();
    expect(unlinked.sort()).toEqual(["/st/drive/init_1.mp4", "/st/drive/only.m4s"]);
    expect(db.orphanInits()).toEqual([]);
  });

  it("запись в индексе удаляется даже если файла уже нет на диске", async () => {
    fill(10, 100);
    const failing: UnlinkFs = {
      async unlink(p) {
        unlinked.push(p);
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      },
    };
    const r = new Retention(db, "/st", failing, 1000);
    const res = await r.runOnce();
    expect(res.removed).toBe(1);
    expect(res.unlinkFailures).toBe(0);
    expect(db.totals().count).toBe(9);
  });

  it("на пустом индексе не падает", async () => {
    const r = new Retention(db, "/st", fs, 1000);
    expect(await r.runOnce()).toEqual({ removed: 0, freedBytes: 0, unlinkFailures: 0 });
  });

  it("unlinkFailures считает не-ENOENT неудачи", async () => {
    fill(10, 100); // 1000 байт при квоте 1000 → чистим до 950, нужно удалить 1 сегмент
    const eio: UnlinkFs = {
      async unlink(p) {
        unlinked.push(p);
        throw Object.assign(new Error("I/O error"), { code: "EIO" });
      },
    };
    const r = new Retention(db, "/st", eio, 1000);
    const res = await r.runOnce();
    // Записи удалены из индекса, поток управления не прерван, но ошибка удаления файла считается
    expect(res.removed).toBe(1);
    expect(res.freedBytes).toBe(100);
    expect(res.unlinkFailures).toBe(1);
    expect(db.totals().count).toBe(9);
  });

  it("ENOENT в unlinkFailures не попадает", async () => {
    fill(10, 100);
    const failing: UnlinkFs = {
      async unlink(p) {
        unlinked.push(p);
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      },
    };
    const r = new Retention(db, "/st", failing, 1000);
    const res = await r.runOnce();
    expect(res.unlinkFailures).toBe(0);
  });
});
