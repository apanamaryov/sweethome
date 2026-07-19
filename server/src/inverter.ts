import { EventEmitter } from "events";
import { Config } from "./config";
import { Transport } from "./transport/types";
import { detectTransports } from "./transport/detect";
import { buildFrame, parseFrame } from "./protocol/crc";
import {
  QUERY,
  parseStatus,
  parseMode,
  parseRatedInfo,
  parseWarnings,
  parseFlags,
  parseId,
  isAck,
  buildControlCommand,
} from "./protocol/pi30";
import { Snapshot, DeviceMode, Baseline, ControlType } from "@inverter/shared";
import { Store } from "./store";

export class Inverter extends EventEmitter {
  private cfg: Config;
  private transport: Transport | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private pollTimer: NodeJS.Timeout | null = null;
  private consecutiveFailures = 0;
  private ratedCounter = 0;
  private store: Store;
  private locked: boolean;
  private deviceId: string | null = null;
  private baseline: Baseline | null = null;

  private snapshot: Snapshot = {
    timestamp: 0,
    connection: { connected: false, transport: "none", device: null, deviceId: null, mock: false, lastError: null },
    control: { allowControl: false, locked: true },
    mode: "Unknown",
    status: null,
    info: null,
    flags: null,
    warnings: null,
    baseline: null,
  };

  constructor(cfg: Config) {
    super();
    this.cfg = cfg;
    this.store = new Store(cfg.dataDir);
    // If control is disabled entirely, we are permanently locked.
    this.locked = cfg.allowControl ? cfg.startupLocked : true;
    this.baseline = this.store.loadBaseline();
    this.snapshot.control = { allowControl: cfg.allowControl, locked: this.locked };
    this.snapshot.baseline = this.baseline;
  }

  isLocked(): boolean {
    return this.locked;
  }

  /** Toggle the read-only lock. Cannot unlock when ALLOW_CONTROL=false. */
  setLock(locked: boolean): { locked: boolean } {
    if (!locked && !this.cfg.allowControl) {
      throw new Error("Control is disabled (ALLOW_CONTROL=false); cannot unlock");
    }
    this.locked = locked;
    this.snapshot = { ...this.snapshot, control: { allowControl: this.cfg.allowControl, locked }, timestamp: Date.now() };
    this.emit("snapshot", this.snapshot);
    return { locked };
  }

  getBaseline(): Baseline | null {
    return this.baseline;
  }

  getSnapshot(): Snapshot {
    return this.snapshot;
  }

  async start(): Promise<void> {
    await this.connect();
    this.scheduleNextPoll(0);
  }

  async stop(): Promise<void> {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    await this.closeTransport();
  }

  /** Serialize all transport access through a single queue (one UART). */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    // Keep the chain alive regardless of individual outcomes.
    this.queue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private async closeTransport(): Promise<void> {
    if (this.transport) {
      try {
        await this.transport.close();
      } catch {
        /* ignore */
      }
      this.transport = null;
    }
    this.deviceId = null; // re-identify on next connection
    this.ratedCounter = 0; // so settings are re-read on the first poll after reconnect
  }

  /** Capture the as-found settings once per device, and persist them. */
  private maybeCaptureBaseline(info: Snapshot["info"], flags: Snapshot["flags"]): void {
    const id = this.deviceId ?? "unknown";
    if (!info) return; // need at least the rated info
    if (this.baseline && this.baseline.deviceId === id) return; // already captured for this device
    this.baseline = { deviceId: id, capturedAt: Date.now(), info, flags };
    try {
      this.store.saveBaseline(this.baseline);
    } catch (e) {
      console.error("[inverter-monitor] failed to persist baseline:", (e as Error).message);
    }
    console.log(`[inverter-monitor] captured settings baseline for device ${id}`);
  }

  /** Force re-capture of the baseline from freshly-read settings. */
  async recaptureBaseline(): Promise<Baseline> {
    if (!this.transport) throw new Error("Inverter is not connected");
    const info = parseRatedInfo(await this.raw(QUERY.RATED));
    let flags = this.snapshot.flags;
    try {
      flags = parseFlags(await this.raw(QUERY.FLAGS));
    } catch {
      /* some firmwares omit QFLAG; keep the last known value */
    }
    const id = this.deviceId ?? "unknown";
    this.baseline = { deviceId: id, capturedAt: Date.now(), info, flags };
    this.store.saveBaseline(this.baseline);
    this.snapshot = { ...this.snapshot, info, flags, baseline: this.baseline, timestamp: Date.now() };
    this.emit("snapshot", this.snapshot);
    return this.baseline;
  }

  /** Probe candidate transports; keep the first that answers QPIGS. */
  private async connect(): Promise<void> {
    await this.closeTransport();
    const candidates = await detectTransports(this.cfg);
    let lastError: string | null = null;

    for (const t of candidates) {
      try {
        await t.open();
        if (t.mock) {
          this.transport = t;
          this.setConnection(true, t, null);
          return;
        }
        // Probe: a real inverter answers QPIGS with a CRC-valid frame carrying
        // >= 17 numeric fields. parseFrame throws on bad framing/CRC; the field
        // check rejects CRC-valid but wrong replies (e.g. "NAK").
        const frame = buildFrame(QUERY.STATUS);
        const raw = await t.transact(frame, this.cfg.commandTimeoutMs);
        const payload = parseFrame(raw);
        const status = parseStatus(payload);
        if (!Number.isFinite(status.batteryVoltage) || payload.trim().split(/\s+/).length < 17) {
          throw new Error(`Unexpected QPIGS reply: ${JSON.stringify(payload)}`);
        }
        this.transport = t;
        this.setConnection(true, t, null);
        return;
      } catch (e) {
        lastError = `${t.name}${t.device ? `(${t.device})` : ""}: ${(e as Error).message}`;
        try {
          await t.close();
        } catch {
          /* ignore */
        }
      }
    }

    this.transport = null;
    this.setConnection(false, null, lastError);
  }

  private setConnection(connected: boolean, t: Transport | null, err: string | null): void {
    this.snapshot = {
      ...this.snapshot,
      connection: {
        connected,
        transport: t ? t.name : "none",
        device: t ? t.device : null,
        deviceId: this.deviceId,
        mock: t ? t.mock : false,
        lastError: err,
      },
    };
    this.emit("snapshot", this.snapshot);
  }

  /** Send a command, return parsed payload string. One retry on failure. */
  private async raw(command: string): Promise<string> {
    return this.enqueue(async () => {
      if (!this.transport) throw new Error("No transport");
      const frame = buildFrame(command);
      let lastErr: Error | null = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const buf = await this.transport.transact(frame, this.cfg.commandTimeoutMs);
          return parseFrame(buf);
        } catch (e) {
          lastErr = e as Error;
        }
      }
      throw lastErr ?? new Error("Command failed");
    });
  }

  private scheduleNextPoll(delay: number): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => void this.poll(), delay);
  }

  private async poll(): Promise<void> {
    try {
      if (!this.transport) {
        await this.connect();
        if (!this.transport) {
          this.scheduleNextPoll(this.cfg.pollIntervalMs);
          return;
        }
      }

      // Identify the device once (serial via QID) so the baseline can be keyed.
      if (this.deviceId === null) {
        try {
          this.deviceId = parseId(await this.raw(QUERY.ID));
        } catch {
          /* some firmwares omit QID; leave null */
        }
      }

      const statusPayload = await this.raw(QUERY.STATUS);
      const status = parseStatus(statusPayload);

      let mode: DeviceMode = this.snapshot.mode;
      try {
        mode = parseMode(await this.raw(QUERY.MODE));
      } catch {
        /* keep previous mode */
      }

      // Settings (rated info + flags) & warnings less often (every ~6 polls),
      // but always on the first poll after connecting so "current settings are
      // read out on connect".
      let info = this.snapshot.info;
      let flags = this.snapshot.flags;
      let warnings = this.snapshot.warnings;
      if (this.ratedCounter % 6 === 0) {
        try {
          info = parseRatedInfo(await this.raw(QUERY.RATED));
        } catch {
          /* keep */
        }
        try {
          flags = parseFlags(await this.raw(QUERY.FLAGS));
        } catch {
          /* keep */
        }
        try {
          warnings = parseWarnings(await this.raw(QUERY.WARNINGS));
        } catch {
          /* keep */
        }
        // Capture the as-found baseline once per device.
        this.maybeCaptureBaseline(info, flags);
      }
      this.ratedCounter++;

      this.consecutiveFailures = 0;
      this.snapshot = {
        timestamp: Date.now(),
        connection: {
          connected: true,
          transport: this.transport.name,
          device: this.transport.device,
          deviceId: this.deviceId,
          mock: this.transport.mock,
          lastError: null,
        },
        control: { allowControl: this.cfg.allowControl, locked: this.locked },
        mode,
        status,
        info,
        flags,
        warnings,
        baseline: this.baseline,
      };
      this.emit("snapshot", this.snapshot);
    } catch (e) {
      this.consecutiveFailures++;
      this.setConnection(false, this.transport, (e as Error).message);
      // After repeated failures, drop the transport and re-detect next cycle.
      if (this.consecutiveFailures >= 3) {
        await this.closeTransport();
        this.consecutiveFailures = 0;
      }
    } finally {
      this.scheduleNextPoll(this.cfg.pollIntervalMs);
    }
  }

  /**
   * Apply a whitelisted control command. Returns { ok, reply }.
   * opts.bypassLock is used only by the MQTT/HA path when MQTT control is
   * explicitly enabled — that flag is itself the deliberate authorization, so
   * it neither requires the UI unlock nor toggles the UI lock afterwards.
   */
  async control(
    type: ControlType,
    value: number,
    opts: { bypassLock?: boolean } = {}
  ): Promise<{ ok: boolean; command: string; reply: string }> {
    if (!this.cfg.allowControl) {
      throw new Error("Control is disabled (ALLOW_CONTROL=false)");
    }
    if (this.locked && !opts.bypassLock) {
      throw new Error("Settings are locked (read-only). Unlock control before writing.");
    }
    const command = buildControlCommand(type, value);
    const reply = await this.raw(command);
    const ok = isAck(reply);
    // Refresh rated info so the UI reflects the change promptly.
    if (ok) {
      try {
        const info = parseRatedInfo(await this.raw(QUERY.RATED));
        this.snapshot = { ...this.snapshot, info, timestamp: Date.now() };
        this.emit("snapshot", this.snapshot);
      } catch {
        /* ignore */
      }
      // Re-engage the UI lock after a UI-originated write (not for MQTT).
      if (!opts.bypassLock && this.cfg.autoRelock) this.setLock(true);
    }
    return { ok, command, reply };
  }

  /**
   * Send an arbitrary command (advanced/debug). Query commands (Q*) are always
   * allowed; anything else is a potential setter and must pass the same gates
   * as control() — otherwise /api/raw would be a lock bypass.
   */
  async rawQuery(command: string): Promise<string> {
    if (!/^[A-Za-z0-9]+$/.test(command)) throw new Error("Invalid command characters");
    if (!/^Q/i.test(command)) {
      if (!this.cfg.allowControl) {
        throw new Error("Control is disabled (ALLOW_CONTROL=false); only Q* commands allowed");
      }
      if (this.locked) {
        throw new Error("Settings are locked (read-only); unlock before sending non-query commands");
      }
    }
    return this.raw(command);
  }
}
