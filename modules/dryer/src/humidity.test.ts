import { absoluteHumidity, excessHumidity, humidityAtTemperature, saturationVaporPressure } from "./humidity";

describe("humidity (Magnus, Alduchov–Eskridge)", () => {
  it("давление насыщения — табличные значения", () => {
    expect(saturationVaporPressure(0)).toBeCloseTo(6.11, 1);
    expect(saturationVaporPressure(20)).toBeCloseTo(23.4, 0);
    expect(saturationVaporPressure(60)).toBeCloseTo(199.3, -1); // ±5 гПа: разные аппроксимации Магнуса
  });

  it("абсолютная влажность 20 °C / 50 % ≈ 8.6 г/м³", () => {
    expect(absoluteHumidity(20, 50)).toBeCloseTo(8.6, 0);
  });

  it("воздух, «нагретый» до своей же температуры, сохраняет RH (тождество)", () => {
    expect(humidityAtTemperature(22, 55, 22)).toBeCloseTo(55, 8);
  });

  it("комнатный воздух 22 °C / 50 %, нагретый до 60 °C, имеет ~7 % RH", () => {
    expect(humidityAtTemperature(22, 50, 60)).toBeGreaterThan(6);
    expect(humidityAtTemperature(22, 50, 60)).toBeLessThan(8.5);
  });

  it("результат обрезается в 0…100 (охлаждение ниже точки росы)", () => {
    expect(humidityAtTemperature(30, 90, 5)).toBe(100);
  });

  it("избыток = RH камеры минус RH нагретого комнатного воздуха", () => {
    const x = excessHumidity({ temp: 60, rh: 42 }, { temp: 22, rh: 50 })!;
    expect(x).toBeGreaterThan(33);
    expect(x).toBeLessThan(36);
  });

  it("сухая камера даёт избыток около нуля, отрицательный не обрезается", () => {
    const floor = humidityAtTemperature(22, 50, 60);
    expect(excessHumidity({ temp: 60, rh: floor }, { temp: 22, rh: 50 })).toBeCloseTo(0, 6);
    expect(excessHumidity({ temp: 60, rh: 2 }, { temp: 22, rh: 50 })).toBeLessThan(0);
  });

  it("без любого из четырёх чисел — null, не ноль", () => {
    expect(excessHumidity({ temp: null, rh: 42 }, { temp: 22, rh: 50 })).toBeNull();
    expect(excessHumidity({ temp: 60, rh: 42 }, { temp: 22, rh: NaN })).toBeNull();
  });
});
