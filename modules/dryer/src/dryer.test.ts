import { DEFAULT_SETTINGS } from "@sweethome/dryer-shared";
import { loadDryerConfig } from "./config";
import { Dryer } from "./dryer";
import { MockNodeLink } from "./node/mock";
import { DryerStore } from "./store";
import { FakeTimers } from "./testing/fake-timers";

function make() {
  const timers = new FakeTimers();
  timers.now = Date.UTC(2026, 7, 30, 12, 0, 0);
  const now = () => timers.now;
  const store = new DryerStore(":memory:");
  const link = new MockNodeLink({ now, timers, excessTauMs: 5 * 60_000 });
  const cfg = loadDryerConfig("/data", { DRYER_TRANSPORT: "mock", DRYER_TICK_MS: "10000" });
  const dryer = new Dryer({ cfg, store, link, timers, now, log: () => {} });
  dryer.start();
  return { timers, store, link, dryer };
}

describe("Dryer", () => {
  it("start сеет пресеты и крутит тик по таймеру; снапшот уходит подписчикам", async () => {
    const { timers, store, dryer } = make();
    expect(store.listPresets()).toHaveLength(30);
    const got: number[] = [];
    const unsub = dryer.subscribe((s) => got.push(s.now));
    await timers.advance(30_000);
    expect(got).toHaveLength(3);
    unsub();
    await timers.advance(10_000);
    expect(got).toHaveLength(3);
  });

  it("startRun по пресету публикует cfg, открывает запись и отдаёт снапшот с run", async () => {
    const { store, link, dryer, timers } = make();
    const apples = store.listPresets().find((p) => p.name === "Яблоки")!;
    const snap = await dryer.startRun({ presetId: apples.id }, "ui:alex");
    expect(snap.run).toMatchObject({ presetName: "Яблоки", setpoint: 60, maxMinutes: 840, startedBy: "ui:alex" });
    expect(snap.run!.autostop.enabled).toBe(true);
    expect(snap.node.state).toBe("heating");
    expect(link.view(timers.now, 60_000).setpoint).toBe(60);
  });

  it("startRun со своими параметрами; неизвестный пресет → RunError preset_not_found (404)", async () => {
    const { dryer } = make();
    await expect(dryer.startRun({ presetId: 999 }, "ui:alex")).rejects.toMatchObject({ code: "preset_not_found", status: 404 });
    const snap = await dryer.startRun({ setpoint: 45, maxMinutes: 120, autostop: false }, "token:laptop");
    expect(snap.run).toMatchObject({ presetName: null, setpoint: 45, maxMinutes: 120, autostopEnabled: false, startedBy: "token:laptop" });
    expect(snap.run!.autostop.reason).toBe("автостоп выключен — остановится по таймеру");
  });

  it("замеры: каждые 10 с во время сушки, раз в 5 минут в простое", async () => {
    const { store, dryer, timers } = make();
    await timers.advance(15 * 60_000); // простой: 90 тиков → 3–4 замера
    const idle = store.excessSeries(0, timers.now).length;
    expect(idle).toBeGreaterThanOrEqual(3);
    expect(idle).toBeLessThanOrEqual(4);
    await dryer.startRun({ setpoint: 60, maxMinutes: 600 }, "ui:alex");
    const before = store.excessSeries(0, timers.now).length;
    await timers.advance(60_000);
    expect(store.excessSeries(0, timers.now).length).toBe(before + 6);
  });

  it("автостоп: избыток упал и держится → STOP, запись autostop, событие run_done", async () => {
    const { store, dryer, timers } = make();
    store.updateSettings({ autostop: { excessThreshold: 3, holdMinutes: 5, minRunMinutes: 10 } });
    await dryer.startRun({ setpoint: 60, maxMinutes: 600 }, "ui:alex");
    // tau = 5 мин: избыток 30 → ниже 3 примерно через 12 мин, плюс 5 мин удержания.
    await timers.advance(25 * 60_000);
    const run = store.listRuns(0, timers.now + 1)[0];
    expect(run.endReason).toBe("autostop");
    const ev = store.unseenEvents();
    expect(ev[0]).toMatchObject({ kind: "run_done", runId: run.id });
    expect(ev[0].text).toMatch(/^Сушка «свои параметры» завершена автостопом за \d+ м$/);
    const snap = dryer.snapshot();
    expect(snap.run).toBeNull();
    expect(["cooldown", "idle"]).toContain(snap.node.state);
  });

  it("автостоп не срабатывает в разогреве и до minRunMinutes; статус объясняет почему", async () => {
    const { dryer, timers } = make();
    await dryer.startRun({ setpoint: 60, maxMinutes: 600 }, "ui:alex");
    let snap = dryer.tick();
    expect(snap.run!.autostop.reason).toBe("разогрев — автостоп ждёт выхода на уставку");
    await timers.advance(15 * 60_000);
    snap = dryer.snapshot();
    expect(snap.node.state).toBe("drying");
    expect(snap.run!.autostop.reason).toBe("минимальное время сушки 60 мин ещё не прошло");
  });

  it("stopRun закрывает запись и возвращает снапшот без run", async () => {
    const { store, dryer } = make();
    await dryer.startRun({ setpoint: 60, maxMinutes: 600 }, "ui:alex");
    const snap = await dryer.stopRun();
    expect(snap.run).toBeNull();
    expect(store.listRuns(0, snap.now + 1)[0].endReason).toBe("stopped");
  });

  it("health: ok при брокере и ноде на связи; ok:false с причиной при потере ноды", () => {
    const { dryer, link } = make();
    expect(dryer.health()).toMatchObject({ ok: true, details: { broker: true, nodeOnline: true, transport: "mock" } });
    link.setOffline(true);
    expect(dryer.health()).toMatchObject({ ok: false, details: { broker: true, nodeOnline: false } });
  });

  it("чистка: замеры старше года удаляются", async () => {
    const { store, dryer, timers } = make();
    store.addSample({
      ts: timers.now - 400 * 86_400_000, runId: null, chamberTemp: 20, chamberRh: 50, ambientTemp: 20, ambientRh: 50,
      plateTemp: 20, excess: 0, heaterDuty: 0, exhaustDuty: 0, exhaustRpm: 0, state: "idle",
    });
    dryer.tick(); // первый тик после старта — чистка
    expect(store.excessSeries(0, timers.now - 399 * 86_400_000)).toHaveLength(0);
  });

  it("подписчик, бросающий исключение, не мешает остальным и следующему тику", async () => {
    const { dryer, timers } = make();
    const got: number[] = [];
    dryer.subscribe(() => {
      throw new Error("boom");
    });
    dryer.subscribe((s) => got.push(s.now));
    await timers.advance(20_000);
    expect(got).toHaveLength(2);
  });

  it("ошибка внутри тика по таймеру логируется, интервал живёт", async () => {
    const timers = new FakeTimers();
    timers.now = Date.UTC(2026, 7, 30, 12, 0, 0);
    const now = () => timers.now;
    const store = new DryerStore(":memory:");
    const link = new MockNodeLink({ now, timers, excessTauMs: 5 * 60_000 });
    const cfg = loadDryerConfig("/data", { DRYER_TRANSPORT: "mock", DRYER_TICK_MS: "10000" });
    const logs: string[] = [];
    const dryer = new Dryer({ cfg, store, link, timers, now, log: (s) => logs.push(s) });
    dryer.start();

    // Первый вызов view() после старта падает — имитируем сбой внутри тика.
    let calls = 0;
    const originalView = link.view.bind(link);
    link.view = ((n: number, staleMs: number) => {
      calls++;
      if (calls === 1) throw new Error("view boom");
      return originalView(n, staleMs);
    }) as typeof link.view;

    const got: number[] = [];
    dryer.subscribe((s) => got.push(s.now));

    await timers.advance(20_000);

    expect(logs.some((m) => m.startsWith("tick failed:"))).toBe(true);
    expect(got).toHaveLength(1);
  });
});
