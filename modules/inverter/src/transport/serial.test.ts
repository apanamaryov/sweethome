/**
 * Unit tests for SerialTransport (server/src/transport/serial.ts).
 *
 * serial.ts imports the real npm package lazily via plain `require("serialport")`
 * calls inside its methods (open/list) and `require.resolve("serialport")` in
 * isAvailable() — never a top-level `import`. So `jest.mock("serialport", factory)`
 * intercepts every one of those calls transparently, without needing
 * `{ virtual: true }` (the optionalDependency IS installed in this monorepo's
 * hoisted root node_modules, so real resolution also succeeds — but we never
 * touch the real native binding; the factory below fully replaces its exports).
 *
 * The factory is self-contained (references only `jest`/`require`, nothing
 * declared later in this file) so it is safe regardless of jest.mock hoisting.
 * Test bodies reach the fake port instances created by `new SerialPort(...)`
 * through the mocked module's `__instances` array, exposed via
 * `jest.requireMock("serialport")`.
 */

import {
  buildReadRequest,
  crc16,
  expectedResponseLength,
} from "../protocol/modbus";

/** Structural shape of the fake port instances, as seen from test bodies. */
interface FakePortLike {
  isOpen: boolean;
  writes: Buffer[];
  closeCalls: number;
  flushCalls: number;
  openError: Error | null;
  writeError: Error | null;
  on(event: string, listener: (...args: any[]) => void): void;
  removeListener(event: string, listener: (...args: any[]) => void): void;
  emit(event: string, ...args: any[]): boolean;
}

jest.mock("serialport", () => {
  const { EventEmitter } = require("events");

  class FakeSerialPort extends EventEmitter {
    isOpen = false;
    writes: Buffer[] = [];
    closeCalls = 0;
    flushCalls = 0;
    openError: Error | null = null;
    writeError: Error | null = null;

    open(cb: (err: Error | null) => void) {
      if (this.openError) {
        cb(this.openError);
        return;
      }
      this.isOpen = true;
      cb(null);
    }

    close(cb: () => void) {
      this.closeCalls++;
      this.isOpen = false;
      cb();
    }

    flush(cb: () => void) {
      this.flushCalls++;
      cb();
    }

    write(data: Buffer, cb: (err: Error | null) => void) {
      this.writes.push(Buffer.from(data));
      cb(this.writeError);
    }
  }

  const instances: FakeSerialPort[] = [];

  const SerialPort = jest.fn().mockImplementation(function (
    _opts: unknown,
    callback?: (err: Error | null) => void
  ) {
    const port = new FakeSerialPort();
    instances.push(port);
    // Real serialport invokes this callback only on a *construction* error;
    // serial.ts relies on port.open()'s own callback for the actual open.
    if (callback) callback(null);
    return port;
  });

  return { SerialPort, __instances: instances };
});

import { SerialTransport } from "./serial";

const serialportMock = jest.requireMock("serialport") as {
  SerialPort: jest.Mock;
  __instances: FakePortLike[];
};

/** Most recently constructed fake port (the one `serial.ts` is now driving). */
function latestPort(): FakePortLike {
  const port = serialportMock.__instances[serialportMock.__instances.length - 1];
  if (!port) throw new Error("no fake SerialPort was constructed");
  return port;
}

/** Builds a valid fn 0x03 read-response frame: slave, fn, byteCount, data, crc. */
function readResponseFrame(slave: number, values: number[]): Buffer {
  const byteCount = values.length * 2;
  const data = Buffer.alloc(byteCount);
  values.forEach((v, i) => data.writeUInt16BE(v, i * 2));
  const body = Buffer.concat([Buffer.from([slave, 0x03, byteCount]), data]);
  const c = crc16(body);
  return Buffer.concat([body, Buffer.from([c & 0xff, (c >> 8) & 0xff])]);
}

beforeEach(() => {
  serialportMock.__instances.length = 0;
});

describe("SerialTransport.isAvailable", () => {
  it("returns true when the serialport module resolves (mock present)", () => {
    expect(SerialTransport.isAvailable()).toBe(true);
  });
});

describe("SerialTransport open/close", () => {
  it("open() constructs and opens the underlying port", async () => {
    const t = new SerialTransport("/dev/ttyFAKE0", 9600);
    await t.open();
    const port = latestPort();
    expect(serialportMock.SerialPort).toHaveBeenCalledTimes(1);
    expect(serialportMock.SerialPort).toHaveBeenCalledWith(
      { path: "/dev/ttyFAKE0", baudRate: 9600, autoOpen: false },
      expect.any(Function)
    );
    expect(port.isOpen).toBe(true);
  });

  it("close() calls the mock port's close and clears isOpen", async () => {
    const t = new SerialTransport("/dev/ttyFAKE1", 9600);
    await t.open();
    const port = latestPort();

    await t.close();

    expect(port.closeCalls).toBe(1);
    expect(port.isOpen).toBe(false);
  });

  it("close() is a no-op when the port was never opened", async () => {
    const t = new SerialTransport("/dev/ttyFAKE2", 9600);
    await expect(t.close()).resolves.toBeUndefined();
  });
});

describe("SerialTransport.transact — happy path", () => {
  it("writes the frame to the port and resolves with the accumulated response", async () => {
    const t = new SerialTransport("/dev/ttyFAKE3", 9600);
    await t.open();
    const port = latestPort();

    // Real documented frame pair (register 201 = mode, addr 0x00C9): the
    // request/response bytes recorded in CLAUDE.md against the live inverter.
    const req = buildReadRequest(1, 201, 1);
    const want = expectedResponseLength(req); // 3 + 1*2 + 2 = 7
    const response = readResponseFrame(1, [3]);
    expect(response).toHaveLength(want);

    const promise = t.transact(req, 1000, want);

    // The frame is written synchronously (our fake's flush/write callbacks
    // fire immediately), so by the time transact() returns its promise the
    // write has already happened.
    expect(port.flushCalls).toBe(1);
    expect(port.writes).toEqual([req]);

    // Emit the response split across two 'data' events to exercise
    // accumulation (Buffer.concat over `chunks`), not just a single chunk.
    let settled = false;
    void promise.then(() => {
      settled = true;
    });

    port.emit("data", response.subarray(0, 3));
    await Promise.resolve();
    expect(settled).toBe(false); // not yet at expectedLen

    port.emit("data", response.subarray(3));
    const result = await promise;

    expect(settled).toBe(true);
    expect(result).toEqual(response);
  });

  it("short-circuits on a Modbus exception frame (5 bytes, fn|0x80) without waiting for expectedLen", async () => {
    const t = new SerialTransport("/dev/ttyFAKE4", 9600);
    await t.open();
    const port = latestPort();

    const req = buildReadRequest(1, 201, 1);
    const want = expectedResponseLength(req); // 7, never reached
    const promise = t.transact(req, 1000, want);

    const body = Buffer.from([1, 0x83, 0x02]); // fn 0x03 | 0x80, exception code 2
    const c = crc16(body);
    const exceptionFrame = Buffer.concat([body, Buffer.from([c & 0xff, (c >> 8) & 0xff])]);
    expect(exceptionFrame).toHaveLength(5);

    port.emit("data", exceptionFrame);
    const result = await promise;

    expect(result).toEqual(exceptionFrame);
  });
});

describe("SerialTransport.transact — timeout", () => {
  it("rejects when no data arrives before timeoutMs elapses", async () => {
    jest.useFakeTimers();
    try {
      const t = new SerialTransport("/dev/ttyFAKE5", 9600);
      await t.open();
      const port = latestPort();

      const req = buildReadRequest(1, 201, 1);
      const promise = t.transact(req, 500, expectedResponseLength(req));

      // Attach the rejection expectation before advancing timers so the
      // rejection is never unhandled, even for one microtask tick.
      const assertion = expect(promise).rejects.toThrow(/timeout/i);

      expect(port.writes).toHaveLength(1); // the write did happen...
      jest.advanceTimersByTime(500); // ...but no reply ever came

      await assertion;
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("SerialTransport.transact — not open", () => {
  it("rejects immediately if the port was never opened", async () => {
    const t = new SerialTransport("/dev/ttyFAKE6", 9600);
    await expect(t.transact(Buffer.from([1, 2, 3]), 1000, 7)).rejects.toThrow(/not open/i);
  });
});
