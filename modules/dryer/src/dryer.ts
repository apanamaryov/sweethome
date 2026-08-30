import type { DryerSnapshot, RunSnapshot, Sample, StartRunRequest } from "@sweethome/dryer-shared";
import type { ModuleHealth } from "@sweethome/shared/module";
import { decideAutostop, type AutostopDecision } from "./autostop";
import type { DryerConfig } from "./config";
import type { NodeLink } from "./node/link";
import { RunError, RunManager, type StartParams } from "./runs";
import type { DryerStore } from "./store";
import { fmtDuration, runTitle } from "./texts";
import type { Timers } from "./timers";
import { validateStartRequest } from "./validate";

export interface DryerDeps {
  cfg: DryerConfig;
  store: DryerStore;
  link: NodeLink;
  timers: Timers;
  now?: () => number;
  log?: (s: string) => void;
}

const IDLE_SAMPLE_MS = 5 * 60_000;
const PRUNE_EVERY_MS = 24 * 3600_000;
const KEEP_SAMPLES_MS = 365 * 24 * 3600_000;

/**
 * Тик раз в cfg.tickMs (спека §8): снапшот ноды → RunManager → замер → автостоп → чистка →
 * рассылка подписчикам WS. Всё состояние — в store и link; сам класс держит только таймер и
 * последнее решение автостопа для снапшота.
 */
export class Dryer {
  private readonly runs: RunManager;
  private readonly now: () => number;
  private readonly log: (s: string) => void;
  private handle: unknown = null;
  private lastIdleSample = 0;
  private lastPrune = 0;
  private lastAutostop: AutostopDecision | null = null;
  private readonly subs = new Set<(s: DryerSnapshot) => void>();

  constructor(private readonly d: DryerDeps) {
    this.now = d.now ?? (() => Date.now());
    this.log = d.log ?? ((s) => console.log(`[dryer] ${s}`));
    this.runs = new RunManager({ store: d.store, link: d.link, timers: d.timers, now: this.now });
  }

  start(): void {
    if (this.handle) return;
    const seeded = this.d.store.seedPresetsIfEmpty();
    if (seeded) this.log(`seeded ${seeded} presets`);
    this.d.link.start();
    // Сбой одного тика не должен убивать интервал (и с ним весь процесс — ModuleHost
    // изолирует только start()/stop()): логируем и ждём следующего срабатывания.
    this.handle = this.d.timers.setInterval(() => {
      try {
        this.tick();
      } catch (e) {
        this.log(`tick failed: ${(e as Error).message}`);
      }
    }, this.d.cfg.tickMs);
  }

  stop(): void {
    if (this.handle) this.d.timers.clearInterval(this.handle);
    this.handle = null;
    this.d.link.stop();
  }

  subscribe(cb: (s: DryerSnapshot) => void): () => void {
    this.subs.add(cb);
    return () => this.subs.delete(cb);
  }

  tick(now: number = this.now()): DryerSnapshot {
    const settings = this.d.store.getSettings();
    const view = this.d.link.view(now, settings.staleAfterSeconds * 1000);

    for (const e of this.runs.tick(now, view, settings)) {
      this.d.store.addEvent(now, e.kind, e.text, e.runId);
      this.log(`event ${e.kind}: ${e.text}`);
    }
    const run = this.d.store.currentRun();

    const active = view.online && view.state !== null && view.state !== "idle";
    if (view.online && (active || now - this.lastIdleSample >= IDLE_SAMPLE_MS)) {
      this.d.store.addSample(this.toSample(now, view, run?.id ?? null));
      if (!active) this.lastIdleSample = now;
    }

    this.lastAutostop = null;
    if (run) {
      const series = this.d.store.excessSeries(now - settings.autostop.holdMinutes * 60_000, now, run.id);
      const decision = decideAutostop(
        { state: view.online ? view.state : null, runStartedAt: run.startedAt, now, enabled: run.autostopEnabled, series },
        settings.autostop,
        settings.staleAfterSeconds
      );
      this.lastAutostop = decision;
      if (decision.stop) {
        this.d.link.sendRun("STOP");
        this.d.store.closeRun(run.id, now, "autostop");
        const text = `Сушка ${runTitle(run.presetName)} завершена автостопом за ${fmtDuration(now - run.startedAt)}`;
        this.d.store.addEvent(now, "run_done", text, run.id);
        this.log(text);
      }
    }

    if (now - this.lastPrune >= PRUNE_EVERY_MS) {
      const n = this.d.store.pruneSamples(now - KEEP_SAMPLES_MS);
      if (n) this.log(`pruned ${n} samples`);
      const ev = this.d.store.pruneEvents(now - KEEP_SAMPLES_MS);
      if (ev) this.log(`pruned ${ev} events`);
      this.lastPrune = now;
    }

    const snap = this.snapshot(now);
    // Исключение одного подписчика (например, ws.send на закрывающемся сокете) не
    // должно мешать остальным подписчикам получить снапшот, ни самому тику завершиться.
    for (const cb of this.subs) {
      try {
        cb(snap);
      } catch (e) {
        this.log(`subscriber failed: ${(e as Error).message}`);
      }
    }
    return snap;
  }

  private toSample(now: number, v: DryerSnapshot["node"], runId: number | null): Sample {
    return {
      ts: now,
      runId,
      chamberTemp: v.chamber.temp,
      chamberRh: v.chamber.rh,
      ambientTemp: v.ambient.temp,
      ambientRh: v.ambient.rh,
      plateTemp: v.plateTemp,
      excess: v.excess,
      heaterDuty: v.heaterDuty,
      exhaustDuty: v.exhaustDuty,
      exhaustRpm: v.exhaustRpm,
      state: v.state ?? "idle",
    };
  }

  snapshot(now: number = this.now()): DryerSnapshot {
    const settings = this.d.store.getSettings();
    const node = this.d.link.view(now, settings.staleAfterSeconds * 1000);
    const run = this.d.store.currentRun();
    let runSnap: RunSnapshot | null = null;
    if (run) {
      const autostop = this.lastAutostop ?? {
        enabled: run.autostopEnabled,
        belowSince: null,
        gaps: false,
        reason: run.autostopEnabled ? "автостоп: ждём первого тика" : "автостоп выключен — остановится по таймеру",
      };
      runSnap = { ...run, autostop: { enabled: autostop.enabled, belowSince: autostop.belowSince, gaps: autostop.gaps, reason: autostop.reason } };
    }
    return { now, node, run: runSnap, settings, events: this.d.store.unseenEvents() };
  }

  async startRun(req: StartRunRequest, startedBy: string): Promise<DryerSnapshot> {
    const settings = this.d.store.getSettings();
    let params: StartParams;
    if (req.presetId !== undefined) {
      const p = this.d.store.getPreset(req.presetId);
      if (!p) throw new RunError("preset_not_found", 404, "Пресет не найден");
      params = { setpoint: p.setpoint, maxMinutes: p.maxMinutes, autostop: p.autostop, presetName: p.name, startedBy };
    } else {
      // Единая точка проверки для REST и MCP: роутер валидирует тело сам, но MCP звал
      // startRun напрямую — и мог записать в сушку любой maxMinutes (спека §5, LIMITS).
      const v = validateStartRequest({ setpoint: req.setpoint, maxMinutes: req.maxMinutes, autostop: req.autostop });
      if (!v.ok) throw new RunError("invalid_request", 400, v.error);
      params = {
        setpoint: v.value.setpoint as number,
        maxMinutes: v.value.maxMinutes as number,
        autostop: v.value.autostop ?? true,
        presetName: null,
        startedBy,
      };
    }
    const run = await this.runs.start(params, settings);
    this.log(`run ${run.id} started by ${startedBy}: ${runTitle(run.presetName)} ${run.setpoint} °C, max ${run.maxMinutes} min`);
    return this.tick();
  }

  async stopRun(): Promise<DryerSnapshot> {
    const closed = await this.runs.stop();
    if (closed) this.log(`run ${closed.id} stopped`);
    return this.tick();
  }

  health(): ModuleHealth {
    const now = this.now();
    const settings = this.d.store.getSettings();
    const view = this.d.link.view(now, settings.staleAfterSeconds * 1000);
    const broker = this.d.link.connected();
    return {
      ok: broker && view.online,
      details: {
        enabled: true,
        transport: this.d.cfg.transport,
        broker,
        nodeOnline: view.online,
        lastSeen: view.updatedAt,
        state: view.state,
        run: this.d.store.currentRun()?.id ?? null,
      },
    };
  }
}
