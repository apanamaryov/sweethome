import { DEFAULT_SETTINGS } from "@sweethome/dryer-shared";
import { DryerStore, SEED_PRESETS } from "./store";

const T = Date.UTC(2026, 7, 30, 10, 0, 0);

const sample = (ts: number, over: Partial<Parameters<DryerStore["addSample"]>[0]> = {}) => ({
  ts,
  runId: null,
  chamberTemp: 58.2,
  chamberRh: 42,
  ambientTemp: 22,
  ambientRh: 50,
  plateTemp: 84,
  excess: 6.2,
  heaterDuty: 71,
  exhaustDuty: 50,
  exhaustRpm: 1850,
  state: "drying" as const,
  ...over,
});

describe("DryerStore", () => {
  let db: DryerStore;
  beforeEach(() => {
    db = new DryerStore(":memory:");
  });
  afterEach(() => db.close());

  describe("presets", () => {
    it("сеет 30 пресетов один раз, повторный посев ничего не добавляет", () => {
      expect(db.seedPresetsIfEmpty()).toBe(SEED_PRESETS.length);
      expect(db.seedPresetsIfEmpty()).toBe(0);
      const all = db.listPresets();
      expect(all).toHaveLength(30);
      expect(all[0]).toMatchObject({ name: "Яблоки", group: "fruit", setpoint: 60, maxMinutes: 840, autostop: true, sort: 1 });
      expect(all.filter((p) => p.group === "vegetable")).toHaveLength(14);
      expect(all.at(-1)).toMatchObject({ name: "Джерки (мясо)", setpoint: 70, maxMinutes: 480 });
    });

    it("CRUD: создать с sort в конец, изменить частично, удалить", () => {
      const a = db.createPreset({ name: "A", group: "other", setpoint: 40, maxMinutes: 60, autostop: true });
      const b = db.createPreset({ name: "B", group: "fruit", setpoint: 60, maxMinutes: 120, autostop: false });
      expect(a.sort).toBe(1);
      expect(b.sort).toBe(2);
      expect(db.getPreset(a.id)).toEqual(a);
      expect(db.updatePreset(a.id, { setpoint: 45, autostop: false })).toMatchObject({ id: a.id, setpoint: 45, autostop: false, name: "A" });
      expect(db.updatePreset(999, { setpoint: 45 })).toBeNull();
      expect(db.deletePreset(a.id)).toBe(true);
      expect(db.deletePreset(a.id)).toBe(false);
      expect(db.listPresets().map((p) => p.name)).toEqual(["B"]);
    });

    it("имя уникально — дубль даёт понятную ошибку", () => {
      db.createPreset({ name: "A", group: "other", setpoint: 40, maxMinutes: 60, autostop: true });
      expect(() => db.createPreset({ name: "A", group: "fruit", setpoint: 50, maxMinutes: 60, autostop: true })).toThrow(
        "Пресет с таким названием уже есть"
      );
    });
  });

  describe("runs", () => {
    const open = (over = {}) =>
      db.openRun({ startedAt: T, presetName: "Яблоки", setpoint: 60, maxMinutes: 840, startedBy: "ui:alex", autostopEnabled: true, ...over });

    it("открытая сушка одна; закрытие ставит время и причину", () => {
      expect(db.currentRun()).toBeNull();
      const r = open();
      expect(r).toMatchObject({ id: 1, startedAt: T, endedAt: null, endReason: null, restarts: 0 });
      expect(db.currentRun()).toEqual(r);
      db.closeRun(r.id, T + 3600_000, "autostop");
      expect(db.currentRun()).toBeNull();
      expect(db.getRun(r.id)).toMatchObject({ endedAt: T + 3600_000, endReason: "autostop" });
    });

    it("bumpRestarts возвращает новое значение", () => {
      const r = open();
      expect(db.bumpRestarts(r.id)).toBe(1);
      expect(db.bumpRestarts(r.id)).toBe(2);
      expect(db.getRun(r.id)!.restarts).toBe(2);
    });

    it("listRuns — по началу в [from, to), новые первыми", () => {
      const a = open({ startedAt: T });
      db.closeRun(a.id, T + 1000, "stopped");
      const b = open({ startedAt: T + 86_400_000, presetName: null, startedBy: "button" });
      db.closeRun(b.id, T + 86_400_000 + 1000, "timeout");
      expect(db.listRuns(T, T + 2 * 86_400_000).map((r) => r.id)).toEqual([b.id, a.id]);
      expect(db.listRuns(T, T + 86_400_000).map((r) => r.id)).toEqual([a.id]);
      expect(db.listRuns(T, T + 86_400_000)[0].presetName).toBe("Яблоки");
      expect(db.getRun(b.id)!.presetName).toBeNull();
    });
  });

  describe("samples", () => {
    it("пишет замеры, отдаёт по сушке и ряд избытка по окну, null сохраняется как null", () => {
      const r = db.openRun({ startedAt: T, presetName: null, setpoint: 60, maxMinutes: 60, startedBy: "button", autostopEnabled: true });
      db.addSample(sample(T, { runId: r.id }));
      db.addSample(sample(T + 10_000, { runId: r.id, excess: null }));
      db.addSample(sample(T + 20_000, { runId: null, state: "idle" }));
      expect(db.samplesForRun(r.id)).toHaveLength(2);
      expect(db.samplesForRun(r.id)[1].excess).toBeNull();
      expect(db.excessSeries(T, T + 15_000)).toEqual([
        { ts: T, excess: 6.2 },
        { ts: T + 10_000, excess: null },
      ]);
    });

    it("повторный ts заменяет строку, а не падает", () => {
      db.addSample(sample(T, { chamberTemp: 50 }));
      db.addSample(sample(T, { chamberTemp: 51 }));
      expect(db.excessSeries(T, T + 1)).toHaveLength(1);
    });

    it("pruneSamples удаляет старое и возвращает счётчик", () => {
      db.addSample(sample(T - 400 * 86_400_000));
      db.addSample(sample(T));
      expect(db.pruneSamples(T - 365 * 86_400_000)).toBe(1);
      expect(db.excessSeries(0, T + 1)).toHaveLength(1);
    });
  });

  describe("events", () => {
    it("добавляет, отдаёт непрочитанные новыми первыми, помечает прочитанным", () => {
      const a = db.addEvent(T, "node_offline", "Нет связи с сушилкой", null);
      const b = db.addEvent(T + 1000, "run_done", "Сушка «Яблоки» завершена автостопом за 9 ч 40 м", 1);
      expect(a).toMatchObject({ id: 1, kind: "node_offline", seen: false, runId: null });
      expect(db.unseenEvents().map((e) => e.id)).toEqual([b.id, a.id]);
      expect(db.markSeen(a.id)).toBe(true);
      expect(db.markSeen(a.id)).toBe(false);
      expect(db.unseenEvents().map((e) => e.id)).toEqual([b.id]);
    });
  });

  describe("settings", () => {
    it("по умолчанию — DEFAULT_SETTINGS; патч сливается по полям", () => {
      expect(db.getSettings()).toEqual(DEFAULT_SETTINGS);
      const s = db.updateSettings({ autostop: { holdMinutes: 45 }, exhaustMin: 30 });
      expect(s).toEqual({ ...DEFAULT_SETTINGS, autostop: { ...DEFAULT_SETTINGS.autostop, holdMinutes: 45 }, exhaustMin: 30 });
      expect(db.getSettings()).toEqual(s);
    });

    it("битое поле откатывается на дефолт, остальные живут", () => {
      db.updateSettings({ exhaustGain: 6 });
      db.rawSetSetting("exhaustMin", "not json");
      db.rawSetSetting("autostop", JSON.stringify({ excessThreshold: "три", holdMinutes: 45 }));
      const s = db.getSettings();
      expect(s.exhaustMin).toBe(DEFAULT_SETTINGS.exhaustMin);
      expect(s.exhaustGain).toBe(6);
      expect(s.autostop).toEqual({ ...DEFAULT_SETTINGS.autostop, holdMinutes: 45 });
    });

    it("значение вне диапазона тоже считается битым", () => {
      db.rawSetSetting("staleAfterSeconds", "5");
      expect(db.getSettings().staleAfterSeconds).toBe(DEFAULT_SETTINGS.staleAfterSeconds);
    });
  });
});
