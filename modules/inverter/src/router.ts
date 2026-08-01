import express, { Router } from "express";
import {
  OUTPUT_SOURCE_PRIORITY,
  CHARGER_SOURCE_PRIORITY,
  ALLOWED_MAX_CHARGE_CURRENT,
  ALLOWED_MAX_AC_CHARGE_CURRENT,
  ControlType,
} from "@sweethome/inverter-shared";
import { writeSource, denyWithoutWrite, requireAdmin } from "@sweethome/shared/module";
import { Inverter } from "./inverter";
import { StatsRecorder } from "./stats/recorder";
import { GAUGE_FIELDS, GaugeField, localDay } from "./stats/db";
import type { InverterConfig } from "./config";

const CONTROL_TYPES: ControlType[] = [
  "outputSourcePriority",
  "chargerSourcePriority",
  "maxChargingCurrent",
  "maxAcChargingCurrent",
  "batteryRechargeVoltage",
  "batteryRedischargeVoltage",
];

export function createInverterRouter(deps: {
  inverter: Inverter;
  stats: StatsRecorder | null;
  cfg: InverterConfig;
}): Router {
  const { inverter, stats, cfg } = deps;
  const router = express.Router();
  // Admin-only зона модуля — тот же список путей, что был в server.ts, минус /api и минус users/tokens (они у хоста).
  router.use(["/control", "/lock", "/raw", "/baseline"], requireAdmin);

  router.get("/snapshot", (_req, res) => res.json(inverter.getSnapshot()));

  router.get("/meta", (req, res) => {
    const u = req.user!;
    res.json({
      session: { username: u.username, role: u.role, mustChangePassword: u.mustChangePassword },
      allowControl: cfg.allowControl,
      outputSourcePriority: OUTPUT_SOURCE_PRIORITY,
      chargerSourcePriority: CHARGER_SOURCE_PRIORITY,
      maxChargingCurrent: ALLOWED_MAX_CHARGE_CURRENT,
      maxAcChargingCurrent: ALLOWED_MAX_AC_CHARGE_CURRENT,
    });
  });

  router.post("/control", async (req, res) => {
    try {
      const { type, value, preview } = req.body ?? {};
      if (!CONTROL_TYPES.includes(type)) {
        return res.status(400).json({ ok: false, error: `Unknown control type: ${type}` });
      }
      const numValue = Number(value);
      if (!Number.isFinite(numValue)) {
        return res.status(400).json({ ok: false, error: "value must be a number" });
      }
      if (preview === true) {
        // Предпросмотр — это чтение: доступен и при включённой блокировке, и без скоупа write.
        const p = await inverter.previewControl(type as ControlType, numValue);
        return res.json({ ok: true, preview: true, ...p });
      }
      if (denyWithoutWrite(req, res)) return;
      const result = await inverter.control(type as ControlType, numValue, { source: writeSource(req) });
      res.json(result);
    } catch (e) {
      res.status(400).json({ ok: false, error: (e as Error).message });
    }
  });

  router.post("/lock", (req, res) => {
    try {
      if (denyWithoutWrite(req, res)) return;
      const { locked } = req.body ?? {};
      if (typeof locked !== "boolean") {
        return res.status(400).json({ ok: false, error: "locked must be a boolean" });
      }
      const result = inverter.setLock(locked);
      res.json({ ok: true, ...result });
    } catch (e) {
      res.status(400).json({ ok: false, error: (e as Error).message });
    }
  });

  router.get("/baseline", (_req, res) => res.json(inverter.getBaseline()));

  router.post("/baseline/recapture", async (req, res) => {
    try {
      if (denyWithoutWrite(req, res)) return;
      const baseline = await inverter.recaptureBaseline();
      res.json({ ok: true, baseline });
    } catch (e) {
      res.status(400).json({ ok: false, error: (e as Error).message });
    }
  });

  // ---- Статистика (SQLite). При недоступной БД — 503, мониторинг живёт. ----
  const parseTime = (v: unknown): number | null => {
    const s = String(v ?? "");
    if (!s) return null;
    const n = Number(s);
    if (Number.isFinite(n)) return n;
    const d = Date.parse(s);
    return Number.isFinite(d) ? d : null;
  };

  router.get("/stats/series", (req, res) => {
    try {
      if (!stats) return res.status(503).json({ ok: false, error: "stats unavailable" });
      const fields = String(req.query.fields ?? "").split(",").filter(Boolean);
      if (!fields.length || fields.some((f) => !(GAUGE_FIELDS as readonly string[]).includes(f))) {
        return res
          .status(400)
          .json({ ok: false, error: `fields: comma list of ${GAUGE_FIELDS.join(", ")}` });
      }
      const from = parseTime(req.query.from);
      const to = parseTime(req.query.to);
      if (from === null || to === null || to <= from) {
        return res.status(400).json({ ok: false, error: "bad from/to" });
      }
      const r = String(req.query.res ?? "auto");
      const eff: "raw" | "minute" =
        r === "raw" || r === "minute"
          ? (r as "raw" | "minute")
          : to - from <= 6 * 3_600_000
            ? "raw"
            : "minute";
      res.json(stats.db.querySeries(fields as GaugeField[], from, to, eff));
    } catch (e) {
      console.error("[inverter] stats query failed:", (e as Error).message);
      res.status(503).json({ ok: false, error: "stats unavailable" });
    }
  });

  router.get("/stats/daily", (req, res) => {
    try {
      if (!stats) return res.status(503).json({ ok: false, error: "stats unavailable" });
      const day = /^\d{4}-\d{2}-\d{2}$/;
      const from = String(req.query.from ?? "");
      const to = String(req.query.to ?? "");
      if (!day.test(from) || !day.test(to)) {
        return res.status(400).json({ ok: false, error: "from/to must be YYYY-MM-DD" });
      }
      res.json(stats.db.queryDaily(from, to));
    } catch (e) {
      console.error("[inverter] stats query failed:", (e as Error).message);
      res.status(503).json({ ok: false, error: "stats unavailable" });
    }
  });

  router.get("/stats/solar-window", (req, res) => {
    try {
      if (!stats) return res.status(503).json({ ok: false, error: "stats unavailable" });
      const dayRe = /^\d{4}-\d{2}-\d{2}$/;
      const now = Date.now();
      const today = localDay(now);
      const day = req.query.day ? String(req.query.day) : today;
      if (!dayRe.test(day)) {
        return res.status(400).json({ ok: false, error: "day must be YYYY-MM-DD" });
      }
      const win = stats.db.querySolarWindow(day, day === today ? now : undefined);
      res.json({ day, ...win });
    } catch (e) {
      console.error("[inverter] stats query failed:", (e as Error).message);
      res.status(503).json({ ok: false, error: "stats unavailable" });
    }
  });

  router.get("/stats/energy", (req, res) => {
    try {
      if (!stats) return res.status(503).json({ ok: false, error: "stats unavailable" });
      const from = parseTime(req.query.from);
      const to = parseTime(req.query.to);
      if (from === null || to === null || to <= from) {
        return res.status(400).json({ ok: false, error: "bad from/to" });
      }
      const bucket = req.query.bucket === "hour" ? ("hour" as const) : ("day" as const);
      res.json(stats.db.queryEnergy(from, to, bucket));
    } catch (e) {
      console.error("[inverter] stats query failed:", (e as Error).message);
      res.status(503).json({ ok: false, error: "stats unavailable" });
    }
  });

  router.get("/stats/events", (req, res) => {
    try {
      if (!stats) return res.status(503).json({ ok: false, error: "stats unavailable" });
      const from = parseTime(req.query.from) ?? undefined;
      const to = parseTime(req.query.to) ?? undefined;
      const type = req.query.type ? String(req.query.type) : undefined;
      const limit = Math.min(500, Math.max(1, Math.trunc(Number(req.query.limit) || 100)));
      const offset = Math.max(0, Math.trunc(Number(req.query.offset) || 0));
      res.json(stats.db.queryEvents({ from, to, type, limit, offset }));
    } catch (e) {
      console.error("[inverter] stats query failed:", (e as Error).message);
      res.status(503).json({ ok: false, error: "stats unavailable" });
    }
  });

  router.get("/stats/export.csv", (req, res) => {
    try {
      if (!stats) return res.status(503).json({ ok: false, error: "stats unavailable" });
      const from = parseTime(req.query.from);
      const to = parseTime(req.query.to);
      if (from === null || to === null || to <= from) {
        return res.status(400).json({ ok: false, error: "bad from/to" });
      }
      const kind = req.query.res === "minute" ? ("minute" as const) : ("raw" as const);
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="stats-${kind}-${from}-${to}.csv"`);
      const cols = stats.db.exportColumns(kind);
      res.write(cols.join(",") + "\n");
      // Значения — числа и имя режима (без запятых/кавычек), экранирование CSV не требуется.
      let after = from - 1;
      for (;;) {
        const chunk = stats.db.exportChunk(kind, after, to, 10_000);
        if (!chunk.length) break;
        res.write(chunk.map((r) => cols.map((c) => r[c] ?? "").join(",")).join("\n") + "\n");
        after = Number(chunk[chunk.length - 1].ts);
      }
      res.end();
    } catch (e) {
      console.error("[inverter] stats query failed:", (e as Error).message);
      if (!res.headersSent) {
        res.status(503).json({ ok: false, error: "stats unavailable" });
      } else {
        res.destroy();
      }
    }
  });

  router.post("/raw", async (req, res) => {
    try {
      const { command } = req.body ?? {};
      if (typeof command !== "string") {
        return res.status(400).json({ ok: false, error: "command must be a string" });
      }
      // Чтение (R) доступно любому токену; запись (W) — только со скоупом write.
      if (/^\s*W/i.test(command) && denyWithoutWrite(req, res)) return;
      const reply = await inverter.rawQuery(command, { source: writeSource(req) });
      res.json({ ok: true, command, reply });
    } catch (e) {
      res.status(400).json({ ok: false, error: (e as Error).message });
    }
  });

  return router;
}
