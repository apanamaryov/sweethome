import { DEFAULT_RTSP_PATH, type CameraConfig } from "../config";
import { BACKOFF_MS, RecorderProcess, RESET_AFTER_MS, type ChildLike } from "./process";

const cam: CameraConfig = { id: "drive", name: "drive", host: "10.0.0.1", rtspPath: DEFAULT_RTSP_PATH };

/** Ручной планировщик: тест сам решает, когда «прошло время». */
class FakeTimers {
  private queue: { at: number; cb: () => void; id: number }[] = [];
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
  /** Промотать время и выполнить всё, что должно было сработать. */
  async advance(ms: number): Promise<void> {
    this.clock += ms;
    const due = this.queue.filter((t) => t.at <= this.clock).sort((a, b) => a.at - b.at);
    this.queue = this.queue.filter((t) => t.at > this.clock);
    for (const t of due) {
      t.cb();
      await Promise.resolve();
      await Promise.resolve();
    }
  }
}

class FakeChild implements ChildLike {
  exitCb: ((code: number | null) => void) | null = null;
  stderrCb: ((c: Buffer) => void) | null = null;
  killed = false;
  stderr = {
    on: (_ev: "data", cb: (c: Buffer) => void) => {
      this.stderrCb = cb;
    },
  };
  on(_ev: "exit", cb: (code: number | null) => void): void {
    this.exitCb = cb;
  }
  kill(): void {
    this.killed = true;
    this.exitCb?.(null);
  }
  /** Симуляция падения процесса. */
  die(code = 1): void {
    this.exitCb?.(code);
  }
}

function makeProc(over: Partial<{ storageReady: () => Promise<boolean> }> = {}) {
  const timers = new FakeTimers();
  const children: FakeChild[] = [];
  const mkdirCalls: string[] = [];
  let runSeq = 0;

  const proc = new RecorderProcess({
    cam,
    camDir: "/st/drive",
    segmentSec: 60,
    ffmpegPath: "ffmpeg",
    spawn: () => {
      const c = new FakeChild();
      children.push(c);
      return c;
    },
    timers,
    storageReady: over.storageReady ?? (async () => true),
    mkdir: async (p) => {
      mkdirCalls.push(p);
    },
    newRunId: () => `run${++runSeq}`,
  });

  return { proc, timers, children, mkdirCalls };
}

describe("RecorderProcess", () => {
  it("создаёт каталог камеры и запускает процесс", async () => {
    const { proc, children, mkdirCalls } = makeProc();
    await proc.start();
    expect(mkdirCalls).toEqual(["/st/drive"]);
    expect(children).toHaveLength(1);
    expect(proc.state().running).toBe(true);
    expect(proc.state().restarts).toBe(0);
  });

  it("перезапускается после падения с первой паузой из ряда", async () => {
    const { proc, timers, children } = makeProc();
    await proc.start();
    children[0].die(1);
    expect(proc.state().running).toBe(false);

    await timers.advance(BACKOFF_MS[0] - 1);
    expect(children).toHaveLength(1); // ещё рано

    await timers.advance(1);
    expect(children).toHaveLength(2);
    expect(proc.state().restarts).toBe(1);
    expect(proc.state().running).toBe(true);
  });

  it("увеличивает паузу при повторных падениях", async () => {
    const { proc, timers, children } = makeProc();
    await proc.start();
    for (let i = 0; i < 3; i++) {
      children[children.length - 1].die(1);
      await timers.advance(BACKOFF_MS[i]);
    }
    expect(children).toHaveLength(4);
    expect(proc.state().restarts).toBe(3);
  });

  it("не растит паузу выше последнего значения ряда", async () => {
    const { proc, timers, children } = makeProc();
    await proc.start();
    for (let i = 0; i < BACKOFF_MS.length + 2; i++) {
      children[children.length - 1].die(1);
      await timers.advance(BACKOFF_MS[BACKOFF_MS.length - 1]);
    }
    expect(children).toHaveLength(BACKOFF_MS.length + 3);
  });

  it("сбрасывает паузу после минуты успешной работы", async () => {
    const { proc, timers, children } = makeProc();
    await proc.start();
    children[0].die(1);
    await timers.advance(BACKOFF_MS[0]);          // перезапуск №1
    await timers.advance(RESET_AFTER_MS);          // проработал долго
    children[1].die(1);
    await timers.advance(BACKOFF_MS[0]);           // снова первая пауза, а не вторая
    expect(children).toHaveLength(3);
  });

  it("не запускает процесс, пока хранилище недоступно", async () => {
    let ready = false;
    const { proc, timers, children } = makeProc({ storageReady: async () => ready });
    await proc.start();
    expect(children).toHaveLength(0);
    expect(proc.state().lastError).toContain("storage");

    ready = true;
    await timers.advance(BACKOFF_MS[0]);
    expect(children).toHaveLength(1);
  });

  it("запоминает последнюю строку ошибки процесса", async () => {
    const { proc, children } = makeProc();
    await proc.start();
    children[0].stderrCb?.(Buffer.from("Connection refused\n"));
    expect(proc.state().lastError).toBe("Connection refused");
  });

  it("stop() глушит процесс и больше не перезапускает", async () => {
    const { proc, timers, children } = makeProc();
    await proc.start();
    proc.stop();
    expect(children[0].killed).toBe(true);
    await timers.advance(60_000);
    expect(children).toHaveLength(1);
    expect(proc.state().running).toBe(false);
  });

  it("повторный start() не поднимает второй процесс", async () => {
    const { proc, children } = makeProc();
    await proc.start();
    await proc.start();
    expect(children).toHaveLength(1);
  });
});
