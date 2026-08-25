import { loadCctvConfig } from "../config";
import { LiveHub, type LiveChild, type Sink } from "./hub";
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
  errCb: ((c: Buffer) => void) | null = null;
  exitCb: ((code: number | null) => void) | null = null;
  errorCb: ((err?: unknown) => void) | null = null;
  killed = false;
  /**
   * Настоящий child_process не эмитит exit синхронно из kill() — только позже.
   * Флаг воспроизводит именно такой порядок, а не удобный для теста синхронный.
   */
  asyncExit = false;
  stdout = {
    on: (_ev: "data", cb: (c: Buffer) => void) => {
      this.dataCb = cb;
    },
  };
  stderr = {
    on: (_ev: "data", cb: (c: Buffer) => void) => {
      this.errCb = cb;
    },
  };
  // "exit" и "error" — разные слушатели с разными callback'ами; сессия
  // регистрирует оба, и второй вызов не должен затирать первый.
  on(ev: "exit" | "error", cb: (arg?: unknown) => void): void {
    if (ev === "exit") this.exitCb = cb;
    else this.errorCb = cb;
  }
  kill(): void {
    this.killed = true;
    if (this.asyncExit) {
      setTimeout(() => this.exitCb?.(null), 0);
    } else {
      this.exitCb?.(null);
    }
  }
  emit(data: string): void {
    this.dataCb?.(Buffer.from(data));
  }
  emitErr(data: string): void {
    this.errCb?.(Buffer.from(data));
  }
}

/** Настоящий тик event loop — чтобы дождаться setTimeout(..., 0) из asyncExit. */
function tick(ms = 5): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  it("первый подписчик поднимает процесс, а готовность приходит с первым фрагментом", () => {
    // Раньше кодеки объявлялись сразу и наугад. Теперь их видно только по
    // заголовку потока: у камер разный состав дорожек, а неверно объявленный
    // кодек не даёт браузеру открыть источник вообще.
    const { hub, children } = make();
    const s = fakeSink();
    hub.subscribe("drive", s);
    expect(children).toHaveLength(1);
    expect(s.texts).toEqual([]);

    children[0].emit("ftyp....moov....mp4a");
    expect(s.texts).toEqual([
      { type: "ready", cam: "drive", mime: 'video/mp4; codecs="avc1.4d0032,mp4a.40.2"' },
    ]);
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

  it("stderr живой сессии вычитывается — иначе канал переполнится и ffmpeg встанет", () => {
    const { hub, children } = make();
    hub.subscribe("drive", fakeSink());
    // Слушатель повешен: без него 64 КБ канала забиваются и процесс виснет
    // насмерть — живая картинка замирает без единого сообщения.
    expect(children[0].errCb).not.toBeNull();
    hub.stop();
  });

  it("последняя строка stderr попадает в сообщение об ошибке зрителю", () => {
    const { hub, children } = make();
    const s = fakeSink();
    hub.subscribe("drive", s);
    children[0].emitErr("Connection timed out\nrtsp: could not open input");
    children[0].exitCb?.(1);

    const err = s.texts.find((t) => t.type === "error");
    expect(err).toBeDefined();
    expect((err as { error: string }).error).toContain("rtsp: could not open input");
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

  it("фрагмент, пришедший после падения процесса, подписчикам не уходит", () => {
    const { hub, children } = make();
    const s = fakeSink();
    hub.subscribe("drive", s);
    children[0].emit("HEAD");
    const chunksBeforeExit = s.chunks.length;

    children[0].exitCb?.(1);
    // данные из буфера пайпа могут прийти уже после exit — к этому моменту
    // подписчик уже получил ошибку и, вероятно, закрыл MediaSource у себя
    children[0].emit("LATE");

    expect(s.texts.some((t) => t.type === "error")).toBe(true);
    expect(s.chunks.length).toBe(chunksBeforeExit);
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

  it("поздний exit старого процесса не гасит новую сессию, поднятую после переподписки", async () => {
    const { hub, timers, children } = make();
    const s1 = fakeSink();
    hub.subscribe("drive", s1);
    hub.unsubscribe("drive", s1);
    // kill() не гарантирует синхронный exit — воспроизводим честный порядок
    children[0].asyncExit = true;

    await timers.advance(15_000); // таймер простоя гасит первый процесс; exit ещё не долетел
    expect(children[0].killed).toBe(true);

    hub.subscribe("drive", fakeSink()); // переподписка ровно в это окно — новая, живая сессия
    expect(children).toHaveLength(2);

    await tick(); // теперь долетает отложенный exit первого (уже неактуального) процесса

    expect(hub.activeCameras()).toEqual(["drive"]);
    hub.subscribe("drive", fakeSink());
    expect(children).toHaveLength(2); // третий процесс не поднялся — камера делит второй

    hub.stop();
  });

  it("после hub.stop() отложенный exit не рассылает ошибку подписчику", async () => {
    const { hub, children } = make();
    const s = fakeSink();
    hub.subscribe("drive", s);
    children[0].asyncExit = true;
    const textsBefore = s.texts.length;

    hub.stop();
    await tick(); // долетает отложенный exit уже остановленного процесса

    expect(s.texts.length).toBe(textsBefore);
  });
});
