/** Состояние ноды — text_sensor `dryer/text_sensor/state/state` (спека §5). */
export type NodeState = "idle" | "heating" | "drying" | "cooldown" | "fault";
export const NODE_STATES: readonly NodeState[] = ["idle", "heating", "drying", "cooldown", "fault"];

export type FaultCode = "plate_overheat" | "overheat" | "sensor" | "heater" | "exhaust";
/** Почему нода остановилась последний раз — `dryer/text_sensor/stop_reason/state`. */
export type StopReason = "command" | "button" | "timeout" | `fault:${FaultCode}`;

export type PresetGroup = "fruit" | "vegetable" | "other";
export const PRESET_GROUPS: readonly PresetGroup[] = ["fruit", "vegetable", "other"];

export interface Preset {
  id: number;
  name: string;
  group: PresetGroup;
  setpoint: number;      // °C
  maxMinutes: number;
  autostop: boolean;
  sort: number;
}
export type PresetInput = Omit<Preset, "id" | "sort">;

/** Чем закончилась сушка. `fault:node_reboot_loop` ставит сам модуль (§8), остальные fault:* — от ноды. */
export type EndReason = "autostop" | "stopped" | "timeout" | "node_lost" | `fault:${string}`;

export interface Run {
  id: number;
  startedAt: number;            // unix ms
  endedAt: number | null;
  presetName: string | null;    // null — свои параметры или кнопка
  setpoint: number;
  maxMinutes: number;
  /** 'ui:alex' | 'token:laptop' | 'mcp:laptop' | 'button' | 'recovered' (сушка шла, когда сервис поднялся). */
  startedBy: string;
  endReason: EndReason | null;
  restarts: number;
  autostopEnabled: boolean;
}

export interface Sample {
  ts: number;
  runId: number | null;
  chamberTemp: number | null;
  chamberRh: number | null;
  ambientTemp: number | null;
  ambientRh: number | null;
  plateTemp: number | null;
  excess: number | null;
  heaterDuty: number | null;
  exhaustDuty: number | null;
  exhaustRpm: number | null;
  state: NodeState;
}

export type EventKind =
  | "run_done"
  | "run_timeout"
  | "run_fault"
  | "run_lost"
  | "run_restarted"
  | "node_offline"
  | "node_online";

export interface DryerEvent {
  id: number;
  ts: number;
  runId: number | null;
  kind: EventKind;
  text: string;   // по-русски, готов к показу
  seen: boolean;
}

export interface AutostopSettings {
  excessThreshold: number;  // пункты %RH
  holdMinutes: number;
  minRunMinutes: number;
}

export interface DryerSettings {
  autostop: AutostopSettings;
  exhaustMin: number;        // %
  exhaustGain: number;       // %/пункт
  staleAfterSeconds: number;
}

export interface SettingsPatch {
  autostop?: Partial<AutostopSettings>;
  exhaustMin?: number;
  exhaustGain?: number;
  staleAfterSeconds?: number;
}

export const DEFAULT_SETTINGS: DryerSettings = {
  autostop: { excessThreshold: 3, holdMinutes: 30, minRunMinutes: 60 },
  exhaustMin: 25,
  exhaustGain: 4,
  staleAfterSeconds: 60,
};

/** Допустимые диапазоны (спека §5, §8). Единый источник для валидации сервера и подсказок в UI. */
export const LIMITS = {
  setpoint: { min: 35, max: 75 },
  maxMinutes: { min: 30, max: 2880 },
  excessThreshold: { min: 0.5, max: 15 },
  holdMinutes: { min: 5, max: 180 },
  minRunMinutes: { min: 0, max: 600 },
  exhaustMin: { min: 20, max: 100 },
  exhaustGain: { min: 0, max: 20 },
  staleAfterSeconds: { min: 30, max: 300 },
} as const;

export interface NodeSnapshot {
  online: boolean;
  /** Когда нода в последний раз что-то присылала; null — никогда. */
  updatedAt: number | null;
  state: NodeState | null;
  stopReason: StopReason | null;
  chamber: { temp: number | null; rh: number | null };
  ambient: { temp: number | null; rh: number | null };
  plateTemp: number | null;
  excess: number | null;
  heaterDuty: number | null;
  exhaustDuty: number | null;
  exhaustRpm: number | null;
  runElapsed: number | null;   // секунд, 0 если стоит
  setpoint: number | null;     // что нода реально использует
  maxMinutes: number | null;
}

export interface AutostopStatus {
  enabled: boolean;
  /** С какого момента избыток непрерывно ниже порога; null — сейчас выше или данных нет. */
  belowSince: number | null;
  /** В окне удержания есть дыры — автостоп ждёт непрерывных данных. */
  gaps: boolean;
  reason: string;
}

export interface RunSnapshot extends Run {
  autostop: AutostopStatus;
}

export interface DryerSnapshot {
  now: number;
  node: NodeSnapshot;
  run: RunSnapshot | null;
  settings: DryerSettings;
  /** Непрочитанные события. */
  events: DryerEvent[];
}

export interface StartRunRequest {
  presetId?: number;
  setpoint?: number;
  maxMinutes?: number;
  autostop?: boolean;
}
