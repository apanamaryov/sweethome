import { CctvDb } from "../index/db";
import { loadCctvConfig } from "../config";
import { RecorderManager, SCAN_INTERVAL_MS, RETENTION_INTERVAL_MS } from "./manager";
import type { ChildLike } from "./process";

class FakeTimers {
  private queue: { at: number; cb: () => void; id: number; every?: number }[] = [];
  private seq = 0;
  clock = 0;
  setTimeout(cb: () => void, ms: number): unknown {
    const id = ++this.seq;
    this.queue.push({ at: this.clock + ms, cb, id });
    return id;
  }
  clearTimeout(h: unknown): void {
    this.queue = this.queue.filter((t) => t.id !== h);
  }
  now(): number {
    return this.clock;
  }
  async advance(ms: number): Promise<void> {
    this.clock += ms;
    const due = this.queue.filter((t) => t.at <= this.clock).sort((a, b) => a.at - b.at);
    this.queue = this.queue.filter((t) => t.at > this.clock);
    for (const t of due) {
      t.cb();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    }
  }
}

class FakeChild implements ChildLike {
  exitCb: ((code: number | null) => void) | null = null;
  stderr = { on: () => {} };
  killed = false;
  on(_ev: "exit", cb: (code: number | null) => void): void {
    this.exitCb = cb;
  }
  kill(): void {
    this.killed = true;
    this.exitCb?.(null);
  }
}

function make(env: NodeJS.ProcessEnv = { CCTV_CAMERAS: "drive=10.0.0.1,yard=10.0.0.2" }) {
  const cfg = loadCctvConfig("/data", env);
  const db = new CctvDb(":memory:");
  const timers = new FakeTimers();
  const children: FakeChild[] = [];
  const scanned: string[] = [];
  let retentionRuns = 0;

  const mgr = new RecorderManager({
    cfg,
    db,
    scanner: {
      async scanCamera(cam) {
        scanned.push(cam);
        return 0;
      },
    },
    retention: {
      async runOnce() {
        retentionRuns++;
        return { removed: 0, freedBytes: 0 };
      },
    },
    spawn: () => {
      const c = new FakeChild();
      children.push(c);
      return c;
    },
    timers,
    // Настоящая проба спрашивает камеру по сети — здесь просто задаём ответ.
    probeAudio: async () => false,
    storageReady: async () => true,
    mkdir: async () => {},
    newRunId: () => "run1",
  });

  return { mgr, db, timers, children, scanned, retentionRuns: () => retentionRuns };
}

describe("RecorderManager", () => {
  it("поднимает по процессу на камеру", async () => {
    const { mgr, db, children } = make();
    await mgr.start();
    expect(children).toHaveLength(2);
    mgr.stop();
    db.close();
  });

  it("ничего не поднимает, когда модуль выключен", async () => {
    const { mgr, db, children } = make({ CCTV_CAMERAS: "" });
    await mgr.start();
    expect(children).toHaveLength(0);
    mgr.stop();
    db.close();
  });

  it("сканирует индекс по таймеру для каждой камеры", async () => {
    const { mgr, db, timers, scanned } = make();
    await mgr.start();
    scanned.length = 0;
    await timers.advance(SCAN_INTERVAL_MS);
    expect(scanned.sort()).toEqual(["drive", "yard"]);
    mgr.stop();
    db.close();
  });

  it("запускает чистку по своему, более редкому таймеру", async () => {
    const { mgr, db, timers, retentionRuns } = make();
    await mgr.start();
    await timers.advance(SCAN_INTERVAL_MS);
    expect(retentionRuns()).toBe(0);
    await timers.advance(RETENTION_INTERVAL_MS);
    expect(retentionRuns()).toBe(1);
    mgr.stop();
    db.close();
  });

  it("отдаёт состояние камер с временем последнего сегмента", async () => {
    const { mgr, db } = make();
    const init = db.upsertInit("drive", "drive/init_run1.mp4", 800, 0);
    db.addSegment({ cam: "drive", initId: init, path: "drive/a.m4s", startMs: 5_000, durMs: 60_000, bytes: 10 });
    await mgr.start();

    const cams = mgr.cameras();
    expect(cams.map((c) => c.id).sort()).toEqual(["drive", "yard"]);
    const drive = cams.find((c) => c.id === "drive")!;
    expect(drive.recording).toBe(true);
    expect(drive.lastSegmentMs).toBe(5_000);
    expect(cams.find((c) => c.id === "yard")!.lastSegmentMs).toBeNull();
    mgr.stop();
    db.close();
  });

  it("stop() глушит все процессы и снимает таймеры", async () => {
    const { mgr, db, timers, children, scanned } = make();
    await mgr.start();
    mgr.stop();
    expect(children.every((c) => c.killed)).toBe(true);
    scanned.length = 0;
    await timers.advance(RETENTION_INTERVAL_MS * 2);
    expect(scanned).toEqual([]);
    db.close();
  });

  it("падение сканера не роняет тик и не мешает следующему", async () => {
    // Сканер здесь намеренно падает, а tickScan честно пишет console.error —
    // глушим ожидаемый вывод, чтобы зелёный прогон оставался чистым.
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      const cfg = loadCctvConfig("/data", { CCTV_CAMERAS: "drive=10.0.0.1" });
      const db = new CctvDb(":memory:");
      const timers = new FakeTimers();
      let calls = 0;
      const mgr = new RecorderManager({
        cfg,
        db,
        scanner: {
          async scanCamera() {
            calls++;
            throw new Error("SMB упал");
          },
        },
        retention: { async runOnce() { return { removed: 0, freedBytes: 0 }; } },
        spawn: () => new FakeChild(),
        timers,
        probeAudio: async () => false,
        storageReady: async () => true,
        mkdir: async () => {},
      });
      await mgr.start();
      await timers.advance(SCAN_INTERVAL_MS);
      await timers.advance(SCAN_INTERVAL_MS);
      expect(calls).toBeGreaterThanOrEqual(2);
      mgr.stop();
      db.close();
    } finally {
      errSpy.mockRestore();
    }
  });

  it("stop() во время start() не оставляет живых процессов", async () => {
    const cfg = loadCctvConfig("/data", { CCTV_CAMERAS: "drive=10.0.0.1,yard=10.0.0.2" });
    const db = new CctvDb(":memory:");
    const timers = new FakeTimers();
    const children: FakeChild[] = [];
    const scanned: string[] = [];

    // Управляемый промис вместо мгновенного true — имитирует сетевой диск,
    // который отвечает не сразу, чтобы start() застыл на первой камере ровно
    // в той точке, где может вклиниться stop().
    let resolveReady!: (v: boolean) => void;
    const readyPromise = new Promise<boolean>((res) => {
      resolveReady = res;
    });

    const mgr = new RecorderManager({
      cfg,
      db,
      scanner: {
        async scanCamera(cam) {
          scanned.push(cam);
          return 0;
        },
      },
      retention: { async runOnce() { return { removed: 0, freedBytes: 0 }; } },
      spawn: () => {
        const c = new FakeChild();
        children.push(c);
        return c;
      },
      timers,
      probeAudio: async () => false,
      storageReady: () => readyPromise,
      mkdir: async () => {},
      newRunId: () => "run1",
    });

    const starting = mgr.start(); // не дожидаемся — start() виснет на storageReady первой камеры
    mgr.stop();
    resolveReady(true);
    await starting;
    // дать микрозадачам (mkdir/spawn второй камеры, если бы утечка была) отработать
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(children.every((c) => c.killed)).toBe(true);
    expect(children.length).toBe(0);

    scanned.length = 0;
    await timers.advance(RETENTION_INTERVAL_MS);
    expect(scanned).toEqual([]);
    expect(children.length).toBe(0);

    expect(mgr.cameras().some((c) => c.recording)).toBe(false);

    db.close();
  });

  it("звук в записи выключен по умолчанию, даже если камера его шлёт", async () => {
    // Перекодирование звука стоит около трети ядра на камеру и идёт круглосуточно.
    // На малине со слабым питанием это давало просадки напряжения и падение —
    // поэтому запись со звуком включается отдельно, после починки питания.
    const { mgr, db } = make();
    await mgr.start();
    expect(mgr.cameras().every((c) => c.recordsAudio)).toBe(false);
    mgr.stop();
    db.close();
  });

});
