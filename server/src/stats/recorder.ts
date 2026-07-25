import path from "path";
import { Snapshot } from "@inverter/shared";
import { Inverter } from "../inverter";
import { FAULTS } from "../protocol/smg";
import { localDay, SAMPLE_FIELDS, SampleRow, StatsDb, StatsEventRow } from "./db";
import { Config } from "../config";

export interface RecorderOpts {
  pollIntervalMs: number;
  rawDays: number;
  minuteDays: number;
  /** Период сброса буфера на диск (щадим SD-карту). */
  flushIntervalMs?: number;
  /** Порог «сеть есть», В. */
  gridPresentVolts?: number;
}

const FAULT_SET = new Set(FAULTS);

// Зарядка от солнца — по регистру 224 (pvChargingPower, PV-мощность в заряд).
// Гистерезис (Шмитт): старт выше START, стоп ниже STOP — чтобы дребезг у нуля
// (рассвет/закат, набегающие облака) не плодил пары событий.
const SOLAR_CHARGE_START_W = 50;
const SOLAR_CHARGE_STOP_W = 20;

/**
 * Копит снапшоты в памяти и раз в flushIntervalMs пишет их одной транзакцией,
 * попутно доводя свёртки и retention. События выводит из диффа соседних снапшотов.
 */
export class StatsRecorder {
  private buf: SampleRow[] = [];
  private pending: StatsEventRow[] = [];
  private timer: NodeJS.Timeout | null = null;
  private lastPruneDay = "";
  private prevMode: string | null = null;
  private prevGrid: boolean | null = null;
  private prevConnected: boolean | null = null;
  private prevWarnings: Set<string> | null = null;
  private prevSolarCharging: boolean | null = null;
  private prevDeviceId: string | null = null;
  private readonly flushIntervalMs: number;
  private readonly gridPresentVolts: number;
  private readonly maxBuffered: number;

  constructor(readonly db: StatsDb, private opts: RecorderOpts) {
    this.flushIntervalMs = opts.flushIntervalMs ?? 60_000;
    this.gridPresentVolts = opts.gridPresentVolts ?? 100;
    // Потолок буфера ~10 минут: при хронических ошибках флаша старьё выбрасывается.
    this.maxBuffered = Math.max(1, Math.ceil(600_000 / opts.pollIntervalMs));
    this.prevDeviceId = db.getMeta("device_id");
  }

  attach(inverter: Inverter): void {
    inverter.on("snapshot", (snap: Snapshot) => this.handleSnapshot(snap));
    this.timer = setInterval(() => this.flush(), this.flushIntervalMs);
    this.timer.unref();
  }

  handleSnapshot(snap: Snapshot): void {
    this.deriveEvents(snap);
    if (!snap.connection.connected || !snap.status) return;
    const values = {} as SampleRow["values"];
    for (const f of SAMPLE_FIELDS) values[f] = snap.status[f];
    this.buf.push({ ts: snap.timestamp, mode: snap.mode, values });
    while (this.buf.length > this.maxBuffered) this.buf.shift();
  }

  private push(ts: number, type: string, detail: object): void {
    this.pending.push({ ts, type, detail: JSON.stringify(detail) });
    // События диффовые и редкие, но при хронических ошибках флаша (например,
    // осцилляции сети вокруг порога) массив не должен расти бесконечно.
    while (this.pending.length > this.maxBuffered) this.pending.shift();
  }

  private deriveEvents(snap: Snapshot): void {
    const ts = snap.timestamp;
    const conn = snap.connection.connected;
    if (this.prevConnected !== null && conn !== this.prevConnected) {
      if (conn) {
        this.push(ts, "conn-restored", {
          transport: snap.connection.transport,
          device: snap.connection.device,
        });
      } else {
        this.push(ts, "conn-lost", { lastError: snap.connection.lastError });
      }
    }
    this.prevConnected = conn;
    if (!conn) {
      // После реконнекта не сравниваем со «старой жизнью» — без ложных диффов.
      this.prevMode = null;
      this.prevGrid = null;
      this.prevWarnings = null;
      this.prevSolarCharging = null;
      return;
    }
    const devId = snap.connection.deviceId;
    if (devId) {
      if (this.prevDeviceId && devId !== this.prevDeviceId) {
        this.push(ts, "device-changed", { from: this.prevDeviceId, to: devId });
      }
      this.prevDeviceId = devId;
    }
    if (this.prevMode !== null && snap.mode !== this.prevMode) {
      this.push(ts, "mode-change", { from: this.prevMode, to: snap.mode });
    }
    this.prevMode = snap.mode;
    if (snap.status) {
      const present = snap.status.gridVoltage > this.gridPresentVolts;
      if (this.prevGrid !== null && present !== this.prevGrid) {
        this.push(ts, present ? "grid-restore" : "grid-loss", {
          gridVoltage: snap.status.gridVoltage,
        });
      }
      this.prevGrid = present;
    }
    if (snap.warnings) {
      const cur = new Set(snap.warnings.active);
      if (this.prevWarnings) {
        for (const w of cur)
          if (!this.prevWarnings.has(w))
            this.push(ts, FAULT_SET.has(w) ? "fault-set" : "warning-set", { bit: w });
        for (const w of this.prevWarnings)
          if (!cur.has(w))
            this.push(ts, FAULT_SET.has(w) ? "fault-clear" : "warning-clear", { bit: w });
      }
      this.prevWarnings = cur;
    }
    if (snap.status) {
      const pcp = snap.status.pvChargingPower;
      let charging = this.prevSolarCharging ?? false;
      if (!charging && pcp > SOLAR_CHARGE_START_W) charging = true;
      else if (charging && pcp < SOLAR_CHARGE_STOP_W) charging = false;
      if (this.prevSolarCharging !== null && charging !== this.prevSolarCharging) {
        this.push(ts, charging ? "solar-charge-start" : "solar-charge-stop", { pvChargingPower: pcp });
      }
      this.prevSolarCharging = charging;
    }
  }

  flush(nowMs: number = Date.now()): void {
    try {
      if (this.buf.length || this.pending.length) {
        const samples = this.buf;
        const events = this.pending;
        this.db.transaction(() => {
          for (const s of samples) this.db.insertSample(s);
          for (const e of events) this.db.insertEvent(e);
        });
        this.buf = [];
        this.pending = [];
        if (this.prevDeviceId && this.prevDeviceId !== this.db.getMeta("device_id")) {
          this.db.setMeta("device_id", this.prevDeviceId);
        }
      }
      this.db.rollupMinutes(nowMs, this.opts.pollIntervalMs);
      this.db.rollupDaily(nowMs);
      const day = localDay(nowMs);
      if (day !== this.lastPruneDay) {
        this.db.prune(nowMs, this.opts.rawDays, this.opts.minuteDays);
        this.lastPruneDay = day;
      }
    } catch (e) {
      // Буфер не очищен — данные доедут со следующим флашем (с потолком maxBuffered).
      console.error("[inverter-monitor] stats flush failed:", (e as Error).message);
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.flush();
    this.db.close();
  }
}

/** Открывает БД и создаёт recorder; при любой ошибке статистика выключается, демон живёт. */
export function createStats(cfg: Config): StatsRecorder | null {
  if (!cfg.stats.enabled) return null;
  try {
    const db = new StatsDb(path.join(cfg.dataDir, "stats.db"));
    return new StatsRecorder(db, {
      pollIntervalMs: cfg.pollIntervalMs,
      rawDays: cfg.stats.rawDays,
      minuteDays: cfg.stats.minuteDays,
    });
  } catch (e) {
    console.error("[inverter-monitor] stats disabled (DB open failed):", (e as Error).message);
    return null;
  }
}
