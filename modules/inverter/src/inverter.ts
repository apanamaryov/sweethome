import { EventEmitter } from "events";
import { InverterConfig } from "./config";
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
import {
  Snapshot,
  DeviceMode,
  Baseline,
  ControlType,
  SourceState,
  initialSourceState,
  instantSource,
  stepSource,
  SeasonProfile,
  NightTariffPhase,
  NightTariffState,
  nightTariffPhase,
  profileSteps,
  profileChanges,
  ProfileStep,
  ProfilePreview,
  ProfilePreviewStep,
  ProfileApplyResult,
} from "@sweethome/inverter-shared";
import { Store } from "./store";

/**
 * Пауза между Modbus-командами: устройство не любит запросы вплотную
 * (esphome-smg-ii использует command_throttle 200 мс).
 */
const INTER_COMMAND_MS = 120;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Источник записей планировщика ночного тарифа в журнале событий. */
export const NIGHT_TARIFF_SOURCE = "schedule:night-tariff";

/** Пауза планировщика после сбоя записи — чтобы не долбить инвертор каждый цикл опроса. */
const SCHEDULE_RETRY_MS = 60_000;

/** Факт записи в инвертор — для журнала событий (кто и что изменил). */
export interface WriteEvent {
  ts: number;
  /** "ui:<user>" | "token:<name>" | "mqtt" | "schedule:night-tariff" */
  source: string;
  kind: "control" | "raw";
  type?: ControlType;
  value?: number;
  register: number;
  rawValue: number;
}

export class Inverter extends EventEmitter {
  private cfg: InverterConfig;
  private transport: Transport | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private pollTimer: NodeJS.Timeout | null = null;
  private consecutiveFailures = 0;
  private ratedCounter = 0;
  private store: Store;
  private locked: boolean;
  private deviceId: string | null = null;
  /** Состояние гистерезиса выведенного источника питания (см. shared/src/source.ts). */
  private sourceState: SourceState = initialSourceState();
  /** Режим предыдущего замера: по его смене состояние гистерезиса пересевается. */
  private lastMode: DeviceMode | null = null;
  private baseline: Baseline | null = null;
  /** Профиль применяется целиком: второй заход, пока идёт первый, смешал бы два сезона. */
  private profileInFlight: SeasonProfile | null = null;
  /**
   * Ночной тариф включён (профиль "night"): планировщик сам переключает приоритет
   * заряда по часам. Хранится на диске — включение переживает перезапуск.
   */
  private nightTariff: boolean;
  private tariffPhase: NightTariffPhase | null = null;
  /** Идущая запись планировщика: профиль дожидается её, чтобы не перемешать записи. */
  private scheduleRun: Promise<void> | null = null;
  private scheduleRetryAt = 0;

  private snapshot: Snapshot = {
    timestamp: 0,
    connection: { connected: false, transport: "none", device: null, deviceId: null, mock: false, lastError: null },
    control: { allowControl: false, locked: true },
    mode: "Unknown",
    powerSource: "Unknown",
    status: null,
    info: null,
    flags: null,
    warnings: null,
    baseline: null,
  };

  constructor(cfg: InverterConfig) {
    super();
    this.cfg = cfg;
    this.store = new Store(cfg.dataDir);
    // If control is disabled entirely, we are permanently locked.
    this.locked = cfg.allowControl ? cfg.startupLocked : true;
    this.baseline = this.store.loadBaseline();
    this.nightTariff = this.store.loadNightTariff();
    this.snapshot.control = { allowControl: cfg.allowControl, locked: this.locked };
    this.snapshot.baseline = this.baseline;
    this.snapshot.nightTariff = this.nightTariffState();
  }

  private nightTariffState(): NightTariffState {
    return { enabled: this.nightTariff, phase: this.nightTariff ? this.tariffPhase : null };
  }

  /** Включить/выключить ночной тариф: флаг на диск и в снапшот. Сам ничего не пишет в инвертор. */
  private setNightTariff(enabled: boolean, phase: NightTariffPhase | null = null): void {
    this.nightTariff = enabled;
    this.tariffPhase = enabled ? phase : null;
    this.scheduleRetryAt = 0;
    try {
      this.store.saveNightTariff(enabled);
    } catch (e) {
      console.error("[inverter] failed to persist the night tariff flag:", (e as Error).message);
    }
    this.snapshot = { ...this.snapshot, nightTariff: this.nightTariffState(), timestamp: Date.now() };
    this.emit("snapshot", this.snapshot);
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
    this.sourceState = initialSourceState(); // иначе после реконнекта всплывёт залежавшийся "Solar"
    this.lastMode = null; // первый замер после реконнекта снова засеет состояние режимом
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
    if (!connected) {
      this.sourceState = initialSourceState();
      this.lastMode = null;
    }
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
      powerSource: connected ? this.snapshot.powerSource : "Unknown",
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
      // `mode` — прямое показание регистра 201, ему сглаживание не нужно и оно
      // вредно: пропадание сети, её возврат и Fault обязаны доехать до бейджа и
      // датчика HA в этом же цикле. Гистерезис нужен только выведенному
      // "Solar", поэтому на каждой смене сырого режима состояние пересевается
      // этим режимом — и сглаживается затем только пара Battery↔Solar,
      // единственная, между которой вывод может метаться внутри одного режима.
      // Заодно это покрывает и первый замер после (пере)подключения: там
      // lastMode сброшен в null, так что режим тоже показывается сразу.
      if (mode !== this.lastMode) this.sourceState = initialSourceState(mode);
      this.lastMode = mode;
      this.sourceState = stepSource(this.sourceState, instantSource(mode, status));

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
        powerSource: this.sourceState.shown,
        status,
        info,
        flags,
        warnings,
        baseline: this.baseline,
        nightTariff: this.nightTariffState(),
      };
      this.emit("snapshot", this.snapshot);
      await this.reconcileNightTariff();
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
   *
   * opts.bypassLock has exactly three callers, all deliberate — do not add a fourth
   * without reading the write-safety section of modules/inverter/CLAUDE.md:
   *   - the MQTT/HA path when MQTT control is explicitly enabled (that flag is
   *     itself the authorization, so it neither needs the UI unlock nor touches it);
   *   - `applyProfile`, which checks the lock once for the whole profile and
   *     re-engages it at the end, because AUTO_RELOCK would otherwise shut the
   *     lock after the profile's first step;
   *   - the night tariff scheduler (`reconcileNightTariff`): applying the "night"
   *     profile — unlocked, by an admin — is the authorization for its timed writes,
   *     until another profile or a manual priority change switches it off.
   *
   * opts.origin marks the writes made on behalf of a profile or the scheduler. A write
   * of either priority WITHOUT it is a manual change, and it switches the night tariff
   * off — otherwise the scheduler would silently undo it on the next cycle.
   */
  async control(
    type: ControlType,
    value: number,
    opts: { bypassLock?: boolean; source?: string; origin?: "profile" | "schedule" } = {}
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
    this.emit("write", {
      ts: Date.now(),
      source: opts.source ?? "unknown",
      kind: "control",
      type,
      value,
      register: w.register,
      rawValue: w.rawValue,
    } satisfies WriteEvent);
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
    if (
      this.nightTariff &&
      !opts.origin &&
      (type === "outputSourcePriority" || type === "chargerSourcePriority")
    ) {
      this.setNightTariff(false);
    }
    // Re-engage the UI lock after a UI-originated write (not for MQTT).
    if (!opts.bypassLock && this.cfg.autoRelock) this.setLock(true);
    return { ok: true, command, reply: "ACK" };
  }

  /**
   * Что будет записано командой control() — без записи. Доступно и при
   * включённой блокировке: это чтение.
   */
  async previewControl(
    type: ControlType,
    value: number
  ): Promise<{
    register: number;
    rawValue: number;
    label: string;
    currentValue: number | null;
    baselineValue: number | null;
  }> {
    const w = buildControlWrite(type, value);
    let currentValue: number | null = null;
    try {
      const regs = await this.readBlock(w.register, 1);
      currentValue = regs.get(w.register) ?? null;
    } catch {
      /* связи нет — отдаём то, что знаем */
    }
    const base = this.baseline?.info as unknown as Record<string, number> | undefined;
    return {
      register: w.register,
      rawValue: w.rawValue,
      label: w.label,
      currentValue,
      baselineValue: base && typeof base[type] === "number" ? base[type] : null,
    };
  }

  /**
   * Предпросмотр сезонного профиля: что стоит в регистрах сейчас и что станет.
   * Только чтение, поэтому доступен и при включённой блокировке.
   */
  async previewProfile(profile: SeasonProfile, phase?: NightTariffPhase): Promise<ProfilePreview> {
    const steps: ProfilePreviewStep[] = [];
    for (const step of profileSteps(profile, phase ?? this.phaseNow())) {
      const p = await this.previewControl(step.type, step.value);
      // Сравниваем сырое с сырым: currentValue из readBlock — значение регистра, и
      // rawValue — тоже. Для шкалированных команд (токи, напряжения) это НЕ то же
      // самое, что сравнение в profileChanges (человеческие единицы из снапшота),
      // так что профиль из такой команды потребует привести обе проверки к одной.
      steps.push({
        type: step.type,
        value: step.value,
        register: p.register,
        rawValue: p.rawValue,
        label: p.label,
        currentValue: p.currentValue,
        // Связи нет (currentValue === null) — считаем, что значение неизвестно, и пишем.
        alreadyApplied: p.currentValue !== null && p.currentValue === p.rawValue,
      });
    }
    return { profile, steps };
  }

  /**
   * Применение сезонного профиля — несколько команд одним действием. Профиль идёт
   * целиком и по одному за раз: параллельный заход отклоняется, иначе два сезона
   * перемешались бы в общей очереди команд.
   *
   * Права и блокировка проверяются один раз на весь профиль: одна разблокировка =
   * один осознанно применённый профиль. Дальше шаги идут с bypassLock, иначе
   * AUTO_RELOCK защёлкнул бы замок после первой же записи и вторая упала бы.
   * Замок возвращается на место в конце — и только если что-то реально записали.
   * Каждый шаг остаётся обычной записью control(): та же валидация, то же событие
   * "write" в журнале.
   */
  async applyProfile(
    profile: SeasonProfile,
    opts: { bypassLock?: boolean; source?: string } = {}
  ): Promise<ProfileApplyResult> {
    if (!this.cfg.allowControl) {
      throw new Error("Control is disabled (ALLOW_CONTROL=false)");
    }
    if (this.locked && !opts.bypassLock) {
      throw new Error("Settings are locked (read-only). Unlock control before writing.");
    }
    if (this.profileInFlight) {
      throw new Error(`Profile ${this.profileInFlight} is already being applied; wait for it to finish.`);
    }
    this.profileInFlight = profile;
    const applied: ProfileApplyResult["applied"] = [];
    const skipped: ProfileStep[] = [];
    // Другой профиль выключает ночной тариф сразу, до записей: иначе планировщик
    // поспорил бы с ним, а после сбоя на середине — молча вернул бы ночные настройки.
    if (profile !== "night" && this.nightTariff) this.setNightTariff(false);
    try {
      // Планировщик мог начать запись до нас: дожидаемся её, иначе его шаг лёг бы
      // между чтением и записью профиля. Новый он не начнёт — profileInFlight уже стоит.
      if (this.scheduleRun) await this.scheduleRun;
      const phase = this.phaseNow();
      const { steps } = await this.previewProfile(profile, phase);
      for (const step of steps) {
        if (step.alreadyApplied) {
          skipped.push({ type: step.type, value: step.value });
          continue;
        }
        try {
          const r = await this.control(step.type, step.value, {
            bypassLock: true,
            source: opts.source,
            origin: "profile",
          });
          applied.push({ type: step.type, value: step.value, command: r.command });
        } catch (e) {
          // Полпрофиля хуже, чем ничего: ошибка обязана сказать, что успело записаться,
          // иначе по одному «no response» не понять, в каком состоянии стоит дом.
          const done = applied.length ? applied.map((s) => s.type).join(", ") : "nothing";
          throw new Error(
            `Profile ${profile} stopped at ${step.type} after ${applied.length} of ${steps.length} ` +
              `steps (applied: ${done}): ${(e as Error).message}`
          );
        }
      }
      // Ночной тариф включается только целиком применённым профилем — даже если ничего
      // писать не пришлось (ночью его регистры совпадают с зимними).
      if (profile === "night") this.setNightTariff(true, phase);
      return { ok: true, profile, applied, skipped };
    } finally {
      // Разблокировка — разрешение на один профиль: возвращаем замок и после срыва на
      // середине, иначе одна неудачная попытка оставила бы запись открытой насовсем.
      // Если не записали ничего, разрешение не потрачено — замок трогать незачем.
      if (applied.length > 0 && !opts.bypassLock && this.cfg.autoRelock) this.setLock(true);
      this.profileInFlight = null;
    }
  }

  /** Фаза ночного тарифа на текущий момент — по часам и последнему известному заряду. */
  private phaseNow(): NightTariffPhase {
    const soc = this.snapshot.status?.batteryCapacity;
    const known = typeof soc === "number" && Number.isFinite(soc) && this.snapshot.connection.connected;
    return nightTariffPhase(new Date(), known ? soc : null, this.tariffPhase);
  }

  /**
   * Планировщик ночного тарифа: раз в цикл опроса сверяет приоритеты с фазой и, если
   * нужно, переписывает их. Сверка, а не будильник на 23:00/07:00: пропущенное время
   * (сервис лежал, не было связи) догоняется на первом же удачном цикле.
   *
   * Каждая запись — обычный control(): тот же белый список и событие "write" с
   * источником "schedule:night-tariff". Замок обходится (см. комментарий у control()),
   * но ALLOW_CONTROL=false сильнее всего — тогда планировщик молчит.
   */
  async reconcileNightTariff(): Promise<void> {
    if (!this.nightTariff || !this.cfg.allowControl) return;
    if (this.profileInFlight || this.scheduleRun) return;
    const info = this.snapshot.info;
    if (!this.snapshot.connection.connected || !info) return;

    const phase = this.phaseNow();
    if (phase !== this.tariffPhase) {
      this.tariffPhase = phase;
      this.snapshot = { ...this.snapshot, nightTariff: this.nightTariffState() };
      this.emit("snapshot", this.snapshot);
    }
    if (Date.now() < this.scheduleRetryAt) return;
    const pending = profileChanges(info, "night", phase);
    if (!pending.length) return;

    this.scheduleRun = (async () => {
      try {
        for (const step of pending) {
          if (!this.nightTariff) return; // выключили между шагами — дальше не пишем
          await this.control(step.type, step.value, {
            bypassLock: true,
            source: NIGHT_TARIFF_SOURCE,
            origin: "schedule",
          });
        }
      } catch (e) {
        this.scheduleRetryAt = Date.now() + SCHEDULE_RETRY_MS;
        console.warn(`[inverter] night tariff: write failed, retrying in 60 s: ${(e as Error).message}`);
      } finally {
        this.scheduleRun = null;
      }
    })();
    await this.scheduleRun;
  }

  /**
   * Диагностика: текстовая команда чтения/записи регистров.
   *   "R <адрес> [количество]"  — чтение (доступно всегда)
   *   "W <адрес> <значение>"    — запись сырого значения (требует разблокировки)
   */
  async rawQuery(command: string, opts: { source?: string } = {}): Promise<string> {
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
    this.emit("write", {
      ts: Date.now(),
      source: opts.source ?? "unknown",
      kind: "raw",
      register: addr,
      rawValue: arg,
    } satisfies WriteEvent);
    return `reg ${addr} := ${arg} — ACK`;
  }
}
