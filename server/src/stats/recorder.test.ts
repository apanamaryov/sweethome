import { EventEmitter } from "events";
import { Snapshot, InverterStatus, DeviceMode } from "@inverter/shared";
import { Inverter } from "../inverter";
import { StatsDb, SAMPLE_FIELDS, SampleField } from "./db";
import { StatsRecorder, RecorderOpts } from "./recorder";

/** InverterStatus with all numeric SAMPLE_FIELDS zeroed + overrides (mirrors db.test.ts). */
function status(over: Partial<Record<SampleField, number>> = {}): InverterStatus {
  const base = Object.fromEntries(SAMPLE_FIELDS.map((f) => [f, 0])) as Record<SampleField, number>;
  Object.assign(base, over);
  return { ...base, raw: "" } as InverterStatus;
}

/** Minimal valid connected Snapshot with overridable status fields, mode and warnings. */
function snapshot(
  ts: number,
  statusOver: Partial<Record<SampleField, number>> = {},
  opts: { mode?: DeviceMode; warnings?: string[]; connected?: boolean } = {}
): Snapshot {
  const connected = opts.connected ?? true;
  return {
    timestamp: ts,
    connection: {
      connected,
      transport: "mock",
      device: null,
      deviceId: "dev-1",
      mock: true,
      lastError: null,
    },
    control: { allowControl: false, locked: true },
    mode: opts.mode ?? "Battery",
    status: connected ? status(statusOver) : null,
    info: null,
    flags: null,
    warnings: connected ? { active: opts.warnings ?? [], raw: "" } : null,
    baseline: null,
  };
}

/** A fake "Inverter" that is just an EventEmitter, plus spies on the write-capable
 * methods a real Inverter exposes (control/rawQuery). recorder.attach() only ever
 * calls .on() on what it's given (and per source, doesn't even keep the reference
 * afterwards) — these spies let us prove it never reaches for the write path. */
function fakeInverter() {
  const emitter = new EventEmitter() as EventEmitter & { control: jest.Mock; rawQuery: jest.Mock };
  emitter.control = jest.fn();
  emitter.rawQuery = jest.fn();
  return emitter;
}

function events(db: StatsDb): Array<{ type: string; detail: string }> {
  return db.all("SELECT type, detail FROM events ORDER BY id") as Array<{
    type: string;
    detail: string;
  }>;
}

function makeRecorder(opts: Partial<RecorderOpts> = {}) {
  const db = new StatsDb(":memory:");
  const recorder = new StatsRecorder(db, {
    pollIntervalMs: 5000,
    rawDays: 30,
    minuteDays: 730,
    ...opts,
  });
  const source = fakeInverter();
  recorder.attach(source as unknown as Inverter);
  return { db, recorder, source };
}

describe("StatsRecorder — buffered flush", () => {
  let db: StatsDb;
  let recorder: StatsRecorder;
  let source: ReturnType<typeof fakeInverter>;
  // flush() also runs retention (prune) against the real wall clock (Date.now()), which
  // would delete "recent" samples whose ts is a tiny epoch-relative offset (e.g. 1_000) as
  // soon as the fake clock's "now" is captured. Anchor sample timestamps to the fake clock's
  // own starting point instead, so they stay well inside the rawDays retention window.
  let T0: number;

  beforeEach(() => {
    jest.useFakeTimers();
    T0 = Date.now();
    ({ db, recorder, source } = makeRecorder());
  });
  afterEach(() => {
    recorder.stop();
    jest.useRealTimers();
  });

  it("does not write buffered samples to the DB before the flush interval elapses", () => {
    source.emit("snapshot", snapshot(T0 + 1_000, { pvPower: 100 }));
    expect(db.all("SELECT COUNT(*) AS n FROM samples")[0].n).toBe(0);
  });

  it("flushes the buffered sample(s) to the DB every 60s", () => {
    source.emit("snapshot", snapshot(T0 + 1_000, { pvPower: 100 }));
    source.emit("snapshot", snapshot(T0 + 6_000, { pvPower: 200 }));

    jest.advanceTimersByTime(60_000);

    const rows = db.all("SELECT ts, pvPower FROM samples ORDER BY ts") as Array<{
      ts: number;
      pvPower: number;
    }>;
    expect(rows).toEqual([
      { ts: T0 + 1_000, pvPower: 100 },
      { ts: T0 + 6_000, pvPower: 200 },
    ]);
  });

  it("keeps buffering and flushes again on the next 60s tick", () => {
    source.emit("snapshot", snapshot(T0 + 1_000, { pvPower: 100 }));
    jest.advanceTimersByTime(60_000);
    source.emit("snapshot", snapshot(T0 + 61_000, { pvPower: 300 }));
    jest.advanceTimersByTime(60_000);

    expect(db.all("SELECT COUNT(*) AS n FROM samples")[0].n).toBe(2);
  });

  it("does not buffer samples for disconnected snapshots (no status)", () => {
    source.emit("snapshot", snapshot(T0 + 1_000, {}, { connected: false }));
    jest.advanceTimersByTime(60_000);
    expect(db.all("SELECT COUNT(*) AS n FROM samples")[0].n).toBe(0);
  });
});

describe("StatsRecorder — mode-change events", () => {
  let db: StatsDb;
  let recorder: StatsRecorder;
  let source: ReturnType<typeof fakeInverter>;

  beforeEach(() => {
    ({ db, recorder, source } = makeRecorder());
  });
  afterEach(() => recorder.stop());

  it("does not fire on the very first snapshot (no previous mode to diff against)", () => {
    source.emit("snapshot", snapshot(1_000, {}, { mode: "Battery" }));
    recorder.flush();
    expect(events(db)).toEqual([]);
  });

  it("fires mode-change with from/to when mode changes between snapshots", () => {
    source.emit("snapshot", snapshot(1_000, {}, { mode: "Battery" }));
    source.emit("snapshot", snapshot(2_000, {}, { mode: "Line" }));
    recorder.flush();

    const rows = events(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("mode-change");
    expect(JSON.parse(rows[0].detail)).toEqual({ from: "Battery", to: "Line" });
  });

  it("does not fire again while the mode stays the same", () => {
    source.emit("snapshot", snapshot(1_000, {}, { mode: "Battery" }));
    source.emit("snapshot", snapshot(2_000, {}, { mode: "Line" }));
    source.emit("snapshot", snapshot(3_000, {}, { mode: "Line" }));
    recorder.flush();

    expect(events(db).filter((e) => e.type === "mode-change")).toHaveLength(1);
  });
});

describe("StatsRecorder — mains/grid loss and return events", () => {
  let db: StatsDb;
  let recorder: StatsRecorder;
  let source: ReturnType<typeof fakeInverter>;

  beforeEach(() => {
    ({ db, recorder, source } = makeRecorder());
  });
  afterEach(() => recorder.stop());

  it("fires grid-loss when gridVoltage drops at/below the presence threshold (default 100V)", () => {
    source.emit("snapshot", snapshot(1_000, { gridVoltage: 230 })); // grid present, sets baseline
    source.emit("snapshot", snapshot(2_000, { gridVoltage: 0 })); // grid gone
    recorder.flush();

    const rows = events(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("grid-loss");
    expect(JSON.parse(rows[0].detail)).toEqual({ gridVoltage: 0 });
  });

  it("fires grid-restore when gridVoltage comes back above the threshold", () => {
    source.emit("snapshot", snapshot(1_000, { gridVoltage: 230 }));
    source.emit("snapshot", snapshot(2_000, { gridVoltage: 0 }));
    source.emit("snapshot", snapshot(3_000, { gridVoltage: 230 }));
    recorder.flush();

    const rows = events(db);
    expect(rows.map((r) => r.type)).toEqual(["grid-loss", "grid-restore"]);
    expect(JSON.parse(rows[1].detail)).toEqual({ gridVoltage: 230 });
  });

  it("uses a configurable gridPresentVolts threshold", () => {
    // Overrides opts, so built independently of the beforeEach default recorder
    // (which afterEach still closes) — this one is closed locally.
    const custom = makeRecorder({ gridPresentVolts: 180 });
    custom.source.emit("snapshot", snapshot(1_000, { gridVoltage: 230 })); // present
    custom.source.emit("snapshot", snapshot(2_000, { gridVoltage: 190 })); // still present (>180)
    custom.source.emit("snapshot", snapshot(3_000, { gridVoltage: 150 })); // now lost (<180)
    custom.recorder.flush();

    expect(events(custom.db).map((r) => r.type)).toEqual(["grid-loss"]);
    custom.recorder.stop();
  });
});

describe("StatsRecorder — alarm appear/clear events", () => {
  let db: StatsDb;
  let recorder: StatsRecorder;
  let source: ReturnType<typeof fakeInverter>;

  beforeEach(() => {
    ({ db, recorder, source } = makeRecorder());
  });
  afterEach(() => recorder.stop());

  it("does not fire on the first snapshot even if warnings are already active", () => {
    source.emit("snapshot", snapshot(1_000, {}, { warnings: ["Battery over voltage"] }));
    recorder.flush();
    expect(events(db)).toEqual([]);
  });

  it("fires fault-set when a bit from the FAULTS table newly appears in warnings.active", () => {
    source.emit("snapshot", snapshot(1_000, {}, { warnings: [] }));
    source.emit("snapshot", snapshot(2_000, {}, { warnings: ["Battery over voltage"] }));
    recorder.flush();

    const rows = events(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("fault-set");
    expect(JSON.parse(rows[0].detail)).toEqual({ bit: "Battery over voltage" });
  });

  it("fires fault-clear when that bit disappears again", () => {
    source.emit("snapshot", snapshot(1_000, {}, { warnings: [] }));
    source.emit("snapshot", snapshot(2_000, {}, { warnings: ["Battery over voltage"] }));
    source.emit("snapshot", snapshot(3_000, {}, { warnings: [] }));
    recorder.flush();

    const rows = events(db);
    expect(rows.map((r) => r.type)).toEqual(["fault-set", "fault-clear"]);
    expect(JSON.parse(rows[1].detail)).toEqual({ bit: "Battery over voltage" });
  });

  it("fires warning-set/warning-clear (not fault-*) for a bit outside the FAULTS table", () => {
    // "PV loss" is not present in the FAULTS list (server/src/protocol/smg.ts) — treated
    // as an ordinary warning bit rather than a fault.
    source.emit("snapshot", snapshot(1_000, {}, { warnings: [] }));
    source.emit("snapshot", snapshot(2_000, {}, { warnings: ["PV loss"] }));
    source.emit("snapshot", snapshot(3_000, {}, { warnings: [] }));
    recorder.flush();

    expect(events(db).map((r) => r.type)).toEqual(["warning-set", "warning-clear"]);
  });

  it("diffs independently when multiple bits change at once", () => {
    source.emit("snapshot", snapshot(1_000, {}, { warnings: ["PV loss"] }));
    source.emit("snapshot", snapshot(2_000, {}, { warnings: ["Battery over voltage"] })); // PV loss clears, fault sets
    recorder.flush();

    const rows = events(db);
    expect(rows.map((r) => r.type).sort()).toEqual(["fault-set", "warning-clear"]);
  });
});

describe("StatsRecorder — solar-charging Schmitt-trigger hysteresis", () => {
  let db: StatsDb;
  let recorder: StatsRecorder;
  let source: ReturnType<typeof fakeInverter>;

  beforeEach(() => {
    ({ db, recorder, source } = makeRecorder());
  });
  afterEach(() => recorder.stop());

  it("does not fire on the first snapshot regardless of pvChargingPower", () => {
    source.emit("snapshot", snapshot(1_000, { pvChargingPower: 60 }));
    recorder.flush();
    expect(events(db)).toEqual([]);
  });

  it("fires solar-charge-start once pvChargingPower rises above the 50W start threshold", () => {
    source.emit("snapshot", snapshot(1_000, { pvChargingPower: 0 }));
    source.emit("snapshot", snapshot(2_000, { pvChargingPower: 51 }));
    recorder.flush();

    const rows = events(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("solar-charge-start");
    expect(JSON.parse(rows[0].detail)).toEqual({ pvChargingPower: 51 });
  });

  it("does NOT start exactly at the 50W threshold (strictly greater-than required)", () => {
    source.emit("snapshot", snapshot(1_000, { pvChargingPower: 0 }));
    source.emit("snapshot", snapshot(2_000, { pvChargingPower: 50 }));
    recorder.flush();
    expect(events(db)).toEqual([]);
  });

  it("fires solar-charge-stop once pvChargingPower drops below the 20W stop threshold", () => {
    source.emit("snapshot", snapshot(1_000, { pvChargingPower: 0 }));
    source.emit("snapshot", snapshot(2_000, { pvChargingPower: 60 })); // start
    source.emit("snapshot", snapshot(3_000, { pvChargingPower: 19 })); // stop
    recorder.flush();

    const rows = events(db);
    expect(rows.map((r) => r.type)).toEqual(["solar-charge-start", "solar-charge-stop"]);
    expect(JSON.parse(rows[1].detail)).toEqual({ pvChargingPower: 19 });
  });

  it("does NOT stop exactly at the 20W threshold (strictly less-than required)", () => {
    source.emit("snapshot", snapshot(1_000, { pvChargingPower: 0 }));
    source.emit("snapshot", snapshot(2_000, { pvChargingPower: 60 })); // start
    source.emit("snapshot", snapshot(3_000, { pvChargingPower: 20 })); // exactly at stop threshold
    recorder.flush();

    expect(events(db).map((r) => r.type)).toEqual(["solar-charge-start"]);
  });

  it("does not chatter for values inside the hysteresis band (20W..50W) while charging", () => {
    source.emit("snapshot", snapshot(1_000, { pvChargingPower: 0 }));
    source.emit("snapshot", snapshot(2_000, { pvChargingPower: 60 })); // -> start
    // Bounce around inside the dead band several times: must stay "charging".
    source.emit("snapshot", snapshot(3_000, { pvChargingPower: 30 }));
    source.emit("snapshot", snapshot(4_000, { pvChargingPower: 45 }));
    source.emit("snapshot", snapshot(5_000, { pvChargingPower: 21 }));
    source.emit("snapshot", snapshot(6_000, { pvChargingPower: 35 }));
    recorder.flush();

    // Only the single start event — no spurious stop/start pairs from the dead band.
    expect(events(db).map((r) => r.type)).toEqual(["solar-charge-start"]);
  });

  it("does not chatter for values inside the band while NOT charging (never crosses 50W)", () => {
    source.emit("snapshot", snapshot(1_000, { pvChargingPower: 0 }));
    source.emit("snapshot", snapshot(2_000, { pvChargingPower: 30 }));
    source.emit("snapshot", snapshot(3_000, { pvChargingPower: 40 }));
    source.emit("snapshot", snapshot(4_000, { pvChargingPower: 25 }));
    recorder.flush();

    expect(events(db)).toEqual([]);
  });

  it("supports a full start/stop/start cycle without extra chatter", () => {
    source.emit("snapshot", snapshot(1_000, { pvChargingPower: 0 }));
    source.emit("snapshot", snapshot(2_000, { pvChargingPower: 80 })); // start
    source.emit("snapshot", snapshot(3_000, { pvChargingPower: 10 })); // stop
    source.emit("snapshot", snapshot(4_000, { pvChargingPower: 35 })); // dead band, no charging -> no event
    source.emit("snapshot", snapshot(5_000, { pvChargingPower: 90 })); // start again
    recorder.flush();

    expect(events(db).map((r) => r.type)).toEqual([
      "solar-charge-start",
      "solar-charge-stop",
      "solar-charge-start",
    ]);
  });
});

describe("StatsRecorder — connection events reset diff baselines", () => {
  let db: StatsDb;
  let recorder: StatsRecorder;
  let source: ReturnType<typeof fakeInverter>;

  beforeEach(() => {
    ({ db, recorder, source } = makeRecorder());
  });
  afterEach(() => recorder.stop());

  it("fires conn-lost/conn-restored across a disconnect and does not diff mode across the gap", () => {
    source.emit("snapshot", snapshot(1_000, {}, { mode: "Battery" }));
    source.emit("snapshot", snapshot(2_000, {}, { connected: false }));
    source.emit("snapshot", snapshot(3_000, {}, { mode: "Line" })); // first snapshot after reconnect
    recorder.flush();

    const rows = events(db);
    expect(rows.map((r) => r.type)).toEqual(["conn-lost", "conn-restored"]);
    // No mode-change event: baseline was cleared by the disconnect, so Battery -> Line
    // across the gap is not treated as a diff.
    expect(rows.some((r) => r.type === "mode-change")).toBe(false);
  });
});

describe("StatsRecorder — never writes to the inverter", () => {
  it("only ever calls .on() on what attach() is given, and never any write-capable method", () => {
    const { db, recorder, source } = makeRecorder();

    // Drive it through every kind of diff this suite exercises, including a
    // disconnect/reconnect cycle, to give any hidden write path a chance to fire.
    source.emit("snapshot", snapshot(1_000, { gridVoltage: 230, pvChargingPower: 0 }, { mode: "Battery" }));
    source.emit(
      "snapshot",
      snapshot(2_000, { gridVoltage: 0, pvChargingPower: 60 }, { mode: "Line", warnings: ["Battery over voltage"] })
    );
    source.emit("snapshot", snapshot(3_000, {}, { connected: false }));
    source.emit("snapshot", snapshot(4_000, { gridVoltage: 230, pvChargingPower: 10 }, { mode: "Battery" }));
    recorder.flush();

    expect(source.control).not.toHaveBeenCalled();
    expect(source.rawQuery).not.toHaveBeenCalled();
    // Sanity: this run did produce DB activity, so the assertions above are
    // meaningfully exercising a non-trivial recorder, not an inert one.
    expect((db.all("SELECT COUNT(*) AS n FROM events")[0] as { n: number }).n).toBeGreaterThan(0);

    recorder.stop(); // closes the db; must be last
  });
});
