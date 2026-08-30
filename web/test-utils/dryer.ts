import type { DryerSnapshot, NodeSnapshot, RunSnapshot } from "@sweethome/dryer-shared";
import { DEFAULT_SETTINGS } from "@sweethome/dryer-shared";

export const NOW = Date.UTC(2026, 7, 30, 12, 0, 0);

export function buildNode(over: Partial<NodeSnapshot> = {}): NodeSnapshot {
  return {
    online: true, updatedAt: NOW, state: "idle", stopReason: "command",
    chamber: { temp: 22.4, rh: 51 }, ambient: { temp: 22.1, rh: 50 }, plateTemp: 22.5, excess: 0.3,
    heaterDuty: 0, exhaustDuty: 0, exhaustRpm: 0, runElapsed: 0, setpoint: 60, maxMinutes: 840,
    ...over,
  };
}

export function buildRun(over: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    id: 7, startedAt: NOW - 3 * 3600_000 - 12 * 60_000, endedAt: null, presetName: "Яблоки", setpoint: 60, maxMinutes: 840,
    startedBy: "ui:alex", endReason: null, restarts: 0, autostopEnabled: true,
    autostop: { enabled: true, belowSince: null, gaps: false, reason: "избыток 6.2, ждём ниже 3" },
    ...over,
  };
}

export function buildDryerSnapshot(over: Partial<DryerSnapshot> = {}): DryerSnapshot {
  return { now: NOW, node: buildNode(), run: null, settings: DEFAULT_SETTINGS, events: [], ...over };
}
