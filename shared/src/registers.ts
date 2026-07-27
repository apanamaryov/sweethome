/**
 * Справочная карта регистров SMG II (наш SK-5500P-48L). Это документация для
 * агентов и людей: декодирование живёт в server/src/protocol/smg.ts, а здесь —
 * структурированное описание тех же адресов. Согласованность (адрес читается
 * поллером, каждое декодируемое поле описано) проверяется тестом
 * server/src/protocol/registers.test.ts.
 */
export interface RegisterDoc {
  addr: number;
  /** Имя поля в InverterStatus / InverterRatedInfo. */
  key: string;
  name: string;
  /** Единица измерения после масштабирования; "" для безразмерных кодов. */
  unit: string;
  /** Делитель сырого значения: 1, 10 или 100. */
  scale: 1 | 10 | 100;
  access: "r" | "rw";
  notes?: string;
}

export const REGISTER_DOCS: RegisterDoc[] = [
  // --- Статус (201–234), только чтение ---
  { addr: 202, key: "gridVoltage", name: "Grid voltage", unit: "V", scale: 10, access: "r" },
  { addr: 203, key: "gridFrequency", name: "Grid frequency", unit: "Hz", scale: 100, access: "r" },
  { addr: 204, key: "mainsPower", name: "Average power drawn from the grid", unit: "W", scale: 1, access: "r" },
  {
    addr: 208, key: "inverterPower", name: "Inverter power", unit: "W", scale: 1, access: "r",
    notes: "positive = supplying, negative = consuming",
  },
  { addr: 210, key: "acOutputVoltage", name: "AC output voltage", unit: "V", scale: 10, access: "r" },
  { addr: 212, key: "acOutputFrequency", name: "AC output frequency", unit: "Hz", scale: 100, access: "r" },
  { addr: 213, key: "acOutputActivePower", name: "AC output active power (load)", unit: "W", scale: 1, access: "r" },
  { addr: 214, key: "acOutputApparentPower", name: "AC output apparent power", unit: "VA", scale: 1, access: "r" },
  { addr: 215, key: "batteryVoltage", name: "Battery voltage", unit: "V", scale: 10, access: "r" },
  {
    addr: 217, key: "batteryPower", name: "Battery power", unit: "W", scale: 1, access: "r",
    notes: "positive = charging, negative = discharging",
  },
  { addr: 219, key: "pvInputVoltage", name: "PV input voltage", unit: "V", scale: 10, access: "r" },
  { addr: 220, key: "pvInputCurrent", name: "PV input current", unit: "A", scale: 10, access: "r" },
  { addr: 223, key: "pvPower", name: "PV power (total generation)", unit: "W", scale: 1, access: "r" },
  { addr: 224, key: "pvChargingPower", name: "PV power going into charging", unit: "W", scale: 1, access: "r" },
  { addr: 225, key: "outputLoadPercent", name: "Output load", unit: "%", scale: 1, access: "r" },
  { addr: 226, key: "dcdcTemperature", name: "DC-DC module temperature", unit: "°C", scale: 1, access: "r" },
  { addr: 227, key: "heatSinkTemperature", name: "Inverter heat sink temperature", unit: "°C", scale: 1, access: "r" },
  { addr: 229, key: "batteryCapacity", name: "Battery state of charge", unit: "%", scale: 1, access: "r" },
  {
    addr: 232, key: "batteryChargingCurrent", name: "Battery current — charging part", unit: "A", scale: 10, access: "r",
    notes: "signed register: positive part is charging current",
  },
  {
    addr: 232, key: "batteryDischargeCurrent", name: "Battery current — discharging part", unit: "A", scale: 10, access: "r",
    notes: "signed register: negative part is discharge current",
  },

  // --- Настройки (300–343, 643) ---
  {
    addr: 300, key: "outputMode", name: "Output mode", unit: "", scale: 1, access: "rw",
    notes: "0 Single, 1 Parallel, 2..4 3-Phase P1..P3",
  },
  {
    addr: 301, key: "outputSourcePriority", name: "Output source priority", unit: "", scale: 1, access: "rw",
    notes: "0 UTI, 1 SOL, 2 SBU, 3 SUB",
  },
  { addr: 302, key: "inputVoltageRange", name: "Input voltage range", unit: "", scale: 1, access: "rw", notes: "0 Wide, 1 Narrow" },
  { addr: 303, key: "buzzerMode", name: "Buzzer mode", unit: "", scale: 1, access: "rw", notes: "0..3" },
  { addr: 305, key: "lcdBacklight", name: "LCD backlight", unit: "", scale: 1, access: "rw", notes: "0 timed off, 1 always on" },
  { addr: 320, key: "acOutputRatingVoltage", name: "AC output rating voltage", unit: "V", scale: 10, access: "rw" },
  { addr: 321, key: "acOutputRatingFrequency", name: "AC output rating frequency", unit: "Hz", scale: 100, access: "rw" },
  {
    addr: 322, key: "batteryType", name: "Battery type", unit: "", scale: 1, access: "rw",
    notes: "0 AGM, 1 Flooded, 2 User, 3..6 Li1..Li4, 8 Lib",
  },
  { addr: 323, key: "batteryOverVoltage", name: "Battery over-voltage protection", unit: "V", scale: 10, access: "rw" },
  { addr: 324, key: "batteryBulkVoltage", name: "Bulk charging voltage (C.V.)", unit: "V", scale: 10, access: "rw" },
  { addr: 325, key: "batteryFloatVoltage", name: "Float charging voltage", unit: "V", scale: 10, access: "rw" },
  {
    addr: 326, key: "batteryRedischargeVoltage", name: "Back-to-battery voltage (recovery)", unit: "V", scale: 10, access: "rw",
    notes: "writable via set_control",
  },
  {
    addr: 327, key: "batteryRechargeVoltage", name: "Back-to-grid voltage (low-voltage protection)", unit: "V", scale: 10, access: "rw",
    notes: "writable via set_control",
  },
  { addr: 329, key: "batteryUnderVoltage", name: "Battery cut-off voltage (off-grid)", unit: "V", scale: 10, access: "rw" },
  {
    addr: 331, key: "chargerSourcePriority", name: "Battery charging priority", unit: "", scale: 1, access: "rw",
    notes: "0 Utility first, 1 PV first, 2 PV and Utility, 3 Only PV; writable via set_control",
  },
  {
    addr: 332, key: "maxChargingCurrent", name: "Max charging current", unit: "A", scale: 10, access: "rw",
    notes: "writable via set_control",
  },
  {
    addr: 333, key: "maxAcChargingCurrent", name: "Max AC charging current", unit: "A", scale: 10, access: "rw",
    notes: "writable via set_control",
  },
  { addr: 334, key: "eqChargingVoltage", name: "Equalization charging voltage", unit: "V", scale: 10, access: "rw" },
  { addr: 341, key: "socBackToUtility", name: "SOC to switch back to the grid", unit: "%", scale: 1, access: "rw" },
  { addr: 342, key: "socBackToBattery", name: "SOC to switch back to the battery", unit: "%", scale: 1, access: "rw" },
  { addr: 343, key: "socLowCutoff", name: "SOC low cut-off", unit: "%", scale: 1, access: "rw" },
  { addr: 643, key: "acOutputRatingActivePower", name: "AC output rating active power", unit: "W", scale: 1, access: "r" },
];

/** Markdown-таблица для ресурса inverter://registers/map. */
export function registerDocsMarkdown(): string {
  const head = [
    "# SMG II register map (SK-5500P-48L)",
    "",
    "Values are read over Modbus RTU (function 0x03); writes use function 0x10 only —",
    "the device does not understand 0x06. `Scale` is a divisor: the raw register value",
    "divided by it gives the physical value.",
    "",
    "| Address | Key | Name | Unit | Scale | Access | Notes |",
    "|---:|---|---|---|---:|---|---|",
  ];
  const rows = REGISTER_DOCS.map(
    (d) => `| ${d.addr} | ${d.key} | ${d.name} | ${d.unit || "—"} | ${d.scale} | ${d.access} | ${d.notes ?? ""} |`
  );
  const tail = [
    "",
    "Faults live in registers 100/101 and warnings in 108/109 as 32-bit masks; the",
    "decoded bit names are what `get_alarms` returns.",
    "",
  ];
  return [...head, ...rows, ...tail].join("\n");
}
