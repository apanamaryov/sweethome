import { screen, waitFor } from "@testing-library/react";
import type { DailyRow } from "@/lib/stats";
import { renderWithProviders, restoreLocation } from "@/test-utils/renderWithProviders";
import { DICTS } from "@/lib/i18n/dict";
import { SolarWindowPanel } from "./SolarWindowPanel";

const t = DICTS.uk;

const at = (day: string, h: number, m: number): number => {
  const [y, mo, d] = day.split("-").map(Number);
  return new Date(y, mo - 1, d, h, m, 0, 0).getTime();
};

const row = (day: string, start: number | null, end: number | null): DailyRow => ({
  day,
  pv_wh: 1000, load_wh: 900, grid_wh: 10, batt_charge_wh: 100, batt_discharge_wh: 90,
  solar_start_ts: start, solar_end_ts: end, soc_min: 50, soc_max: 100,
  grid_loss_count: 0, sample_count: 100,
});

function jsonOk(body: unknown) {
  return { ok: true, json: async () => body };
}

afterEach(() => restoreLocation());

async function render(props: Parameters<typeof SolarWindowPanel>[0], fetchImpl?: jest.Mock) {
  global.fetch = (fetchImpl ?? jest.fn()) as unknown as typeof fetch;
  return renderWithProviders(<SolarWindowPanel {...props} />, { withSnapshot: false, withMeta: false });
}

describe("SolarWindowPanel — single day", () => {
  it("asks the API for the selected day, not for today", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(jsonOk({ day: "2026-07-24", start: at("2026-07-24", 8, 0), end: at("2026-07-24", 19, 30), state: "ended" }));
    await render({ kind: "day", day: "2026-07-24", daily: [] }, fetchMock);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(String(fetchMock.mock.calls[0][0])).toContain("/api/stats/solar-window?day=2026-07-24");
  });

  it("renders start, end and the length for a closed day", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(jsonOk({ day: "2026-07-24", start: at("2026-07-24", 8, 0), end: at("2026-07-24", 19, 30), state: "ended" }));
    await render({ kind: "day", day: "2026-07-24", daily: [] }, fetchMock);

    const val = await screen.findByText(/→/);
    expect(val.textContent).toContain("08:00");
    expect(val.textContent).toContain("19:30");
    expect(val.textContent).toContain(`${t.solarDuration} 11 ${t.unitHour} 30 ${t.unitMinute}`);
  });

  it("shows the ongoing state for today", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(jsonOk({ day: "2026-07-27", start: at("2026-07-27", 8, 9), end: null, state: "active" }));
    await render({ kind: "day", day: "2026-07-27", daily: [] }, fetchMock);

    expect((await screen.findByText(new RegExp(t.solarOngoing))).textContent).toContain("08:09");
  });

  it("says nothing started on an idle day", async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonOk({ day: "2026-01-05", start: null, end: null, state: "idle" }));
    await render({ kind: "day", day: "2026-01-05", daily: [] }, fetchMock);

    expect(await screen.findByText(t.solarNotStarted)).toBeInTheDocument();
  });

  it("stays silent when the stats API is unavailable", async () => {
    const fetchMock = jest.fn().mockRejectedValue(new Error("503"));
    const { container } = await render({ kind: "day", day: "2026-01-05", daily: [] }, fetchMock);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(container.querySelector(".solar-panel")).toBeNull();
  });

  it("refetches when the selected day changes", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(jsonOk({ day: "x", start: null, end: null, state: "idle" }));
    const { rerender } = await render({ kind: "day", day: "2026-07-24", daily: [] }, fetchMock);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    rerender(<SolarWindowPanel kind="day" day="2026-07-25" daily={[]} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(String(fetchMock.mock.calls[1][0])).toContain("day=2026-07-25");
  });
});

describe("SolarWindowPanel — range summary", () => {
  const week = [
    row("2026-07-24", at("2026-07-24", 8, 0), at("2026-07-24", 19, 0)),
    row("2026-07-25", at("2026-07-25", 7, 30), at("2026-07-25", 18, 0)),
    row("2026-07-26", at("2026-07-26", 9, 0), at("2026-07-26", 20, 30)),
  ];

  it("summarizes the loaded daily rows without calling the API", async () => {
    const fetchMock = jest.fn();
    await render({ kind: "week", day: "2026-07-26", daily: week }, fetchMock);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText(t.solarEarliest)).toBeInTheDocument();
    expect(screen.getByText("7:30")).toBeInTheDocument();
    expect(screen.getByText("20:30")).toBeInTheDocument();
    expect(screen.getByText(`11 ${t.unitHour} 0 ${t.unitMinute}`)).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument(); // дней с данными
  });

  it("reports the absence of data for a dark range", async () => {
    await render({ kind: "month", day: "2026-01-05", daily: [row("2026-01-05", null, null)] });
    expect(screen.getByText(t.solarNoData)).toBeInTheDocument();
  });
});
