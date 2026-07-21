import { Transport } from "./types";

/**
 * USB-HID transport for Voltronic inverters whose USB port enumerates as a
 * HID-UART bridge (very common: VID 0x0665 / PID 0x5161, Cypress-based).
 *
 * The command frame is written in 8-byte HID reports; responses arrive as
 * 8-byte reports and are accumulated until the terminating CR (0x0d).
 *
 * node-hid is an optional dependency and required lazily. NOTE: exact HID report
 * framing can vary slightly between clones — validate against the real dongle;
 * the serial path is the more portable fallback.
 */
const KNOWN_HID = [{ vendorId: 0x0665, productId: 0x5161 }];

/**
 * Pause between consecutive 8-byte reports of one command. The bridge drains
 * its tiny buffer into the inverter's UART at 2400 baud (~33 ms per report),
 * so back-to-back reports can overflow it and corrupt long (setter) commands.
 * 350 ms matches the field-proven pacing used by mpp-solar.
 */
const REPORT_PACING_MS = 350;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class HidTransport implements Transport {
  readonly name = "hid";
  readonly mock = false;
  readonly device: string;
  private vendorId: number;
  private productId: number;
  private path: string | null;
  private dev: any = null;
  /** Response bytes received so far (zero padding already stripped). */
  private rx: number[] = [];
  /** The pending transact() waiting for a CR-terminated reply. */
  private waiter: { resolve: (b: Buffer) => void; reject: (e: Error) => void } | null = null;

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
    this.rx = [];
    // Event-driven reads: node-hid pumps reports in on a background thread.
    // The synchronous readTimeout() alternative blocks the whole Node event
    // loop for the duration of a read (~0.5 s per QPIGS reply at 2400 baud,
    // or the full timeout when the device is silent), freezing HTTP/WS.
    this.dev.on("data", (report: Buffer) => {
      for (const b of report) {
        // Reports are zero-padded; NUL is never valid in the ASCII protocol
        // and embedded padding would corrupt the CRC check.
        if (b !== 0x00) this.rx.push(b);
      }
      this.deliver();
    });
    // Without an 'error' listener an unplug mid-read would crash the process
    // (unhandled EventEmitter error from the read thread).
    this.dev.on("error", (e: unknown) => {
      const w = this.waiter;
      this.waiter = null;
      if (w) w.reject(e instanceof Error ? e : new Error(String(e)));
    });
  }

  /** Hand a complete CR-terminated reply to the pending transact, if any. */
  private deliver(): void {
    if (!this.waiter) return;
    const end = this.rx.indexOf(0x0d);
    if (end < 0) return;
    const reply = Buffer.from(this.rx.slice(0, end + 1));
    this.rx = []; // anything past the CR is padding/junk
    const w = this.waiter;
    this.waiter = null;
    w.resolve(reply);
  }

  async close(): Promise<void> {
    const w = this.waiter;
    this.waiter = null;
    if (w) w.reject(new Error("HID device closed"));
    try {
      if (this.dev) {
        this.dev.removeAllListeners();
        this.dev.close();
      }
    } catch {
      /* ignore */
    }
    this.dev = null;
  }

  async transact(frame: Buffer, timeoutMs: number): Promise<Buffer> {
    if (!this.dev) throw new Error("HID device not open");
    // The Inverter command queue serializes transactions; this is a belt-and-
    // braces guard against a future caller bypassing it.
    if (this.waiter) throw new Error("HID transaction already in progress");

    // Write in 8-byte reports (zero-padded). hidapi expects the first byte of
    // every write to be the report ID; these devices use unnumbered reports,
    // so it must be 0x00 (otherwise the first command byte is eaten as the ID).
    for (let i = 0; i < frame.length; i += 8) {
      if (i > 0) await sleep(REPORT_PACING_MS);
      const chunk = Array.from(frame.subarray(i, i + 8));
      while (chunk.length < 8) chunk.push(0x00);
      this.dev.write([0x00, ...chunk]);
    }

    // Discard anything received before/while writing — it can only be the
    // late tail of a previously timed-out reply, and gluing it onto this
    // transaction's response would corrupt (or worse, plausibly fake) it.
    // The real reply cannot start before the final CR chunk above is sent.
    this.rx = [];

    return new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        reject(new Error(`HID timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      this.waiter = {
        resolve: (b) => {
          clearTimeout(timer);
          resolve(b);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      };
      // In case a full reply raced in between the last write and installing
      // the waiter, deliver it now instead of waiting for a 'data' event
      // that will never come.
      this.deliver();
    });
  }
}
