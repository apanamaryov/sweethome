import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpContext } from "../server";
import { parseDay, parseTime } from "../time";
import { downsample } from "../downsample";
import { guard } from "./read";

/** Величины, доступные в /api/stats/series (совпадает с GAUGE_FIELDS сервера). */
const GAUGE_FIELDS = [
  "pvPower",
  "acOutputActivePower",
  "mainsPower",
  "batteryPower",
  "batteryVoltage",
  "batteryCapacity",
  "gridVoltage",
  "outputLoadPercent",
  "dcdcTemperature",
  "heatSinkTemperature",
] as const;

const SIX_HOURS_MS = 6 * 3_600_000;
const WH_IN_KWH = 1000;

const timeArg = z.union([z.string(), z.number()]);

export function registerStatsTools(server: McpServer, ctx: McpContext): void {
  const stats = ctx.gateway.stats;
  if (!stats) return; // статистика выключена — инструментов просто нет

  server.registerTool(
    "get_series",
    {
      title: "Time series",
      description:
        'Historical series for one or more metrics. Time accepts unix ms, ISO 8601, "now" or an offset like "-24h". ' +
        "Resolution defaults to raw for windows up to 6 hours and per-minute averages beyond that.",
      inputSchema: {
        fields: z.array(z.enum(GAUGE_FIELDS)).min(1).describe("Metrics to fetch"),
        from: timeArg.describe('Window start, e.g. "-24h"'),
        to: timeArg.default("now").describe('Window end, e.g. "now"'),
        res: z.enum(["auto", "raw", "minute"]).default("auto").describe("Sample resolution"),
        maxPoints: z.number().int().min(2).max(5000).default(500).describe("Cap on returned points"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ fields, from, to, res, maxPoints }) =>
      guard(async () => {
        const now = Date.now();
        const f = parseTime(from, now);
        const t = parseTime(to ?? "now", now);
        if (t <= f) throw new Error("`to` must be later than `from`");
        const effective = res && res !== "auto" ? res : t - f <= SIX_HOURS_MS ? "raw" : "minute";
        const rows = await stats.series({ fields: [...fields], from: f, to: t, res: effective });
        const d = downsample(rows, maxPoints ?? 500);
        const text =
          `${d.rows.length} point(s) of ${fields.join(", ")} at ${effective} resolution` +
          (d.downsampled ? ` (downsampled from ${d.sourcePoints})` : "");
        return {
          structuredContent: {
            from: f,
            to: t,
            res: effective,
            fields: [...fields],
            downsampled: d.downsampled,
            sourcePoints: d.sourcePoints,
            points: d.rows,
          },
          text,
        };
      })
  );

  server.registerTool(
    "get_daily",
    {
      title: "Daily totals",
      description:
        'Per-day energy totals, SOC range and solar window. Days accept YYYY-MM-DD, "today", "yesterday" or "-7d".',
      inputSchema: {
        from: z.string().describe('First day, e.g. "-7d"'),
        to: z.string().default("today").describe("Last day"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ from, to }) =>
      guard(async () => {
        const now = Date.now();
        const rows = await stats.daily(parseDay(from, now), parseDay(to ?? "today", now));
        return {
          structuredContent: { days: rows, count: rows.length },
          text: rows.length ? `${rows.length} day(s) of totals.` : "No data for that range.",
        };
      })
  );

  server.registerTool(
    "get_energy",
    {
      title: "Energy buckets",
      description:
        "Energy in watt-hours bucketed by hour or day: PV generated, load consumed, taken from the grid, battery charge/discharge.",
      inputSchema: {
        from: timeArg.describe("Window start"),
        to: timeArg.default("now").describe("Window end"),
        bucket: z.enum(["hour", "day"]).default("day").describe("Bucket size"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ from, to, bucket }) =>
      guard(async () => {
        const now = Date.now();
        const f = parseTime(from, now);
        const t = parseTime(to ?? "now", now);
        if (t <= f) throw new Error("`to` must be later than `from`");
        const buckets = await stats.energy(f, t, bucket ?? "day");
        const pv = buckets.reduce((a, b) => a + (b.pv_wh ?? 0), 0);
        return {
          structuredContent: { from: f, to: t, bucket: bucket ?? "day", buckets },
          text: `${buckets.length} bucket(s); PV total ${(pv / WH_IN_KWH).toFixed(2)} kWh.`,
        };
      })
  );

  server.registerTool(
    "get_events",
    {
      title: "Event log",
      description: "Event log: mode changes, grid loss and restore, faults, connectivity and control writes.",
      inputSchema: {
        from: timeArg.optional().describe("Window start"),
        to: timeArg.optional().describe("Window end"),
        type: z.string().optional().describe('Filter by event type, e.g. "control" or "mode-change"'),
        limit: z.number().int().min(1).max(500).default(100),
        offset: z.number().int().min(0).default(0),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ from, to, type, limit, offset }) =>
      guard(async () => {
        const now = Date.now();
        const lim = limit ?? 100;
        const rows = await stats.events({
          from: from === undefined ? undefined : parseTime(from, now),
          to: to === undefined ? undefined : parseTime(to, now),
          type,
          limit: lim,
          offset: offset ?? 0,
        });
        const truncated = rows.length === lim;
        return {
          structuredContent: { events: rows, count: rows.length, truncated },
          text:
            `${rows.length} event(s)` +
            (truncated ? " — the limit was reached, raise `limit` or page with `offset` for more." : "."),
        };
      })
  );

  server.registerTool(
    "get_solar_window",
    {
      title: "Solar day window",
      description: "When stable PV output started and stopped on a given day; today's window may still be in progress.",
      inputSchema: { day: z.string().default("today").describe('YYYY-MM-DD, "today", "yesterday" or "-3d"') },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ day }) =>
      guard(async () => {
        const w = await stats.solarWindow(parseDay(day ?? "today", Date.now()));
        const hhmm = (ms: number | null) => (ms === null ? "—" : new Date(ms).toLocaleTimeString());
        const text =
          w.state === "idle"
            ? `${w.day}: no stable solar output.`
            : w.state === "active"
              ? `${w.day}: solar running since ${hhmm(w.start)}.`
              : `${w.day}: solar ${hhmm(w.start)} – ${hhmm(w.end)}.`;
        return { structuredContent: { ...w }, text };
      })
  );

  server.registerTool(
    "summarize_period",
    {
      title: "Period summary",
      description:
        "One-call summary of a period: PV generated, load consumed, taken from the grid, battery charge/discharge, " +
        "SOC range and alarm events.",
      inputSchema: {
        from: timeArg.default("-1d").describe("Window start"),
        to: timeArg.default("now").describe("Window end"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ from, to }) =>
      guard(async () => {
        const now = Date.now();
        const f = parseTime(from ?? "-1d", now);
        const t = parseTime(to ?? "now", now);
        if (t <= f) throw new Error("`to` must be later than `from`");

        const [days, events] = await Promise.all([
          stats.daily(parseDay(fromDay(f), now), parseDay(fromDay(t), now)),
          stats.events({ from: f, to: t, limit: 500, offset: 0 }),
        ]);

        const sum = (key: string) => days.reduce((a, d) => a + (Number(d[key]) || 0), 0);
        const socValues = days
          .flatMap((d) => [d.batteryCapacity_min, d.batteryCapacity_max])
          .map(Number)
          .filter((n) => Number.isFinite(n));
        const alarms = events.filter((e) => e.type.startsWith("fault") || e.type.startsWith("warning"));

        const summary = {
          from: f,
          to: t,
          days: days.length,
          pvKwh: sum("pv_wh") / WH_IN_KWH,
          loadKwh: sum("load_wh") / WH_IN_KWH,
          gridKwh: sum("grid_wh") / WH_IN_KWH,
          batteryChargedKwh: sum("batt_charge_wh") / WH_IN_KWH,
          batteryDischargedKwh: sum("batt_discharge_wh") / WH_IN_KWH,
          socMin: socValues.length ? Math.min(...socValues) : null,
          socMax: socValues.length ? Math.max(...socValues) : null,
          eventCount: events.length,
          alarmCount: alarms.length,
          alarmTypes: [...new Set(alarms.map((a) => a.type))],
        };
        const text =
          `${summary.days} day(s): PV ${summary.pvKwh.toFixed(2)} kWh, load ${summary.loadKwh.toFixed(2)} kWh, ` +
          `grid ${summary.gridKwh.toFixed(2)} kWh, battery +${summary.batteryChargedKwh.toFixed(2)}/` +
          `-${summary.batteryDischargedKwh.toFixed(2)} kWh, SOC ${summary.socMin ?? "?"}–${summary.socMax ?? "?"}%, ` +
          `${summary.alarmCount} alarm event(s).`;
        return { structuredContent: summary, text };
      })
  );

  server.registerTool(
    "export_csv",
    {
      title: "Export CSV",
      description:
        "Prepare a CSV export of raw or per-minute samples. Returns a resource link — read that resource to get the " +
        "file, so the data does not land in the conversation unless you ask for it.",
      inputSchema: {
        from: timeArg.describe("Window start"),
        to: timeArg.default("now").describe("Window end"),
        res: z.enum(["raw", "minute"]).default("minute").describe("Sample resolution"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ from, to, res }): Promise<CallToolResult> => {
      try {
        const now = Date.now();
        const f = parseTime(from, now);
        const t = parseTime(to ?? "now", now);
        if (t <= f) throw new Error("`to` must be later than `from`");
        const kind = res ?? "minute";
        const uri = `inverter://stats/export/${kind}/${f}/${t}.csv`;
        return {
          content: [
            { type: "text", text: `CSV export ready at ${uri} — read that resource to fetch it.` },
            { type: "resource_link", uri, name: `stats-${kind}-${f}-${t}.csv`, mimeType: "text/csv" },
          ],
          structuredContent: { uri, from: f, to: t, res: kind },
        };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );
}

/** Локальный день по метке времени — границы окна для суточной сводки. */
function fromDay(ms: number): string {
  const d = new Date(ms);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
