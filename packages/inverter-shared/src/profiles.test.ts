import type { InverterRatedInfo } from "./types";
import {
  SEASON_PROFILES,
  detectSeasonProfile,
  isNightTariffTime,
  isSeasonProfile,
  nightTariffPhase,
  nightTariffSteps,
  profileChanges,
} from "./profiles";

/** Местное время: 23 сентября 2026, заданный час и минута. */
const at = (h: number, m = 0) => new Date(2026, 8, 23, h, m);

/** Полный InverterRatedInfo не нужен — тесты смотрят только на два приоритета. */
function info(overrides: Partial<InverterRatedInfo>): InverterRatedInfo {
  return {
    outputMode: 0,
    outputSourcePriority: 2,
    inputVoltageRange: 0,
    buzzerMode: 0,
    lcdBacklight: 1,
    acOutputRatingVoltage: 230,
    acOutputRatingFrequency: 50,
    batteryType: 3,
    batteryOverVoltage: 60,
    batteryBulkVoltage: 56.4,
    batteryFloatVoltage: 54,
    batteryRedischargeVoltage: 52,
    batteryRechargeVoltage: 46,
    batteryUnderVoltage: 42,
    chargerSourcePriority: 1,
    maxChargingCurrent: 60,
    maxAcChargingCurrent: 30,
    eqChargingVoltage: 56.4,
    socBackToUtility: 20,
    socBackToBattery: 80,
    socLowCutoff: 10,
    acOutputRatingActivePower: 5500,
    raw: "",
    ...overrides,
  };
}

describe("SEASON_PROFILES", () => {
  test("winter keeps the battery in reserve: SUB output, utility charges first", () => {
    expect(SEASON_PROFILES.winter).toEqual([
      { type: "outputSourcePriority", value: 3 },
      { type: "chargerSourcePriority", value: 0 },
    ]);
  });

  test("summer leans on the sun: SBU output, PV charges first", () => {
    expect(SEASON_PROFILES.summer).toEqual([
      { type: "outputSourcePriority", value: 2 },
      { type: "chargerSourcePriority", value: 1 },
    ]);
  });
});

describe("isSeasonProfile", () => {
  test("accepts the known names", () => {
    expect(isSeasonProfile("winter")).toBe(true);
    expect(isSeasonProfile("night")).toBe(true);
    expect(isSeasonProfile("summer")).toBe(true);
  });

  test("rejects anything else", () => {
    expect(isSeasonProfile("autumn")).toBe(false);
    expect(isSeasonProfile(2)).toBe(false);
    expect(isSeasonProfile(undefined)).toBe(false);
  });
});

describe("detectSeasonProfile", () => {
  test("reports winter when both priorities match the winter profile", () => {
    expect(detectSeasonProfile(info({ outputSourcePriority: 3, chargerSourcePriority: 0 }))).toBe("winter");
  });

  test("reports summer when both priorities match the summer profile", () => {
    expect(detectSeasonProfile(info({ outputSourcePriority: 2, chargerSourcePriority: 1 }))).toBe("summer");
  });

  test("reports nothing when only one half matches", () => {
    expect(detectSeasonProfile(info({ outputSourcePriority: 3, chargerSourcePriority: 1 }))).toBeNull();
  });

  test("reports nothing without settings", () => {
    expect(detectSeasonProfile(null)).toBeNull();
  });

  test("reports night only from the server flag — at night its registers look like winter", () => {
    const winterLike = info({ outputSourcePriority: 3, chargerSourcePriority: 0 });
    expect(detectSeasonProfile(winterLike, true)).toBe("night");
    expect(detectSeasonProfile(null, true)).toBe("night");
    // Дневные регистры ночного тарифа без флага — это не профиль, а ручная настройка.
    expect(detectSeasonProfile(info({ outputSourcePriority: 3, chargerSourcePriority: 3 }))).toBeNull();
  });
});

describe("ночной тариф", () => {
  test("cheap hours are 23:00–07:00 local time", () => {
    expect(isNightTariffTime(at(22, 59))).toBe(false);
    expect(isNightTariffTime(at(23, 0))).toBe(true);
    expect(isNightTariffTime(at(3))).toBe(true);
    expect(isNightTariffTime(at(6, 59))).toBe(true);
    expect(isNightTariffTime(at(7, 0))).toBe(false);
  });

  test("the grid charges at night, only PV during the day; output stays SUB", () => {
    expect(nightTariffSteps("night")).toEqual([
      { type: "outputSourcePriority", value: 3 },
      { type: "chargerSourcePriority", value: 0 },
    ]);
    expect(nightTariffSteps("day")).toEqual([
      { type: "outputSourcePriority", value: 3 },
      { type: "chargerSourcePriority", value: 3 },
    ]);
    expect(nightTariffSteps("backup")).toEqual(nightTariffSteps("night"));
    expect(SEASON_PROFILES.night).toEqual(nightTariffSteps("day"));
  });

  test("night hours win regardless of charge", () => {
    expect(nightTariffPhase(at(0), 10, "backup")).toBe("night");
    expect(nightTariffPhase(at(23), 90, "day")).toBe("night");
  });

  test("a low battery during the day gets topped up from the grid up to 50%", () => {
    expect(nightTariffPhase(at(12), 31, "day")).toBe("day");
    expect(nightTariffPhase(at(12), 30, "day")).toBe("backup");
    expect(nightTariffPhase(at(12), 45, "backup")).toBe("backup"); // гистерезис
    expect(nightTariffPhase(at(12), 50, "backup")).toBe("day");
    // В 7:00 после ночи батарея ещё пустая — дозаряд продолжается днём.
    expect(nightTariffPhase(at(7), 20, "night")).toBe("backup");
    expect(nightTariffPhase(at(7), 40, "night")).toBe("day");
  });

  test("an unknown charge keeps the current day phase", () => {
    expect(nightTariffPhase(at(12), null, "backup")).toBe("backup");
    expect(nightTariffPhase(at(12), null, "day")).toBe("day");
    expect(nightTariffPhase(at(12), null, null)).toBe("day");
  });

  test("profileChanges follows the phase", () => {
    const winter = info({ outputSourcePriority: 3, chargerSourcePriority: 0 });
    expect(profileChanges(winter, "night", "night")).toEqual([]);
    expect(profileChanges(winter, "night", "day")).toEqual([{ type: "chargerSourcePriority", value: 3, current: 0 }]);
  });
});

describe("profileChanges", () => {
  test("lists only the settings that differ, with their current value", () => {
    const changes = profileChanges(info({ outputSourcePriority: 3, chargerSourcePriority: 1 }), "winter");
    expect(changes).toEqual([{ type: "chargerSourcePriority", value: 0, current: 1 }]);
  });

  test("is empty when the profile is already applied", () => {
    expect(profileChanges(info({ outputSourcePriority: 2, chargerSourcePriority: 1 }), "summer")).toEqual([]);
  });

  test("lists every step with an unknown current value when settings were not read yet", () => {
    expect(profileChanges(null, "summer")).toEqual([
      { type: "outputSourcePriority", value: 2, current: null },
      { type: "chargerSourcePriority", value: 1, current: null },
    ]);
  });
});
