import { loadConfig } from "../config";
import { Inverter } from "../inverter";
import { StatsDb } from "../stats/db";
import { StatsRecorder } from "../stats/recorder";
import { createLocalGateway } from "./local-gateway";
import type { GatewayCapabilities } from "@inverter/mcp";

/**
 * Контракт между статистикой сервера и инструментами MCP. Фейковый шлюз в
 * mcp/ повторяет схему строк руками, поэтому здесь она проверяется против
 * НАСТОЯЩЕЙ StatsDb: перепутанные имена колонок (soc_min против
 * batteryCapacity_min) иначе всплывают только на живых данных.
 */

const DAY_MS = 86_400_000;

function gateway(db: StatsDb) {
  process.env.INVERTER_TRANSPORT = "mock";
  const cfg = loadConfig();
  const inverter = new Inverter(cfg);
  const recorder = new StatsRecorder(db, { pollIntervalMs: 5000, rawDays: 30, minuteDays: 730 });
  const caps: GatewayCapabilities = {
    role: "admin",
    scopes: ["read", "write"],
    allowControl: true,
    statsEnabled: true,
  };
  return { gw: createLocalGateway(inverter, cfg, recorder, caps, "test"), inverter };
}

/** Одна закрытая сутки в таблице daily — через настоящие свёртки. */
function seedClosedDay(db: StatsDb): string {
  const dayStart = new Date(Date.now() - DAY_MS);
  dayStart.setHours(12, 0, 0, 0);
  const ts = dayStart.getTime();
  db.transaction(() => {
    for (let i = 0; i < 3; i++) {
      db.insertSample({
        ts: ts + i * 5000,
        mode: "Battery",
        values: {
          gridVoltage: 230, gridFrequency: 50, mainsPower: 0, inverterPower: 100,
          acOutputVoltage: 230, acOutputFrequency: 50, acOutputActivePower: 100,
          acOutputApparentPower: 120, outputLoadPercent: 5, batteryVoltage: 52,
          batteryPower: -100, batteryChargingCurrent: 0, batteryDischargeCurrent: 2,
          batteryCapacity: 60 + i * 10, pvInputVoltage: 300, pvInputCurrent: 3,
          pvPower: 900, pvChargingPower: 500, dcdcTemperature: 30, heatSinkTemperature: 35,
        },
      });
    }
  });
  db.rollupMinutes(Date.now(), 5000);
  db.rollupDaily(Date.now());
  const p = (x: number) => String(x).padStart(2, "0");
  return `${dayStart.getFullYear()}-${p(dayStart.getMonth() + 1)}-${p(dayStart.getDate())}`;
}

describe("LocalGateway against a real StatsDb", () => {
  let db: StatsDb;

  beforeEach(() => {
    db = new StatsDb(":memory:");
  });

  afterEach(() => db.close());

  it("returns daily rows carrying the SOC columns the MCP summary reads", async () => {
    const day = seedClosedDay(db);
    const { gw, inverter } = gateway(db);

    const rows = await gw.stats!.daily(day, day);
    expect(rows).toHaveLength(1);
    // Именно эти ключи читает summarize_period в mcp/src/tools/stats.ts.
    expect(Object.keys(rows[0])).toEqual(expect.arrayContaining(["soc_min", "soc_max", "pv_wh", "load_wh"]));
    expect(Number(rows[0].soc_min)).toBe(60);
    expect(Number(rows[0].soc_max)).toBe(80);

    inverter.removeAllListeners();
  });

  it("serves series, energy, events and the solar window without HTTP", async () => {
    seedClosedDay(db);
    const { gw, inverter } = gateway(db);
    const to = Date.now();
    const from = to - 2 * DAY_MS;

    const series = await gw.stats!.series({ fields: ["pvPower"], from, to, res: "minute" });
    expect(Array.isArray(series)).toBe(true);
    expect(Object.keys(series[0])).toEqual(expect.arrayContaining(["t", "pvPower"]));

    const energy = await gw.stats!.energy(from, to, "day");
    expect(Array.isArray(energy)).toBe(true);
    expect(Object.keys(energy[0])).toEqual(expect.arrayContaining(["t", "pv_wh", "load_wh", "grid_wh"]));

    const events = await gw.stats!.events({ limit: 10, offset: 0 });
    expect(Array.isArray(events)).toBe(true);

    const win = await gw.stats!.solarWindow();
    expect(win).toMatchObject({ day: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
    expect(["idle", "active", "ended"]).toContain(win.state);

    inverter.removeAllListeners();
  });

  it("exports CSV with a header and reports no truncation for a small window", async () => {
    seedClosedDay(db);
    const { gw, inverter } = gateway(db);

    const r = await gw.stats!.exportCsv({ from: Date.now() - 2 * DAY_MS, to: Date.now(), res: "minute" });
    expect(r.truncated).toBe(false);
    expect(r.csv.split("\n")[0]).toContain("ts");

    inverter.removeAllListeners();
  });

  it("reports no stats gateway when statistics are disabled", () => {
    process.env.INVERTER_TRANSPORT = "mock";
    const cfg = loadConfig();
    const inverter = new Inverter(cfg);
    const gw = createLocalGateway(
      inverter,
      cfg,
      null,
      { role: "viewer", scopes: ["read"], allowControl: false, statsEnabled: false },
      "test"
    );
    expect(gw.stats).toBeNull();
    inverter.removeAllListeners();
  });
});
