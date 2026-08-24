import express, { Router } from "express";
import type { CameraInfo, StorageInfo, TimelineResponse } from "@sweethome/cctv-shared";
import type { CctvConfig } from "./config";
import type { CctvDb } from "./index/db";
import { buildConcatList, concatArgs, downloadFileName } from "./download";
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

export function createCctvRouter(deps: {
  cfg: CctvConfig;
  db: CctvDb;
  manager: { cameras(): CameraInfo[]; storageAvailable(): boolean };
  sendFile: SendFile;
  spawn: (cmd: string, args: string[]) => { stdout: { pipe(dest: unknown): void } | null; on(ev: "exit", cb: (code: number | null) => void): void; kill(sig?: string): void };
  tmpFile: (content: string) => Promise<{ path: string; cleanup: () => Promise<void> }>;
}): Router {
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

  router.get("/download", async (req, res) => {
    const r = parseRange(req.query as Record<string, unknown>);
    if (!r) return res.status(400).json({ ok: false, error: "cam, from and to are required (from < to)" });
    if (!known.has(r.cam)) return res.status(404).json({ ok: false, error: `unknown camera: ${r.cam}` });
    if (r.toMs - r.fromMs > cfg.downloadMaxMin * 60_000) {
      return res.status(413).json({ ok: false, error: `interval exceeds ${cfg.downloadMaxMin} minutes` });
    }

    const segs = db.segmentsBetween(r.cam, r.fromMs, r.toMs);
    if (segs.length === 0) return res.status(404).json({ ok: false, error: "nothing recorded in this interval" });

    const init = db.initPathById(segs[0].initId);
    const list = buildConcatList(segs, cfg.storageDir, init?.path);
    const tmp = await deps.tmpFile(list);
    const child = deps.spawn(cfg.ffmpegPath, concatArgs({ listPath: tmp.path }));

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", `attachment; filename="${downloadFileName(r.cam, r.fromMs)}"`);
    child.stdout?.pipe(res);
    child.on("exit", () => void tmp.cleanup());
    // Клиент ушёл — незачем держать ffmpeg и греть Wi-Fi.
    res.on("close", () => child.kill("SIGTERM"));
  });

  return router;
}
