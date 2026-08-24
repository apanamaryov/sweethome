import type { CameraInfo } from "@sweethome/cctv-shared";
import type { CctvConfig } from "../config";
import type { CctvDb } from "../index/db";
import { RecorderProcess, type Spawner, type Timers } from "./process";

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
    }
  ) {}

  async start(): Promise<void> {
    const { cfg } = this.deps;
    if (!cfg.enabled) return;
    this.stopped = false;

    for (const cam of cfg.cameras) {
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
      });
      this.procs.set(cam.id, proc);
      await proc.start();
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
        ...(st?.lastError ? { lastError: st.lastError } : {}),
      };
    });
  }

  storageAvailable(): boolean {
    return this.storageOk;
  }
}
