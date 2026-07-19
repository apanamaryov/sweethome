import assert from "assert";
import { crc16, buildFrame, parseFrame, buildResponse, commandFromFrame } from "../src/protocol/crc";
import {
  parseStatus,
  parseRatedInfo,
  parseFlags,
  parseMode,
  parseWarnings,
  buildControlCommand,
  isAck,
} from "../src/protocol/pi30";

// 1. CRC-эталоны (сверены с mpp-solar/skymax в сессии 2026-07-17)
const CRC_ETALONS: Array<[string, string]> = [
  ["QPIGS", "b7a9"],
  ["QPIRI", "f854"],
  ["QMOD", "49c1"],
  ["QPIWS", "b4da"],
  ["QID", "d6ea"],
];
for (const [cmd, hex] of CRC_ETALONS) {
  assert.strictEqual(crc16(Buffer.from(cmd, "ascii")).toString("hex"), hex, `CRC(${cmd})`);
}

// 2. Раундтрип кадров (запрос и ответ)
const frame = buildFrame("QPIGS");
assert.strictEqual(commandFromFrame(frame), "QPIGS");
assert.strictEqual(frame[frame.length - 1], 0x0d);
const payload =
  "230.0 50.0 230.0 50.0 0690 0600 010 410 52.40 000 078 0043 00.0 000.0 52.40 00015 00010101 00 00 00000 010";
assert.strictEqual(parseFrame(buildResponse(payload)), payload);

// 3. QPIGS: маппинг позиций
const st = parseStatus(payload);
assert.strictEqual(st.gridVoltage, 230);
assert.strictEqual(st.acOutputActivePower, 600);
assert.strictEqual(st.batteryVoltage, 52.4);
assert.strictEqual(st.batteryCapacity, 78);
assert.strictEqual(st.batteryDischargeCurrent, 15);
assert.strictEqual(st.deviceStatus, "00010101");
assert.strictEqual(st.pvChargingPower, 0);

// 4. QPIRI: маппинг позиций ключевых настроек
const rated = parseRatedInfo(
  "230.0 23.9 230.0 50.0 23.9 5500 5500 48.0 46.0 42.0 56.4 54.0 0 030 060 0 2 1 1 1 0 0 54.0"
);
assert.strictEqual(rated.acOutputRatingActivePower, 5500);
assert.strictEqual(rated.batteryRechargeVoltage, 46);
assert.strictEqual(rated.maxAcChargingCurrent, 30);
assert.strictEqual(rated.maxChargingCurrent, 60);
assert.strictEqual(rated.outputSourcePriority, 2);
assert.strictEqual(rated.chargerSourcePriority, 1);
assert.strictEqual(rated.batteryRedischargeVoltage, 54);

// 5. QFLAG / QMOD / QPIWS
const flags = parseFlags("EbkuvxyzDaj");
assert.strictEqual(flags.flags.filter((f) => f.enabled).length, 7);
assert.strictEqual(flags.flags.find((f) => f.key === "a")?.enabled, false);
assert.strictEqual(parseMode("B"), "Battery");
const warn = parseWarnings("00000100000000000000000000000000");
assert.deepStrictEqual(warn.active, ["Line fail (no utility)"]);

// 6. Сеттеры: точный формат провода (PBCV с точкой — критично для железа)
assert.strictEqual(buildControlCommand("outputSourcePriority", 2), "POP02");
assert.strictEqual(buildControlCommand("chargerSourcePriority", 3), "PCP03");
assert.strictEqual(buildControlCommand("maxChargingCurrent", 60), "MCHGC060");
assert.strictEqual(buildControlCommand("maxAcChargingCurrent", 2), "MUCHGC002");
assert.strictEqual(buildControlCommand("batteryRechargeVoltage", 46), "PBCV46.0");
assert.strictEqual(buildControlCommand("batteryRedischargeVoltage", 54), "PBDV54.0");
assert.strictEqual(isAck(" ACK "), true);
assert.throws(() => buildControlCommand("maxChargingCurrent", 55));

console.log("selfcheck OK");
