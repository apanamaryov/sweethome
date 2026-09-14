import type { InverterRatedInfo } from "./types";
import { SEASON_PROFILES, detectSeasonProfile, isSeasonProfile, profileChanges } from "./profiles";

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
  test("accepts the two known names", () => {
    expect(isSeasonProfile("winter")).toBe(true);
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
