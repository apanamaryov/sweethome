import type { NodeSnapshot } from "@sweethome/dryer-shared";

/** Что модуль публикует ноде в `cfg/*` перед стартом (спека §5). */
export interface NodeCfg {
  setpoint: number;
  maxMinutes: number;
  exhaustMin: number;
  exhaustGain: number;
}

/**
 * Граница между модулем и нодой. Две реализации: MqttNodeLink (живая нода через брокер)
 * и MockNodeLink (симулятор для npm run dev и тестов). Модуль опрашивает view() на каждом
 * тике — никаких колбэков, так проще рассуждать о порядке событий.
 */
export interface NodeLink {
  start(): void;
  stop(): void;
  /** Связь с брокером (у симулятора всегда true). */
  connected(): boolean;
  view(now: number, staleAfterMs: number): NodeSnapshot;
  /** Секунд с загрузки ноды по последнему сообщению; null — не знаем. */
  uptime(): number | null;
  publishCfg(cfg: NodeCfg): void;
  sendRun(cmd: "START" | "STOP"): void;
}

export function emptyNodeSnapshot(): NodeSnapshot {
  return {
    online: false,
    updatedAt: null,
    state: null,
    stopReason: null,
    chamber: { temp: null, rh: null },
    ambient: { temp: null, rh: null },
    plateTemp: null,
    excess: null,
    heaterDuty: null,
    exhaustDuty: null,
    exhaustRpm: null,
    runElapsed: null,
    setpoint: null,
    maxMinutes: null,
  };
}
