import assert from "assert";
import {
  crc16,
  buildReadRequest,
  buildWriteRequest,
  expectedResponseLength,
  parseReadResponse,
  parseWriteResponse,
  toSigned,
  ModbusError,
} from "../src/protocol/modbus";
import {
  decodeStatus,
  decodeSettings,
  decodeFlags,
  decodeAlarms,
  decodeMode,
  buildControlWrite,
  RegisterMap,
} from "../src/protocol/smg";

const hex = (s: string) => Buffer.from(s.replace(/\s+/g, ""), "hex");

// 1. Эталонные кадры, снятые с живого SK-5500P-48L (сессия 2026-07-23).
//    Запрос чтения регистра 201 (режим) и реальные ответы инвертора.
assert.deepStrictEqual(buildReadRequest(1, 201, 1), hex("01 03 00 c9 00 01 54 34"), "read frame reg 201");
assert.deepStrictEqual(buildReadRequest(1, 215, 1), hex("01 03 00 d7 00 01 34 32"), "read frame reg 215");

const LIVE: Array<[string, string, number]> = [
  ["mode", "01 03 02 00 03 f8 45", 3], //          режим Off-Grid
  ["ac voltage", "01 03 02 09 17 fe 1a", 2327], // 232.7 В
  ["battery voltage", "01 03 02 02 0a 39 23", 522], // 52.2 В
  ["soc", "01 03 02 00 48 b8 72", 72], //          72 %
];
for (const [name, frame, value] of LIVE) {
  const [v] = parseReadResponse(hex(frame), 1, 1);
  assert.strictEqual(v, value, `live etalon: ${name}`);
}

// 2. CRC-16/Modbus: подтверждение на живом запросе (в кадре — little-endian: 54 34).
assert.strictEqual(crc16(hex("01 03 00 c9 00 01")), 0x3454, "crc16 of read request");

// 3. Кадр записи (fn 0x10 — единственный, который понимает устройство) и эхо.
const writeReq = buildWriteRequest(1, 331, [3]);
assert.strictEqual(writeReq[1], 0x10, "write uses fn 0x10");
assert.strictEqual(writeReq.length, 11, "write frame length");
assert.strictEqual(expectedResponseLength(writeReq), 8);
// Эхо конструируем как устройство: slave, fn, addr, count + CRC.
{
  const echoBody = Buffer.from([1, 0x10, 331 >> 8, 331 & 0xff, 0, 1]);
  const c = crc16(echoBody);
  const echo = Buffer.concat([echoBody, Buffer.from([c & 0xff, (c >> 8) & 0xff])]);
  parseWriteResponse(echo, 1, 331, 1); // не должно бросить
}

// 4. Ответ-исключение разбирается в ModbusError с кодом.
{
  const exBody = Buffer.from([1, 0x83, 0x02]);
  const c = crc16(exBody);
  const ex = Buffer.concat([exBody, Buffer.from([c & 0xff, (c >> 8) & 0xff])]);
  assert.throws(
    () => parseReadResponse(ex, 1, 1),
    (e: unknown) => e instanceof ModbusError && e.exceptionCode === 2,
    "exception frame"
  );
}

// 5. Битые CRC отклоняются.
assert.throws(() => parseReadResponse(hex("01 03 02 00 03 f8 46"), 1, 1), /CRC/, "bad crc");

// 6. expectedResponseLength для чтения.
assert.strictEqual(expectedResponseLength(buildReadRequest(1, 201, 17)), 3 + 34 + 2);

// 7. Знаковые значения (S_WORD): ток батареи −1.0 А = 0xFFF6.
assert.strictEqual(toSigned(0xfff6), -10);
assert.strictEqual(toSigned(0x020a), 522);

// 8. Декодер статуса: маппинг регистров и масштабы.
{
  const regs: RegisterMap = new Map<number, number>([
    [201, 2],
    [202, 2327],
    [203, 5001],
    [204, 150],
    [208, 600],
    [210, 2298],
    [212, 5000],
    [213, 600],
    [214, 690],
    [215, 522],
    [217, 0x10000 - 520], // −520 Вт (разряд)
    [219, 2805],
    [220, 114],
    [223, 3200],
    [224, 2680],
    [225, 11],
    [226, 41],
    [227, 43],
    [229, 72],
    [232, 0x10000 - 100], // −10.0 А → разряд
  ]);
  const st = decodeStatus(regs);
  assert.strictEqual(st.gridVoltage, 232.7);
  assert.strictEqual(st.gridFrequency, 50.01);
  assert.strictEqual(st.acOutputVoltage, 229.8);
  assert.strictEqual(st.acOutputActivePower, 600);
  assert.strictEqual(st.batteryVoltage, 52.2);
  assert.strictEqual(st.batteryPower, -520);
  assert.strictEqual(st.batteryChargingCurrent, 0);
  assert.strictEqual(st.batteryDischargeCurrent, 10);
  assert.strictEqual(st.batteryCapacity, 72);
  assert.strictEqual(st.pvPower, 3200);
  assert.strictEqual(st.pvChargingPower, 2680);
  assert.strictEqual(st.heatSinkTemperature, 43);
  assert.strictEqual(decodeMode(regs.get(201)!), "Line");
}

// 9. Декодер настроек.
{
  const regs: RegisterMap = new Map<number, number>([
    [300, 0],
    [301, 2],
    [302, 0],
    [303, 1],
    [305, 1],
    [306, 1],
    [307, 0],
    [310, 1],
    [313, 0],
    [320, 2300],
    [321, 5000],
    [322, 3],
    [324, 564],
    [325, 540],
    [326, 540],
    [327, 460],
    [329, 420],
    [331, 1],
    [332, 600],
    [333, 300],
    [341, 30],
    [342, 80],
    [343, 10],
    [643, 5500],
  ]);
  const info = decodeSettings(regs);
  assert.strictEqual(info.outputSourcePriority, 2); // SBU
  assert.strictEqual(info.chargerSourcePriority, 1); // PV first
  assert.strictEqual(info.maxChargingCurrent, 60);
  assert.strictEqual(info.maxAcChargingCurrent, 30);
  assert.strictEqual(info.batteryRechargeVoltage, 46);
  assert.strictEqual(info.batteryRedischargeVoltage, 54);
  assert.strictEqual(info.batteryBulkVoltage, 56.4);
  assert.strictEqual(info.batteryUnderVoltage, 42);
  assert.strictEqual(info.batteryType, 3); // Li1
  assert.strictEqual(info.socBackToUtility, 30);
  assert.strictEqual(info.acOutputRatingActivePower, 5500);

  const flags = decodeFlags(regs);
  assert.strictEqual(flags.flags.find((f) => f.key === "lcdHome")?.enabled, true);
  assert.strictEqual(flags.flags.find((f) => f.key === "ecoMode")?.enabled, false);
  assert.strictEqual(flags.flags.find((f) => f.key === "overloadBypass")?.enabled, true);
}

// 10. Fault/warning-маски (32 бита каждая).
{
  const regs: RegisterMap = new Map<number, number>([
    [100, 0],
    [101, 1 << 6], // Output over load (бит 6 fault)
    [108, 0],
    [109, (1 << 3) | (1 << 8)], // Mains low voltage + Battery low voltage
  ]);
  const w = decodeAlarms(regs);
  assert.deepStrictEqual(w.active, ["Output over load", "Mains low voltage", "Battery low voltage"]);
}
{
  const w = decodeAlarms(
    new Map([
      [100, 0],
      [101, 0],
      [108, 0],
      [109, 0],
    ])
  );
  assert.deepStrictEqual(w.active, []);
}

// 11. Сеттеры: регистры, масштаб ×10 для токов/напряжений, валидация.
assert.deepStrictEqual(buildControlWrite("outputSourcePriority", 2).register, 301);
assert.deepStrictEqual(buildControlWrite("chargerSourcePriority", 3), {
  register: 331,
  rawValue: 3,
  label: "charger priority = Only PV",
});
assert.strictEqual(buildControlWrite("maxChargingCurrent", 60).rawValue, 600);
assert.strictEqual(buildControlWrite("maxAcChargingCurrent", 30).rawValue, 300);
assert.strictEqual(buildControlWrite("batteryRechargeVoltage", 46).register, 327);
assert.strictEqual(buildControlWrite("batteryRechargeVoltage", 46).rawValue, 460);
assert.strictEqual(buildControlWrite("batteryRedischargeVoltage", 54).register, 326);
assert.throws(() => buildControlWrite("maxChargingCurrent", 55), /must be one of/);
assert.throws(() => buildControlWrite("batteryRechargeVoltage", 70), /out of range/);
assert.throws(() => buildControlWrite("outputSourcePriority", 9), /Invalid/);

console.log("selfcheck OK");
