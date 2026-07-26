import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LangProvider } from "@/lib/i18n";
import { DICTS } from "@/lib/i18n/dict";
import type { DailyRow, EnergyBucket, SeriesPoint, StatsEvent } from "@/lib/stats";
import StatsPage from "./page";

const t = DICTS.uk;

// jsdom has no ResizeObserver; TimeChart (rendered per stats section) creates
// one in a useEffect to track its container width (see TimeChart.test.tsx).
class MockResizeObserver {
  observe = jest.fn();
  unobserve = jest.fn();
  disconnect = jest.fn();
}

beforeEach(() => {
  (global as unknown as { ResizeObserver: unknown }).ResizeObserver = jest
    .fn()
    .mockImplementation(() => new MockResizeObserver());
});

function jsonOk(body: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: async () => body });
}

const SAMPLE_ROWS: SeriesPoint[] = [
  {
    t: Date.UTC(2026, 6, 25, 8, 0, 0),
    pvPower: 100,
    acOutputActivePower: 200,
    mainsPower: 10,
    batteryPower: 50,
    batteryCapacity: 80,
    batteryVoltage: 53.2,
    dcdcTemperature: 30,
    heatSinkTemperature: 35,
  },
  {
    t: Date.UTC(2026, 6, 25, 9, 0, 0),
    pvPower: 300,
    acOutputActivePower: 220,
    mainsPower: 0,
    batteryPower: -20,
    batteryCapacity: 85,
    batteryVoltage: 53.6,
    dcdcTemperature: 31,
    heatSinkTemperature: 36,
  },
];

const SAMPLE_DAILY: DailyRow[] = [
  {
    day: "2026-07-25",
    pv_wh: 2000,
    load_wh: 1500,
    grid_wh: 500,
    batt_charge_wh: 800,
    batt_discharge_wh: 300,
    solar_start_ts: Date.UTC(2026, 6, 25, 6, 40, 0),
    solar_end_ts: Date.UTC(2026, 6, 25, 18, 20, 0),
    soc_min: 60,
    soc_max: 95,
    grid_loss_count: 0,
    sample_count: 288,
  },
];

const SAMPLE_ENERGY: EnergyBucket[] = [
  { t: Date.UTC(2026, 6, 25, 8, 0, 0), pv_wh: 1000, load_wh: 800, grid_wh: 200, batt_charge_wh: 400, batt_discharge_wh: 100 },
];

const SAMPLE_EVENTS: StatsEvent[] = [
  { id: 1, ts: Date.UTC(2026, 6, 25, 8, 5, 0), type: "grid-loss", detail: JSON.stringify({ gridVoltage: 0 }) },
];

function mockStatsFetch(overrides: {
  rows?: SeriesPoint[] | Error;
  daily?: DailyRow[];
  energy?: EnergyBucket[];
  events?: StatsEvent[];
}) {
  global.fetch = jest.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/stats/series")) {
      return overrides.rows instanceof Error ? Promise.reject(overrides.rows) : jsonOk(overrides.rows ?? []);
    }
    if (url.includes("/api/stats/daily")) return jsonOk(overrides.daily ?? []);
    if (url.includes("/api/stats/energy")) return jsonOk(overrides.energy ?? []);
    if (url.includes("/api/stats/events")) return jsonOk(overrides.events ?? []);
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  }) as unknown as typeof fetch;
}

// StatsPage's effect fires 4 parallel fetches (each going through getJson's own
// await chain), so a fixed microtask-flush count is fragile; instead wait for
// the loading placeholder to clear, which is a reliable signal that the
// effect's Promise.all (success or error path) has settled.
async function renderStats() {
  const utils = render(
    <LangProvider>
      <StatsPage />
    </LangProvider>
  );
  await waitFor(() => expect(screen.queryByText(t.stLoading)).not.toBeInTheDocument());
  return utils;
}

describe("StatsPage", () => {
  it("renders the period controls and export links", async () => {
    mockStatsFetch({ rows: [] });
    await renderStats();

    expect(screen.getByRole("button", { name: t.stPeriodDay })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: t.stPeriodWeek })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: t.stPeriodMonth })).toBeInTheDocument();
    expect(screen.getByText(t.stExportRaw)).toBeInTheDocument();
    expect(screen.getByText(t.stExportMinute)).toBeInTheDocument();
  });

  it("renders per-metric charts, the daily table and the events table from loaded data", async () => {
    mockStatsFetch({ rows: SAMPLE_ROWS, daily: SAMPLE_DAILY, energy: SAMPLE_ENERGY, events: SAMPLE_EVENTS });
    const { container } = await renderStats();

    // 4 power charts + battery + temp = 6 chart-box sections, each with a canvas.
    const chartBoxes = container.querySelectorAll(".chart-box canvas");
    expect(chartBoxes.length).toBeGreaterThanOrEqual(6);

    expect(screen.getByText(t.stDailyTitle)).toBeInTheDocument();
    expect(screen.getByText("2.0")).toBeInTheDocument(); // pv_wh 2000 -> 2.0 kWh
    expect(screen.getByText("1.5")).toBeInTheDocument(); // load_wh 1500 -> 1.5 kWh
    expect(screen.getByText("60/95%")).toBeInTheDocument();

    expect(screen.getByText(t.stEventsTitle)).toBeInTheDocument();
    // Scoped to the events table: the event-type <select> also has an option
    // labeled t.stEvGridLoss, so an unscoped getByText would match twice.
    const eventsTable = container.querySelector<HTMLElement>(".stats-events")!;
    expect(within(eventsTable).getByText(t.stEvGridLoss)).toBeInTheDocument();
    expect(within(eventsTable).getByText("0 " + t.capV)).toBeInTheDocument(); // evText for grid-loss
  });

  it("shows the unavailable banner when the stats API is unreachable", async () => {
    mockStatsFetch({ rows: new Error("no stats db") });
    await renderStats();

    expect(screen.getByText(t.stUnavailable)).toBeInTheDocument();
  });

  it("shows the no-data message when the period has no series/daily/event rows", async () => {
    mockStatsFetch({ rows: [], daily: [], energy: [], events: [] });
    await renderStats();

    expect(screen.getAllByText(t.stNoData).length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText(t.stDailyTitle)).not.toBeInTheDocument();
  });

  it("switching to the week period re-fetches with a different range and marks the button active", async () => {
    mockStatsFetch({ rows: SAMPLE_ROWS, daily: SAMPLE_DAILY, energy: SAMPLE_ENERGY, events: SAMPLE_EVENTS });
    const user = userEvent.setup();
    await renderStats();

    const countSeriesCalls = () =>
      (global.fetch as jest.Mock).mock.calls.filter(([u]: [string]) => String(u).includes("/api/stats/series"))
        .length;
    const seriesCallsBefore = countSeriesCalls();

    await user.click(screen.getByRole("button", { name: t.stPeriodWeek }));

    await waitFor(() => expect(countSeriesCalls()).toBeGreaterThan(seriesCallsBefore));
    expect(screen.getByRole("button", { name: t.stPeriodWeek })).toHaveClass("active");
  });
});
