/** Parsed real-time status (from QPIGS). */
export interface InverterStatus {
  gridVoltage: number; // V
  gridFrequency: number; // Hz
  acOutputVoltage: number; // V
  acOutputFrequency: number; // Hz
  acOutputApparentPower: number; // VA
  acOutputActivePower: number; // W
  outputLoadPercent: number; // %
  busVoltage: number; // V
  batteryVoltage: number; // V
  batteryChargingCurrent: number; // A
  batteryCapacity: number; // %
  heatSinkTemperature: number; // °C
  pvInputCurrent: number; // A (PV input current for battery)
  pvInputVoltage: number; // V
  batteryVoltageFromScc: number; // V
  batteryDischargeCurrent: number; // A
  deviceStatus: string; // raw b7..b0 bit string
  pvChargingPower: number; // W
  raw: string;
}

/** Rated info & current configurable settings (from QPIRI). */
export interface InverterRatedInfo {
  gridRatingVoltage: number;
  gridRatingCurrent: number;
  acOutputRatingVoltage: number;
  acOutputRatingFrequency: number;
  acOutputRatingCurrent: number;
  acOutputRatingApparentPower: number;
  acOutputRatingActivePower: number;
  batteryRatingVoltage: number;
  batteryRechargeVoltage: number;
  batteryUnderVoltage: number;
  batteryBulkVoltage: number;
  batteryFloatVoltage: number;
  batteryType: number;
  maxAcChargingCurrent: number;
  maxChargingCurrent: number;
  inputVoltageRange: number;
  outputSourcePriority: number; // 0 UtilitySolarBat, 1 SolarUtilityBat, 2 SolarBatUtility (model-dependent)
  chargerSourcePriority: number; // 0 Utility first, 1 Solar first, 2 Solar+Utility, 3 Only solar
  parallelMaxNum: number;
  machineType: string;
  topology: number;
  outputMode: number;
  batteryRedischargeVoltage: number;
  raw: string;
}

export interface InverterWarnings {
  active: string[];
  raw: string;
}

/** Enable/disable function flags (from QFLAG). */
export interface InverterFlag {
  key: string; // single-letter protocol code
  name: string; // human-readable
  enabled: boolean;
}
export interface InverterFlags {
  flags: InverterFlag[];
  raw: string;
}

/**
 * The "as-found" settings captured once when a device first connects. Persisted
 * to disk and keyed by device serial so a new/real inverter recaptures its own.
 */
export interface Baseline {
  deviceId: string;
  capturedAt: number;
  info: InverterRatedInfo | null;
  flags: InverterFlags | null;
}

export type DeviceMode =
  | "PowerOn"
  | "Standby"
  | "Line"
  | "Battery"
  | "Fault"
  | "PowerSaving"
  | "Shutdown"
  | "Unknown";

/** Full snapshot broadcast to clients. */
export interface Snapshot {
  timestamp: number;
  connection: {
    connected: boolean;
    transport: string; // "serial" | "hid" | "mock" | "none"
    device: string | null;
    deviceId: string | null; // serial from QID
    mock: boolean;
    lastError: string | null;
  };
  control: {
    allowControl: boolean; // hard master switch (ALLOW_CONTROL)
    locked: boolean; // runtime read-only lock; writes rejected while true
  };
  mode: DeviceMode;
  status: InverterStatus | null;
  info: InverterRatedInfo | null;
  flags: InverterFlags | null;
  warnings: InverterWarnings | null;
  baseline: Baseline | null;
}
