import { screen } from "@testing-library/react";
import { renderWithProviders, buildSnapshot, buildStatus, restoreLocation } from "@/test-utils/renderWithProviders";
import { DICTS } from "@/lib/i18n/dict";
import HomePage from "./page";

const t = DICTS.uk;

afterEach(() => {
  restoreLocation();
});

describe("HomePage — overview", () => {
  it("shows the connecting placeholder before a snapshot arrives", async () => {
    await renderWithProviders(<HomePage />, { snapshot: null, withMeta: false });

    expect(screen.getByText(t.connecting)).toBeInTheDocument();
  });

  it("renders the inverter card from the snapshot: source badge, SOC, load and PV", async () => {
    const status = buildStatus({
      batteryCapacity: 87,
      acOutputActivePower: 350,
      pvChargingPower: 280,
    });
    await renderWithProviders(<HomePage />, {
      snapshot: buildSnapshot({ mode: "Battery", powerSource: "Solar", status }),
      withMeta: false,
    });

    const badge = screen.getByText(t.modeSolar);
    expect(badge).toHaveClass("mode-badge", "mode-Solar");
    expect(screen.getByText("87")).toBeInTheDocument(); // SOC
    expect(screen.getByText("350")).toBeInTheDocument(); // load, acOutputActivePower
    expect(screen.getByText("280")).toBeInTheDocument(); // PV, pvChargingPower
  });

  it("links to /inverter", async () => {
    await renderWithProviders(<HomePage />, { snapshot: buildSnapshot(), withMeta: false });

    expect(screen.getByRole("link", { name: t.homeInverterCardOpen })).toHaveAttribute("href", "/inverter");
  });
});
