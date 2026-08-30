import { FakeTimers } from "../testing/fake-timers";
import { MockNodeLink } from "./mock";

function make(over: { excessTauMs?: number } = {}) {
  const timers = new FakeTimers();
  timers.now = Date.UTC(2026, 7, 30, 12, 0, 0);
  const link = new MockNodeLink({ now: () => timers.now, timers, excessTauMs: over.excessTauMs ?? 60_000 });
  link.publishCfg({ setpoint: 60, maxMinutes: 60, exhaustMin: 25, exhaustGain: 4 });
  /** Прокрутить симулятор на N секунд шагами по секунде. */
  const run = (sec: number) => {
    for (let i = 0; i < sec; i++) {
      timers.now += 1000;
      link.step(1000);
    }
  };
  return { link, timers, run, view: () => link.view(timers.now, 60_000) };
}

describe("MockNodeLink", () => {
  it("в простое — idle, online, выходы выкл, комнатные значения", () => {
    const { view } = make();
    const v = view();
    expect(v.online).toBe(true);
    expect(v.state).toBe("idle");
    expect(v.heaterDuty).toBe(0);
    expect(v.exhaustDuty).toBe(0);
    expect(v.runElapsed).toBe(0);
    expect(v.chamber.temp).toBeCloseTo(22, 0);
    expect(v.setpoint).toBe(60);
    expect(v.maxMinutes).toBe(60);
  });

  it("START → heating → drying: камера доходит до уставки, избыток убывает", () => {
    const { link, run, view } = make();
    link.sendRun("START");
    expect(view().state).toBe("heating");
    expect(view().heaterDuty).toBeGreaterThan(0);
    const x0 = view().excess!;
    run(600);
    const v = view();
    expect(v.state).toBe("drying");
    expect(v.chamber.temp).toBeGreaterThan(58);
    expect(v.chamber.temp).toBeLessThan(63);
    expect(v.excess).toBeLessThan(x0);
    expect(v.runElapsed).toBe(600);
    expect(v.exhaustDuty).toBeGreaterThanOrEqual(25);
  });

  it("STOP → cooldown с вытяжкой 50 %, потом idle, stop_reason=command", () => {
    const { link, run, view } = make();
    link.sendRun("START");
    run(600);
    link.sendRun("STOP");
    expect(view().state).toBe("cooldown");
    expect(view().exhaustDuty).toBe(50);
    expect(view().heaterDuty).toBe(0);
    run(1800);
    expect(view().state).toBe("idle");
    expect(view().stopReason).toBe("command");
    expect(view().runElapsed).toBe(0);
  });

  it("таймер max_minutes останавливает сам с причиной timeout", () => {
    const { link, run, view } = make();
    link.publishCfg({ setpoint: 60, maxMinutes: 30, exhaustMin: 25, exhaustGain: 4 });
    link.sendRun("START");
    run(30 * 60 + 5);
    expect(["cooldown", "idle"]).toContain(view().state);
    expect(view().stopReason).toBe("timeout");
  });

  it("кнопка: из простоя стартует с текущей уставкой, из сушки — стоп с причиной button", () => {
    const { link, run, view } = make();
    link.pressButton();
    expect(view().state).toBe("heating");
    run(5);
    link.pressButton();
    expect(view().state).toBe("cooldown");
    expect(view().stopReason).toBe("button");
  });

  it("fault держится до STOP; после STOP — cooldown", () => {
    const { link, view } = make();
    link.sendRun("START");
    link.simulateFault("exhaust");
    expect(view().state).toBe("fault");
    expect(view().stopReason).toBe("fault:exhaust");
    expect(view().heaterDuty).toBe(0);
    link.sendRun("START"); // в fault старт игнорируется
    expect(view().state).toBe("fault");
    link.sendRun("STOP");
    expect(view().state).toBe("cooldown");
  });

  it("перезагрузка: idle, uptime с нуля, stop_reason прежний; offline скрывает ноду", () => {
    const { link, run, view } = make();
    link.sendRun("START");
    run(100);
    expect(link.uptime()).toBe(100);
    link.simulateReboot();
    expect(view().state).toBe("idle");
    expect(link.uptime()).toBe(0);
    expect(view().stopReason).toBe("command");
    link.setOffline(true);
    expect(view().online).toBe(false);
    expect(link.connected()).toBe(true);
  });

  it("start() крутит шаги по таймеру, stop() останавливает", async () => {
    const { link, timers, view } = make();
    link.start();
    link.sendRun("START");
    await timers.advance(120_000);
    expect(view().chamber.temp).toBeGreaterThan(30);
    link.stop();
    const t = view().chamber.temp;
    await timers.advance(60_000);
    expect(view().chamber.temp).toBe(t);
  });
});
