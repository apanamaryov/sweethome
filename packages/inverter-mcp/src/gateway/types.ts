import type {
  ApiMeta,
  Baseline,
  ControlResponse,
  ControlType,
  Role,
  Snapshot,
  TokenScope,
} from "@sweethome/inverter-shared";

/** Что инструментам разрешено — считается один раз при старте сервера MCP. */
export interface GatewayCapabilities {
  role: Role;
  scopes: TokenScope[];
  allowControl: boolean;
  statsEnabled: boolean;
}

export interface SeriesQuery {
  fields: string[];
  from: number;
  to: number;
  res: "raw" | "minute";
}

export interface EventsQuery {
  from?: number;
  to?: number;
  type?: string;
  limit: number;
  offset: number;
}

export interface SolarWindowResult {
  day: string;
  start: number | null;
  end: number | null;
  state: "idle" | "active" | "ended";
}

export interface ControlPreview {
  register: number;
  rawValue: number;
  label: string;
  currentValue: number | null;
  baselineValue: number | null;
}

export interface StatsGateway {
  series(q: SeriesQuery): Promise<Array<Record<string, number | null>>>;
  daily(from: string, to: string): Promise<Array<Record<string, unknown>>>;
  energy(from: number, to: number, bucket: "hour" | "day"): Promise<Array<Record<string, number>>>;
  events(q: EventsQuery): Promise<Array<{ id: number; ts: number; type: string; detail: string }>>;
  solarWindow(day?: string): Promise<SolarWindowResult>;
  /** Жёсткий предел CSV_LIMIT_BYTES: агенту нельзя вываливать гигабайты. */
  exportCsv(q: { from: number; to: number; res: "raw" | "minute" }): Promise<{ csv: string; truncated: boolean }>;
}

/** Единственная граница между ядром MCP и сервисом. */
export interface InverterGateway {
  snapshot(): Promise<Snapshot>;
  meta(): Promise<ApiMeta>;
  baseline(): Promise<Baseline | null>;
  control(type: ControlType, value: number): Promise<ControlResponse>;
  previewControl(type: ControlType, value: number): Promise<ControlPreview>;
  setLock(locked: boolean): Promise<{ locked: boolean }>;
  recaptureBaseline(): Promise<Baseline>;
  raw(command: string): Promise<string>;
  stats: StatsGateway | null;
  /** Подписка на снапшоты; возвращает отписку. */
  onSnapshot(cb: (s: Snapshot) => void): () => void;
  capabilities(): GatewayCapabilities;
  close(): void;
}

/** Ошибка обращения к сервису — инструменты превращают её в isError-ответ. */
export class GatewayError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

/** Предел размера CSV-выгрузки. */
export const CSV_LIMIT_BYTES = 5 * 1024 * 1024;
