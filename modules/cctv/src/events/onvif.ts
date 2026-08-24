import type { CameraConfig } from "../config";
import type { CctvDb } from "../index/db";
import type { Timers } from "../recorder/process";

export type SoapPost = (url: string, body: string, action?: string) => Promise<string>;

/** Топик движения у этих камер (объявлен в GetEventProperties). */
export const MOTION_TOPIC = "tns1:VideoSource/MotionAlarm";

const NS = 'xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:tev="http://www.onvif.org/ver10/events/wsdl"';
const PULL_ACTION = "http://www.onvif.org/ver10/events/wsdl/PullPointSubscription/PullMessagesRequest";

export function soapEnvelope(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><s:Envelope ${NS}><s:Body>${body}</s:Body></s:Envelope>`;
}

export function subscriptionAddress(xml: string): string | null {
  const m = /<(?:\w+:)?Address[^>]*>([^<]+)</.exec(xml);
  return m ? m[1].trim() : null;
}

export function parseNotifications(
  xml: string
): { topic: string; state: string | null; tsMs: number | null }[] {
  const out: { topic: string; state: string | null; tsMs: number | null }[] = [];
  const blocks = xml.match(/<(?:\w+:)?NotificationMessage[\s\S]*?<\/(?:\w+:)?NotificationMessage>/g);
  if (!blocks) return out;

  for (const blk of blocks) {
    const topic = /<(?:\w+:)?Topic[^>]*>([^<]+)</.exec(blk);
    const state = /<(?:\w+:)?SimpleItem\s+Name="State"\s+Value="([^"]+)"/.exec(blk);
    const time = /UtcTime="([^"]+)"/.exec(blk);
    const tsMs = time ? Date.parse(time[1]) : NaN;
    out.push({
      topic: topic ? topic[1].trim() : "",
      state: state ? state[1] : null,
      tsMs: Number.isFinite(tsMs) ? tsMs : null,
    });
  }
  return out;
}

/** Пауза между циклами опроса при обычной работе и после ошибки. */
const PULL_GAP_MS = 500;
const ERROR_GAP_MS = 30_000;

/**
 * Подписка на события камеры и метки движения в индексе.
 *
 * Камеры объявляют MotionAlarm, но на момент проектирования ни одного такого
 * события получить не удалось (спека §10, §20). Поэтому наблюдатель полностью
 * необязателен: его отказ никак не влияет ни на запись, ни на просмотр.
 */
export class MotionWatcher {
  private pullUrl: string | null = null;
  private stopped = false;
  private timer: unknown = null;
  private events = 0;
  private lastError: string | undefined;

  constructor(
    private deps: {
      cam: CameraConfig;
      db: CctvDb;
      post: SoapPost;
      timers: Timers;
      now?: () => number;
    }
  ) {}

  state(): { subscribed: boolean; events: number; lastError?: string } {
    return { subscribed: this.pullUrl !== null, events: this.events, lastError: this.lastError };
  }

  start(): void {
    this.stopped = false;
    void this.loop();
  }

  /** Один проход: подписка (если нужна) + один опрос. Отдельный метод ради тестов. */
  async startOnce(): Promise<void> {
    try {
      if (this.pullUrl === null) await this.subscribe();
      if (this.pullUrl !== null) await this.pullOnce();
    } catch (e) {
      this.lastError = (e as Error).message;
      this.pullUrl = null;
    }
  }

  private async loop(): Promise<void> {
    if (this.stopped) return;
    await this.startOnce();
    if (this.stopped) return;
    const gap = this.pullUrl === null ? ERROR_GAP_MS : PULL_GAP_MS;
    this.timer = this.deps.timers.setTimeout(() => void this.loop(), gap);
  }

  private async subscribe(): Promise<void> {
    const url = `http://${this.deps.cam.host}:8899/onvif/event_service`;
    const xml = await this.deps.post(
      url,
      soapEnvelope("<tev:CreatePullPointSubscription><tev:InitialTerminationTime>PT300S</tev:InitialTerminationTime></tev:CreatePullPointSubscription>")
    );
    this.pullUrl = subscriptionAddress(xml);
    if (this.pullUrl === null) this.lastError = "camera did not return a subscription address";
  }

  private async pullOnce(): Promise<void> {
    const xml = await this.deps.post(
      this.pullUrl!,
      soapEnvelope("<tev:PullMessages><tev:Timeout>PT20S</tev:Timeout><tev:MessageLimit>20</tev:MessageLimit></tev:PullMessages>"),
      PULL_ACTION
    );
    const now = this.deps.now ?? (() => Date.now());
    for (const n of parseNotifications(xml)) {
      if (n.topic !== MOTION_TOPIC) continue;
      if (n.state !== "true") continue; // false — окончание движения, метка не нужна
      this.deps.db.addMotion(this.deps.cam.id, n.tsMs ?? now(), "motion");
      this.events++;
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) this.deps.timers.clearTimeout(this.timer);
    this.timer = null;
    this.pullUrl = null;
  }
}
