import { Transport } from "./types";

/**
 * Serial (RS232 via USB adapter, or a CDC USB port) transport.
 * serialport is an optional dependency; it is required lazily so the app still
 * runs (in mock mode) if the native module failed to install.
 */
export class SerialTransport implements Transport {
  readonly name = "serial";
  readonly mock = false;
  readonly device: string;
  private baudRate: number;
  private port: any = null;
  private lastAsyncError: Error | null = null;

  constructor(device: string, baudRate: number) {
    this.device = device;
    this.baudRate = baudRate;
  }

  static isAvailable(): boolean {
    try {
      require.resolve("serialport");
      return true;
    } catch {
      return false;
    }
  }

  static async list(): Promise<string[]> {
    try {
      const { SerialPort } = require("serialport");
      const ports = await SerialPort.list();
      return ports.map((p: any) => p.path).filter(Boolean);
    } catch {
      return [];
    }
  }

  async open(): Promise<void> {
    const { SerialPort } = require("serialport");
    await new Promise<void>((resolve, reject) => {
      this.port = new SerialPort(
        { path: this.device, baudRate: this.baudRate, autoOpen: false },
        (err: Error | null) => {
          if (err) reject(err);
        }
      );
      this.port.open((err: Error | null) => (err ? reject(err) : resolve()));
    });
    // Persistent error listener: serialport emits async 'error' events (e.g. the
    // device is unplugged); without a listener Node treats it as fatal. Capture
    // it here so it never becomes an uncaught exception.
    this.port.on("error", (e: Error) => {
      this.lastAsyncError = e;
    });
  }

  async close(): Promise<void> {
    if (this.port && this.port.isOpen) {
      await new Promise<void>((resolve) => this.port.close(() => resolve()));
    }
    this.port = null;
  }

  transact(frame: Buffer, timeoutMs: number): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      if (!this.port || !this.port.isOpen) {
        return reject(new Error("Serial port not open"));
      }
      const chunks: Buffer[] = [];
      let done = false;

      const cleanup = () => {
        this.port.removeListener("data", onData);
        this.port.removeListener("error", onError);
        clearTimeout(timer);
      };
      const finish = (buf: Buffer) => {
        if (done) return;
        done = true;
        cleanup();
        resolve(buf);
      };
      const fail = (err: Error) => {
        if (done) return;
        done = true;
        cleanup();
        reject(err);
      };

      const onData = (data: Buffer) => {
        chunks.push(data);
        const acc = Buffer.concat(chunks);
        if (acc.includes(0x0d)) finish(acc);
      };
      const onError = (err: Error) => fail(err);
      const timer = setTimeout(() => fail(new Error(`Serial timeout after ${timeoutMs}ms`)), timeoutMs);

      this.port.on("data", onData);
      this.port.on("error", onError);
      // Discard any stale bytes (e.g. the tail of a previously timed-out reply)
      // so they can't be glued onto this transaction's response.
      this.port.flush(() => {
        if (done) return;
        this.port.write(frame, (err: Error | null) => {
          if (err) fail(err);
        });
      });
    });
  }
}
