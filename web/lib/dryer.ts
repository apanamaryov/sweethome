import type uPlot from "uplot";
import type {
  DryerSettings, DryerSnapshot, EndReason, NodeSnapshot, Preset, PresetInput, Run, Sample, SettingsPatch, StartRunRequest,
} from "@sweethome/dryer-shared";
import { redirectToLogin, sendJson } from "@/lib/api";
import type { Dict } from "@/lib/i18n/dict";

export type { DryerSnapshot, Preset, Run, Sample };

/** Ответ модуля: не-2xx несёт `error` по-русски, готовый к показу (спека §8) — пробрасываем как есть. */
async function unwrap<T>(res: Response): Promise<T> {
  if (res.ok) return (await res.json()) as T;
  let msg = `HTTP ${res.status}`;
  try {
    const b = await res.json();
    if (typeof b?.error === "string") msg = b.error;
  } catch {}
  throw new Error(msg);
}

/** GET простым fetch(path), без объекта опций (в отличие от sendJson) — 401 обрабатываем так же. */
async function getRaw(path: string): Promise<Response> {
  const res = await fetch(path);
  if (res.status === 401) {
    redirectToLogin();
    throw new Error("Unauthorized");
  }
  return res;
}

export const fetchDryerState = async () => unwrap<DryerSnapshot>(await sendJson("GET", "/api/dryer/state"));
export const fetchPresets = async () => (await unwrap<{ presets: Preset[] }>(await getRaw("/api/dryer/presets"))).presets;
export const startRun = async (req: StartRunRequest) => unwrap<DryerSnapshot>(await sendJson("POST", "/api/dryer/runs", req));
export const stopRun = async () => unwrap<DryerSnapshot>(await sendJson("POST", "/api/dryer/runs/current/stop"));
export const fetchRuns = async (fromMs: number, toMs: number) =>
  (await unwrap<{ runs: Run[] }>(await sendJson("GET", `/api/dryer/runs?from=${fromMs}&to=${toMs}`))).runs;
export const fetchRunSamples = async (runId: number) =>
  unwrap<{ run: Run; samples: Sample[] }>(await sendJson("GET", `/api/dryer/runs/${runId}/samples`));
export const fetchSettings = async () => (await unwrap<{ settings: DryerSettings }>(await getRaw("/api/dryer/settings"))).settings;
export const saveSettings = async (patch: SettingsPatch) =>
  (await unwrap<{ settings: DryerSettings }>(await sendJson("PUT", "/api/dryer/settings", patch))).settings;
export const createPreset = async (p: PresetInput) => (await unwrap<{ preset: Preset }>(await sendJson("POST", "/api/dryer/presets", p))).preset;
export const updatePreset = async (id: number, patch: Partial<PresetInput>) =>
  (await unwrap<{ preset: Preset }>(await sendJson("PUT", `/api/dryer/presets/${id}`, patch))).preset;
export const deletePreset = async (id: number) => {
  await unwrap<unknown>(await sendJson("DELETE", `/api/dryer/presets/${id}`));
};
export const markEventSeen = async (id: number) => {
  await unwrap<unknown>(await sendJson("POST", `/api/dryer/events/${id}/seen`));
};

/** Нет связи перекрывает любое состояние (спека §9). */
export function stateLabel(t: Dict, node: Pick<NodeSnapshot, "online" | "state">): string {
  if (!node.online || node.state === null) return t.dryerStateOffline;
  switch (node.state) {
    case "idle": return t.dryerStateIdle;
    case "heating": return t.dryerStateHeating;
    case "drying": return t.dryerStateDrying;
    case "cooldown": return t.dryerStateCooldown;
    case "fault": return t.dryerStateFault;
  }
}

export function stateTone(node: Pick<NodeSnapshot, "online" | "state">): "ok" | "amber" | "bad" | "muted" {
  if (!node.online || node.state === null || node.state === "fault") return "bad";
  if (node.state === "heating" || node.state === "cooldown") return "amber";
  if (node.state === "drying") return "ok";
  return "muted";
}

export function faultLabel(t: Dict, reason: string | null): string {
  const code = reason?.startsWith("fault:") ? reason.slice(6) : reason;
  switch (code) {
    case "plate_overheat": return t.dryerFaultPlateOverheat;
    case "overheat": return t.dryerFaultOverheat;
    case "sensor": return t.dryerFaultSensor;
    case "heater": return t.dryerFaultHeater;
    case "exhaust": return t.dryerFaultExhaust;
    case "node_reboot_loop": return t.dryerFaultRebootLoop;
    case null: case undefined: return t.dryerFaultUnknown;
    default: return `${t.dryerFaultUnknown}: ${code}`;
  }
}

export function endReasonLabel(t: Dict, reason: EndReason | null): string {
  if (reason === null) return t.dryerEndRunning;
  switch (reason) {
    case "autostop": return t.dryerEndAutostop;
    case "stopped": return t.dryerEndStopped;
    case "timeout": return t.dryerEndTimeout;
    case "node_lost": return t.dryerEndLost;
    default: return `${t.dryerEndFault}: ${faultLabel(t, reason)}`;
  }
}

/** «3:12» — часы:минуты, без секунд. */
export function fmtHm(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000));
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
}

/** Ряды для TimeChart: [сек, камера, уставка, избыток, нагрев %]. null не превращается в ноль. */
export function chartData(samples: Sample[], setpoint: number): uPlot.AlignedData {
  return [
    samples.map((s) => Math.round(s.ts / 1000)),
    samples.map((s) => s.chamberTemp),
    samples.map(() => setpoint),
    samples.map((s) => s.excess),
    samples.map((s) => s.heaterDuty),
  ];
}
