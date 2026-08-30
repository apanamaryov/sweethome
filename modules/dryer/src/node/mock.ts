import type { FaultCode, NodeSnapshot, NodeState, StopReason } from "@sweethome/dryer-shared";
import type { Timers } from "../timers";
import { emptyNodeSnapshot, type NodeCfg, type NodeLink } from "./link";

export interface MockOptions {
  now: () => number;
  timers: Timers;
  ambient?: { temp: number; rh: number };
  /** Период шага физики при start(); по умолчанию 1 с. */
  stepMs?: number;
  /** За сколько избыток падает в e раз; в бою ~3 ч, в тестах — секунды. */
  excessTauMs?: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Симулятор ноды с той же границей NodeLink: тепловая модель первого порядка, автомат
 * состояний как в прошивке (§7) и ручки для тестов (кнопка, сброс, ошибка, offline).
 * Времена ускорены: до уставки доходит за минуты, а не за полчаса — это стенд для веба,
 * а не цифровой двойник.
 */
export class MockNodeLink implements NodeLink {
  private cfg: NodeCfg = { setpoint: 60, maxMinutes: 720, exhaustMin: 25, exhaustGain: 4 };
  private state: NodeState = "idle";
  private stopReason: StopReason = "command";
  private readonly ambient: { temp: number; rh: number };
  private chamberT: number;
  private plateT: number;
  private heaterDuty = 0;
  private exhaustDuty = 0;
  private integral = 0;
  private runStartedAt: number | null = null;
  private reached = false;
  private bootAt: number;
  private offline = false;
  private handle: unknown = null;
  private readonly tau: number;

  constructor(private readonly o: MockOptions) {
    this.ambient = o.ambient ?? { temp: 22, rh: 50 };
    this.chamberT = this.ambient.temp;
    this.plateT = this.ambient.temp;
    this.bootAt = o.now();
    this.tau = o.excessTauMs ?? 3 * 3600_000;
  }

  start(): void {
    if (this.handle) return;
    const ms = this.o.stepMs ?? 1000;
    this.handle = this.o.timers.setInterval(() => this.step(ms), ms);
  }

  stop(): void {
    if (this.handle) this.o.timers.clearInterval(this.handle);
    this.handle = null;
  }

  connected(): boolean {
    return true;
  }

  publishCfg(cfg: NodeCfg): void {
    this.cfg = { ...cfg };
  }

  sendRun(cmd: "START" | "STOP"): void {
    if (cmd === "START") {
      if (this.state === "idle") this.begin();
    } else if (this.state === "heating" || this.state === "drying") {
      this.end("command");
    } else if (this.state === "fault") {
      this.state = "cooldown";
    }
  }

  private begin(): void {
    this.state = "heating";
    this.runStartedAt = this.o.now();
    this.reached = false;
    this.integral = 0;
    // выходы пересчитываются в step(): без этого view() сразу после START видит heaterDuty = 0
    this.step(0);
  }

  private end(reason: StopReason): void {
    this.stopReason = reason;
    this.state = reason.startsWith("fault:") ? "fault" : "cooldown";
    this.runStartedAt = null;
    this.heaterDuty = 0;
    // то же: вытяжка 50 % на остывании должна быть видна сразу после STOP
    this.step(0);
  }

  private active(): boolean {
    return this.state === "heating" || this.state === "drying";
  }

  private elapsedSec(): number {
    return this.runStartedAt === null ? 0 : Math.floor((this.o.now() - this.runStartedAt) / 1000);
  }

  private excess(): number {
    if (!this.active()) return 0;
    return 30 * Math.exp(-(this.o.now() - (this.runStartedAt ?? this.o.now())) / this.tau);
  }

  /** Один шаг физики и автомата. Публичный — тесты крутят его руками. */
  step(dtMs: number): void {
    const dt = dtMs / 1000;
    if (this.active()) {
      // ПИ-регулятор вместо PID: П даёт 100 % при недогреве ≥ 4 °C, И (только вблизи уставки,
      // чтобы не накапливаться за разогрев) убирает статическую ошибку — иначе камера зависла бы
      // на 58–59 °C и никогда не перешла в drying.
      const err = this.cfg.setpoint - this.chamberT;
      if (Math.abs(err) < 5) this.integral = clamp(this.integral + err * dt * 0.5, 0, 60);
      else if (err <= -5) this.integral = 0;
      this.heaterDuty = clamp(err * 25 + this.integral, 0, 100);
      this.exhaustDuty = clamp(this.cfg.exhaustMin + this.excess() * this.cfg.exhaustGain, this.cfg.exhaustMin, 100);
      // Приоритет температуры (§7): нагрев в упоре и недогрев ≥ 2 °C — вытяжка прижимается к минимуму.
      if (this.heaterDuty >= 100 && this.chamberT < this.cfg.setpoint - 2) this.exhaustDuty = this.cfg.exhaustMin;
    } else {
      this.heaterDuty = 0;
      this.exhaustDuty = this.state === "cooldown" || this.state === "fault" ? 50 : 0;
    }
    const circulation = this.active() || this.state === "cooldown" || this.state === "fault";
    this.plateT += dt * ((this.heaterDuty / 100) * 0.5 - (this.plateT - this.chamberT) * 0.02);
    const mix = circulation ? 0.01 : 0.002;
    const vent = 0.002 * (1 + this.exhaustDuty / 50);
    this.chamberT += dt * ((this.plateT - this.chamberT) * mix - (this.chamberT - this.ambient.temp) * vent);

    if (this.state === "heating" && this.chamberT >= this.cfg.setpoint - 0.5) {
      this.state = "drying";
      this.reached = true;
    }
    if (this.active() && this.elapsedSec() >= this.cfg.maxMinutes * 60) this.end("timeout");
    // dt > 0: нулевой шаг из begin()/end() не должен сразу схлопывать cooldown → idle на холодной пластине.
    if (this.state === "cooldown" && dt > 0 && this.plateT < 50) this.state = "idle";
  }

  view(now: number, _staleAfterMs: number): NodeSnapshot {
    const chamberRh = this.active() ? clamp(7 + this.excess(), 0, 100) : this.ambient.rh;
    return {
      ...emptyNodeSnapshot(),
      online: !this.offline,
      updatedAt: now,
      state: this.state,
      stopReason: this.stopReason,
      chamber: { temp: this.chamberT, rh: chamberRh },
      ambient: { ...this.ambient },
      plateTemp: this.plateT,
      excess: this.excess(),
      heaterDuty: Math.round(this.heaterDuty),
      exhaustDuty: Math.round(this.exhaustDuty),
      exhaustRpm: this.exhaustDuty > 0 ? Math.round(900 + 18 * this.exhaustDuty) : 0,
      runElapsed: this.elapsedSec(),
      setpoint: this.cfg.setpoint,
      maxMinutes: this.cfg.maxMinutes,
    };
  }

  uptime(): number | null {
    return Math.floor((this.o.now() - this.bootAt) / 1000);
  }

  // --- ручки для тестов и npm run dev ---

  pressButton(): void {
    if (this.state === "idle") this.begin();
    else if (this.state === "fault") this.state = "cooldown";
    else if (this.active()) this.end("button");
  }

  simulateFault(code: FaultCode): void {
    this.end(`fault:${code}`);
  }

  /** Питание моргнуло: idle, выходы выкл, uptime с нуля, stop_reason прежний (retained в брокере). */
  simulateReboot(): void {
    this.state = "idle";
    this.runStartedAt = null;
    this.heaterDuty = 0;
    this.exhaustDuty = 0;
    this.bootAt = this.o.now();
  }

  setOffline(v: boolean): void {
    this.offline = v;
  }
}
