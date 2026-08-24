import { spawn as nodeSpawn } from "child_process";
import { mkdirSync } from "fs";
import { promises as nodeFs } from "fs";
import { randomUUID } from "crypto";
import { WebSocket } from "ws";
import type { HomeModule, ModuleHealth } from "@sweethome/shared/module";
import type { LiveClientMessage } from "@sweethome/cctv-shared";
import { loadCctvConfig, type CctvConfig } from "./config";
import { CctvDb } from "./index/db";
import { Scanner, type FsLike } from "./index/scanner";
import { Retention, type UnlinkFs } from "./index/retention";
import { RecorderManager } from "./recorder/manager";
import { probeFfmpeg } from "./recorder/ffmpeg";
import type { Spawner, Timers } from "./recorder/process";
import { LiveHub, type LiveSpawner, type Sink } from "./live/hub";
import { createCctvRouter } from "./router";

type ModuleFs = FsLike &
  UnlinkFs & {
    mkdir(p: string, o: { recursive: true }): Promise<unknown>;
    access(p: string): Promise<void>;
  };

export interface CctvModuleOverrides {
  cfg?: CctvConfig;
  db?: CctvDb;
  spawn?: Spawner;
  liveSpawn?: LiveSpawner;
  timers?: Timers;
  fs?: ModuleFs;
  probe?: () => Promise<{ ok: boolean; version?: string; error?: string }>;
}

const realTimers: Timers = {
  setTimeout: (cb, ms) => setTimeout(cb, ms),
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
  now: () => Date.now(),
};

// fs.promises.readFile без явной кодировки отдаёт Buffer, а не строку — Scanner
// ждёт текст плейлиста. Адаптер, а не приведение типа: так несовпадение сигнатур
// видно на этапе компиляции, а не всплывает как runtime-баг на реальном диске.
const realFs: ModuleFs = {
  readFile: (p) => nodeFs.readFile(p, "utf8"),
  stat: (p) => nodeFs.stat(p),
  readdir: (p) => nodeFs.readdir(p),
  unlink: (p) => nodeFs.unlink(p),
  mkdir: (p, o) => nodeFs.mkdir(p, o),
  access: (p) => nodeFs.access(p),
};

/** `ffmpeg -version` через child_process — только для проверки наличия бинарника. */
async function realExec(cmd: string, args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = nodeSpawn(cmd, args);
    let stdout = "";
    child.stdout?.on("data", (c: Buffer) => {
      stdout += c.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code: code ?? 1, stdout }));
  });
}

export function createCctvModule(rootDataDir: string, over: CctvModuleOverrides = {}): HomeModule {
  const cfg = over.cfg ?? loadCctvConfig(rootDataDir);
  const fs = over.fs ?? realFs;
  const timers = over.timers ?? realTimers;
  // nodeSpawn перегружен по второму параметру (args | options) — прямая ссылка
  // на функцию не разрешается в нужную перегрузку, поэтому оборачиваем.
  const spawn: Spawner = over.spawn ?? ((cmd, args) => nodeSpawn(cmd, args));
  const liveSpawn: LiveSpawner = over.liveSpawn ?? ((cmd, args) => nodeSpawn(cmd, args));

  // База открывается здесь, а не в start(): роутеру она нужна уже при сборке
  // объекта модуля, а не только после первого start(). Владеем ею (и закрываем
  // в stop()) только если её не подсунули через overrides — тесты открывают и
  // закрывают свою копию сами.
  const ownsDb = over.db === undefined;
  if (ownsDb) mkdirSync(cfg.dataDir, { recursive: true });
  const db: CctvDb = over.db ?? new CctvDb(`${cfg.dataDir}/index.db`);
  let dbClosed = false;

  let ffmpeg: { ok: boolean; version?: string; error?: string } = { ok: false, error: "not probed" };
  let manager: RecorderManager | null = null;
  const hub = new LiveHub({ cfg, timers, spawn: liveSpawn });

  const storageReady = async (): Promise<boolean> => {
    try {
      await fs.access(cfg.storageDir);
      return true;
    } catch {
      return false;
    }
  };

  // Собирается только в start(), но роутеру он нужен уже сейчас — читаем его
  // через замыкание, а не через постоянно живой геттер: снаружи это обычная
  // переменная, а не отдельная сущность, которую нужно было бы поддерживать.
  const router = createCctvRouter({
    cfg,
    db,
    manager: {
      cameras: () =>
        manager?.cameras() ??
        cfg.cameras.map((c) => ({ id: c.id, name: c.name, recording: false, lastSegmentMs: null, restarts: 0 })),
      storageAvailable: () => manager?.storageAvailable() ?? false,
    },
    sendFile: (res, abs) => res.sendFile(abs),
    spawn: (cmd, args) => nodeSpawn(cmd, args),
    tmpFile: async (content) => {
      // Временный файл для concat-списка — не то, что тесты подставляют через
      // overrides.fs (там нет writeFile: это внутренняя деталь одного маршрута,
      // не часть контракта модуля). Пишем напрямую через настоящий fs.
      const p = `${cfg.dataDir}/download-${randomUUID()}.txt`;
      await nodeFs.writeFile(p, content);
      return { path: p, cleanup: () => fs.unlink(p).catch(() => {}) };
    },
  });

  return {
    id: "cctv",
    apiRouter: router,
    ws: {
      onConnection(ws: WebSocket) {
        const sink: Sink = {
          send: (data) => {
            if (ws.readyState === WebSocket.OPEN) ws.send(data);
          },
          sendText: (msg) => {
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
          },
        };
        ws.on("message", (raw: unknown) => {
          let msg: LiveClientMessage;
          try {
            msg = JSON.parse(String(raw)) as LiveClientMessage;
          } catch {
            return; // мусор от клиента не должен ронять соединение
          }
          if (msg.type === "subscribe") hub.subscribe(msg.cam, sink);
          else if (msg.type === "unsubscribe") hub.unsubscribe(msg.cam, sink);
        });
        ws.on("close", () => hub.unsubscribeAll(sink));
      },
    },

    async start() {
      if (!cfg.enabled) {
        console.log("[cctv] disabled (no cameras configured)");
        return;
      }

      ffmpeg = await (over.probe ?? (() => probeFfmpeg(cfg.ffmpegPath, realExec)))();
      if (!ffmpeg.ok) {
        console.error(`[cctv] ffmpeg is not usable (${ffmpeg.error}) — recording disabled`);
        return; // модуль жив, но не пишет: health расскажет правду
      }

      manager = new RecorderManager({
        cfg,
        db,
        scanner: new Scanner(db, cfg.storageDir, fs, cfg.segmentSec),
        retention: new Retention(db, cfg.storageDir, fs, cfg.quotaBytes),
        spawn,
        timers,
        storageReady,
        mkdir: (p) => fs.mkdir(p, { recursive: true }).then(() => undefined),
      });
      await manager.start();

      console.log(
        `[cctv] ffmpeg=${ffmpeg.version} cameras=${cfg.cameras.map((c) => c.id).join(",")} ` +
          `storage=${cfg.storageDir} quota=${Math.round(cfg.quotaBytes / 1024 ** 3)}GB`
      );
    },

    async stop() {
      hub.stop();
      manager?.stop();
      manager = null;
      if (ownsDb && !dbClosed) {
        db.close();
        dbClosed = true;
      }
    },

    health(): ModuleHealth {
      if (!cfg.enabled) return { ok: true, details: { enabled: false } };
      if (!ffmpeg.ok) return { ok: false, details: { enabled: true, ffmpeg: ffmpeg.error ?? "missing" } };
      const cams = manager?.cameras() ?? [];
      const storage = manager?.storageAvailable() ?? false;
      return {
        ok: storage && cams.every((c) => c.recording),
        details: { enabled: true, ffmpeg: ffmpeg.version, storage, cameras: cams },
      };
    },
  };
}
