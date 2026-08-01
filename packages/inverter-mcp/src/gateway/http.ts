import { WebSocket } from "ws";
import type { ApiMeta, Baseline, ControlResponse, ControlType, Snapshot, TokenScope } from "@sweethome/inverter-shared";
import {
  ControlPreview,
  CSV_LIMIT_BYTES,
  EventsQuery,
  GatewayCapabilities,
  GatewayError,
  InverterGateway,
  SeriesQuery,
  SolarWindowResult,
  StatsGateway,
} from "./types";

export interface HttpGatewayOptions {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Подменяется в тестах; по умолчанию — ws. */
  webSocketImpl?: typeof WebSocket;
}

interface MeResponseShape {
  role: "admin" | "viewer";
  scopes: TokenScope[];
}

const RECONNECT_MS = 5000;

/** Клиент сервиса inverter-monitor поверх REST + WS под Bearer-токеном. */
class HttpGateway implements InverterGateway {
  readonly stats: StatsGateway | null;
  private fetchImpl: typeof fetch;
  private ws: WebSocket | null = null;
  private listeners = new Set<(s: Snapshot) => void>();
  private closed = false;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(
    private opts: HttpGatewayOptions,
    private caps: GatewayCapabilities
  ) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.stats = caps.statsEnabled ? this.buildStats() : null;
  }

  capabilities(): GatewayCapabilities {
    return this.caps;
  }

  private url(path: string): string {
    return new URL(path, this.opts.baseUrl).toString();
  }

  async request<T>(path: string, init?: RequestInit & { raw?: boolean }): Promise<T> {
    const timeout = this.opts.timeoutMs ?? 10_000;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout);
    let res: Response;
    try {
      res = await this.fetchImpl(this.url(path), {
        ...init,
        signal: ctl.signal,
        headers: {
          Authorization: `Bearer ${this.opts.token}`,
          ...(init?.body ? { "Content-Type": "application/json" } : {}),
          ...(init?.headers as Record<string, string> | undefined),
        },
      });
    } catch (e) {
      throw new GatewayError(
        `Inverter service at ${this.opts.baseUrl} is unreachable: ${(e as Error).message}. ` +
          `Check INVERTER_MCP_URL and that the service is running.`
      );
    } finally {
      clearTimeout(timer);
    }

    if (init?.raw) {
      const text = await res.text();
      if (!res.ok) throw new GatewayError(`HTTP ${res.status} for ${path}`, res.status);
      return text as unknown as T;
    }

    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      /* пустой ответ */
    }
    if (!res.ok) {
      const msg = (body as { error?: string } | null)?.error ?? `HTTP ${res.status}`;
      throw new GatewayError(msg, res.status);
    }
    return body as T;
  }

  snapshot(): Promise<Snapshot> {
    return this.request<Snapshot>("/api/snapshot");
  }

  meta(): Promise<ApiMeta> {
    return this.request<ApiMeta>("/api/meta");
  }

  baseline(): Promise<Baseline | null> {
    return this.request<Baseline | null>("/api/baseline");
  }

  control(type: ControlType, value: number): Promise<ControlResponse> {
    return this.request<ControlResponse>("/api/control", {
      method: "POST",
      body: JSON.stringify({ type, value }),
    });
  }

  async previewControl(type: ControlType, value: number): Promise<ControlPreview> {
    const r = await this.request<ControlPreview & { ok: boolean; preview: boolean }>("/api/control", {
      method: "POST",
      body: JSON.stringify({ type, value, preview: true }),
    });
    return {
      register: r.register,
      rawValue: r.rawValue,
      label: r.label,
      currentValue: r.currentValue,
      baselineValue: r.baselineValue,
    };
  }

  async setLock(locked: boolean): Promise<{ locked: boolean }> {
    const r = await this.request<{ ok: boolean; locked: boolean }>("/api/lock", {
      method: "POST",
      body: JSON.stringify({ locked }),
    });
    return { locked: r.locked };
  }

  async recaptureBaseline(): Promise<Baseline> {
    const r = await this.request<{ ok: boolean; baseline: Baseline }>("/api/baseline/recapture", {
      method: "POST",
      body: JSON.stringify({}),
    });
    return r.baseline;
  }

  async raw(command: string): Promise<string> {
    const r = await this.request<{ ok: boolean; reply: string }>("/api/raw", {
      method: "POST",
      body: JSON.stringify({ command }),
    });
    return r.reply;
  }

  private buildStats(): StatsGateway {
    const qs = (params: Record<string, string | number | undefined>): string =>
      new URLSearchParams(
        Object.entries(params)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => [k, String(v)])
      ).toString();

    return {
      series: (q: SeriesQuery) =>
        this.request(
          `/api/stats/series?${qs({ fields: q.fields.join(","), from: q.from, to: q.to, res: q.res })}`
        ),
      daily: (from: string, to: string) => this.request(`/api/stats/daily?${qs({ from, to })}`),
      energy: (from: number, to: number, bucket: "hour" | "day") =>
        this.request(`/api/stats/energy?${qs({ from, to, bucket })}`),
      events: (q: EventsQuery) =>
        this.request(
          `/api/stats/events?${qs({ from: q.from, to: q.to, type: q.type, limit: q.limit, offset: q.offset })}`
        ),
      solarWindow: (day?: string) => this.request<SolarWindowResult>(`/api/stats/solar-window?${qs({ day })}`),
      exportCsv: async (q) => {
        const csv = await this.request<string>(
          `/api/stats/export.csv?${qs({ from: q.from, to: q.to, res: q.res })}`,
          { raw: true }
        );
        return csv.length > CSV_LIMIT_BYTES
          ? { csv: csv.slice(0, CSV_LIMIT_BYTES), truncated: true }
          : { csv, truncated: false };
      },
    };
  }

  onSnapshot(cb: (s: Snapshot) => void): () => void {
    this.listeners.add(cb);
    this.ensureSocket();
    return () => {
      this.listeners.delete(cb);
      if (!this.listeners.size) this.dropSocket();
    };
  }

  private ensureSocket(): void {
    if (this.ws || this.closed) return;
    const Impl = this.opts.webSocketImpl ?? WebSocket;
    const url = this.url("/ws").replace(/^http/, "ws");
    const sock = new Impl(url, { headers: { Authorization: `Bearer ${this.opts.token}` } });
    this.ws = sock;

    sock.on("message", (data: Buffer | string) => {
      try {
        const msg = JSON.parse(String(data)) as { type: string; data: Snapshot };
        if (msg.type === "snapshot") for (const cb of this.listeners) cb(msg.data);
      } catch {
        /* мусор в сокете игнорируем */
      }
    });
    // Сервис на Pi перезапускается (деплой, рестарт systemd) — подписка должна пережить это.
    const retry = () => {
      this.ws = null;
      if (this.closed || !this.listeners.size) return;
      this.reconnectTimer = setTimeout(() => this.ensureSocket(), RECONNECT_MS);
    };
    sock.on("close", retry);
    sock.on("error", retry);
  }

  private dropSocket(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.ws?.removeAllListeners();
    this.ws?.close();
    this.ws = null;
  }

  close(): void {
    this.closed = true;
    this.listeners.clear();
    this.dropSocket();
  }
}

/** Создать шлюз и выяснить права токена (несколько запросов на старте). */
export async function createHttpGateway(opts: HttpGatewayOptions): Promise<InverterGateway> {
  const probe = new HttpGateway(opts, { role: "viewer", scopes: [], allowControl: false, statsEnabled: false });
  const me = await probe.request<MeResponseShape>("/api/me");
  const meta = await probe.meta();
  let statsEnabled = true;
  try {
    await probe.request("/api/stats/solar-window");
  } catch (e) {
    if (e instanceof GatewayError && e.status === 503) statsEnabled = false;
    else throw e;
  }
  probe.close();

  return new HttpGateway(opts, {
    role: me.role,
    scopes: me.scopes ?? [],
    allowControl: meta.allowControl,
    statsEnabled,
  });
}
