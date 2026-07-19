import { Transport } from "./types";
import { buildResponse, commandFromFrame } from "../protocol/crc";

/**
 * Simulated inverter for when no hardware is attached. Emits plausible,
 * time-varying data so the whole UI/API is fully exercisable, and accepts
 * setter commands (updating internal state and replying ACK).
 */
export class MockTransport implements Transport {
  readonly name = "mock";
  readonly mock = true;
  readonly device = null;

  // Mutable settings the setter commands change.
  private outputSourcePriority = 2; // SBU
  private chargerSourcePriority = 1; // Solar first
  private maxChargingCurrent = 60;
  private maxAcChargingCurrent = 30;
  private batteryRechargeVoltage = 46.0;
  private batteryRedischargeVoltage = 54.0;
  private batteryCapacity = 78;

  async open(): Promise<void> {
    /* nothing to open */
  }
  async close(): Promise<void> {
    /* nothing to close */
  }

  async transact(frame: Buffer, _timeoutMs: number): Promise<Buffer> {
    const cmd = commandFromFrame(frame);
    // Small artificial latency to feel real.
    await new Promise((r) => setTimeout(r, 30));
    return buildResponse(this.respond(cmd));
  }

  private respond(cmd: string): string {
    if (cmd === "QPIGS") return this.status();
    if (cmd === "QMOD") return this.mode();
    if (cmd === "QPIRI") return this.rated();
    if (cmd === "QPIWS") return "00000000000000000000000000000000";
    if (cmd === "QFLAG") return "EbkuvxyzDaj";
    if (cmd === "QID") return "SK5500P48L-MOCK-0001";
    if (cmd === "QVFW") return "VERFW:00012.34";

    // Setters
    let m: RegExpMatchArray | null;
    if ((m = cmd.match(/^POP0(\d)$/))) {
      this.outputSourcePriority = parseInt(m[1], 10);
      return "ACK";
    }
    if ((m = cmd.match(/^PCP0(\d)$/))) {
      this.chargerSourcePriority = parseInt(m[1], 10);
      return "ACK";
    }
    if ((m = cmd.match(/^MCHGC(\d{3})$/))) {
      this.maxChargingCurrent = parseInt(m[1], 10);
      return "ACK";
    }
    if ((m = cmd.match(/^MUCHGC(\d{3})$/))) {
      this.maxAcChargingCurrent = parseInt(m[1], 10);
      return "ACK";
    }
    if ((m = cmd.match(/^PBCV(\d\d\.\d)$/))) {
      this.batteryRechargeVoltage = parseFloat(m[1]);
      return "ACK";
    }
    if ((m = cmd.match(/^PBDV(\d\d\.\d)$/))) {
      this.batteryRedischargeVoltage = parseFloat(m[1]);
      return "ACK";
    }
    return "NAK";
  }

  private daylight(): number {
    // 0..1 solar factor based on local hour, peak ~13:00.
    const h = new Date().getHours() + new Date().getMinutes() / 60;
    const f = Math.cos(((h - 13) / 7) * (Math.PI / 2));
    return Math.max(0, Math.min(1, f));
  }

  private status(): string {
    const sun = this.daylight();
    const jitter = (base: number, amp: number) => base + (Math.random() - 0.5) * amp;

    const pvVoltage = sun > 0.05 ? jitter(280, 20) : 0;
    const pvPower = Math.round(sun * jitter(3200, 300));
    const loadPower = Math.round(jitter(600, 250));
    const loadVA = Math.round(loadPower * 1.15);
    const batteryVoltage = jitter(52.4, 0.6);

    // Charge if surplus solar, discharge otherwise.
    const surplus = pvPower - loadPower;
    const chargeCurrent = surplus > 0 ? Math.min(this.maxChargingCurrent, Math.round(surplus / batteryVoltage)) : 0;
    const dischargeCurrent = surplus < 0 ? Math.round(-surplus / batteryVoltage) : 0;
    const pvChargeCurrent = pvPower > 0 ? +(pvPower / Math.max(1, pvVoltage)).toFixed(1) : 0;

    // Drift battery capacity slowly.
    this.batteryCapacity = Math.max(20, Math.min(100, this.batteryCapacity + (surplus > 0 ? 0.05 : -0.05)));

    const loadPercent = Math.round((loadPower / 5500) * 100);
    const temp = Math.round(jitter(38 + sun * 12, 3));

    const fields = [
      "230.0", // grid voltage
      "50.0", // grid freq
      "230.0", // ac out voltage
      "50.0", // ac out freq
      String(loadVA).padStart(4, "0"),
      String(loadPower).padStart(4, "0"),
      String(loadPercent).padStart(3, "0"),
      "410", // bus voltage
      batteryVoltage.toFixed(2),
      String(chargeCurrent).padStart(3, "0"),
      String(Math.round(this.batteryCapacity)).padStart(3, "0"),
      String(temp).padStart(4, "0"),
      pvChargeCurrent.toFixed(1).padStart(4, "0"),
      pvVoltage.toFixed(1),
      batteryVoltage.toFixed(2), // scc voltage
      String(dischargeCurrent).padStart(5, "0"),
      "00010101", // device status bits
      "00",
      "00",
      String(pvPower).padStart(5, "0"),
      "010",
    ];
    return fields.join(" ");
  }

  private mode(): string {
    const sun = this.daylight();
    return sun > 0.1 ? "L" : "B"; // Line during day, Battery at night
  }

  private rated(): string {
    const fields = [
      "230.0",
      "23.9",
      "230.0",
      "50.0",
      "23.9",
      "5500",
      "5500",
      "48.0",
      this.batteryRechargeVoltage.toFixed(1),
      "42.0",
      "56.4",
      "54.0",
      "0", // battery type
      String(this.maxAcChargingCurrent).padStart(3, "0"),
      String(this.maxChargingCurrent).padStart(3, "0"),
      "0",
      String(this.outputSourcePriority),
      String(this.chargerSourcePriority),
      "1",
      "1",
      "0",
      "0",
      this.batteryRedischargeVoltage.toFixed(1),
    ];
    return fields.join(" ");
  }
}
