/**
 * Unit-тесты чистого вывода источника питания (shared/src/source.ts).
 *
 * Гоняются jest'ом сервера: его конфиг держит `shared/src` в `roots`
 * (server/jest.config.cjs) — тот же приём, что у settings.test.ts.
 */
import {
  DISCHARGE_EPS_A,
  PV_MIN_W,
  SWITCH_AFTER,
  initialSourceState,
  instantSource,
  stepSource,
} from "./source";
import type { InverterStatus } from "./types";

/** Полный статус с нулевым солнцем и спокойной батареей; переопределяем нужное. */
function status(over: Partial<InverterStatus> = {}): InverterStatus {
  return {
    gridVoltage: 0,
    gridFrequency: 0,
    mainsPower: 0,
    inverterPower: 300,
    acOutputVoltage: 230,
    acOutputFrequency: 50,
    acOutputActivePower: 300,
    acOutputApparentPower: 350,
    outputLoadPercent: 6,
    batteryVoltage: 52,
    batteryPower: 0,
    batteryChargingCurrent: 0,
    batteryDischargeCurrent: 0,
    batteryCapacity: 70,
    pvInputVoltage: 300,
    pvInputCurrent: 3,
    pvPower: 0,
    pvChargingPower: 0,
    dcdcTemperature: 30,
    heatSinkTemperature: 35,
    raw: "",
    ...over,
  };
}

describe("instantSource — мгновенный кандидат по одному замеру", () => {
  it("ночью в автономе остаётся Battery: выработки нет", () => {
    expect(instantSource("Battery", status({ pvPower: 0 }))).toBe("Battery");
  });

  it("на рассвете остаётся Battery: солнце есть, но банка всё ещё разряжается", () => {
    expect(instantSource("Battery", status({ pvPower: 400, batteryDischargeCurrent: 4 }))).toBe("Battery");
  });

  it("даёт Solar, когда есть выработка и из батареи ничего не течёт", () => {
    expect(instantSource("Battery", status({ pvPower: 900, batteryDischargeCurrent: 0 }))).toBe("Solar");
  });

  it("даёт Solar и при профиците, уходящем в заряд", () => {
    const s = status({ pvPower: 1800, pvChargingPower: 1200, batteryChargingCurrent: 20 });
    expect(instantSource("Battery", s)).toBe("Solar");
  });

  it("не подменяет режим Line даже при ярком солнце: нагрузку тянет сеть", () => {
    expect(instantSource("Line", status({ pvPower: 1500 }))).toBe("Line");
  });

  it("не подменяет режим Charging", () => {
    expect(instantSource("Charging", status({ pvPower: 1500 }))).toBe("Charging");
  });

  it("возвращает режим как есть, когда статуса нет", () => {
    expect(instantSource("Battery", null)).toBe("Battery");
  });

  it("трактует NaN в выработке как «не солнце»", () => {
    expect(instantSource("Battery", status({ pvPower: NaN }))).toBe("Battery");
  });

  it("трактует NaN в токе разряда как «не солнце»", () => {
    expect(instantSource("Battery", status({ pvPower: 900, batteryDischargeCurrent: NaN }))).toBe("Battery");
  });

  it("порог выработки строгий: ровно PV_MIN_W не считается солнцем", () => {
    expect(instantSource("Battery", status({ pvPower: PV_MIN_W }))).toBe("Battery");
    expect(instantSource("Battery", status({ pvPower: PV_MIN_W + 1 }))).toBe("Solar");
  });

  it("допуск по разряду нестрогий: ровно DISCHARGE_EPS_A ещё считается солнцем", () => {
    const s = status({ pvPower: 900, batteryDischargeCurrent: DISCHARGE_EPS_A });
    expect(instantSource("Battery", s)).toBe("Solar");
  });
});

describe("stepSource — гистерезис в SWITCH_AFTER замеров подряд", () => {
  it("одиночный выброс не переключает показанное значение", () => {
    const s0 = initialSourceState("Battery");
    const s1 = stepSource(s0, "Solar");
    expect(s1.shown).toBe("Battery");
    expect(s1.pending).toBe("Solar");
    expect(s1.count).toBe(1);
  });

  it("переключает ровно на SWITCH_AFTER-м одинаковом замере, не раньше", () => {
    // Сам порог берём из модуля, а не «две штуки» в тексте теста: поднимут
    // SWITCH_AFTER — проверка поедет за ним, а не начнёт врать.
    let s = initialSourceState("Battery");
    for (let i = 1; i < SWITCH_AFTER; i++) {
      s = stepSource(s, "Solar");
      expect(s.shown).toBe("Battery"); // ещё копим
      expect(s.pending).toBe("Solar");
      expect(s.count).toBe(i);
    }
    s = stepSource(s, "Solar");
    expect(s.shown).toBe("Solar");
    expect(s.count).toBe(0);
  });

  it("смена кандидата на полпути начинает счёт заново", () => {
    let s = initialSourceState("Battery");
    s = stepSource(s, "Solar");
    s = stepSource(s, "Line"); // другой кандидат — счёт с 1, переключения нет
    expect(s.shown).toBe("Battery");
    expect(s.pending).toBe("Line");
    expect(s.count).toBe(1);
    for (let i = 1; i < SWITCH_AFTER; i++) s = stepSource(s, "Line");
    expect(s.shown).toBe("Line");
  });

  it("кандидат, равный показанному, сбрасывает ожидание", () => {
    let s = initialSourceState("Battery");
    s = stepSource(s, "Solar");
    s = stepSource(s, "Battery"); // облако ушло, вернулись к текущему
    expect(s).toEqual({ shown: "Battery", pending: "Battery", count: 0 });
  });

  it("облачный день не даёт переключений: кандидаты чередуются каждый замер", () => {
    let s = initialSourceState("Battery");
    for (const c of ["Solar", "Battery", "Solar", "Battery", "Solar"] as const) {
      s = stepSource(s, c);
    }
    expect(s.shown).toBe("Battery");
  });

  it("initialSourceState по умолчанию стартует с Unknown", () => {
    expect(initialSourceState()).toEqual({ shown: "Unknown", pending: "Unknown", count: 0 });
  });
});
