import type { LiveServerMessage } from "@sweethome/cctv-shared";
import type { CameraConfig } from "../config";
import { liveArgs } from "../recorder/ffmpeg";

export interface LiveChild {
  stdout: { on(ev: "data", cb: (c: Buffer) => void): void } | null;
  on(ev: "exit", cb: (code: number | null) => void): void;
  kill(sig?: string): void;
}

export type LiveSpawner = (cmd: string, args: string[]) => LiveChild;

/** Куда уходит поток: бинарные фрагменты и текстовые сообщения. */
export interface Sink {
  send(data: Buffer): void;
  sendText(msg: LiveServerMessage): void;
}

/**
 * Один процесс ffmpeg на камеру. Первый пришедший фрагмент — заголовок потока
 * (`ftyp`+`moov`); он запоминается и уходит каждому новому зрителю, иначе
 * браузеру нечем инициализировать воспроизведение.
 */
export class LiveSession {
  private child: LiveChild | null = null;
  private header: Buffer | null = null;
  private sinks = new Set<Sink>();

  constructor(
    private deps: { cam: CameraConfig; ffmpegPath: string; spawn: LiveSpawner; onExit: () => void }
  ) {}

  start(): void {
    if (this.child) return;
    const child = this.deps.spawn(this.deps.ffmpegPath, liveArgs({ cam: this.deps.cam }));
    this.child = child;

    child.stdout?.on("data", (chunk: Buffer) => {
      if (this.header === null) this.header = chunk;
      for (const s of this.sinks) s.send(chunk);
    });

    child.on("exit", () => {
      this.child = null;
      this.header = null;
      for (const s of this.sinks) {
        s.sendText({ type: "error", cam: this.deps.cam.id, error: "live stream stopped" });
      }
      // Процесс мёртв: данные из буфера пайпа могут прийти уже после exit, а у
      // подписчика к этому моменту закрыт MediaSource — фрагмент туда слать нельзя.
      this.sinks.clear();
      this.deps.onExit();
    });
  }

  attach(sink: Sink): void {
    this.sinks.add(sink);
    if (this.header !== null) sink.send(this.header);
  }

  detach(sink: Sink): void {
    this.sinks.delete(sink);
  }

  size(): number {
    return this.sinks.size;
  }

  stop(): void {
    const child = this.child;
    this.child = null;
    this.header = null;
    this.sinks.clear();
    child?.kill("SIGTERM");
  }
}
