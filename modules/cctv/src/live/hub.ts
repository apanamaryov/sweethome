import type { CctvConfig } from "../config";
import type { Timers } from "../recorder/process";
import { LiveSession, type LiveChild, type LiveSpawner, type Sink } from "./session";

export type { LiveChild, LiveSpawner, Sink } from "./session";

/** Кодек этих камер измерен разведкой: H.264 Main, level 5.0. */
export const LIVE_MIME = 'video/mp4; codecs="avc1.4d0032"';

export class LiveHub {
  private sessions = new Map<string, LiveSession>();
  private idleTimers = new Map<string, unknown>();

  constructor(private deps: { cfg: CctvConfig; timers: Timers; spawn: LiveSpawner }) {}

  subscribe(camId: string, sink: Sink): void {
    const cam = this.deps.cfg.cameras.find((c) => c.id === camId);
    if (!cam) {
      sink.sendText({ type: "error", cam: camId, error: `unknown camera: ${camId}` });
      return;
    }

    this.cancelIdle(camId);
    let session = this.sessions.get(camId);
    if (!session) {
      session = new LiveSession({
        cam,
        ffmpegPath: this.deps.cfg.ffmpegPath,
        spawn: this.deps.spawn,
        // Процесс умирает асинхронно: к этому моменту в мапе может лежать уже
        // другая, живая сессия этой камеры — её удалять нельзя.
        onExit: () => {
          if (this.sessions.get(camId) === session) this.sessions.delete(camId);
        },
      });
      this.sessions.set(camId, session);
      session.start();
    }
    session.attach(sink);
    sink.sendText({ type: "ready", cam: camId, mime: LIVE_MIME });
  }

  unsubscribe(camId: string, sink: Sink): void {
    const session = this.sessions.get(camId);
    if (!session) return;
    session.detach(sink);
    if (session.size() === 0) this.armIdle(camId);
  }

  unsubscribeAll(sink: Sink): void {
    for (const camId of [...this.sessions.keys()]) this.unsubscribe(camId, sink);
  }

  /**
   * Гасим не сразу: переход между страницами не должен дёргать ffmpeg — повторный
   * запуск стоит несколько секунд ожидания опорного кадра.
   */
  private armIdle(camId: string): void {
    this.cancelIdle(camId);
    const h = this.deps.timers.setTimeout(() => {
      this.idleTimers.delete(camId);
      const s = this.sessions.get(camId);
      if (s && s.size() === 0) {
        s.stop();
        this.sessions.delete(camId);
      }
    }, this.deps.cfg.liveIdleSec * 1000);
    this.idleTimers.set(camId, h);
  }

  private cancelIdle(camId: string): void {
    const h = this.idleTimers.get(camId);
    if (h !== undefined) {
      this.deps.timers.clearTimeout(h);
      this.idleTimers.delete(camId);
    }
  }

  activeCameras(): string[] {
    return [...this.sessions.keys()];
  }

  stop(): void {
    for (const h of this.idleTimers.values()) this.deps.timers.clearTimeout(h);
    this.idleTimers.clear();
    for (const s of this.sessions.values()) s.stop();
    this.sessions.clear();
  }
}
