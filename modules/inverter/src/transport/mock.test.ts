import { MockTransport } from "./mock";
import {
  buildReadRequest,
  buildWriteRequest,
  parseReadResponse,
  parseWriteResponse,
  expectedResponseLength,
  crc16,
  ModbusError,
} from "../protocol/modbus";

describe("MockTransport — identity", () => {
  it("reports the mock transport identity", () => {
    const t = new MockTransport();
    expect(t.name).toBe("mock");
    expect(t.mock).toBe(true);
    expect(t.device).toBeNull();
  });

  it("open()/close() resolve without doing anything real", async () => {
    const t = new MockTransport();
    await expect(t.open()).resolves.toBeUndefined();
    await expect(t.close()).resolves.toBeUndefined();
  });
});

describe("MockTransport — fn 0x03 read", () => {
  it("reg 201 (mode) parses to a valid mode 0..6", async () => {
    const t = new MockTransport();
    const req = buildReadRequest(1, 201, 1);
    const res = await t.transact(req, 1000, expectedResponseLength(req));
    const [mode] = parseReadResponse(res, 1, 1);
    expect(mode).toBeGreaterThanOrEqual(0);
    expect(mode).toBeLessThanOrEqual(6);
  });

  it("status block (201..217, count 17) returns exactly expectedResponseLength bytes and all 17 registers parse", async () => {
    const t = new MockTransport();
    const req = buildReadRequest(1, 201, 17);
    const want = expectedResponseLength(req);
    const res = await t.transact(req, 1000, want);
    expect(res.length).toBe(want);
    const values = parseReadResponse(res, 1, 17);
    expect(values).toHaveLength(17);
    for (const v of values) {
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(0xffff);
    }
  });

  it("an out-of-map register is NOT rejected — fn 0x03 always succeeds and defaults missing addresses to 0", async () => {
    // Real behavior check (not in the brief's original assumption): mock.ts's
    // fn 0x03 branch never validates the address against the seeded register
    // map — `this.regs.get(addr + i) ?? 0` just returns 0 for anything
    // unmapped. There is no "illegal data address" exception path for reads.
    const t = new MockTransport();
    const req = buildReadRequest(1, 999, 1);
    const res = await t.transact(req, 1000, expectedResponseLength(req));
    const [v] = parseReadResponse(res, 1, 1);
    expect(v).toBe(0);
  });
});

describe("MockTransport — fn 0x10 write", () => {
  it("write reg 331 = [3] echoes correctly and a subsequent read reflects the written value", async () => {
    const t = new MockTransport();
    const writeReq = buildWriteRequest(1, 331, [3]);
    const writeRes = await t.transact(writeReq, 1000, expectedResponseLength(writeReq));
    expect(() => parseWriteResponse(writeRes, 1, 331, 1)).not.toThrow();

    const readReq = buildReadRequest(1, 331, 1);
    const readRes = await t.transact(readReq, 1000, expectedResponseLength(readReq));
    const [value] = parseReadResponse(readRes, 1, 1);
    expect(value).toBe(3);
  });
});

describe("MockTransport — exception frames", () => {
  it("an unsupported function code gets an exception frame (0x80 bit set) that parseReadResponse rejects as a ModbusError", async () => {
    // mock.ts only implements fn 0x03 and fn 0x10; anything else falls into
    // its catch-all "Illegal function" branch, which is the only place the
    // emulator actually produces a Modbus exception frame. Using request fn
    // 0x83 (= 0x03 | 0x80) makes the echoed exception frame's function byte
    // match what parseReadResponse's exception-detection expects for a 0x03
    // request, so this exercises the real "exception" branch in
    // protocol/modbus.ts (exceptionCode set), not just its generic
    // "wrong function" fallback.
    const t = new MockTransport();
    const body = Buffer.from([1, 0x83, 0x00, 0xc9, 0x00, 0x01]);
    const c = crc16(body);
    const req = Buffer.concat([body, Buffer.from([c & 0xff, (c >> 8) & 0xff])]);

    const res = await t.transact(req, 1000, 5);
    expect(res).toHaveLength(5);
    expect(res[1] & 0x80).toBe(0x80);

    expect(() => parseReadResponse(res, 1, 1)).toThrow(ModbusError);
    try {
      parseReadResponse(res, 1, 1);
      throw new Error("expected parseReadResponse to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ModbusError);
      expect((e as ModbusError).exceptionCode).toBe(1); // "Illegal function"
    }
  });
});

describe("MockTransport — transact resolution", () => {
  it("resolves by awaiting its own fixed internal delay, not by real accumulation of timeoutMs/expectedLen", async () => {
    // mock.ts's transact() takes `_timeoutMs`/`_expectedLen` (both unused,
    // underscore-prefixed) and always resolves after a single internal
    // `setTimeout(r, 20)`. Passing a tiny timeoutMs and a bogus, impossible
    // expectedLen proves resolution isn't gated on either: a real
    // timeout/accumulation-driven transport would reject or hang here.
    jest.useFakeTimers();
    try {
      const t = new MockTransport();
      const req = buildReadRequest(1, 201, 1);
      const promise = t.transact(req, 1 /* tiny timeoutMs */, 999999 /* bogus expectedLen */);

      let settled = false;
      void promise.then(() => {
        settled = true;
      });

      await Promise.resolve(); // flush microtasks queued so far
      expect(settled).toBe(false); // the internal 20ms delay hasn't elapsed yet

      jest.advanceTimersByTime(20);
      const res = await promise;
      expect(settled).toBe(true);
      expect(res.length).toBeGreaterThan(0);
    } finally {
      jest.useRealTimers();
    }
  });
});
