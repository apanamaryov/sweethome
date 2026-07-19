import { Transport } from "./types";

/**
 * USB-HID transport for Voltronic inverters whose USB port enumerates as a
 * HID-UART bridge (very common: VID 0x0665 / PID 0x5161, Cypress-based).
 *
 * The command frame is written in 8-byte HID reports; responses are read as
 * 8-byte reports and accumulated until the terminating CR (0x0d).
 *
 * node-hid is an optional dependency and required lazily. NOTE: exact HID report
 * framing can vary slightly between clones — validate against the real dongle;
 * the serial path is the more portable fallback.
 */
const KNOWN_HID = [{ vendorId: 0x0665, productId: 0x5161 }];

export class HidTransport implements Transport {
  readonly name = "hid";
  readonly mock = false;
  readonly device: string;
  private vendorId: number;
  private productId: number;
  private path: string | null;
  private dev: any = null;

  constructor(opts: { vendorId: number; productId: number; path?: string | null }) {
    this.vendorId = opts.vendorId;
    this.productId = opts.productId;
    this.path = opts.path ?? null;
    this.device = opts.path ?? `hid:${opts.vendorId.toString(16)}:${opts.productId.toString(16)}`;
  }

  static isAvailable(): boolean {
    try {
      require.resolve("node-hid");
      return true;
    } catch {
      return false;
    }
  }

  /** Return matching known inverter HID devices currently attached. */
  static find(): Array<{ vendorId: number; productId: number; path?: string }> {
    try {
      const HID = require("node-hid");
      const devices: any[] = HID.devices();
      return devices.filter((d) =>
        KNOWN_HID.some((k) => k.vendorId === d.vendorId && k.productId === d.productId)
      );
    } catch {
      return [];
    }
  }

  async open(): Promise<void> {
    const HID = require("node-hid");
    this.dev = this.path ? new HID.HID(this.path) : new HID.HID(this.vendorId, this.productId);
  }

  async close(): Promise<void> {
    try {
      if (this.dev) this.dev.close();
    } catch {
      /* ignore */
    }
    this.dev = null;
  }

  async transact(frame: Buffer, timeoutMs: number): Promise<Buffer> {
    if (!this.dev) throw new Error("HID device not open");

    // Write in 8-byte reports (zero-padded). hidapi expects the first byte of
    // every write to be the report ID; these devices use unnumbered reports,
    // so it must be 0x00 (otherwise the first command byte is eaten as the ID).
    for (let i = 0; i < frame.length; i += 8) {
      const chunk = Array.from(frame.subarray(i, i + 8));
      while (chunk.length < 8) chunk.push(0x00);
      this.dev.write([0x00, ...chunk]);
    }

    // Read reports until CR or deadline.
    const deadline = Date.now() + timeoutMs;
    const chunks: number[] = [];
    while (Date.now() < deadline) {
      const remaining = Math.max(1, deadline - Date.now());
      let report: number[] = [];
      try {
        report = this.dev.readTimeout(remaining);
      } catch (e) {
        throw new Error(`HID read error: ${(e as Error).message}`);
      }
      if (!report || report.length === 0) continue;
      for (const b of report) {
        // Reports are zero-padded; NUL is never valid in the ASCII protocol
        // and embedded padding would corrupt the CRC check.
        if (b === 0x00) continue;
        chunks.push(b);
        if (b === 0x0d) return Buffer.from(chunks);
      }
    }
    throw new Error(`HID timeout after ${timeoutMs}ms`);
  }
}
