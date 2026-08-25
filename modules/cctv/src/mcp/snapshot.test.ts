import { Readable } from "stream";
import { archiveFrameArgs, grabFrame, liveFrameArgs, type FrameChild } from "./snapshot";

const CAM = { id: "drive", name: "Въезд", host: "10.0.0.9", rtspPath: "live/ch00_0" };

/** Поддельный ffmpeg: отдаёт что велено и завершает работу по команде теста. */
class FakeChild implements FrameChild {
  stdoutCb: ((c: Buffer) => void) | null = null;
  stderrCb: ((c: Buffer) => void) | null = null;
  exitCb: ((arg?: unknown) => void) | null = null;
  errorCb: ((arg?: unknown) => void) | null = null;
  killed: NodeJS.Signals | undefined | null = null;
  written: Buffer[] = [];
  stdinEnded = false;

  stdout = {
    on: (_ev: "data", cb: (c: Buffer) => void) => {
      this.stdoutCb = cb;
    },
  } as unknown as NodeJS.ReadableStream;

  stderr = {
    on: (_ev: "data", cb: (c: Buffer) => void) => {
      this.stderrCb = cb;
    },
  };

  stdin = {
    on: () => {},
    write: (chunk: Buffer, _enc: unknown, cb?: () => void) => {
      this.written.push(Buffer.from(chunk));
      cb?.();
      return true;
    },
    end: () => {
      this.stdinEnded = true;
    },
    once: () => {},
    emit: () => false,
    removeListener: () => {},
  } as unknown as NodeJS.WritableStream;

  on(ev: "exit" | "error", cb: (arg?: unknown) => void): void {
    if (ev === "exit") this.exitCb = cb;
    else this.errorCb = cb;
  }
  kill(sig?: NodeJS.Signals): void {
    this.killed = sig ?? "SIGTERM";
  }
}

describe("аргументы кадра", () => {
  it("живой кадр берётся по TCP и сразу уменьшается", () => {
    const args = liveFrameArgs(CAM, 640);
    // TCP — потому что по UDP поток у этих камер не поднимается (спека §2.1).
    expect(args).toContain("-rtsp_transport");
    expect(args[args.indexOf("-rtsp_transport") + 1]).toBe("tcp");
    expect(args).toContain("rtsp://10.0.0.9:554/live/ch00_0");
    expect(args[args.indexOf("-vf") + 1]).toBe("scale=640:-2");
    expect(args[args.indexOf("-frames:v") + 1]).toBe("1");
  });

  it("кадр из архива читает склейку со stdin и перематывает после -i", () => {
    // На трубе входная перемотка (-ss до -i) не работает: ключ обязан идти после входа.
    const args = archiveFrameArgs(12.5, 320);
    expect(args[args.indexOf("-i") + 1]).toBe("pipe:0");
    expect(args.indexOf("-ss")).toBeGreaterThan(args.indexOf("-i"));
    expect(args[args.indexOf("-ss") + 1]).toBe("12.500");
    expect(args[args.indexOf("-vf") + 1]).toBe("scale=320:-2");
  });
});

describe("grabFrame", () => {
  it("собирает кадр из stdout", async () => {
    const child = new FakeChild();
    const p = grabFrame({ spawn: () => child, ffmpegPath: "ffmpeg", args: [], timeoutMs: 1000 });
    child.stdoutCb!(Buffer.from([0xff, 0xd8]));
    child.stdoutCb!(Buffer.from([0xff, 0xd9]));
    child.exitCb!(0);
    await expect(p).resolves.toEqual(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  });

  it("пустой вывод объясняется хвостом stderr, а не голым кодом выхода", async () => {
    const child = new FakeChild();
    const p = grabFrame({ spawn: () => child, ffmpegPath: "ffmpeg", args: [], timeoutMs: 1000 });
    child.stderrCb!(Buffer.from("Connection refused"));
    child.exitCb!(1);
    await expect(p).rejects.toThrow(/Connection refused/);
  });

  it("слишком большой кадр обрывает процесс, а не копится в памяти", async () => {
    const child = new FakeChild();
    const p = grabFrame({ spawn: () => child, ffmpegPath: "ffmpeg", args: [], timeoutMs: 1000, maxBytes: 10 });
    child.stdoutCb!(Buffer.alloc(11));
    await expect(p).rejects.toThrow(/smaller width/);
    expect(child.killed).toBe("SIGKILL");
  });

  it("неудачный запуск ffmpeg — ошибка ответа, а не падение процесса", async () => {
    // Необработанный "error" у child_process роняет весь монолит вместе с
    // мониторингом инвертора — этот модуль уже наступал на это дважды.
    const child = new FakeChild();
    const p = grabFrame({ spawn: () => child, ffmpegPath: "ffmpeg", args: [], timeoutMs: 1000 });
    child.errorCb!(new Error("ENOENT"));
    await expect(p).rejects.toThrow(/ENOENT/);
  });

  it("зависший ffmpeg убивается по таймауту", async () => {
    const child = new FakeChild();
    const p = grabFrame({ spawn: () => child, ffmpegPath: "ffmpeg", args: [], timeoutMs: 10 });
    await expect(p).rejects.toThrow(/did not produce a frame/);
    expect(child.killed).toBe("SIGKILL");
  });

  it("скармливает вход по порядку: сначала заголовок потока, потом сегмент", async () => {
    // Порядок не косметический: без init в начале склейка не открывается вообще.
    const child = new FakeChild();
    const p = grabFrame({
      spawn: () => child,
      ffmpegPath: "ffmpeg",
      args: [],
      timeoutMs: 1000,
      input: [Readable.from([Buffer.from("INIT")]), Readable.from([Buffer.from("SEG")])],
    });

    await new Promise((r) => setTimeout(r, 5));
    expect(Buffer.concat(child.written).toString()).toBe("INITSEG");

    child.stdoutCb!(Buffer.from("JPEG"));
    child.exitCb!(0);
    await expect(p).resolves.toEqual(Buffer.from("JPEG"));
  });

  it("готовый кадр важнее ненулевого кода выхода", async () => {
    // ffmpeg закрывает вход, как только набрал кадр, и уходит с ненулевым кодом —
    // это норма, а не повод потерять уже полученную картинку.
    const child = new FakeChild();
    const p = grabFrame({ spawn: () => child, ffmpegPath: "ffmpeg", args: [], timeoutMs: 1000 });
    child.stdoutCb!(Buffer.from("JPEG"));
    child.exitCb!(1);
    await expect(p).resolves.toEqual(Buffer.from("JPEG"));
  });
});
