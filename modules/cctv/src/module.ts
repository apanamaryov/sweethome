import { spawn as nodeSpawn } from "child_process";
import { createReadStream, mkdirSync } from "fs";
import { promises as nodeFs } from "fs";
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
import { MotionWatcher, type SoapPost } from "./events/onvif";

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
  post?: SoapPost;
}

/**
 * Порог неотправленного хвоста у сокета зрителя.
 *
 * `ws` буферизует не влезшее в сокет прямо в куче и БЕЗ предела. Телефон, ушедший
 * из зоны Wi-Fi, держит соединение открытым до таймаута — это 10–15 минут; при
 * ~90 КБ/с это 50–80 МБ на одного зрителя, при том что свободной памяти на малине
 * около 440 МБ и ограничения памяти в юните нет. OOM убил бы весь монолит вместе
 * с мониторингом инвертора. Спека §8: для живой картинки актуальность важнее
 * непрерывности — отставший просто пропустит фрагменты и догонит.
 */
const LIVE_MAX_BUFFERED_BYTES = 2 * 1024 * 1024;

const realTimers: Timers = {
  setTimeout: (cb, ms) => setTimeout(cb, ms),
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
  now: () => Date.now(),
};

/** ONVIF-запрос через встроенный в Node 24 fetch — только чтение/подписка, ничего не меняет. */
const realPost: SoapPost = async (url, body, action) => {
  const ct = action
    ? `application/soap+xml; charset=utf-8; action="${action}"`
    : "application/soap+xml; charset=utf-8";
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": ct }, body });
  return await res.text();
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
  let started = false;
  const hub = new LiveHub({ cfg, timers, spawn: liveSpawn });
  // Наблюдатели за движением — по одному на камеру, необязательны (см. events/onvif.ts).
  const watchers: MotionWatcher[] = [];

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
    // Чтение с диска для /download — не через overrides.fs: там нет потокового
    // чтения (это внутренняя деталь одного маршрута, а не контракт модуля).
    openRead: (abs) => createReadStream(abs),
  });

  return {
    id: "cctv",
    apiRouter: router,
    ws: {
      onConnection(ws: WebSocket) {
        const sink: Sink = {
          send: (data) => {
            if (ws.readyState !== WebSocket.OPEN) return;
            // Зритель не успевает — фрагмент выбрасываем, а не копим в куче.
            if (ws.bufferedAmount > LIVE_MAX_BUFFERED_BYTES) return;
            ws.send(data);
          },
          sendText: (msg) => {
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
          },
        };
        ws.on("message", (raw: unknown) => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(String(raw));
          } catch {
            return; // мусор от клиента не должен ронять соединение
          }
          // "null" и "42" — валидный JSON, но не объект: без этой проверки
          // msg.type ниже бросил бы TypeError вне try/catch разбора.
          if (!parsed || typeof parsed !== "object") return;
          const msg = parsed as LiveClientMessage;

          if (msg.type === "subscribe") {
            if (!ffmpeg.ok) {
              // Без бинарника нечего спавнить: не запускаем сессию, которая
              // заведомо не поднимется, а честно сообщаем зрителю причину.
              sink.sendText({ type: "error", cam: msg.cam, error: "ffmpeg is not available" });
              return;
            }
            hub.subscribe(msg.cam, sink);
          } else if (msg.type === "unsubscribe") {
            hub.unsubscribe(msg.cam, sink);
          }
        });
        ws.on("close", () => hub.unsubscribeAll(sink));
        // У `ws` событие "error" без слушателя — брошенное исключение, а обрыв
        // соединения у зрителя на мобильном это обычное дело. Полагаться на общий
        // перехватчик в server/src/index.ts этому модулю нельзя (урок из его же
        // документации): отписываем зрителя ровно так же, как при close.
        ws.on("error", () => hub.unsubscribeAll(sink));
      },
    },

    async start() {
      // Повторный start() без stop() поднял бы второй RecorderManager поверх
      // тех же камер (дублирующая запись в один каталог) и второй набор
      // таймеров — внутренние компоненты от такой гонки защищены, а сборка
      // модуля до сих пор не была. Хост сегодня зовёт start()/stop() по разу,
      // но это ровно тот класс гонок, что уже не раз оказывался реальным.
      if (started) {
        console.warn("[cctv] start() called again without stop() — ignoring");
        return;
      }
      started = true;

      // Второй start() после честного stop(): если базу закрывали мы сами —
      // переоткрываем тот же объект (роутер и RecorderManager уже держат на
      // него ссылку, пересобирать её незачем).
      if (ownsDb && dbClosed) {
        db.reopen(`${cfg.dataDir}/index.db`);
        dbClosed = false;
      }

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

      // Метки движения — необязательная надстройка (см. events/onvif.ts): камеры
      // объявляют событие, но работоспособность на практике не подтверждена.
      // Отключается флагом; сама подписка не мешает ни записи, ни просмотру.
      if (cfg.motionEvents) {
        for (const cam of cfg.cameras) {
          const w = new MotionWatcher({ cam, db, post: over.post ?? realPost, timers });
          watchers.push(w);
          w.start();
        }
      }
    },

    async stop() {
      // Наблюдателей гасим первыми: у них может быть висящий запрос к камере,
      // а закрывать базу под ним (ниже) не хочется — так error просто попадёт
      // в state(), а не в "запись после close()".
      for (const w of watchers) w.stop();
      watchers.length = 0;
      hub.stop();
      manager?.stop();
      manager = null;
      if (ownsDb && !dbClosed) {
        db.close();
        dbClosed = true;
      }
      // Разрешаем честный повторный start() после этого stop() — гейт выше
      // блокирует только повторный вызов БЕЗ промежуточного stop().
      started = false;
    },

    health(): ModuleHealth {
      if (!cfg.enabled) return { ok: true, details: { enabled: false } };
      if (!ffmpeg.ok) return { ok: false, details: { enabled: true, ffmpeg: ffmpeg.error ?? "missing" } };
      const cams = manager?.cameras() ?? [];
      const storage = manager?.storageAvailable() ?? false;
      return {
        ok: storage && cams.every((c) => c.recording),
        details: {
          enabled: true,
          ffmpeg: ffmpeg.version,
          storage,
          cameras: cams,
          motion: watchers.map((w) => w.state()),
        },
      };
    },
  };
}
