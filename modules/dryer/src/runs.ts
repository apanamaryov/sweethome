import type { DryerSettings, EndReason, EventKind, NodeSnapshot, NodeState, Run } from "@sweethome/dryer-shared";
import type { NodeCfg, NodeLink } from "./node/link";
import type { DryerStore } from "./store";
import { faultText, fmtDuration, runTitle } from "./texts";
import type { Timers } from "./timers";

export type RunErrorCode =
  | "node_offline"
  | "already_running"
  | "fault_active"
  | "node_busy"
  | "node_unresponsive"
  | "preset_not_found"; // ставит Dryer.startRun (Task 10), сюда — чтобы роутер знал один класс ошибок

export class RunError extends Error {
  constructor(
    public readonly code: RunErrorCode,
    public readonly status: number,
    message: string
  ) {
    super(message);
  }
}

export interface StartParams {
  setpoint: number;
  maxMinutes: number;
  autostop: boolean;
  presetName: string | null;
  startedBy: string;
}

export interface RunEvent {
  kind: EventKind;
  text: string;
  runId: number | null;
}

export interface RunManagerDeps {
  store: DryerStore;
  link: NodeLink;
  timers: Timers;
  now: () => number;
  /** Сколько раз переотправлять START после перезагрузки ноды (спека §8: 3). */
  maxRestarts?: number;
  startTimeoutMs?: number;
  pollMs?: number;
}

const ACTIVE: ReadonlySet<NodeState> = new Set(["heating", "drying"]);
const OFFLINE_EVENT_MS = 2 * 60_000;
const LOST_GRACE_MS = 15 * 60_000;
const DEFAULT_SETPOINT = 60;
const DEFAULT_MAX_MINUTES = 720;

/**
 * Жизненный цикл сушки (спека §8): старт/стоп по команде, запуск кнопкой, самостоятельная
 * остановка ноды, перезапуск после сброса, потеря ноды. Никаких таймеров внутри — всё
 * решается на tick() по снапшоту ноды; единственное ожидание — в start(), и оно через
 * инъектированные таймеры.
 */
export class RunManager {
  private prev: { state: NodeState | null; uptime: number | null; online: boolean } = { state: null, uptime: null, online: false };
  /** Мы сами отправили START и ждём heating — переход не считать кнопкой. */
  private pendingStart: number | null = null;
  private offlineSince: number | null = null;
  private offlineAnnounced = false;
  private readonly maxRestarts: number;
  private readonly startTimeoutMs: number;
  private readonly pollMs: number;

  constructor(private readonly d: RunManagerDeps) {
    this.maxRestarts = d.maxRestarts ?? 3;
    this.startTimeoutMs = d.startTimeoutMs ?? 5000;
    this.pollMs = d.pollMs ?? 200;
  }

  nodeCfg(run: { setpoint: number; maxMinutes: number }, settings: DryerSettings): NodeCfg {
    return { setpoint: run.setpoint, maxMinutes: run.maxMinutes, exhaustMin: settings.exhaustMin, exhaustGain: settings.exhaustGain };
  }

  async start(p: StartParams, settings: DryerSettings): Promise<Run> {
    const staleMs = settings.staleAfterSeconds * 1000;
    const view = this.d.link.view(this.d.now(), staleMs);
    if (!view.online) throw new RunError("node_offline", 503, "Нет связи с сушилкой");
    if (this.d.store.currentRun()) throw new RunError("already_running", 409, "Сушка уже идёт");
    if (view.state === "fault") throw new RunError("fault_active", 409, "Сушилка в ошибке — сначала сбрось её");
    if (view.state !== "idle") throw new RunError(view.state && ACTIVE.has(view.state) ? "already_running" : "node_busy", 409,
      view.state && ACTIVE.has(view.state) ? "Сушка уже идёт" : "Сушилка ещё остывает");

    this.d.link.publishCfg(this.nodeCfg(p, settings)); // cfg — ДО команды
    this.d.link.sendRun("START");
    const startedAt = this.d.now();
    this.pendingStart = startedAt;
    const ok = await this.waitFor(() => {
      const s = this.d.link.view(this.d.now(), staleMs).state;
      return s !== null && ACTIVE.has(s);
    });
    if (!ok) {
      this.pendingStart = null;
      throw new RunError("node_unresponsive", 504, "Сушилка не ответила на команду");
    }
    return this.d.store.openRun({
      startedAt,
      presetName: p.presetName,
      setpoint: p.setpoint,
      maxMinutes: p.maxMinutes,
      startedBy: p.startedBy,
      autostopEnabled: p.autostop,
    });
  }

  /** Стоп и одновременно сброс ошибки. Возвращает закрытую запись, если она была. */
  async stop(): Promise<Run | null> {
    this.d.link.sendRun("STOP");
    const run = this.d.store.currentRun();
    if (run) this.d.store.closeRun(run.id, this.d.now(), "stopped");
    return run;
  }

  private waitFor(cond: () => boolean): Promise<boolean> {
    const deadline = this.d.now() + this.startTimeoutMs;
    return new Promise((resolve) => {
      const poll = () => {
        if (cond()) return resolve(true);
        if (this.d.now() >= deadline) return resolve(false);
        this.d.timers.setTimeout(poll, this.pollMs);
      };
      poll();
    });
  }

  tick(now: number, view: NodeSnapshot, settings: DryerSettings): RunEvent[] {
    const events: RunEvent[] = [];
    let run = this.d.store.currentRun();
    // Гонка с реальной нодой: start()/afterReboot() опрашивают view() раз в pollMs и видят
    // ACTIVE раньше, чем их продолжение доходит до store.openRun(); если tick() вклинится в
    // этот же промежуток, pendingStart ниже уже обнулится — запоминаем «было» до обнуления.
    const wasPending = this.pendingStart !== null;

    // --- связь ---
    if (!view.online) {
      if (this.offlineSince === null) this.offlineSince = now;
      if (!this.offlineAnnounced && now - this.offlineSince >= OFFLINE_EVENT_MS) {
        this.offlineAnnounced = true;
        events.push({ kind: "node_offline", text: "Нет связи с сушилкой", runId: run?.id ?? null });
      }
      // Нода досушивает сама; закрываем только когда её таймер уже точно сработал.
      if (run && now > run.startedAt + run.maxMinutes * 60_000 + LOST_GRACE_MS) {
        this.d.store.closeRun(run.id, now, "node_lost");
        events.push({ kind: "run_lost", text: `Связь с сушилкой потеряна, сушка ${runTitle(run.presetName)} закрыта`, runId: run.id });
        run = null;
      }
      this.prev = { state: this.prev.state, uptime: this.prev.uptime, online: false };
      return events;
    }
    if (this.offlineAnnounced) events.push({ kind: "node_online", text: "Связь с сушилкой восстановлена", runId: null });
    this.offlineSince = null;
    this.offlineAnnounced = false;

    // --- перезагрузка ноды ---
    const uptime = this.d.link.uptime();
    const rebooted = this.prev.uptime !== null && uptime !== null && uptime < this.prev.uptime;
    const state = view.state;

    if (this.pendingStart !== null && ((state !== null && ACTIVE.has(state)) || now - this.pendingStart > 10_000)) {
      this.pendingStart = null;
    }

    if (run) {
      if (rebooted && state !== null && !ACTIVE.has(state)) {
        events.push(...this.afterReboot(run, now, settings));
      } else if (state !== null && !ACTIVE.has(state) && this.prev.state !== null && ACTIVE.has(this.prev.state) && this.pendingStart === null) {
        events.push(...this.closeBecauseNodeStopped(run, view, now));
      }
    } else if (state !== null && ACTIVE.has(state) && this.pendingStart === null && !wasPending) {
      // Сушка идёт, а записи нет: кнопка на корпусе (prev был idle/cooldown) либо сервис
      // поднялся посреди сушки (prev неизвестен) — тогда начало восстанавливаем из run_elapsed.
      const fromButton = this.prev.state !== null && !ACTIVE.has(this.prev.state);
      const elapsedMs = (view.runElapsed ?? 0) * 1000;
      this.d.store.openRun({
        startedAt: fromButton ? now : now - elapsedMs,
        presetName: null,
        setpoint: view.setpoint ?? DEFAULT_SETPOINT,
        maxMinutes: view.maxMinutes ?? DEFAULT_MAX_MINUTES,
        startedBy: fromButton ? "button" : "recovered",
        autostopEnabled: true,
      });
    }

    this.prev = { state, uptime, online: true };
    return events;
  }

  private afterReboot(run: Run, now: number, settings: DryerSettings): RunEvent[] {
    const title = runTitle(run.presetName);
    if (now - run.startedAt >= run.maxMinutes * 60_000) {
      this.d.store.closeRun(run.id, now, "timeout");
      return [{ kind: "run_timeout", text: `Сушка ${title} остановлена по таймеру (${fmtDuration(run.maxMinutes * 60_000)})`, runId: run.id }];
    }
    if (run.restarts >= this.maxRestarts) {
      this.d.store.closeRun(run.id, now, "fault:node_reboot_loop");
      return [{ kind: "run_fault", text: `Сушка ${title} прервана: ${faultText("fault:node_reboot_loop")}`, runId: run.id }];
    }
    this.d.link.publishCfg(this.nodeCfg(run, settings));
    this.d.link.sendRun("START");
    this.pendingStart = now;
    const n = this.d.store.bumpRestarts(run.id);
    return [{ kind: "run_restarted", text: `Нода перезагрузилась — сушка ${title} перезапущена (${n})`, runId: run.id }];
  }

  private closeBecauseNodeStopped(run: Run, view: NodeSnapshot, now: number): RunEvent[] {
    const title = runTitle(run.presetName);
    const reason = view.stopReason ?? "command";
    if (reason === "timeout") {
      this.d.store.closeRun(run.id, now, "timeout");
      return [{ kind: "run_timeout", text: `Сушка ${title} остановлена по таймеру (${fmtDuration(run.maxMinutes * 60_000)})`, runId: run.id }];
    }
    if (reason.startsWith("fault:")) {
      this.d.store.closeRun(run.id, now, reason as EndReason);
      return [{ kind: "run_fault", text: `Сушка ${title} прервана: ${faultText(reason)}`, runId: run.id }];
    }
    // button или command от кого-то ещё — просто остановлена, событие не нужно.
    this.d.store.closeRun(run.id, now, "stopped");
    return [];
  }
}
