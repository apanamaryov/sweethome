import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { localIso, parseTime, type McpSessionContext } from "@sweethome/home-mcp";
import { LIMITS, PRESET_GROUPS, type DryerSnapshot, type NodeState, type Run, type Sample } from "@sweethome/dryer-shared";
import type { Dryer } from "../dryer";
import type { DryerStore } from "../store";
import { endReasonText, faultText, fmtDuration, runTitle } from "../texts";
import { validatePresetInput } from "../validate";

/** Что агент должен знать до первого вызова. */
export const DRYER_INSTRUCTIONS =
  "Dryer: a food dehydrator (fruit, vegetables, herbs) controlled by an ESP32 node. Starting a run " +
  "switches on a 220 V heater for hours — always confirm with the person before dryer_start, and never " +
  "start while the node reports a fault: ask what happened first (dryer_stop clears the fault). " +
  "The key number is `excess` — humidity above what merely heated room air would have; it falls toward " +
  "zero as the food dries, and the service stops the run itself (autostop) when it stays below the " +
  "threshold. Temperatures are °C, times are unix ms unless a tool says otherwise.";

export interface DryerMcpDeps {
  dryer: Dryer;
  store: DryerStore;
  /** «Сейчас» для разбора относительных времён и текстов; в тестах — фальшивые часы. */
  now?: () => number;
}

const MAX_POINTS = 200;

const STATE_RU: Record<NodeState, string> = {
  idle: "простой",
  heating: "разогрев",
  drying: "сушка",
  cooldown: "остывание",
  fault: "ошибка",
};

async function guard(fn: () => Promise<{ structuredContent: Record<string, unknown>; text: string }>): Promise<CallToolResult> {
  try {
    const { structuredContent, text } = await fn();
    return { content: [{ type: "text", text }], structuredContent };
  } catch (e) {
    return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true };
  }
}

const f1 = (v: number | null) => (v === null ? "—" : String(Math.round(v * 10) / 10));

/** Одна строка о состоянии — для текста ответов start/stop/state. */
export function describeSnapshot(s: DryerSnapshot): string {
  const n = s.node;
  if (!n.online) return `Сушилка: нет связи${s.run ? `, сушка ${runTitle(s.run.presetName)} идёт автономно` : ""}`;
  const state = n.state ? STATE_RU[n.state] : "неизвестно";
  const parts = [`Сушилка: ${state}`];
  if (s.run) parts.push(`${runTitle(s.run.presetName)} ${s.run.setpoint} °C, идёт ${fmtDuration(s.now - s.run.startedAt)} из ${fmtDuration(s.run.maxMinutes * 60_000)}`);
  parts.push(`камера ${f1(n.chamber.temp)} °C / ${f1(n.chamber.rh)} %`, `избыток ${f1(n.excess)}`, `нагрев ${f1(n.heaterDuty)} %`, `вытяжка ${f1(n.exhaustDuty)} %`);
  if (n.state === "fault" && n.stopReason) parts.push(faultText(n.stopReason));
  if (s.run) parts.push(`автостоп: ${s.run.autostop.reason}`);
  return parts.join(" · ");
}

function describeRun(r: Run, now: number): string {
  const end = r.endedAt ?? now;
  return (
    `#${r.id} ${localIso(r.startedAt)} ${runTitle(r.presetName)} ${r.setpoint} °C, ${fmtDuration(end - r.startedAt)}, ` +
    (r.endReason ? endReasonText(r.endReason) : "идёт") +
    (r.restarts ? `, перезапусков: ${r.restarts}` : "") +
    `, запустил ${r.startedBy}`
  );
}

/** Равномерное прореживание до MAX_POINTS — агенту хватит формы кривой, контекст не раздуваем. */
export function thin<T>(rows: T[], max = MAX_POINTS): T[] {
  if (rows.length <= max) return rows;
  const step = rows.length / max;
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(rows[Math.floor(i * step)]);
  return out;
}

export function registerDryerTools(server: McpServer, deps: DryerMcpDeps & { ctx: McpSessionContext }): void {
  const { dryer, store, ctx } = deps;
  const now = deps.now ?? (() => Date.now());
  const canWrite = ctx.role === "admin" && ctx.scopes.includes("write");

  server.registerTool(
    "dryer_get_state",
    {
      title: "Dryer state",
      description:
        "Current state of the dryer: node online/state, chamber and room temperature/humidity, humidity excess, " +
        "heater and exhaust duty, the running batch (preset, elapsed, autostop status) and unread events.",
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async () =>
      guard(async () => {
        const s = dryer.snapshot();
        return { structuredContent: s as unknown as Record<string, unknown>, text: describeSnapshot(s) };
      })
  );

  server.registerTool(
    "dryer_list_presets",
    {
      title: "Dryer presets",
      description: "Presets (product → temperature, max duration, autostop) grouped as fruit / vegetable / other.",
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async () =>
      guard(async () => {
        const presets = store.listPresets();
        const text = PRESET_GROUPS.map(
          (g) =>
            `${g}:\n` +
            presets
              .filter((p) => p.group === g)
              .map((p) => `  ${p.name} — ${p.setpoint} °C, до ${fmtDuration(p.maxMinutes * 60_000)}${p.autostop ? "" : ", без автостопа"}`)
              .join("\n")
        ).join("\n");
        return { structuredContent: { presets }, text };
      })
  );

  server.registerTool(
    "dryer_get_runs",
    {
      title: "Drying runs",
      description: "Runs started within [from, to): when, preset, duration, how it ended, restarts. Times: unix ms, ISO 8601, 'now' or an offset like '-24h' / '-7d'.",
      inputSchema: { from: z.string().describe("start: unix ms, ISO, 'now' or offset like '-7d'"), to: z.string().describe("end, exclusive: same forms") },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ from, to }) =>
      guard(async () => {
        const fromMs = parseTime(from, now());
        const toMs = parseTime(to, now());
        if (toMs <= fromMs) throw new Error("`to` must be after `from`");
        const runs = store.listRuns(fromMs, toMs);
        return {
          structuredContent: { runs },
          text: runs.length ? runs.map((r) => describeRun(r, now())).join("\n") : "Сушек за период нет.",
        };
      })
  );

  server.registerTool(
    "dryer_get_run_chart",
    {
      title: "Run chart",
      description: "Samples of one run (chamber temperature, excess, heater/exhaust duty, state), thinned to at most 200 points.",
      inputSchema: { runId: z.number().int().positive() },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ runId }) =>
      guard(async () => {
        const run = store.getRun(runId);
        if (!run) throw new Error(`run #${runId} not found`);
        const all = store.samplesForRun(runId);
        const points = thin(all).map((s: Sample) => ({
          ts: s.ts, chamberTemp: s.chamberTemp, excess: s.excess, heaterDuty: s.heaterDuty, exhaustDuty: s.exhaustDuty, plateTemp: s.plateTemp, state: s.state,
        }));
        const firstDrying = all.find((s) => s.state === "drying");
        const text =
          `${describeRun(run, now())}\n${points.length} точек из ${all.length}` +
          (firstDrying ? `; разогрев ${fmtDuration(firstDrying.ts - run.startedAt)}` : "") +
          (all.length ? `; избыток ${f1(all[0].excess)} → ${f1(all[all.length - 1].excess)}` : "");
        return { structuredContent: { run, points }, text };
      })
  );

  if (!canWrite) return;

  server.registerTool(
    "dryer_start",
    {
      title: "Start drying",
      description:
        "Start a run by preset name, or with explicit setpoint (°C) and maxHours. Switches on the heater — confirm with the person first. " +
        "Fails if a run is already going, the node is in fault (call dryer_stop to clear it), cooling down or offline.",
      inputSchema: {
        preset: z.string().optional().describe("preset name, e.g. 'Яблоки'"),
        setpoint: z.number().min(LIMITS.setpoint.min).max(LIMITS.setpoint.max).optional(),
        maxHours: z.number().positive().optional(),
        autostop: z.boolean().optional(),
      },
      annotations: { destructiveHint: true },
    },
    async ({ preset, setpoint, maxHours, autostop }) =>
      guard(async () => {
        let snap: DryerSnapshot;
        if (preset !== undefined) {
          const p = store.listPresets().find((x) => x.name.toLowerCase() === preset.toLowerCase());
          if (!p) throw new Error(`Пресет не найден: ${preset}`);
          snap = await dryer.startRun({ presetId: p.id }, ctx.source);
        } else {
          if (setpoint === undefined || maxHours === undefined) throw new Error("Укажи preset либо setpoint и maxHours");
          snap = await dryer.startRun({ setpoint, maxMinutes: Math.round(maxHours * 60), autostop }, ctx.source);
        }
        return { structuredContent: snap as unknown as Record<string, unknown>, text: describeSnapshot(snap) };
      })
  );

  server.registerTool(
    "dryer_stop",
    {
      title: "Stop drying",
      description: "Stop the current run (also clears a fault). The node keeps the fans on until the plate cools.",
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    async () =>
      guard(async () => {
        const snap = await dryer.stopRun();
        return { structuredContent: snap as unknown as Record<string, unknown>, text: describeSnapshot(snap) };
      })
  );

  server.registerTool(
    "dryer_upsert_preset",
    {
      title: "Create or update preset",
      description: "Create a preset or update the one with the same name. Groups: fruit, vegetable, other.",
      inputSchema: {
        name: z.string().min(1),
        group: z.enum(["fruit", "vegetable", "other"]),
        setpoint: z.number(),
        maxHours: z.number().positive(),
        autostop: z.boolean().optional(),
      },
      annotations: { idempotentHint: true },
    },
    async ({ name, group, setpoint, maxHours, autostop }) =>
      guard(async () => {
        const v = validatePresetInput({ name, group, setpoint, maxMinutes: Math.round(maxHours * 60), autostop: autostop ?? true });
        if (!v.ok) throw new Error(v.error);
        const existing = store.listPresets().find((p) => p.name === v.value.name);
        const preset = existing ? store.updatePreset(existing.id, v.value)! : store.createPreset(v.value);
        return { structuredContent: { preset }, text: `${existing ? "Обновлён" : "Создан"} пресет ${preset.name}: ${preset.setpoint} °C, до ${fmtDuration(preset.maxMinutes * 60_000)}` };
      })
  );
}
