import { DEFAULT_SETTINGS } from "@sweethome/dryer-shared";
import { MockNodeLink } from "./node/mock";
import { RunError, RunManager } from "./runs";
import { DryerStore } from "./store";
import { FakeTimers } from "./testing/fake-timers";

const S = DEFAULT_SETTINGS;
const STALE = S.staleAfterSeconds * 1000;

function make() {
  const timers = new FakeTimers();
  timers.now = Date.UTC(2026, 7, 30, 12, 0, 0);
  const now = () => timers.now;
  const store = new DryerStore(":memory:");
  const link = new MockNodeLink({ now, timers, excessTauMs: 60_000 });
  const runs = new RunManager({ store, link, timers, now });
  const view = () => link.view(timers.now, STALE);
  /** Тик модуля: секунда физики + тик менеджера; возвращает события. */
  const tick = (sec = 1) => {
    let ev: ReturnType<RunManager["tick"]> = [];
    for (let i = 0; i < sec; i++) {
      timers.now += 1000;
      link.step(1000);
      ev = ev.concat(runs.tick(timers.now, view(), S));
    }
    return ev;
  };
  const params = { setpoint: 60, maxMinutes: 60, autostop: true, presetName: "Яблоки", startedBy: "ui:alex" };
  return { timers, store, link, runs, view, tick, params };
}

describe("RunManager.start / stop", () => {
  it("публикует cfg до START, ждёт heating и открывает запись", async () => {
    const { runs, store, view, params, tick } = make();
    const run = await runs.start(params, S);
    expect(view().state).toBe("heating");
    expect(view().setpoint).toBe(60);
    expect(run).toMatchObject({ presetName: "Яблоки", setpoint: 60, maxMinutes: 60, startedBy: "ui:alex", autostopEnabled: true });
    expect(store.currentRun()!.id).toBe(run.id);
    expect(tick(3)).toEqual([]); // наш собственный старт не принимается за кнопку
    expect(store.currentRun()!.id).toBe(run.id);
  });

  it("stop закрывает запись причиной stopped и шлёт STOP", async () => {
    const { runs, store, view, params } = make();
    const run = await runs.start(params, S);
    const closed = await runs.stop();
    expect(closed!.id).toBe(run.id);
    expect(store.getRun(run.id)).toMatchObject({ endReason: "stopped" });
    expect(view().state).toBe("cooldown");
  });

  it("409 already_running при открытой сушке, 409 fault_active в ошибке, 409 node_busy при остывании", async () => {
    const { runs, link, params, tick } = make();
    await runs.start(params, S);
    tick(120); // пластина должна прогреться выше 50 °C, иначе остывание закончится мгновенно
    await expect(runs.start(params, S)).rejects.toMatchObject({ code: "already_running", status: 409 });
    link.simulateFault("sensor");
    tick(1);
    await expect(runs.start(params, S)).rejects.toMatchObject({ code: "fault_active", status: 409 });
    await runs.stop(); // сброс ошибки → cooldown
    tick(1);
    await expect(runs.start(params, S)).rejects.toMatchObject({ code: "node_busy", status: 409 });
  });

  it("503 node_offline, если нода не на связи", async () => {
    const { runs, link, params } = make();
    link.setOffline(true);
    await expect(runs.start(params, S)).rejects.toMatchObject({ code: "node_offline", status: 503 });
  });

  it("504 node_unresponsive, если нода не перешла в heating за 5 с; записи нет", async () => {
    const { runs, link, store, params, timers } = make();
    // Нода «глухая»: команду глотает. Подменяем sendRun.
    link.sendRun = () => {};
    const p = runs.start(params, S);
    const failed = p.catch((e: RunError) => e);
    await timers.advance(5500);
    expect(await failed).toMatchObject({ code: "node_unresponsive", status: 504 });
    expect(store.currentRun()).toBeNull();
  });
});

describe("RunManager.tick", () => {
  it("кнопка: heating без нашей команды → сушка started_by=button с уставкой ноды", () => {
    const { runs, link, store, tick } = make();
    tick(1);
    link.pressButton();
    const ev = tick(1);
    const run = store.currentRun()!;
    expect(run).toMatchObject({ startedBy: "button", presetName: null, setpoint: 60, maxMinutes: 720, autostopEnabled: true });
    expect(ev).toEqual([]);
    expect(runs).toBeDefined();
  });

  it("нода остановилась сама по таймеру → запись закрыта timeout, событие run_timeout", async () => {
    const { runs, store, tick, params } = make();
    const run = await runs.start({ ...params, maxMinutes: 30 }, S);
    const ev = tick(30 * 60 + 5);
    expect(store.getRun(run.id)).toMatchObject({ endReason: "timeout" });
    expect(ev).toEqual([{ kind: "run_timeout", runId: run.id, text: "Сушка «Яблоки» остановлена по таймеру (30 м)" }]);
  });

  it("fault на ноде → запись закрыта fault:*, событие run_fault", async () => {
    const { runs, link, store, tick, params } = make();
    const run = await runs.start(params, S);
    tick(2);
    link.simulateFault("exhaust");
    const ev = tick(1);
    expect(store.getRun(run.id)).toMatchObject({ endReason: "fault:exhaust" });
    expect(ev).toEqual([{ kind: "run_fault", runId: run.id, text: "Сушка «Яблоки» прервана: вытяжка не крутится" }]);
  });

  it("кнопка во время нашей сушки → запись закрыта stopped, без события", async () => {
    const { runs, link, store, tick, params } = make();
    const run = await runs.start(params, S);
    tick(2);
    link.pressButton();
    expect(tick(1)).toEqual([]);
    expect(store.getRun(run.id)).toMatchObject({ endReason: "stopped" });
  });

  it("перезагрузка ноды посреди сушки → перезапуск, restarts=1, событие run_restarted", async () => {
    const { runs, link, store, view, tick, params } = make();
    const run = await runs.start(params, S);
    tick(60);
    link.simulateReboot();
    const ev = tick(1);
    expect(ev).toEqual([{ kind: "run_restarted", runId: run.id, text: "Нода перезагрузилась — сушка «Яблоки» перезапущена (1)" }]);
    expect(view().state).toBe("heating");
    expect(store.getRun(run.id)!.restarts).toBe(1);
    expect(tick(3)).toEqual([]); // повторный старт не считается кнопкой
    expect(store.currentRun()!.id).toBe(run.id);
  });

  it("перезагрузка, когда время сушки вышло → закрытие timeout без перезапуска", async () => {
    const { runs, link, store, view, tick, params, timers } = make();
    const run = await runs.start({ ...params, maxMinutes: 30 }, S);
    tick(5);
    link.setOffline(true);
    timers.now += 31 * 60_000; // нода молчала полчаса, потом вернулась перезагруженной
    link.setOffline(false);
    link.simulateReboot();
    const ev = tick(1);
    expect(store.getRun(run.id)).toMatchObject({ endReason: "timeout" });
    expect(ev.map((e) => e.kind)).toContain("run_timeout");
    expect(view().state).toBe("idle");
  });

  it("больше 3 перезапусков → fault:node_reboot_loop", async () => {
    const { runs, link, store, tick, params } = make();
    const run = await runs.start(params, S);
    for (let i = 0; i < 3; i++) {
      tick(5);
      link.simulateReboot();
      tick(1);
    }
    expect(store.getRun(run.id)!.restarts).toBe(3);
    tick(5);
    link.simulateReboot();
    const ev = tick(1);
    expect(store.getRun(run.id)).toMatchObject({ endReason: "fault:node_reboot_loop" });
    expect(ev).toEqual([{ kind: "run_fault", runId: run.id, text: "Сушка «Яблоки» прервана: нода перезагружается по кругу" }]);
  });

  it("нода пропала во время сушки: запись живёт; node_offline через 2 мин; node_lost после max+15 мин", async () => {
    const { runs, link, store, tick, params, timers } = make();
    const run = await runs.start({ ...params, maxMinutes: 30 }, S);
    tick(5);
    link.setOffline(true);
    expect(tick(120)).toEqual([]); // событие — когда тишина длится ≥ 2 мин от первого офлайн-тика
    expect(tick(1)).toEqual([{ kind: "node_offline", runId: run.id, text: "Нет связи с сушилкой" }]);
    expect(store.currentRun()!.id).toBe(run.id);
    timers.now += 44 * 60_000;
    const ev = runs.tick(timers.now, link.view(timers.now, STALE), S);
    expect(store.getRun(run.id)).toMatchObject({ endReason: "node_lost" });
    expect(ev).toEqual([{ kind: "run_lost", runId: run.id, text: "Связь с сушилкой потеряна, сушка «Яблоки» закрыта" }]);
    link.setOffline(false);
    expect(tick(1)).toEqual([{ kind: "node_online", runId: null, text: "Связь с сушилкой восстановлена" }]);
  });

  it("сервис поднялся, а нода уже сушит → запись started_by=recovered от начала сушки", () => {
    const { runs, link, store, tick, timers } = make();
    link.pressButton();
    for (let i = 0; i < 120; i++) {
      timers.now += 1000;
      link.step(1000);
    }
    const ev = runs.tick(timers.now, link.view(timers.now, STALE), S);
    const run = store.currentRun()!;
    expect(run.startedBy).toBe("recovered");
    expect(run.startedAt).toBe(timers.now - 120_000);
    expect(ev).toEqual([]);
    expect(tick(1)).toEqual([]);
  });

  it("nodeCfg собирает cfg из сушки и настроек", () => {
    const { runs } = make();
    expect(runs.nodeCfg({ setpoint: 55, maxMinutes: 600 }, { ...S, exhaustMin: 30, exhaustGain: 5 })).toEqual({
      setpoint: 55,
      maxMinutes: 600,
      exhaustMin: 30,
      exhaustGain: 5,
    });
  });
});
