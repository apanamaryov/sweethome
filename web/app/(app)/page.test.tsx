import { screen } from "@testing-library/react";
import {
  renderWithProviders,
  buildSnapshot,
  buildStatus,
  buildMeta,
  restoreLocation,
} from "@/test-utils/renderWithProviders";
import { DICTS } from "@/lib/i18n/dict";
import HomePage from "./page";

const t = DICTS.uk;

afterEach(() => {
  restoreLocation();
});

describe("HomePage — overview", () => {
  it("shows the connecting placeholder before a snapshot arrives", async () => {
    await renderWithProviders(<HomePage />, { snapshot: null, withMeta: true });

    expect(screen.getByText(t.connecting)).toBeInTheDocument();
  });

  it("renders the flow card: badge-free header, node values from the snapshot", async () => {
    const status = buildStatus({
      batteryCapacity: 87,
      acOutputActivePower: 350,
      pvPower: 280,
      mainsPower: 0,
      batteryPower: 120,
    });
    await renderWithProviders(<HomePage />, {
      snapshot: buildSnapshot({ status }),
      withMeta: true,
      meta: buildMeta("admin", { pvPeakW: 5160 }),
    });

    expect(document.querySelector(".flow-svg")).toBeInTheDocument();
    expect(screen.getByText(/5% · 280/)).toBeInTheDocument(); // солнце: 280/5160 ≈ 5%
    expect(screen.getByText(/87% · \+120/)).toBeInTheDocument(); // батарея: SOC · заряд
    expect(screen.getByText(/6% · 350/)).toBeInTheDocument(); // нагрузка: 350/5500 ≈ 6%
    expect(document.querySelector(".mode-badge")).not.toBeInTheDocument(); // бейджа больше нет
  });

  it("whole card is a link to /inverter (no separate 'open' link)", async () => {
    await renderWithProviders(<HomePage />, { snapshot: buildSnapshot(), withMeta: true });

    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("href", "/inverter");
    expect(link.querySelector("section.card.home-card")).toBeInTheDocument();
    expect(screen.queryByText(t.homeInverterCardOpen)).not.toBeInTheDocument();
  });

  it("shows the card as a plain always-visible section, not a collapsed/collapsible Panel", async () => {
    // Regression guard: обзор — «статус с одного взгляда», никакого Panel
    // (он стартует свёрнутым, панель-тоггл прячет контент за .hidden).
    const status = buildStatus({ batteryCapacity: 87, acOutputActivePower: 350, pvPower: 280 });
    const { container } = await renderWithProviders(<HomePage />, {
      snapshot: buildSnapshot({ status }),
      withMeta: true,
    });

    expect(container.querySelector(".panel")).not.toBeInTheDocument();
    expect(container.querySelector(".panel-toggle")).not.toBeInTheDocument();
    expect(container.querySelector(".hidden")).not.toBeInTheDocument();

    const card = container.querySelector("section.card.home-card");
    expect(card).toBeInTheDocument();
    expect(card).toHaveTextContent("87");
    expect(card).toHaveTextContent("280");
  });

  it("bypass shows the amber chip in the header", async () => {
    await renderWithProviders(<HomePage />, {
      snapshot: buildSnapshot({ mode: "Bypass", status: buildStatus({ outputLoadPercent: 107 }) }),
      withMeta: true,
    });

    const chip = screen.getByText(t.flowChipBypass);
    expect(chip.closest(".warnchip")).toHaveClass("amber");
  });

  it("fault with the Overload bit shows the brick overload chip", async () => {
    await renderWithProviders(<HomePage />, {
      snapshot: buildSnapshot({ mode: "Fault", warnings: { active: ["Overload"], raw: "" } }),
      withMeta: true,
    });

    const chip = screen.getByText(t.flowChipOverload);
    expect(chip.closest(".warnchip")).toHaveClass("brick");
  });
});
