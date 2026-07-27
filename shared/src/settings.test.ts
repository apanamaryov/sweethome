import { diffSettings } from "./settings";
import type { Baseline, InverterFlags, InverterRatedInfo } from "./types";

const info: InverterRatedInfo = {
  outputMode: 0, outputSourcePriority: 2, inputVoltageRange: 0, buzzerMode: 0, lcdBacklight: 1,
  acOutputRatingVoltage: 230, acOutputRatingFrequency: 50, batteryType: 3, batteryOverVoltage: 60,
  batteryBulkVoltage: 56.4, batteryFloatVoltage: 54, batteryRedischargeVoltage: 52,
  batteryRechargeVoltage: 48, batteryUnderVoltage: 46, chargerSourcePriority: 3,
  maxChargingCurrent: 60, maxAcChargingCurrent: 30, eqChargingVoltage: 56.4,
  socBackToUtility: 20, socBackToBattery: 80, socLowCutoff: 10,
  acOutputRatingActivePower: 5500, raw: "",
};

const flags: InverterFlags = {
  flags: [{ key: "ecoMode", name: "Eco mode", enabled: true }],
  raw: "",
};

const baseline: Baseline = {
  deviceId: "dev-1",
  capturedAt: 1000,
  info: { ...info, chargerSourcePriority: 1, maxChargingCurrent: 40 },
  flags: { flags: [{ key: "ecoMode", name: "Eco mode", enabled: false }], raw: "" },
};

describe("diffSettings", () => {
  it("marks fields that drifted from the baseline", () => {
    const d = diffSettings(info, flags, baseline);
    const drifted = d.settings.filter((r) => r.drifted).map((r) => r.key);
    expect(drifted.sort()).toEqual(["chargerSourcePriority", "maxChargingCurrent"]);
    expect(d.driftCount).toBe(3); // два поля настроек + один флаг
    expect(d.capturedAt).toBe(1000);
    expect(d.deviceId).toBe("dev-1");
  });

  it("renders coded values through the shared maps and units from the register map", () => {
    const d = diffSettings(info, flags, baseline);
    const csp = d.settings.find((r) => r.key === "chargerSourcePriority")!;
    expect(csp.currentLabel).toBe("Only PV");
    expect(csp.baselineLabel).toBe("PV first");
    expect(csp.addr).toBe(331);

    const mcc = d.settings.find((r) => r.key === "maxChargingCurrent")!;
    expect(mcc.currentLabel).toBe("60 A");

    const type = d.settings.find((r) => r.key === "batteryType")!;
    expect(type.currentLabel).toBe("Li1");
  });

  it("reports flag drift separately", () => {
    const d = diffSettings(info, flags, baseline);
    expect(d.flags).toEqual([
      { key: "ecoMode", name: "Eco mode", current: true, baseline: false, drifted: true },
    ]);
  });

  it("works without a baseline and without flags", () => {
    const d = diffSettings(info, null, null);
    expect(d.driftCount).toBe(0);
    expect(d.settings.every((r) => r.drifted === false && r.baseline === null)).toBe(true);
    expect(d.flags).toEqual([]);
  });

  it("returns an empty diff when settings have not been read yet", () => {
    const d = diffSettings(null, null, baseline);
    expect(d.settings).toEqual([]);
    expect(d.driftCount).toBe(0);
  });

  it("does not flag NaN-vs-NaN as drift (unread register on both sides)", () => {
    const withNaN = { ...info, socLowCutoff: NaN };
    const baseNaN: Baseline = { ...baseline, info: { ...baseline.info!, socLowCutoff: NaN } };
    const d = diffSettings(withNaN, null, baseNaN);
    expect(d.settings.find((r) => r.key === "socLowCutoff")!.drifted).toBe(false);
  });
});
