import { EventEmitter } from "events";
import { Config } from "./config";
import { Transport } from "./transport/types";
import { detectTransports } from "./transport/detect";
import {
  buildReadRequest,
  buildWriteRequest,
  expectedResponseLength,
  parseReadResponse,
  parseWriteResponse,
} from "./protocol/modbus";
import {
  RegisterMap,
  STATUS_BLOCKS,
  ALARM_BLOCKS,
  SETTINGS_BLOCKS,
  decodeStatus,
  decodeSettings,
  decodeFlags,
  decodeAlarms,
  decodeMode,
  buildControlWrite,
} from "./protocol/smg";
import { Snapshot, DeviceMode, Baseline, ControlType } from "@inverter/shared";
import { Store } from "./store";

/**
 * Пауза между Modbus-командами: устройство не любит запросы вплотную
 * (esphome-smg-ii использует command_throttle 200 мс).
 */
const INTER_COMMAND_MS = 120;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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
    // Keep the chain alive regardless of individual outcomes, and pace the
    // next command so the inverter's Modbus stack keeps up.
    this.queue = run.then(
      () => sleep(INTER_COMMAND_MS),
      () => sleep(INTER_COMMAND_MS)
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
    if (!info) return; // need at least the settings
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
    const regs = await this.readBlocks(SETTINGS_BLOCKS);
    const info = decodeSettings(regs);
    const flags = decodeFlags(regs);
    const id = this.deviceId ?? "unknown";
    this.baseline = { deviceId: id, capturedAt: Date.now(), info, flags };
    this.store.saveBaseline(this.baseline);
    this.snapshot = { ...this.snapshot, info, flags, baseline: this.baseline, timestamp: Date.now() };
    this.emit("snapshot", this.snapshot);
    return this.baseline;
  }

  /** Прочитать один блок регистров: адрес → u16. */
  private async readBlock(start: number, count: number): Promise<RegisterMap> {
    return this.enqueue(async () => {
      if (!this.transport) throw new Error("No transport");
      const req = buildReadRequest(this.cfg.slaveId, start, count);
      let lastErr: Error | null = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const resp = await this.transport.transact(req, this.cfg.commandTimeoutMs, expectedResponseLength(req));
          const values = parseReadResponse(resp, this.cfg.slaveId, count);
          const map: RegisterMap = new Map();
          values.forEach((v, i) => map.set(start + i, v));
          return map;
        } catch (e) {
          lastErr = e as Error;
          if (attempt === 0) await sleep(INTER_COMMAND_MS);
        }
      }
      throw lastErr ?? new Error("Read failed");
    });
  }

  /** Прочитать несколько блоков в одну карту регистров. */
  private async readBlocks(blocks: Array<[number, number]>): Promise<RegisterMap> {
    const all: RegisterMap = new Map();
    for (const [start, count] of blocks) {
      const m = await this.readBlock(start, count);
      for (const [a, v] of m) all.set(a, v);
    }
    return all;
  }

  /** Записать значение в регистр (fn 0x10, устройство не поддерживает 0x06). */
  private async writeRegister(register: number, rawValue: number): Promise<void> {
    return this.enqueue(async () => {
      if (!this.transport) throw new Error("No transport");
      const req = buildWriteRequest(this.cfg.slaveId, register, [rawValue]);
      const resp = await this.transport.transact(req, this.cfg.commandTimeoutMs, expectedResponseLength(req));
      parseWriteResponse(resp, this.cfg.slaveId, register, 1);
    });
  }

  /** Probe candidate transports; keep the first that answers a mode read. */
  private async connect(): Promise<void> {
    await this.closeTransport();
    const candidates = await detectTransports(this.cfg);
    let lastError: string | null = null;

    for (const t of candidates) {
      try {
        await t.open();
        // Probe: реальный SMG II отвечает на чтение регистра 201 (режим)
        // CRC-валидным кадром с осмысленным значением 0..6.
        const req = buildReadRequest(this.cfg.slaveId, 201, 1);
        const resp = await t.transact(req, this.cfg.commandTimeoutMs, expectedResponseLength(req));
        const [modeReg] = parseReadResponse(resp, this.cfg.slaveId, 1);
        if (decodeMode(modeReg) === "Unknown") {
          throw new Error(`Unexpected mode register value: ${modeReg}`);
        }
        this.transport = t;
        this.deviceId = t.mock ? "SMG-MOCK-0001" : `smg-modbus-${this.cfg.slaveId}`;
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

      const statusRegs = await this.readBlocks(STATUS_BLOCKS);
      const status = decodeStatus(statusRegs);
      const mode: DeviceMode = decodeMode(statusRegs.get(201) ?? -1);

      let warnings = this.snapshot.warnings;
      try {
        warnings = decodeAlarms(await this.readBlocks(ALARM_BLOCKS));
      } catch {
        /* keep previous */
      }

      // Settings (registers 300+) less often (every ~6 polls), but always on
      // the first poll after connecting so "current settings are read out on
      // connect".
      let info = this.snapshot.info;
      let flags = this.snapshot.flags;
      if (this.ratedCounter % 6 === 0) {
        try {
          const regs = await this.readBlocks(SETTINGS_BLOCKS);
          info = decodeSettings(regs);
          flags = decodeFlags(regs);
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
   * Apply a whitelisted control command. Returns { ok, command, reply }.
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
    const w = buildControlWrite(type, value);
    const command = `reg ${w.register} := ${w.rawValue} (${w.label})`;
    await this.writeRegister(w.register, w.rawValue); // бросает при Modbus-исключении
    // Refresh settings so the UI reflects the change promptly.
    try {
      const regs = await this.readBlocks(SETTINGS_BLOCKS);
      this.snapshot = {
        ...this.snapshot,
        info: decodeSettings(regs),
        flags: decodeFlags(regs),
        timestamp: Date.now(),
      };
      this.emit("snapshot", this.snapshot);
    } catch {
      /* ignore */
    }
    // Re-engage the UI lock after a UI-originated write (not for MQTT).
    if (!opts.bypassLock && this.cfg.autoRelock) this.setLock(true);
    return { ok: true, command, reply: "ACK" };
  }

  /**
   * Диагностика: текстовая команда чтения/записи регистров.
   *   "R <адрес> [количество]"  — чтение (доступно всегда)
   *   "W <адрес> <значение>"    — запись сырого значения (требует разблокировки)
   */
  async rawQuery(command: string): Promise<string> {
    const m = command.trim().toUpperCase().match(/^([RW])\s+(\d{1,5})(?:\s+(\d{1,5}))?$/);
    if (!m) throw new Error('Use "R <addr> [count]" to read or "W <addr> <value>" to write');
    const op = m[1];
    const addr = parseInt(m[2], 10);
    const arg = m[3] !== undefined ? parseInt(m[3], 10) : undefined;

    if (op === "R") {
      const count = Math.max(1, Math.min(32, arg ?? 1));
      const regs = await this.readBlock(addr, count);
      return [...regs.entries()].map(([a, v]) => `${a} = ${v} (0x${v.toString(16).padStart(4, "0")})`).join("\n");
    }

    // Запись: те же гейты, что у control() — иначе это обход блокировки.
    if (!this.cfg.allowControl) {
      throw new Error("Control is disabled (ALLOW_CONTROL=false); only reads allowed");
    }
    if (this.locked) {
      throw new Error("Settings are locked (read-only); unlock before writing");
    }
    if (arg === undefined) throw new Error('Write needs a value: "W <addr> <value>"');
    await this.writeRegister(addr, arg);
    return `reg ${addr} := ${arg} — ACK`;
  }
}
