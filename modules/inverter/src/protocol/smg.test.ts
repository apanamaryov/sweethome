import {
  decodeStatus,
  decodeSettings,
  decodeFlags,
  decodeAlarms,
  decodeMode,
  buildControlWrite,
  RegisterMap,
} from "./smg";

describe("decodeStatus", () => {
  const regs: RegisterMap = new Map<number, number>([
    [201, 2], [202, 2327], [203, 5001], [204, 150], [208, 600],
    [210, 2298], [212, 5000], [213, 600], [214, 690], [215, 522],
    [217, 0x10000 - 520], [219, 2805], [220, 114], [223, 3200],
    [224, 2680], [225, 11], [226, 41], [227, 43], [229, 72],
    [232, 0x10000 - 100],
  ]);
  const st = decodeStatus(regs);
  it("scales voltages/frequencies by division (no float tails)", () => {
    expect(st.gridVoltage).toBe(232.7);
    expect(st.gridFrequency).toBe(50.01);
    expect(st.acOutputVoltage).toBe(229.8);
    expect(st.batteryVoltage).toBe(52.2);
  });
  it("maps powers and derives charge/discharge current", () => {
    expect(st.acOutputActivePower).toBe(600);
    expect(st.batteryPower).toBe(-520);
    expect(st.batteryChargingCurrent).toBe(0);
    expect(st.batteryDischargeCurrent).toBe(10);
    expect(st.batteryCapacity).toBe(72);
    expect(st.pvPower).toBe(3200);
    expect(st.pvChargingPower).toBe(2680);
    expect(st.heatSinkTemperature).toBe(43);
  });
  it("returns NaN for missing registers", () => {
    expect(Number.isNaN(decodeStatus(new Map()).gridVoltage)).toBe(true);
  });
});

describe("decodeMode", () => {
  it.each([
    [0, "PowerOn"], [1, "Standby"], [2, "Line"], [3, "Battery"],
    [4, "Bypass"], [5, "Charging"], [6, "Fault"], [99, "Unknown"],
  ])("mode %i", (reg, name) => {
    expect(decodeMode(reg as number)).toBe(name);
  });
});

describe("decodeSettings", () => {
  const regs: RegisterMap = new Map<number, number>([
    [300, 0], [301, 2], [302, 0], [303, 1], [305, 1], [306, 1], [307, 0],
    [310, 1], [313, 0], [320, 2300], [321, 5000], [322, 3], [324, 564],
    [325, 540], [326, 540], [327, 460], [329, 420], [331, 1], [332, 600],
    [333, 300], [341, 30], [342, 80], [343, 10], [643, 5500],
  ]);
  const info = decodeSettings(regs);
  it("decodes priorities, currents, voltages, SOC, rated power", () => {
    expect(info.outputSourcePriority).toBe(2);
    expect(info.chargerSourcePriority).toBe(1);
    expect(info.maxChargingCurrent).toBe(60);
    expect(info.maxAcChargingCurrent).toBe(30);
    expect(info.batteryRechargeVoltage).toBe(46);
    expect(info.batteryRedischargeVoltage).toBe(54);
    expect(info.batteryBulkVoltage).toBe(56.4);
    expect(info.batteryUnderVoltage).toBe(42);
    expect(info.batteryType).toBe(3);
    expect(info.socBackToUtility).toBe(30);
    expect(info.acOutputRatingActivePower).toBe(5500);
  });
});

describe("decodeFlags", () => {
  const regs: RegisterMap = new Map<number, number>([
    [306, 1], [307, 0], [310, 1], [313, 0],
  ]);
  const flags = decodeFlags(regs);
  it("maps single-bit toggles", () => {
    expect(flags.flags.find((f) => f.key === "lcdHome")?.enabled).toBe(true);
    expect(flags.flags.find((f) => f.key === "ecoMode")?.enabled).toBe(false);
    expect(flags.flags.find((f) => f.key === "overloadBypass")?.enabled).toBe(true);
  });
  it("omits flags for absent registers", () => {
    expect(decodeFlags(new Map()).flags).toHaveLength(0);
  });
});

describe("decodeAlarms", () => {
  it("lists active fault+warning bits by name", () => {
    const regs: RegisterMap = new Map<number, number>([
      [100, 0], [101, 1 << 6], [108, 0], [109, (1 << 3) | (1 << 8)],
    ]);
    expect(decodeAlarms(regs).active).toEqual([
      "Output over load", "Mains low voltage", "Battery low voltage",
    ]);
  });
  it("returns empty list when no bits set", () => {
    expect(decodeAlarms(new Map([[100, 0], [101, 0], [108, 0], [109, 0]])).active).toEqual([]);
  });
});

describe("buildControlWrite", () => {
  it("maps registers, scales ×10, labels", () => {
    expect(buildControlWrite("outputSourcePriority", 2).register).toBe(301);
    expect(buildControlWrite("chargerSourcePriority", 3)).toEqual({
      register: 331, rawValue: 3, label: "charger priority = Only PV",
    });
    expect(buildControlWrite("maxChargingCurrent", 60).rawValue).toBe(600);
    expect(buildControlWrite("maxAcChargingCurrent", 30).rawValue).toBe(300);
    expect(buildControlWrite("batteryRechargeVoltage", 46).register).toBe(327);
    expect(buildControlWrite("batteryRechargeVoltage", 46).rawValue).toBe(460);
    expect(buildControlWrite("batteryRedischargeVoltage", 54).register).toBe(326);
  });
  it("validates values", () => {
    expect(() => buildControlWrite("maxChargingCurrent", 55)).toThrow(/must be one of/);
    expect(() => buildControlWrite("batteryRechargeVoltage", 70)).toThrow(/out of range/);
    expect(() => buildControlWrite("outputSourcePriority", 9)).toThrow(/Invalid/);
  });
});
