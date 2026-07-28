import type { Snapshot } from "@inverter/shared";
import { summarizeSnapshot, formatWatts } from "./format";

const NOW = 1_700_000_010_000;

const base: Snapshot = {
  timestamp: NOW - 3000,
  connection: {
    connected: true,
    transport: "serial",
    device: "/dev/ttyUSB0",
    deviceId: "dev-1",
    mock: false,
    lastError: null,
  },
  control: { allowControl: true, locked: true },
  mode: "Battery",
  powerSource: "Battery",
  status: {
    gridVoltage: 232.7, gridFrequency: 50, mainsPower: 0, inverterPower: 430,
    acOutputVoltage: 230, acOutputFrequency: 50, acOutputActivePower: 430, acOutputApparentPower: 500,
    outputLoadPercent: 8, batteryVoltage: 52.2, batteryPower: -400, batteryChargingCurrent: 0,
    batteryDischargeCurrent: 7.7, batteryCapacity: 72, pvInputVoltage: 310, pvInputCurrent: 4,
    pvPower: 1240, pvChargingPower: 800, dcdcTemperature: 35, heatSinkTemperature: 41, raw: "",
  },
  info: null,
  flags: null,
  warnings: { active: [], raw: "fault=0x0 warning=0x0" },
  baseline: null,
};

describe("formatWatts", () => {
  it("switches to kW above a kilowatt", () => {
    expect(formatWatts(430)).toBe("430 W");
    expect(formatWatts(1240)).toBe("1.24 kW");
    expect(formatWatts(-400)).toBe("-400 W");
  });
});

describe("summarizeSnapshot", () => {
  it("renders one readable line with mode, SOC, PV, load and grid", () => {
    const line = summarizeSnapshot(base, NOW);
    expect(line).toContain("Battery");
    expect(line).toContain("SOC 72%");
    expect(line).toContain("PV 1.24 kW");
    expect(line).toContain("load 430 W");
    expect(line).toContain("232.7 V");
    expect(line).toContain("3 s ago");
    expect(line).toContain("write locked");
  });

  it("says so when the inverter is not connected", () => {
    const off = { ...base, connection: { ...base.connection, connected: false }, status: null };
    expect(summarizeSnapshot(off, NOW)).toContain("no connection");
  });

  it("marks demo data", () => {
    const mock = { ...base, connection: { ...base.connection, mock: true, transport: "mock" } };
    expect(summarizeSnapshot(mock, NOW)).toContain("demo data");
  });

  it("lists active alarms", () => {
    const bad = { ...base, warnings: { active: ["Over temperature"], raw: "" } };
    expect(summarizeSnapshot(bad, NOW)).toContain("alarms: Over temperature");
  });
});
