import type { CameraConfig } from "../config";
import { recordArgs } from "./ffmpeg";

export interface ChildLike {
  on(ev: "exit", cb: (code: number | null) => void): void;
  stderr: { on(ev: "data", cb: (c: Buffer) => void): void } | null;
  kill(sig?: string): void;
}

export type Spawner = (cmd: string, args: string[]) => ChildLike;

/** Инъекция таймеров — чтобы надзор проверялся тестом без реальных задержек. */
export interface Timers {
  setTimeout(cb: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
  now(): number;
}

/** Паузы перед перезапуском: обрыв Wi-Fi лечится за секунды, мёртвая камера — нет. */
export const BACKOFF_MS: readonly number[] = [1000, 2000, 5000, 10000, 30000];

/** Проработал столько — считаем, что причина падений ушла, и начинаем ряд заново. */
export const RESET_AFTER_MS = 60_000;

export interface RecorderState {
  running: boolean;
  restarts: number;
  lastError?: string;
  startedAtMs: number | null;
}

export class RecorderProcess {
  private child: ChildLike | null = null;
  private timer: unknown = null;
  private stopped = false;
  private starting = false;
  private failures = 0;
  private restarts = 0;
  private startedAtMs: number | null = null;
  private lastError: string | undefined;

  constructor(
    private deps: {
      cam: CameraConfig;
      camDir: string;
      segmentSec: number;
      ffmpegPath: string;
      spawn: Spawner;
      timers: Timers;
      storageReady: () => Promise<boolean>;
      mkdir: (p: string) => Promise<void>;
      newRunId: () => string;
    }
  ) {}

  state(): RecorderState {
    return {
      running: this.child !== null,
      restarts: this.restarts,
      lastError: this.lastError,
      startedAtMs: this.startedAtMs,
    };
  }

  async start(): Promise<void> {
    // starting — против конкурентного второго вызова: без него два неawait-нутых
    // start() оба проходят проверку "child === null" и оба доходят до spawn().
    if (this.child !== null || this.stopped || this.starting) return;
    this.starting = true;
    try {
      const ready = await this.deps.storageReady();
      // stop() мог случиться, пока мы ждали ответ хранилища (это реальный сетевой
      // диск — секунды ожидания обычны). Перепроверяем, иначе поднимем процесс,
      // которым уже никто не будет управлять.
      if (this.stopped) return;

      if (!ready) {
        // Не крутим ffmpeg вхолостую: он всё равно упадёт, а логи заспамит.
        this.lastError = "storage is not available";
        this.scheduleRestart();
        return;
      }

      try {
        await this.deps.mkdir(this.deps.camDir);
      } catch (e) {
        if (this.stopped) return;
        this.lastError = `mkdir failed: ${(e as Error).message}`;
        this.scheduleRestart();
        return;
      }
      // Та же гонка: stop() во время mkdir().
      if (this.stopped) return;

      const args = recordArgs({
        cam: this.deps.cam,
        camDir: this.deps.camDir,
        segmentSec: this.deps.segmentSec,
        runId: this.deps.newRunId(),
      });

      const child = this.deps.spawn(this.deps.ffmpegPath, args);
      this.child = child;
      this.startedAtMs = this.deps.timers.now();

      child.stderr?.on("data", (chunk) => {
        const line = chunk.toString().trim().split("\n").pop();
        if (line) this.lastError = line;
      });

      child.on("exit", () => {
        const ranFor = this.deps.timers.now() - (this.startedAtMs ?? 0);
        this.child = null;
        this.startedAtMs = null;
        if (this.stopped) return;
        if (ranFor >= RESET_AFTER_MS) this.failures = 0;
        this.restarts++;
        this.scheduleRestart();
      });
    } finally {
      this.starting = false;
    }
  }

  private scheduleRestart(): void {
    if (this.stopped) return;
    const delay = BACKOFF_MS[Math.min(this.failures, BACKOFF_MS.length - 1)];
    this.failures++;
    this.timer = this.deps.timers.setTimeout(() => {
      this.timer = null;
      void this.start();
    }, delay);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      this.deps.timers.clearTimeout(this.timer);
      this.timer = null;
    }
    const child = this.child;
    this.child = null;
    this.startedAtMs = null;
    child?.kill("SIGTERM");
  }
}
