import { loadCctvConfig } from "../config";
import { LiveHub, LIVE_MIME, type LiveChild, type Sink } from "./hub";
import type { LiveServerMessage } from "@sweethome/cctv-shared";

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
  async advance(ms: number): Promise<void> {
    this.clock += ms;
    const due = this.queue.filter((t) => t.at <= this.clock).sort((a, b) => a.at - b.at);
    this.queue = this.queue.filter((t) => t.at > this.clock);
    for (const t of due) {
      t.cb();
      await Promise.resolve();
    }
  }
}

class FakeChild implements LiveChild {
  dataCb: ((c: Buffer) => void) | null = null;
  exitCb: ((code: number | null) => void) | null = null;
  killed = false;
  stdout = {
    on: (_ev: "data", cb: (c: Buffer) => void) => {
      this.dataCb = cb;
    },
  };
  on(_ev: "exit", cb: (code: number | null) => void): void {
    this.exitCb = cb;
  }
  kill(): void {
    this.killed = true;
    this.exitCb?.(null);
  }
  emit(data: string): void {
    this.dataCb?.(Buffer.from(data));
  }
}

function fakeSink(): Sink & { chunks: Buffer[]; texts: LiveServerMessage[] } {
  const chunks: Buffer[] = [];
  const texts: LiveServerMessage[] = [];
  return {
    chunks,
    texts,
    send(d) {
      chunks.push(d);
    },
    sendText(m) {
      texts.push(m);
    },
  };
}

function make() {
  const cfg = loadCctvConfig("/data", { CCTV_CAMERAS: "drive=10.0.0.1,yard=10.0.0.2", CCTV_LIVE_IDLE_SEC: "15" });
  const timers = new FakeTimers();
  const children: FakeChild[] = [];
  const hub = new LiveHub({
    cfg,
    timers,
    spawn: () => {
      const c = new FakeChild();
      children.push(c);
      return c;
    },
  });
  return { hub, timers, children };
}

describe("LiveHub", () => {
  it("первый подписчик поднимает процесс и получает готовность", () => {
    const { hub, children } = make();
    const s = fakeSink();
    hub.subscribe("drive", s);
    expect(children).toHaveLength(1);
    expect(s.texts).toEqual([{ type: "ready", cam: "drive", mime: LIVE_MIME }]);
    hub.stop();
  });

  it("неизвестная камера — ошибка, процесс не поднимается", () => {
    const { hub, children } = make();
    const s = fakeSink();
    hub.subscribe("nope", s);
    expect(children).toHaveLength(0);
    expect(s.texts[0]).toMatchObject({ type: "error", cam: "nope" });
    hub.stop();
  });

  it("несколько зрителей одной камеры делят один процесс", () => {
    const { hub, children } = make();
    hub.subscribe("drive", fakeSink());
    hub.subscribe("drive", fakeSink());
    expect(children).toHaveLength(1);
    hub.stop();
  });

  it("разные камеры — разные процессы", () => {
    const { hub, children } = make();
    hub.subscribe("drive", fakeSink());
    hub.subscribe("yard", fakeSink());
    expect(children).toHaveLength(2);
    expect(hub.activeCameras().sort()).toEqual(["drive", "yard"]);
    hub.stop();
  });

  it("фрагменты рассылаются всем подписчикам камеры", () => {
    const { hub, children } = make();
    const a = fakeSink();
    const b = fakeSink();
    hub.subscribe("drive", a);
    hub.subscribe("drive", b);
    children[0].emit("HEAD");
    children[0].emit("FRAG1");
    expect(a.chunks.map(String)).toEqual(["HEAD", "FRAG1"]);
    expect(b.chunks.map(String)).toEqual(["HEAD", "FRAG1"]);
    hub.stop();
  });

  it("подключившийся позже получает начальный фрагмент, иначе браузеру нечем начать", () => {
    const { hub, children } = make();
    const first = fakeSink();
    hub.subscribe("drive", first);
    children[0].emit("HEAD");
    children[0].emit("FRAG1");

    const late = fakeSink();
    hub.subscribe("drive", late);
    expect(late.chunks.map(String)).toEqual(["HEAD"]); // только заголовок, без старых фрагментов
    children[0].emit("FRAG2");
    expect(late.chunks.map(String)).toEqual(["HEAD", "FRAG2"]);
    hub.stop();
  });

  it("уход последнего зрителя гасит процесс не сразу, а по простою", async () => {
    const { hub, timers, children } = make();
    const s = fakeSink();
    hub.subscribe("drive", s);
    hub.unsubscribe("drive", s);
    expect(children[0].killed).toBe(false);

    await timers.advance(14_000);
    expect(children[0].killed).toBe(false);

    await timers.advance(1_000);
    expect(children[0].killed).toBe(true);
    expect(hub.activeCameras()).toEqual([]);
    hub.stop();
  });

  it("вернувшийся зритель отменяет гашение и переиспользует процесс", async () => {
    const { hub, timers, children } = make();
    const s = fakeSink();
    hub.subscribe("drive", s);
    hub.unsubscribe("drive", s);
    await timers.advance(10_000);
    hub.subscribe("drive", fakeSink());
    await timers.advance(10_000);
    expect(children).toHaveLength(1);
    expect(children[0].killed).toBe(false);
    hub.stop();
  });

  it("падение процесса сообщается подписчикам", () => {
    const { hub, children } = make();
    const s = fakeSink();
    hub.subscribe("drive", s);
    children[0].exitCb?.(1);
    expect(s.texts.some((t) => t.type === "error")).toBe(true);
    hub.stop();
  });

  it("unsubscribeAll снимает зрителя со всех камер", async () => {
    const { hub, timers, children } = make();
    const s = fakeSink();
    hub.subscribe("drive", s);
    hub.subscribe("yard", s);
    hub.unsubscribeAll(s);
    await timers.advance(15_000);
    expect(children.every((c) => c.killed)).toBe(true);
    hub.stop();
  });

  it("stop() глушит все процессы сразу", () => {
    const { hub, children } = make();
    hub.subscribe("drive", fakeSink());
    hub.subscribe("yard", fakeSink());
    hub.stop();
    expect(children.every((c) => c.killed)).toBe(true);
  });
});
