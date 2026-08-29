/**
 * Влажность по формуле Магнуса (коэффициенты Alduchov–Eskridge, 1996).
 * Та же математика зашита в прошивку (firmware/dryer/dryer.yaml, sensor humidity_excess):
 * менять — только парой.
 */

/** Давление насыщенного пара над водой, гПа. */
export function saturationVaporPressure(tC: number): number {
  return 6.1094 * Math.exp((17.625 * tC) / (243.04 + tC));
}

/** Абсолютная влажность, г/м³. */
export function absoluteHumidity(tC: number, rh: number): number {
  const e = (saturationVaporPressure(tC) * rh) / 100;
  return (216.7 * e) / (273.15 + tC);
}

/** RH, которую имел бы воздух (tA, rhA), нагретый/охлаждённый до tB без обмена влагой. */
export function humidityAtTemperature(tA: number, rhA: number, tB: number): number {
  const ah = absoluteHumidity(tA, rhA);
  const eB = (ah * (273.15 + tB)) / 216.7;
  const rh = (100 * eB) / saturationVaporPressure(tB);
  return Math.min(100, Math.max(0, rh));
}

const isNum = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * Избыток влажности камеры над «просто нагретым комнатным воздухом», пункты %RH (спека §4).
 * null — если любого входа нет: нулём это подменять нельзя, ноль здесь значит «продукт сухой».
 */
export function excessHumidity(
  chamber: { temp: number | null; rh: number | null },
  ambient: { temp: number | null; rh: number | null }
): number | null {
  if (!isNum(chamber.temp) || !isNum(chamber.rh) || !isNum(ambient.temp) || !isNum(ambient.rh)) return null;
  return chamber.rh - humidityAtTemperature(ambient.temp, ambient.rh, chamber.temp);
}
