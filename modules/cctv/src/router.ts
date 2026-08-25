import express, { Router } from "express";
import { pipeline } from "stream/promises";
import type { CameraInfo, StorageInfo, TimelineResponse } from "@sweethome/cctv-shared";
import type { CctvConfig } from "./config";
import type { CctvDb } from "./index/db";
import { downloadFileName } from "./download";
import { buildSpans, clampSpans } from "./index/spans";
import { buildVodPlaylist } from "./playlist";

export type SendFile = (res: express.Response, absPath: string) => void;

/** Разбор и проверка `cam`/`from`/`to`. Возвращает null, если параметры негодные. */
function parseRange(q: Record<string, unknown>): { cam: string; fromMs: number; toMs: number } | null {
  const cam = typeof q.cam === "string" ? q.cam : "";
  const fromMs = Number(q.from);
  const toMs = Number(q.to);
  if (!cam) return null;
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return null;
  if (toMs <= fromMs) return null;
  return { cam, fromMs, toMs };
}

/** Чтение файла хранилища потоком — вся файловая зависимость `/download`. */
export type OpenRead = (absPath: string) => NodeJS.ReadableStream;

/** Зависимости роутера — отдельный экспортируемый тип, чтобы сборка модуля проверялась типами, а не приведениями. */
export interface CctvRouterDeps {
  cfg: CctvConfig;
  db: CctvDb;
  manager: { cameras(): CameraInfo[]; storageAvailable(): boolean };
  sendFile: SendFile;
  openRead: OpenRead;
}

export function createCctvRouter(deps: CctvRouterDeps): Router {
  const { cfg, db, manager, sendFile } = deps;
  const router = express.Router();
  const known = new Set(cfg.cameras.map((c) => c.id));

  router.get("/cameras", (_req, res) => {
    res.json({ cameras: manager.cameras() });
  });

  router.get("/timeline", (req, res) => {
    const r = parseRange(req.query as Record<string, unknown>);
    if (!r) return res.status(400).json({ ok: false, error: "cam, from and to are required (from < to)" });
    if (!known.has(r.cam)) return res.status(404).json({ ok: false, error: `unknown camera: ${r.cam}` });

    const segs = db.segmentsBetween(r.cam, r.fromMs, r.toMs);
    const body: TimelineResponse = {
      cam: r.cam,
      fromMs: r.fromMs,
      toMs: r.toMs,
      spans: clampSpans(buildSpans(segs), r.fromMs, r.toMs),
      marks: db.motionBetween(r.cam, r.fromMs, r.toMs),
      segments: segs.length,
      bytes: segs.reduce((sum, s) => sum + s.bytes, 0),
      // Та же выборка, что уходит в /playlist.m3u8, и без подрезки: это нулевая
      // отметка шкалы плеера. Клиенту нужны обе системы отсчёта — подрезанные
      // отрезки для полос на ленте и эта отметка для перевода времени в позицию.
      playlistStartMs: segs.length > 0 ? segs[0].startMs : null,
    };
    res.json(body);
  });

  router.get("/playlist.m3u8", (req, res) => {
    const r = parseRange(req.query as Record<string, unknown>);
    if (!r) return res.status(400).json({ ok: false, error: "cam, from and to are required (from < to)" });
    if (!known.has(r.cam)) return res.status(404).json({ ok: false, error: `unknown camera: ${r.cam}` });

    const segs = db.segmentsBetween(r.cam, r.fromMs, r.toMs);
    res.type("application/vnd.apple.mpegurl").send(buildVodPlaylist(segs));
  });

  // Путь к файлу берётся ИЗ ИНДЕКСА по числовому id. Ничего из запроса в путь не
  // попадает — поэтому выйти за пределы каталога хранилища через адрес нельзя.
  router.get("/segment/:id", (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ ok: false, error: "bad id" });
    const seg = db.segmentById(id);
    if (!seg) return res.status(404).json({ ok: false, error: "segment not found" });
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    sendFile(res, `${cfg.storageDir}/${seg.path}`);
  });

  router.get("/init/:id", (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ ok: false, error: "bad id" });
    const init = db.initPathById(id);
    if (!init) return res.status(404).json({ ok: false, error: "init not found" });
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    sendFile(res, `${cfg.storageDir}/${init.path}`);
  });

  router.get("/storage", (_req, res) => {
    const t = db.totals();
    const spanMs = t.oldestMs !== null && t.newestMs !== null ? t.newestMs - t.oldestMs : 0;
    // Глубина архива: сколько суток влезет в квоту при текущем расходе.
    const perDay = spanMs > 0 ? (t.bytes / spanMs) * 86_400_000 : 0;
    const body: StorageInfo = {
      available: manager.storageAvailable(),
      usedBytes: t.bytes,
      quotaBytes: cfg.quotaBytes,
      depthDays: perDay > 0 ? Math.round(cfg.quotaBytes / perDay) : null,
      oldestMs: t.oldestMs,
      newestMs: t.newestMs,
    };
    res.json(body);
  });

  /**
   * Склейка интервала в один файл — БЕЗ ffmpeg.
   *
   * Фрагментированный MP4 для того и придуман, чтобы склеиваться побайтово:
   * init (`ftyp`+`moov`), затем сегменты (`styp`+`moof`+`mdat`) по порядку.
   * Демуксер `concat` тут не работает в принципе — он открывает каждый файл
   * списка отдельно, а в `.m4s` без `moov` нет ни одного потока; на малине
   * лишний процесс ещё и заметно дороже простого чтения с диска.
   */
  router.get("/download", async (req, res) => {
    const r = parseRange(req.query as Record<string, unknown>);
    if (!r) return res.status(400).json({ ok: false, error: "cam, from and to are required (from < to)" });
    if (!known.has(r.cam)) return res.status(404).json({ ok: false, error: `unknown camera: ${r.cam}` });
    if (r.toMs - r.fromMs > cfg.downloadMaxMin * 60_000) {
      return res.status(413).json({ ok: false, error: `interval exceeds ${cfg.downloadMaxMin} minutes` });
    }

    const segs = db.segmentsBetween(r.cam, r.fromMs, r.toMs);
    if (segs.length === 0) return res.status(404).json({ ok: false, error: "nothing recorded in this interval" });

    // Разные init в интервале — это разные прогоны записи, у каждого свой
    // заголовок потока; такой диапазон побайтово не склеивается вообще. Отдать
    // «что получилось» нельзя: пользователь сохранит файл, который не откроется,
    // и узнает об этом сильно позже. На живой малине перезапуск записи случился
    // в первые же сутки — это не гипотетический случай.
    const initId = segs[0].initId;
    if (segs.some((s) => s.initId !== initId)) {
      return res.status(400).json({
        ok: false,
        error: "interval covers a recording restart: pick a range that does not span it",
      });
    }

    // Init без записи в индексе — рассогласование данных, а не ошибка запроса:
    // без заголовков потока склейка не откроется ни одним плеером.
    const init = db.initPathById(initId);
    if (!init) return res.status(500).json({ ok: false, error: "index inconsistency: init segment is missing" });

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", `attachment; filename="${downloadFileName(r.cam, r.fromMs)}"`);

    try {
      for (const relPath of [init.path, ...segs.map((s) => s.path)]) {
        // end: false — ответ закрываем сами, после последнего сегмента.
        await pipeline(deps.openRead(`${cfg.storageDir}/${relPath}`), res, { end: false });
      }
    } catch (e) {
      const msg = (e as Error)?.message ?? "unknown error";
      if (!res.headersSent && !res.destroyed) {
        // Ни байта ещё не ушло — можно ответить честной ошибкой. Заголовки
        // видео при этом надо снять, иначе браузер сохранит JSON под ".mp4".
        res.removeHeader("Content-Disposition");
        res.setHeader("Content-Type", "application/json");
        return res.status(500).json({ ok: false, error: `cannot read recording: ${msg}` });
      }
      // Часть файла уже у клиента. Аккуратно закрыть ответ здесь нельзя:
      // браузер счёл бы обрезанную склейку целой. Рвём соединение — незакрытая
      // загрузка видна пользователю как незакрытая.
      console.warn(`[cctv] download ${r.cam}: поток оборван — ${msg}`);
      res.destroy();
      return;
    }
    res.end();
  });

  return router;
}
