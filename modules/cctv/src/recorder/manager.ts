import type { CameraInfo } from "@sweethome/cctv-shared";
import type { CctvConfig } from "../config";
import type { CctvDb } from "../index/db";
import { RecorderProcess, type Spawner, type Timers } from "./process";
import { probeAudio } from "./probe-audio";
import type { CameraConfig } from "../config";

/** Индекс отстаёт от диска не больше чем на этот интервал. */
export const SCAN_INTERVAL_MS = 15_000;
/** Чистка — дело редкое: 500 ГБ за десять минут не набегает. */
export const RETENTION_INTERVAL_MS = 600_000;

export class RecorderManager {
  private procs = new Map<string, RecorderProcess>();
  private scanTimer: unknown = null;
  private retentionTimer: unknown = null;
  private stopped = false;
  private storageOk = true;
  /**
   * Шлёт ли камера звук. Спрашивается один раз при старте настоящей пробой:
   * объявленная в потоке дорожка ничего не значит — наши камеры объявляют AAC
   * и молчат в неё.
   */
  private audio = new Map<string, boolean>();

  constructor(
    private deps: {
      cfg: CctvConfig;
      db: CctvDb;
      scanner: { scanCamera(cam: string): Promise<number> };
      retention: { runOnce(): Promise<{ removed: number; freedBytes: number }> };
      spawn: Spawner;
      timers: Timers;
      storageReady: () => Promise<boolean>;
      mkdir: (p: string) => Promise<void>;
      newRunId?: () => string;
      /** Проба звука; подменяется в тестах, чтобы не спрашивать настоящую камеру. */
      probeAudio?: (cam: CameraConfig) => Promise<boolean>;
    }
  ) {}

  async start(): Promise<void> {
    const { cfg } = this.deps;
    if (!cfg.enabled) return;
    this.stopped = false;

    // Спрашиваем камеры про звук до запуска записи: пустая дорожка задерживает
    // первую выдачу ffmpeg примерно на десять секунд — и в записи, и в живом
    // просмотре. Пробы идут разом и не мешают друг другу.
    await Promise.all(
      cfg.cameras.map(async (cam) => {
        const probe =
          this.deps.probeAudio ??
          ((c: CameraConfig) =>
            probeAudio({ cam: c, ffmpegPath: cfg.ffmpegPath, spawn: this.deps.spawn, timers: this.deps.timers }));
        const has = await probe(cam);
        this.audio.set(cam.id, has);
        console.log(`[cctv] ${cam.id}: звук ${has ? "есть" : "не передаётся камерой"}`);
      })
    );
    if (this.stopped) return;

    for (const cam of cfg.cameras) {
      // stop() мог случиться между итерациями (пока предыдущая камера ждала
      // storageReady/mkdir на сетевом диске) — не поднимаем то, что сразу же
      // придётся глушить.
      if (this.stopped) return;

      const proc = new RecorderProcess({
        cam,
        camDir: `${cfg.storageDir}/${cam.id}`,
        segmentSec: cfg.segmentSec,
        ffmpegPath: cfg.ffmpegPath,
        spawn: this.deps.spawn,
        timers: this.deps.timers,
        storageReady: async () => {
          this.storageOk = await this.deps.storageReady();
          return this.storageOk;
        },
        mkdir: this.deps.mkdir,
        newRunId: this.deps.newRunId ?? (() => `${Date.now().toString(36)}`),
        withAudio: () => this.hasAudio(cam.id) && cfg.recordAudio,
      });
      this.procs.set(cam.id, proc);
      await proc.start();

      // Остановили, пока этот процесс поднимался: stop() уже прошёл и не
      // застал его в this.procs, значит глушим его здесь сами — иначе он
      // останется писать бесконтрольно до конца жизни сервиса.
      if (this.stopped) {
        proc.stop();
        this.procs.delete(cam.id);
        return;
      }
    }

    this.armScan();
    this.armRetention();
  }

  private armScan(): void {
    if (this.stopped) return;
    this.scanTimer = this.deps.timers.setTimeout(() => {
      void this.tickScan();
    }, SCAN_INTERVAL_MS);
  }

  private async tickScan(): Promise<void> {
    for (const cam of this.deps.cfg.cameras) {
      try {
        await this.deps.scanner.scanCamera(cam.id);
      } catch (e) {
        // Диск мог отвалиться — тик всё равно должен встать в очередь заново.
        console.error(`[cctv] scan ${cam.id} failed:`, (e as Error).message);
      }
    }
    this.armScan();
  }


  private armRetention(): void {
    if (this.stopped) return;
    this.retentionTimer = this.deps.timers.setTimeout(() => {
      void this.tickRetention();
    }, RETENTION_INTERVAL_MS);
  }

  private async tickRetention(): Promise<void> {
    try {
      const r = await this.deps.retention.runOnce();
      if (r.removed > 0) {
        console.log(`[cctv] retention: removed ${r.removed} segments, freed ${Math.round(r.freedBytes / 1024 ** 2)} MB`);
      }
    } catch (e) {
      console.error("[cctv] retention failed:", (e as Error).message);
    }
    this.armRetention();
  }

  stop(): void {
    this.stopped = true;
    if (this.scanTimer !== null) this.deps.timers.clearTimeout(this.scanTimer);
    if (this.retentionTimer !== null) this.deps.timers.clearTimeout(this.retentionTimer);
    this.scanTimer = null;
    this.retentionTimer = null;
    for (const p of this.procs.values()) p.stop();
    this.procs.clear();
  }

  cameras(): CameraInfo[] {
    return this.deps.cfg.cameras.map((cam) => {
      const st = this.procs.get(cam.id)?.state();
      return {
        id: cam.id,
        name: cam.name,
        recording: st?.running ?? false,
        lastSegmentMs: this.deps.db.lastSegmentStart(cam.id),
        restarts: st?.restarts ?? 0,
        hasAudio: this.hasAudio(cam.id),
        recordsAudio: this.hasAudio(cam.id) && this.deps.cfg.recordAudio,
        ...(st?.lastError ? { lastError: st.lastError } : {}),
      };
    });
  }

  /** Шлёт ли камера звук — ответ пробы, снятой при старте. */
  hasAudio(camId: string): boolean {
    return this.audio.get(camId) ?? false;
  }

  storageAvailable(): boolean {
    return this.storageOk;
  }
}
