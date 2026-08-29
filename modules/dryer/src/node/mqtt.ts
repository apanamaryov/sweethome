import { NODE_STATES, type NodeSnapshot, type NodeState, type StopReason } from "@sweethome/dryer-shared";
import { emptyNodeSnapshot, type NodeCfg, type NodeLink } from "./link";

/** Ровно то, что мы зовём у mqtt.js — тест подсовывает подделку, боевой код — настоящий клиент. */
export interface MqttClientLike {
  on(event: "connect", cb: () => void): unknown;
  on(event: "message", cb: (topic: string, payload: Buffer) => void): unknown;
  on(event: "error", cb: (e: Error) => void): unknown;
  on(event: "close" | "offline", cb: () => void): unknown;
  subscribe(topic: string, opts: { qos: 0 | 1 | 2 }): unknown;
  publish(topic: string, payload: string, opts: { qos: 0 | 1 | 2; retain: boolean }): unknown;
  end(force?: boolean): unknown;
}

export type MqttConnect = (
  url: string,
  opts: { username?: string; password?: string; reconnectPeriod: number }
) => MqttClientLike;

export interface MqttNodeLinkOptions {
  url: string;
  user: string | null;
  pass: string | null;
  prefix: string;
  connect: MqttConnect;
  now: () => number;
  log?: (msg: string) => void;
}

const TOPIC_RE = /^(sensor|text_sensor|binary_sensor)\/([a-z0-9_]+)\/state$/;

/** Подписка на `<prefix>/#`, последние значения по ключам, публикация cfg/cmd (спека §5). */
export class MqttNodeLink implements NodeLink {
  private client: MqttClientLike | null = null;
  private isConnected = false;
  private status: "online" | "offline" | null = null;
  private lastMsgAt: number | null = null;
  private readonly num = new Map<string, number>();
  private readonly text = new Map<string, string>();
  private readonly log: (msg: string) => void;

  constructor(private readonly o: MqttNodeLinkOptions) {
    this.log = o.log ?? ((m) => console.log(`[dryer] ${m}`));
  }

  start(): void {
    if (this.client) return;
    const c = this.o.connect(this.o.url, {
      username: this.o.user ?? undefined,
      password: this.o.pass ?? undefined,
      reconnectPeriod: 5000,
    });
    this.client = c;
    c.on("connect", () => {
      this.isConnected = true;
      c.subscribe(`${this.o.prefix}/#`, { qos: 1 });
      this.log(`MQTT connected to ${this.o.url}`);
    });
    c.on("close", () => (this.isConnected = false));
    c.on("offline", () => (this.isConnected = false));
    c.on("error", (e) => this.log(`MQTT error: ${e.message}`));
    c.on("message", (topic, payload) => this.handle(topic, payload.toString()));
  }

  stop(): void {
    this.client?.end(true);
    this.client = null;
    this.isConnected = false;
  }

  connected(): boolean {
    return this.isConnected;
  }

  private handle(topic: string, raw: string): void {
    const pre = `${this.o.prefix}/`;
    if (!topic.startsWith(pre)) return;
    const rest = topic.slice(pre.length);
    const s = raw.trim();
    if (rest === "status") {
      this.status = s === "online" ? "online" : "offline";
      this.lastMsgAt = this.o.now();
      return;
    }
    const m = TOPIC_RE.exec(rest);
    if (!m) return;
    const [, kind, key] = m;
    this.lastMsgAt = this.o.now();
    if (kind === "sensor") {
      const v = Number(s);
      // ESPHome шлёт "nan" для отсутствующего значения — это null, не ноль.
      if (Number.isFinite(v)) this.num.set(key, v);
      else this.num.delete(key);
    } else if (kind === "text_sensor") {
      this.text.set(key, s);
    }
    // binary_sensor heater/circulation в снапшот не входят (спека §8) — не храним.
  }

  private n(key: string): number | null {
    return this.num.get(key) ?? null;
  }

  view(now: number, staleAfterMs: number): NodeSnapshot {
    const fresh = this.lastMsgAt !== null && now - this.lastMsgAt <= staleAfterMs;
    const stateRaw = this.text.get("state");
    const state = stateRaw && (NODE_STATES as readonly string[]).includes(stateRaw) ? (stateRaw as NodeState) : null;
    const reason = this.text.get("stop_reason");
    return {
      ...emptyNodeSnapshot(),
      online: this.status === "online" && fresh,
      updatedAt: this.lastMsgAt,
      state,
      stopReason: reason ? (reason as StopReason) : null,
      chamber: { temp: this.n("chamber_temperature"), rh: this.n("chamber_humidity") },
      ambient: { temp: this.n("ambient_temperature"), rh: this.n("ambient_humidity") },
      plateTemp: this.n("plate_temperature"),
      excess: this.n("humidity_excess"),
      heaterDuty: this.n("heater_duty"),
      exhaustDuty: this.n("exhaust_duty"),
      exhaustRpm: this.n("exhaust_rpm"),
      runElapsed: this.n("run_elapsed"),
      setpoint: this.n("setpoint"),
      maxMinutes: this.n("max_minutes"),
    };
  }

  uptime(): number | null {
    return this.n("uptime");
  }

  private pub(topic: string, payload: string, retain: boolean): void {
    this.client?.publish(`${this.o.prefix}/${topic}`, payload, { qos: 1, retain });
  }

  /** Порядок важен: cfg уходит ДО START (спека §8), retained — нода кэширует во флеш. */
  publishCfg(cfg: NodeCfg): void {
    this.pub("cfg/setpoint", String(cfg.setpoint), true);
    this.pub("cfg/max_minutes", String(cfg.maxMinutes), true);
    this.pub("cfg/exhaust_min", String(cfg.exhaustMin), true);
    this.pub("cfg/exhaust_gain", String(cfg.exhaustGain), true);
  }

  /** Не retained намеренно: устаревший START не должен запускать нагрев после перезагрузки ноды. */
  sendRun(cmd: "START" | "STOP"): void {
    this.pub("cmd/run", cmd, false);
  }
}
