/**
 * Unit tests for Inverter (server/src/inverter.ts) — the core: transport
 * queue/pacing, polling, connect probe, auto-reconnect, baseline capture,
 * write gates.
 *
 * How inverter.ts actually works (read from source, not assumed):
 *   - `new Inverter(cfg: Config)` takes no transport — the only seam is
 *     transport/detect.ts's `detectTransports(cfg)`, which the private
 *     `connect()` calls to get an ordered candidate list. That module is
 *     mocked below so tests fully control which Transport instances answer
 *     open()/transact() — no real hardware, no MockTransport internals.
 *   - store.ts's Store is REAL (not mocked): its constructor does a genuine
 *     fs.mkdirSync + baseline.json read/write against a per-test
 *     os.tmpdir() DATA_DIR (same approach as server.http.test.ts), so the
 *     baseline tests exercise the real persistence path.
 *   - ALL transport I/O is serialized through the private `enqueue()` queue:
 *     `enqueue(fn)` chains `fn` onto a shared `this.queue` promise and,
 *     whatever `fn`'s outcome, appends a further `sleep(120)` link onto
 *     `this.queue` *after* fn settles — but the promise `enqueue()` hands
 *     back to its caller only waits for `fn` itself, not that trailing
 *     sleep. So a single enqueued read/write resolves as soon as its own
 *     transact() does; the 120ms pacing only shows up as a gap before the
 *     *next* enqueued command's `fn` is allowed to start.
 *   - `readBlock(start, count)` is itself one `enqueue()`'d fn that retries
 *     once internally on failure (an `await sleep(120)` between the two
 *     attempts, INSIDE the same fn) before throwing; `readBlocks()` awaits
 *     each `readBlock()` in turn, so multiple blocks of one status/settings
 *     read are also ~120ms apart, via the same shared queue.
 *   - `connect()`: `closeTransport()` (transport=null, deviceId=null,
 *     ratedCounter=0), then tries each `detectTransports()` candidate in
 *     turn: `open()` + a raw read of register 201 (this probe bypasses
 *     `enqueue()` entirely — it's a direct `transact()` call), and
 *     `decodeMode()` must not be "Unknown" or it throws and connect() moves
 *     on to the next candidate (closing the failed one first, via
 *     `t.close()`). No retry of the SAME candidate. The first candidate
 *     that probes OK becomes `this.transport`; deviceId is set (mock ?
 *     "SMG-MOCK-0001" : `smg-modbus-${slaveId}`) and a "snapshot" fires via
 *     `setConnection()`.
 *   - `poll()`: if no transport, calls `connect()` and, if still none,
 *     reschedules and returns (no failure counted). Otherwise it reads
 *     STATUS_BLOCKS + ALARM_BLOCKS every cycle and emits "snapshot".
 *     SETTINGS_BLOCKS are read only when `ratedCounter % 6 === 0`
 *     (ratedCounter starts at 0 → true on the very first poll after a
 *     (re)connect, then every 6th poll again); `maybeCaptureBaseline()` runs
 *     right after that settings read (a no-op once
 *     `baseline.deviceId === current deviceId`). `ratedCounter` increments
 *     every poll regardless of whether settings were read. On any read
 *     failure, poll()'s catch increments `consecutiveFailures` and emits a
 *     disconnected snapshot; at >=3 consecutive failures it calls
 *     `closeTransport()` (dropping the transport, resetting ratedCounter)
 *     and resets the counter — the NEXT poll's `if (!this.transport)`
 *     branch then re-runs `connect()`. That is the auto-reconnect; it takes
 *     one extra poll cycle after the 3rd failure to actually reconnect.
 *   - `control(type, value, opts)`: throws immediately if `!cfg.allowControl`
 *     ("ALLOW_CONTROL=false"), or if `locked && !opts.bypassLock` ("Settings
 *     are locked"). Otherwise it builds the whitelisted write via
 *     `buildControlWrite()`, writes it, re-reads SETTINGS_BLOCKS (6 more
 *     enqueue()'d reads, so ~5*120ms of pacing) to refresh the snapshot, and
 *     — unless `opts.bypassLock` — re-locks when `cfg.autoRelock` is true.
 *   - `rawQuery(cmd)`: `"R <addr> [count]"` is always allowed (read-only, no
 *     gates, no post-op refresh); `"W <addr> <value>"` is gated by the exact
 *     same two checks as `control()` (allowControl, then locked), and — unlike
 *     control() — does NOT re-read settings afterward, so it resolves via a
 *     single enqueue()'d write with no extra pacing to wait out.
 *
 * Timer strategy: `jest.useFakeTimers()` globally. FakeTransport.transact()
 * below resolves via microtasks only (no internal setTimeout, unlike the real
 * MockTransport's 20ms artificial delay), so connect()'s probe and any single
 * successful read/write complete with a plain `await` — no timer advance
 * needed. Only the 120ms pacing sleeps and the poll-interval timer are real
 * (fake) timers that need `jest.advanceTimersByTimeAsync()`.
 *
 * Two deliberate isolation tricks used throughout:
 *   - `connectAndFreeze()` calls `start()` then immediately
 *     `jest.clearAllTimers()` to cancel the scheduled first poll (always
 *     queued at delay 0 by start()). Tests that don't want the background
 *     poll loop competing for the shared enqueue() queue while they drive
 *     `control()`/pacing by hand use this; tests that ARE about polling
 *     (cadence, reconnect, baseline) call `start()` directly instead.
 *   - `pollIntervalMs` is set to a large value (60s) in poll-loop tests so
 *     that a single generous `advanceTimersByTimeAsync()` window can never
 *     accidentally run into the *next* poll cycle too.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { Snapshot } from "@inverter/shared";
import { Config } from "./config";
import { Transport } from "./transport/types";
import { crc16 } from "./protocol/modbus";

jest.mock("./transport/detect", () => ({
  detectTransports: jest.fn(),
}));

import { Inverter } from "./inverter";
import { detectTransports } from "./transport/detect";

const detectTransportsMock = detectTransports as jest.Mock;

function withCrc(body: Buffer): Buffer {
  const c = crc16(body);
  return Buffer.concat([body, Buffer.from([c & 0xff, (c >> 8) & 0xff])]);
}

/**
 * Every register address inverter.ts ever reads (STATUS_BLOCKS + ALARM_BLOCKS
 * + SETTINGS_BLOCKS from protocol/smg.ts), defaulted to 0, with a valid mode
 * (register 201 = 2, "Line") so the connect() probe passes by default.
 */
function fullRegs(overrides: Record<number, number> = {}): Record<number, number> {
  const m: Record<number, number> = {};
  const range = (start: number, count: number) => {
    for (let i = 0; i < count; i++) m[start + i] = 0;
  };
  range(201, 17); // status, incl. 201 mode
  range(219, 2);
  range(223, 5);
  range(229, 1);
  range(232, 3);
  range(100, 2); // alarms
  range(108, 2);
  range(300, 11); // settings
  range(313, 1);
  range(320, 10);
  range(331, 7);
  range(341, 3);
  range(643, 1);
  m[201] = 2; // valid default mode
  return { ...m, ...overrides };
}

interface TransactCall {
  fn: number;
  addr: number;
  count: number;
  time: number;
}

/**
 * A fully controllable fake Transport: an in-memory Modbus register map using
 * the same wire format as the real transport/mock.ts, plus hooks to force
 * transact() failures on demand. Deliberately has NO internal setTimeout
 * (unlike MockTransport's 20ms delay) so tests only need to reason about
 * inverter.ts's own pacing/retry timers.
 */
class FakeTransport implements Transport {
  readonly name: string;
  readonly device: string | null;
  readonly mock: boolean;
  regs = new Map<number, number>();
  /** When true, every transact() call (reads AND writes, incl. the probe) rejects. */
  failAll = false;
  calls: TransactCall[] = [];
  closed = false;

  constructor(
    opts: { name?: string; device?: string | null; mock?: boolean; regs?: Record<number, number> } = {}
  ) {
    this.name = opts.name ?? "fake";
    this.device = opts.device ?? null;
    this.mock = opts.mock ?? true;
    for (const [a, v] of Object.entries(opts.regs ?? {})) this.regs.set(Number(a), v);
  }

  async open(): Promise<void> {
    /* always succeeds */
  }
  async close(): Promise<void> {
    this.closed = true;
  }

  async transact(frame: Buffer, _timeoutMs: number, _expectedLen: number): Promise<Buffer> {
    const slave = frame[0];
    const fn = frame[1];
    const addr = frame.readUInt16BE(2);
    const count = frame.readUInt16BE(4);
    this.calls.push({ fn, addr, count, time: Date.now() });
    if (this.failAll) throw new Error("simulated transport failure");

    if (fn === 0x03) {
      const body = Buffer.alloc(3 + count * 2);
      body[0] = slave;
      body[1] = 0x03;
      body[2] = count * 2;
      for (let i = 0; i < count; i++) {
        body.writeUInt16BE((this.regs.get(addr + i) ?? 0) & 0xffff, 3 + i * 2);
      }
      return withCrc(body);
    }
    if (fn === 0x10) {
      for (let i = 0; i < count; i++) this.regs.set(addr + i, frame.readUInt16BE(7 + i * 2));
      const body = Buffer.alloc(6);
      body[0] = slave;
      body[1] = 0x10;
      body.writeUInt16BE(addr, 2);
      body.writeUInt16BE(count, 4);
      return withCrc(body);
    }
    throw new Error(`unsupported function 0x${fn.toString(16)}`);
  }
}

let tmp: string;

function baseConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 3000,
    host: "0.0.0.0",
    transport: "mock",
    serialDevice: null,
    baudRate: 9600,
    slaveId: 1,
    pollIntervalMs: 5000,
    commandTimeoutMs: 3000,
    allowMock: true,
    allowControl: true,
    startupLocked: true,
    autoRelock: true,
    dataDir: tmp,
    stats: { enabled: false, rawDays: 30, minuteDays: 730, solarThresholdW: 200, solarDwellMin: 15 },
    auth: { sessionTtlDays: 30 },
    mcp: { enabled: false, maxSessions: 8 },
    mqtt: {
      url: null,
      username: null,
      password: null,
      baseTopic: "inverter",
      discoveryPrefix: "homeassistant",
      nodeId: "sk5500p48l",
      deviceName: "Inverter SK-5500P-48L",
      enableControl: false,
    },
    ...overrides,
  };
}

let inverter: Inverter | null;

function makeInverter(overrides: Partial<Config> = {}): Inverter {
  inverter = new Inverter(baseConfig(overrides));
  return inverter;
}

/** start() + drop the auto-queued first poll (delay 0) so it can't compete
 *  with hand-driven enqueue() calls in the same test. */
async function connectAndFreeze(inv: Inverter): Promise<void> {
  await inv.start();
  jest.clearAllTimers();
}

async function adv(ms: number): Promise<void> {
  await jest.advanceTimersByTimeAsync(ms);
}

/**
 * Advance fake time in small steps until at least one more "snapshot" event
 * has landed, then return the latest one. Used instead of a single big
 * advanceTimersByTimeAsync() guess for multi-cycle poll tests: with a small
 * `pollIntervalMs` a fixed-size advance can easily overshoot into the NEXT
 * cycle too (or several), silently skipping the very snapshot a test wants to
 * inspect. Stepping and checking after every step guarantees we stop at the
 * first new one — a full poll cycle needs at least INTER_COMMAND_MS (120ms)
 * of internal pacing, so a 50ms step can never let two cycles complete
 * between checks.
 */
async function waitForSnapshot(snapshots: Snapshot[], stepMs = 50, maxSteps = 400): Promise<Snapshot> {
  const before = snapshots.length;
  for (let i = 0; i < maxSteps && snapshots.length === before; i++) {
    await adv(stepMs);
  }
  if (snapshots.length === before) {
    throw new Error(`timed out waiting for a new snapshot (still at ${snapshots.length})`);
  }
  return snapshots[snapshots.length - 1];
}

beforeEach(() => {
  jest.useFakeTimers();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "inverter-test-"));
  inverter = null;
  detectTransportsMock.mockReset();
});

afterEach(async () => {
  if (inverter) await inverter.stop();
  jest.clearAllTimers();
  jest.useRealTimers();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("enqueue — serializes commands with 120ms pacing", () => {
  it("does not start the second queued read until 120ms after the first one finishes", async () => {
    const t = new FakeTransport({ regs: fullRegs() });
    detectTransportsMock.mockResolvedValue([t]);
    const inv = makeInverter();
    await connectAndFreeze(inv);

    t.calls = []; // ignore the probe's transact() call — it bypasses the queue entirely

    const p1 = inv.rawQuery("R 210 1");
    const p2 = inv.rawQuery("R 211 1");

    await adv(0); // let the first (already-queued) read run via microtasks
    expect(t.calls).toHaveLength(1);

    await adv(100);
    expect(t.calls).toHaveLength(1); // still short of the 120ms pacing gap

    await adv(20); // 100 + 20 = 120ms since the first call
    expect(t.calls).toHaveLength(2);
    expect(t.calls[1].time - t.calls[0].time).toBe(120);

    await Promise.all([p1, p2]);
  });
});

describe("connect() probe", () => {
  it("keeps the first candidate that answers register 201 with a valid mode", async () => {
    const t = new FakeTransport({ regs: fullRegs({ 201: 3 }) }); // 3 = Battery/off-grid
    detectTransportsMock.mockResolvedValue([t]);
    const inv = makeInverter();

    await inv.start();

    const snap = inv.getSnapshot();
    expect(snap.connection.connected).toBe(true);
    expect(snap.connection.transport).toBe("fake");
    expect(snap.connection.deviceId).toBe("SMG-MOCK-0001"); // t.mock === true
  });

  it("rejects a candidate whose mode register decodes to Unknown, with no candidates left", async () => {
    const t = new FakeTransport({ regs: fullRegs({ 201: 99 }) }); // out of the 0..6 range
    detectTransportsMock.mockResolvedValue([t]);
    const inv = makeInverter();

    await inv.start();

    const snap = inv.getSnapshot();
    expect(snap.connection.connected).toBe(false);
    expect(snap.connection.lastError).toMatch(/Unexpected mode register value: 99/);
    expect(t.closed).toBe(true); // the failed candidate is closed before giving up
  });

  it("skips a candidate with an invalid mode and falls through to the next candidate", async () => {
    const bad = new FakeTransport({ name: "bad", regs: fullRegs({ 201: 99 }) });
    const good = new FakeTransport({ name: "good", regs: fullRegs({ 201: 2 }) });
    detectTransportsMock.mockResolvedValue([bad, good]);
    const inv = makeInverter();

    await inv.start();

    const snap = inv.getSnapshot();
    expect(snap.connection.connected).toBe(true);
    expect(snap.connection.transport).toBe("good");
    expect(bad.closed).toBe(true);
  });
});

describe("poll() — status/alarms every cycle; settings on cycle 1 and every 6th", () => {
  it("refreshes status every poll but only re-reads settings on the 1st and 7th cycle", async () => {
    const t = new FakeTransport({ regs: fullRegs({ 229: 50, 300: 111 }) });
    detectTransportsMock.mockResolvedValue([t]);
    const inv = makeInverter({ pollIntervalMs: 300 });

    const snapshots: Snapshot[] = [];
    inv.on("snapshot", (s: Snapshot) => snapshots.push(s));

    await inv.start(); // first poll queued at delay 0

    async function runOnePoll(soc: number, outputMode: number): Promise<Snapshot> {
      t.regs.set(229, soc);
      t.regs.set(300, outputMode);
      return waitForSnapshot(snapshots);
    }

    // Poll #1 (ratedCounter starts at 0): always reads settings too.
    let last = await runOnePoll(51, 111);
    expect(last.status?.batteryCapacity).toBe(51);
    expect(last.info?.outputMode).toBe(111);

    // Polls #2..#6: status refreshes every time, settings stay stale even
    // though the underlying register keeps changing underneath.
    for (let i = 0; i < 5; i++) {
      last = await runOnePoll(60 + i, 999);
      expect(last.status?.batteryCapacity).toBe(60 + i);
      expect(last.info?.outputMode).toBe(111); // stale on purpose
    }

    // Poll #7: ratedCounter is 6 at the top of this cycle (6 % 6 === 0) → settings refresh again.
    last = await runOnePoll(70, 222);
    expect(last.status?.batteryCapacity).toBe(70);
    expect(last.info?.outputMode).toBe(222);
  });
});

describe("auto-reconnect after 3 consecutive poll failures", () => {
  it("drops the transport after 3 failed cycles and re-detects on the next poll", async () => {
    const t = new FakeTransport({ regs: fullRegs() });
    detectTransportsMock.mockResolvedValue([t]);
    const inv = makeInverter({ pollIntervalMs: 300 });

    const snapshots: Snapshot[] = [];
    inv.on("snapshot", (s: Snapshot) => snapshots.push(s));

    await inv.start();
    let last = await waitForSnapshot(snapshots); // poll #1: succeeds
    expect(last.connection.connected).toBe(true);
    expect(detectTransportsMock).toHaveBeenCalledTimes(1);

    t.failAll = true; // every subsequent transact() call now rejects

    last = await waitForSnapshot(snapshots); // poll #2: fails, consecutiveFailures=1 (transport still held)
    expect(last.connection.connected).toBe(false);
    expect(last.connection.lastError).toMatch(/simulated transport failure/);
    expect(t.closed).toBe(false);
    expect(detectTransportsMock).toHaveBeenCalledTimes(1);

    last = await waitForSnapshot(snapshots); // poll #3: fails, consecutiveFailures=2
    expect(t.closed).toBe(false);
    expect(detectTransportsMock).toHaveBeenCalledTimes(1);

    last = await waitForSnapshot(snapshots); // poll #4: 3rd consecutive failure -> closeTransport()
    expect(t.closed).toBe(true);
    expect(detectTransportsMock).toHaveBeenCalledTimes(1); // re-detect happens on the NEXT poll, not this one

    t.failAll = false; // let the reconnect succeed
    last = await waitForSnapshot(snapshots); // poll #5: transport is gone -> connect() re-runs detectTransports and succeeds
    expect(detectTransportsMock).toHaveBeenCalledTimes(2);
    expect(last.connection.connected).toBe(true);
  });
});

describe("baseline capture — once per device, persisted, survives a reconnect", () => {
  it("captures the baseline on the first settings read and does not overwrite it on a later reconnect", async () => {
    const t = new FakeTransport({ regs: fullRegs({ 300: 111 }) });
    detectTransportsMock.mockResolvedValue([t]);
    const inv = makeInverter({ pollIntervalMs: 60_000 });

    await inv.start();
    await adv(3000); // poll #1 captures the baseline

    const baseline1 = inv.getBaseline();
    expect(baseline1).not.toBeNull();
    expect(baseline1!.info?.outputMode).toBe(111);
    const capturedAt1 = baseline1!.capturedAt;

    // Really persisted to disk (real Store, real fs — not mocked).
    const onDisk = JSON.parse(fs.readFileSync(path.join(tmp, "baseline.json"), "utf8"));
    expect(onDisk.info.outputMode).toBe(111);

    // Device's settings change, then a full disconnect + reconnect.
    t.regs.set(300, 222);
    await inv.stop();
    await inv.start();
    await adv(3000); // first poll after reconnect: settings ARE freshly read into the live snapshot...

    expect(inv.getSnapshot().info?.outputMode).toBe(222);
    // ...but the captured baseline itself is untouched (same device id, already captured).
    const baseline2 = inv.getBaseline();
    expect(baseline2!.capturedAt).toBe(capturedAt1);
    expect(baseline2!.info?.outputMode).toBe(111);
  });
});

describe("write gates", () => {
  it("ALLOW_CONTROL=false: control() always throws, permanently locked, no transport needed", async () => {
    const inv = makeInverter({ allowControl: false });

    expect(inv.isLocked()).toBe(true);
    await expect(inv.control("chargerSourcePriority", 1)).rejects.toThrow(/ALLOW_CONTROL=false/);
  });

  it("STARTUP_LOCKED=true (default): control() refused until unlocked, then succeeds", async () => {
    const t = new FakeTransport({ regs: fullRegs() });
    detectTransportsMock.mockResolvedValue([t]);
    const inv = makeInverter({ allowControl: true, startupLocked: true });
    await connectAndFreeze(inv);

    expect(inv.isLocked()).toBe(true);
    await expect(inv.control("chargerSourcePriority", 1)).rejects.toThrow(/locked/i);

    inv.setLock(false);
    const p = inv.control("chargerSourcePriority", 1); // "PV first" -> reg 331 := 1
    await adv(1500); // let writeRegister + the post-write settings refresh (6 blocks) pace out
    const result = await p;

    expect(result.ok).toBe(true);
    expect(t.regs.get(331)).toBe(1);
  });

  it("emits a write event carrying the source after a successful control write", async () => {
    const t = new FakeTransport({ regs: fullRegs() });
    detectTransportsMock.mockResolvedValue([t]);
    const inv = makeInverter({ allowControl: true, startupLocked: false });
    await connectAndFreeze(inv);

    const seen: unknown[] = [];
    inv.on("write", (e) => seen.push(e));

    const p = inv.control("chargerSourcePriority", 1, { source: "token:mcp" });
    await adv(1500);
    await p;

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      source: "token:mcp",
      kind: "control",
      type: "chargerSourcePriority",
      value: 1,
      register: 331,
      rawValue: 1,
    });
  });

  it("emits a write event for a raw W command and none for a read", async () => {
    const t = new FakeTransport({ regs: fullRegs() });
    detectTransportsMock.mockResolvedValue([t]);
    const inv = makeInverter({ allowControl: true, startupLocked: false });
    await connectAndFreeze(inv);

    const seen: Array<{ kind: string; register: number; source: string }> = [];
    inv.on("write", (e) => seen.push(e));

    const read = inv.rawQuery("R 201 1", { source: "ui:admin" });
    await adv(500);
    await read;
    expect(seen).toEqual([]);

    const write = inv.rawQuery("W 331 3", { source: "ui:admin" });
    await adv(500);
    await write;
    expect(seen).toEqual([expect.objectContaining({ kind: "raw", register: 331, source: "ui:admin" })]);
  });

  it("AUTO_RELOCK=true (default): re-locks automatically after a successful write", async () => {
    const t = new FakeTransport({ regs: fullRegs() });
    detectTransportsMock.mockResolvedValue([t]);
    const inv = makeInverter({ allowControl: true, startupLocked: true, autoRelock: true });
    await connectAndFreeze(inv);

    inv.setLock(false);
    expect(inv.isLocked()).toBe(false);

    const p = inv.control("chargerSourcePriority", 2);
    await adv(1500);
    await p;

    expect(inv.isLocked()).toBe(true);
  });

  it("AUTO_RELOCK=false: stays unlocked after a successful write", async () => {
    const t = new FakeTransport({ regs: fullRegs() });
    detectTransportsMock.mockResolvedValue([t]);
    const inv = makeInverter({ allowControl: true, startupLocked: true, autoRelock: false });
    await connectAndFreeze(inv);

    inv.setLock(false);
    const p = inv.control("chargerSourcePriority", 2);
    await adv(1500);
    await p;

    expect(inv.isLocked()).toBe(false);
  });
});

describe("rawQuery — R always allowed, W gated exactly like control()", () => {
  it('"R <addr> [count]" works even when ALLOW_CONTROL=false', async () => {
    const t = new FakeTransport({ regs: fullRegs({ 201: 2 }) });
    detectTransportsMock.mockResolvedValue([t]);
    const inv = makeInverter({ allowControl: false });
    await connectAndFreeze(inv);

    const result = await inv.rawQuery("R 201 1");
    expect(result).toMatch(/^201 = 2 /);
  });

  it('"W <addr> <value>" throws under ALLOW_CONTROL=false, same gate as control()', async () => {
    const t = new FakeTransport({ regs: fullRegs() });
    detectTransportsMock.mockResolvedValue([t]);
    const inv = makeInverter({ allowControl: false });
    await connectAndFreeze(inv);

    await expect(inv.rawQuery("W 331 3")).rejects.toThrow(/ALLOW_CONTROL=false/);
  });

  it('"W <addr> <value>" throws while locked, succeeds once unlocked (no post-write settings refresh)', async () => {
    const t = new FakeTransport({ regs: fullRegs() });
    detectTransportsMock.mockResolvedValue([t]);
    const inv = makeInverter({ allowControl: true, startupLocked: true });
    await connectAndFreeze(inv);

    await expect(inv.rawQuery("W 331 3")).rejects.toThrow(/locked/i);

    inv.setLock(false);
    const result = await inv.rawQuery("W 331 3"); // single enqueue()'d write, no timer advance needed
    expect(result).toMatch(/reg 331 := 3/);
    expect(t.regs.get(331)).toBe(3);
  });
});

describe("powerSource — вывод источника питания с гистерезисом", () => {
  it("подменяет Battery на Solar после двух подряд солнечных циклов, не после первого", async () => {
    // 201=3 Battery, 223=900 Вт выработки, 232=0 (ни заряда, ни разряда)
    const t = new FakeTransport({ regs: fullRegs({ 201: 3, 223: 900, 232: 0 }) });
    detectTransportsMock.mockReturnValue([t]);
    const inv = makeInverter();
    const snaps: Snapshot[] = [];
    inv.on("snapshot", (s: Snapshot) => snaps.push(s));

    // connectAndFreeze() тут не годится: он clearAllTimers()'ит единственный
    // запланированный poll(0) и больше ничего его не перепланирует — ни один
    // "snapshot" от цикла поллинга никогда не придёт. Нужен реальный цикл
    // поллинга (как в describe("poll()...") и describe("auto-reconnect...")).
    await inv.start();

    // Первый поллинг: кандидат Solar только взводит ожидание.
    const first = await waitForSnapshot(snaps);
    expect(first.mode).toBe("Battery");
    expect(first.powerSource).toBe("Battery");

    // Второй подряд такой же — переключение.
    const second = await waitForSnapshot(snaps);
    expect(second.powerSource).toBe("Solar");
  });

  it("возвращается к Battery через два цикла, когда батарея начала разряжаться", async () => {
    const t = new FakeTransport({ regs: fullRegs({ 201: 3, 223: 900, 232: 0 }) });
    detectTransportsMock.mockReturnValue([t]);
    const inv = makeInverter();
    const snaps: Snapshot[] = [];
    inv.on("snapshot", (s: Snapshot) => snaps.push(s));

    await inv.start();
    await waitForSnapshot(snaps);
    expect((await waitForSnapshot(snaps)).powerSource).toBe("Solar");

    // Солнце село: выработки нет, из банки течёт 4.0 А (232 = -40).
    t.regs.set(223, 0);
    t.regs.set(232, 0x10000 - 40);

    expect((await waitForSnapshot(snaps)).powerSource).toBe("Solar"); // взвели ожидание
    expect((await waitForSnapshot(snaps)).powerSource).toBe("Battery"); // переключились
  });

  it("не подменяет режим Line даже при полном солнце", async () => {
    // 201=2 Line
    const t = new FakeTransport({ regs: fullRegs({ 201: 2, 223: 1500, 232: 0 }) });
    detectTransportsMock.mockReturnValue([t]);
    const inv = makeInverter();
    const snaps: Snapshot[] = [];
    inv.on("snapshot", (s: Snapshot) => snaps.push(s));

    await inv.start();
    await waitForSnapshot(snaps);
    const s = await waitForSnapshot(snaps);
    expect(s.mode).toBe("Line");
    expect(s.powerSource).toBe("Line");
  });

  it("сбрасывает источник в Unknown на отключении, чтобы Solar не залежался", async () => {
    const t = new FakeTransport({ regs: fullRegs({ 201: 3, 223: 900, 232: 0 }) });
    detectTransportsMock.mockReturnValue([t]);
    const inv = makeInverter();
    const snaps: Snapshot[] = [];
    inv.on("snapshot", (s: Snapshot) => snaps.push(s));

    await inv.start();
    await waitForSnapshot(snaps);
    expect((await waitForSnapshot(snaps)).powerSource).toBe("Solar");

    // Связь пропала — poll() ловит ошибку и эмитит отключённый снапшот.
    t.failAll = true;
    const dead = await waitForSnapshot(snaps);
    expect(dead.connection.connected).toBe(false);
    expect(dead.powerSource).toBe("Unknown");
  });

  it("отдаёт Unknown в снапшоте до первого успешного поллинга", () => {
    const inv = makeInverter();
    expect(inv.getSnapshot().powerSource).toBe("Unknown");
  });
});
