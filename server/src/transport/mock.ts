import { Transport } from "./types";
import { crc16 } from "../protocol/modbus";

/**
 * Simulated SMG II inverter for when no hardware is attached: a tiny Modbus
 * RTU slave with plausible, time-varying register values. The whole UI/API is
 * fully exercisable; writes (fn 0x10) update the register map and are echoed
 * back like the real device does.
 */
export class MockTransport implements Transport {
  readonly name = "mock";
  readonly mock = true;
  readonly device = null;

  private regs = new Map<number, number>();
  private soc = 78; // %

  constructor() {
    // Настройки (as-found). Масштабы устройства: напряжения ×0.1 и т.д.
    const seed: Array<[number, number]> = [
      [300, 0], // output mode: Single
      [301, 2], // output priority: SBU
      [302, 0], // input range: Wide
      [303, 1], // buzzer: on changes/warnings/faults
      [305, 1], // LCD always on
      [306, 1],
      [307, 0],
      [308, 1],
      [309, 1],
      [310, 1],
      [313, 0],
      [320, 2300], // out 230.0 V
      [321, 5000], // out 50.00 Hz
      [322, 3], // battery: Li1
      [323, 576], // overvoltage 57.6
      [324, 564], // bulk 56.4
      [325, 540], // float 54.0
      [326, 540], // back to battery 54.0
      [327, 460], // back to grid 46.0
      [329, 420], // off-grid cutoff 42.0
      [331, 1], // charge: PV first
      [332, 600], // max charge 60.0 A
      [333, 300], // max AC charge 30.0 A
      [334, 564],
      [335, 60],
      [336, 120],
      [337, 30],
      [341, 30], // SOC back to utility
      [342, 80], // SOC back to battery
      [343, 10], // SOC cutoff
      [643, 5500], // rated power
      [100, 0],
      [101, 0],
      [108, 0],
      [109, 0],
    ];
    for (const [a, v] of seed) this.regs.set(a, v);
    this.tick();
  }

  async open(): Promise<void> {
    /* nothing to open */
  }
  async close(): Promise<void> {
    /* nothing to close */
  }

  async transact(frame: Buffer, _timeoutMs: number, _expectedLen: number): Promise<Buffer> {
    await new Promise((r) => setTimeout(r, 20)); // лёгкая «настоящая» задержка
    const slave = frame[0];
    const fn = frame[1];
    if (fn === 0x03) {
      this.tick();
      const addr = frame.readUInt16BE(2);
      const count = frame.readUInt16BE(4);
      const body = Buffer.alloc(3 + count * 2);
      body[0] = slave;
      body[1] = 0x03;
      body[2] = count * 2;
      for (let i = 0; i < count; i++) {
        body.writeUInt16BE((this.regs.get(addr + i) ?? 0) & 0xffff, 3 + i * 2);
      }
      return this.withCrc(body);
    }
    if (fn === 0x10) {
      const addr = frame.readUInt16BE(2);
      const count = frame.readUInt16BE(4);
      for (let i = 0; i < count; i++) {
        this.regs.set(addr + i, frame.readUInt16BE(7 + i * 2));
      }
      // Эхо: slave, fn, addr, count.
      const body = Buffer.alloc(6);
      body[0] = slave;
      body[1] = 0x10;
      body.writeUInt16BE(addr, 2);
      body.writeUInt16BE(count, 4);
      return this.withCrc(body);
    }
    // Illegal function — как ответило бы устройство.
    const body = Buffer.from([slave, fn | 0x80, 0x01]);
    return this.withCrc(body);
  }

  private withCrc(body: Buffer): Buffer {
    const c = crc16(body);
    return Buffer.concat([body, Buffer.from([c & 0xff, (c >> 8) & 0xff])]);
  }

  private set(addr: number, value: number): void {
    this.regs.set(addr, Math.round(value) & 0xffff);
  }
  private setSigned(addr: number, value: number): void {
    const v = Math.round(value);
    this.regs.set(addr, (v < 0 ? v + 0x10000 : v) & 0xffff);
  }

  /** 0..1 solar factor based on local hour, peak ~13:00. */
  private daylight(): number {
    const h = new Date().getHours() + new Date().getMinutes() / 60;
    const f = Math.cos(((h - 13) / 7) * (Math.PI / 2));
    return Math.max(0, Math.min(1, f));
  }

  /** Обновить статусные регистры правдоподобной динамикой. */
  private tick(): void {
    const sun = this.daylight();
    const jitter = (base: number, amp: number) => base + (Math.random() - 0.5) * amp;

    const pvVoltage = sun > 0.05 ? jitter(280, 20) : 0;
    const pvPower = Math.round(sun * jitter(3200, 300));
    const loadPower = Math.round(jitter(600, 250));
    const loadVA = Math.round(loadPower * 1.15);
    const batteryVoltage = jitter(52.4, 0.6);

    const surplus = pvPower - loadPower;
    const maxChargeA = (this.regs.get(332) ?? 600) / 10;
    const battA = surplus > 0 ? Math.min(maxChargeA, surplus / batteryVoltage) : surplus / batteryVoltage;
    this.soc = Math.max(20, Math.min(100, this.soc + (surplus > 0 ? 0.05 : -0.05)));

    const gridOk = true;
    const mode = sun > 0.1 ? 2 : 3; // днём Mains, ночью Off-Grid

    this.set(201, mode);
    this.setSigned(202, gridOk ? jitter(2300, 30) : 0); // 230.0 V ×0.1
    this.setSigned(203, 5000); // 50.00 Hz ×0.01
    this.setSigned(204, Math.max(0, -surplus)); // от сети докрываем дефицит
    this.setSigned(205, 2300);
    this.setSigned(206, Math.round((loadPower / 230) * 10));
    this.setSigned(207, 5000);
    this.setSigned(208, loadPower);
    this.setSigned(209, battA > 0 ? Math.round(battA * batteryVoltage) : 0);
    this.setSigned(210, jitter(2300, 20));
    this.setSigned(211, Math.round((loadPower / 230) * 10));
    this.setSigned(212, 5000);
    this.setSigned(213, loadPower);
    this.setSigned(214, loadVA);
    this.setSigned(215, Math.round(batteryVoltage * 10));
    this.setSigned(216, Math.round(battA * 10));
    this.setSigned(217, Math.round(battA * batteryVoltage));
    this.setSigned(219, Math.round(pvVoltage * 10));
    this.setSigned(220, pvVoltage > 0 ? Math.round((pvPower / pvVoltage) * 10) : 0);
    this.setSigned(223, pvPower);
    this.setSigned(224, battA > 0 ? Math.round(battA * batteryVoltage) : 0);
    this.setSigned(225, Math.round((loadPower / 5500) * 100));
    this.setSigned(226, Math.round(jitter(36 + sun * 10, 3)));
    this.setSigned(227, Math.round(jitter(38 + sun * 12, 3)));
    this.set(229, Math.round(this.soc));
    this.setSigned(232, Math.round(battA * 10));
    this.setSigned(233, 0);
    this.setSigned(234, battA > 0 ? Math.round(battA * 10) : 0);
  }
}
