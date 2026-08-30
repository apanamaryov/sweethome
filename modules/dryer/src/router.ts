import express, { Router, type Request, type Response } from "express";
import { denyWithoutWrite, requireAdmin, writeSource } from "@sweethome/shared/module";
import type { Dryer } from "./dryer";
import { RunError } from "./runs";
import type { DryerStore } from "./store";
import { validatePresetInput, validatePresetPatch, validateSettingsPatch, validateStartRequest } from "./validate";

export interface DryerRouterDeps {
  dryer: Dryer;
  store: DryerStore;
}

const badRequest = (res: Response, error: string) => res.status(400).json({ ok: false, error });

function intParam(v: string): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** RunError → её статус и код; всё прочее — 500 с текстом. */
function sendError(res: Response, e: unknown): void {
  if (e instanceof RunError) {
    res.status(e.status).json({ ok: false, code: e.code, error: e.message });
    return;
  }
  res.status(500).json({ ok: false, error: (e as Error).message });
}

/** Маршруты спеки §8. Смотреть — любая роль; менять — admin (+ скоуп write для токенов на старт/стоп). */
export function createDryerRouter(deps: DryerRouterDeps): Router {
  const { dryer, store } = deps;
  const router = express.Router();

  router.get("/state", (_req, res) => {
    res.json(dryer.snapshot());
  });

  // --- пресеты ---
  router.get("/presets", (_req, res) => {
    res.json({ presets: store.listPresets() });
  });

  router.post("/presets", requireAdmin, (req: Request, res: Response) => {
    const v = validatePresetInput(req.body);
    if (!v.ok) return badRequest(res, v.error);
    try {
      res.status(201).json({ ok: true, preset: store.createPreset(v.value) });
    } catch (e) {
      const msg = (e as Error).message;
      res.status(msg.includes("уже есть") ? 409 : 500).json({ ok: false, error: msg });
    }
  });

  router.put("/presets/:id", requireAdmin, (req, res) => {
    const id = intParam(req.params.id);
    if (id === null) return badRequest(res, "Некорректный id пресета");
    const v = validatePresetPatch(req.body);
    if (!v.ok) return badRequest(res, v.error);
    try {
      const preset = store.updatePreset(id, v.value);
      if (!preset) return res.status(404).json({ ok: false, error: "Пресет не найден" });
      res.json({ ok: true, preset });
    } catch (e) {
      const msg = (e as Error).message;
      res.status(msg.includes("уже есть") ? 409 : 500).json({ ok: false, error: msg });
    }
  });

  router.delete("/presets/:id", requireAdmin, (req, res) => {
    const id = intParam(req.params.id);
    if (id === null) return badRequest(res, "Некорректный id пресета");
    if (!store.deletePreset(id)) return res.status(404).json({ ok: false, error: "Пресет не найден" });
    res.json({ ok: true });
  });

  // --- сушки ---
  router.post("/runs", requireAdmin, async (req, res) => {
    if (denyWithoutWrite(req, res)) return;
    const v = validateStartRequest(req.body);
    if (!v.ok) return badRequest(res, v.error);
    try {
      res.json(await dryer.startRun(v.value, writeSource(req)));
    } catch (e) {
      sendError(res, e);
    }
  });

  router.post("/runs/current/stop", requireAdmin, async (req, res) => {
    if (denyWithoutWrite(req, res)) return;
    try {
      res.json(await dryer.stopRun());
    } catch (e) {
      sendError(res, e);
    }
  });

  router.get("/runs", (req, res) => {
    const from = Number(req.query.from);
    const to = Number(req.query.to);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
      return badRequest(res, "Нужны from и to в unix ms, from < to");
    }
    res.json({ runs: store.listRuns(from, to) });
  });

  router.get("/runs/:id/samples", (req, res) => {
    const id = intParam(req.params.id);
    if (id === null) return badRequest(res, "Некорректный id сушки");
    const run = store.getRun(id);
    if (!run) return res.status(404).json({ ok: false, error: "Сушка не найдена" });
    res.json({ run, samples: store.samplesForRun(id) });
  });

  // --- настройки ---
  router.get("/settings", (_req, res) => {
    res.json({ settings: store.getSettings() });
  });

  router.put("/settings", requireAdmin, (req, res) => {
    const v = validateSettingsPatch(req.body);
    if (!v.ok) return badRequest(res, v.error);
    res.json({ ok: true, settings: store.updateSettings(v.value) });
  });

  // --- события ---
  router.post("/events/:id/seen", (req, res) => {
    const id = intParam(req.params.id);
    if (id === null) return badRequest(res, "Некорректный id события");
    if (!store.markSeen(id)) return res.status(404).json({ ok: false, error: "Событие не найдено или уже прочитано" });
    res.json({ ok: true });
  });

  return router;
}
