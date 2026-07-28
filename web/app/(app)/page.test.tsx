import { screen } from "@testing-library/react";
import { renderWithProviders, buildSnapshot, buildStatus, restoreLocation } from "@/test-utils/renderWithProviders";
import { DICTS } from "@/lib/i18n/dict";
import DashboardPage from "./page";

const t = DICTS.uk;

afterEach(() => {
  restoreLocation();
});

describe("DashboardPage", () => {
  it("shows placeholder dashes for every metric before a snapshot arrives", async () => {
    await renderWithProviders(<DashboardPage />, { snapshot: null, withMeta: false });

    // 4 cards x their own big/sub metrics all fall back to the em dash; the
    // battery-state tag also reads "—" (not t.idle) while there's no status yet.
    expect(screen.getAllByText("—").length).toBeGreaterThan(5);
    expect(screen.getByText(t.cardBattery)).toBeInTheDocument();
  });

  it("renders battery/solar/load/grid metrics from a snapshot's status", async () => {
    const status = buildStatus({
      batteryVoltage: 53.6,
      batteryCapacity: 87,
      batteryChargingCurrent: 4,
      batteryDischargeCurrent: 0,
      pvPower: 420,
      pvInputVoltage: 120.3,
      pvInputCurrent: 3.2,
      acOutputActivePower: 350,
      acOutputVoltage: 230.1,
      acOutputFrequency: 50.01,
      acOutputApparentPower: 400,
      outputLoadPercent: 12,
      mainsPower: 120,
      gridVoltage: 230.5,
      gridFrequency: 50.02,
      heatSinkTemperature: 38,
    });
    await renderWithProviders(<DashboardPage />, {
      snapshot: buildSnapshot({ status }),
      withMeta: false,
    });

    expect(screen.getByText("87")).toBeInTheDocument(); // SOC in the ring
    expect(screen.getByText("53.60")).toBeInTheDocument(); // batteryVoltage, 2 digits
    expect(screen.getByText("4")).toBeInTheDocument(); // charging current, 0 digits
    expect(screen.getByText("420")).toBeInTheDocument(); // pvPower
    expect(screen.getByText("120.3")).toBeInTheDocument(); // pvInputVoltage
    expect(screen.getByText("350")).toBeInTheDocument(); // acOutputActivePower
    expect(screen.getByText("12%")).toBeInTheDocument(); // outputLoadPercent tag
    expect(screen.getByText("120")).toBeInTheDocument(); // mainsPower
    expect(screen.getByText("230.5")).toBeInTheDocument(); // gridVoltage
  });

  it("shows the charge power from the positive part of batteryPower", async () => {
    await renderWithProviders(<DashboardPage />, {
      snapshot: buildSnapshot({
        status: buildStatus({ batteryPower: 2200, batteryChargingCurrent: 41, batteryDischargeCurrent: 0 }),
      }),
      withMeta: false,
    });

    const value = screen.getByText("2200");
    expect(value).toBeInTheDocument();
    // Метка идёт следующим элементом в той же метрике — как у соседних «заряд, А» / «разряд, А».
    expect(value.parentElement).toHaveTextContent(t.capChargeW);
  });

  it("shows zero charge power while the battery is discharging, not the signed value", async () => {
    await renderWithProviders(<DashboardPage />, {
      snapshot: buildSnapshot({
        // Регистр 217 отрицательный при разряде; в поле «заряд, Вт» должен попасть 0.
        status: buildStatus({ batteryPower: -450, batteryChargingCurrent: 0, batteryDischargeCurrent: 9 }),
      }),
      withMeta: false,
    });

    expect(screen.queryByText("-450")).not.toBeInTheDocument();
    expect(screen.queryByText("450")).not.toBeInTheDocument();
    const label = screen.getByText(t.capChargeW);
    expect(label.parentElement).toHaveTextContent("0");
  });

  it("shows the charging tag/state when batteryChargingCurrent > 0", async () => {
    await renderWithProviders(<DashboardPage />, {
      snapshot: buildSnapshot({ status: buildStatus({ batteryChargingCurrent: 5, batteryDischargeCurrent: 0 }) }),
      withMeta: false,
    });

    const tag = screen.getByText(t.charging);
    expect(tag).toHaveClass("tag", "state-charge");
  });

  it("shows the discharging tag/state when batteryDischargeCurrent > 0", async () => {
    await renderWithProviders(<DashboardPage />, {
      snapshot: buildSnapshot({ status: buildStatus({ batteryChargingCurrent: 0, batteryDischargeCurrent: 3 }) }),
      withMeta: false,
    });

    const tag = screen.getByText(t.discharging);
    expect(tag).toHaveClass("tag", "state-discharge");
  });

  it("shows the idle tag/state when neither charging nor discharging", async () => {
    await renderWithProviders(<DashboardPage />, {
      snapshot: buildSnapshot({ status: buildStatus({ batteryChargingCurrent: 0, batteryDischargeCurrent: 0 }) }),
      withMeta: false,
    });

    const tag = screen.getByText(t.idle);
    expect(tag).toHaveClass("tag", "state-idle");
  });
});
