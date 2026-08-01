import { render } from "@testing-library/react";
import { buildSnapshot, buildStatus } from "@/test-utils/renderWithProviders";
import { InverterFlow, flowState, pctLabel } from "./InverterFlow";

const snap = (
  st: Parameters<typeof buildStatus>[0],
  over: Parameters<typeof buildSnapshot>[0] = {}
) => buildSnapshot({ status: buildStatus(st), ...over });

describe("flowState", () => {
  it("evening: sun and battery feed simultaneously", () => {
    const f = flowState(snap({ pvPower: 380, mainsPower: 0, batteryPower: -520 }));
    expect(f.sunActive).toBe(true);
    expect(f.batteryDischarging).toBe(true);
    expect(f.gridActive).toBe(false);
  });

  it("cloudy SUB: sun + grid feed, charging battery is a consumer", () => {
    const f = flowState(snap({ pvPower: 600, mainsPower: 400, batteryPower: 150 }));
    expect(f.sunActive).toBe(true);
    expect(f.gridActive).toBe(true);
    expect(f.batteryDischarging).toBe(false);
    expect(f.batteryCharging).toBe(true);
  });

  it("grid absence is voltage-based", () => {
    expect(flowState(snap({ gridVoltage: 0 })).gridAbsent).toBe(true);
    expect(flowState(snap({ gridVoltage: 231 })).gridAbsent).toBe(false);
  });

  it("fault: everything idles, overload bit recognized", () => {
    const f = flowState(
      snap({ pvPower: 500 }, { mode: "Fault", warnings: { active: ["Overload"], raw: "" } })
    );
    expect(f.fault).toBe(true);
    expect(f.overloadFault).toBe(true);
    expect(f.sunActive).toBe(false);
  });

  it("bypass and overload flags", () => {
    const f = flowState(snap({ outputLoadPercent: 107 }, { mode: "Bypass" }));
    expect(f.bypass).toBe(true);
    expect(f.overload).toBe(true);
  });
});

describe("pctLabel", () => {
  it("rounds percent of peak and hides when peak is unset", () => {
    expect(pctLabel(380, 5160)).toBe("7%");
    expect(pctLabel(380, 0)).toBeNull();
    expect(pctLabel(380, undefined)).toBeNull();
  });
});

describe("InverterFlow render", () => {
  it("glows every feeding source and animates its branch", () => {
    const { container } = render(
      <InverterFlow
        snapshot={snap({ pvPower: 380, mainsPower: 0, batteryPower: -520 })}
        pvPeakW={5160}
      />
    );
    const glows = [...container.querySelectorAll(".flow-glow")].map((el) =>
      el.getAttribute("data-node")
    );
    expect(glows).toContain("sun");
    expect(glows).toContain("battery");
    expect(glows).not.toContain("grid");
    expect(container.querySelector('path[data-branch="sun"]')?.getAttribute("data-active")).toBe("1");
    expect(container.querySelector('path[data-branch="grid"]')?.getAttribute("data-active")).toBe("0");
    expect(container.querySelector('path[data-branch="battery"]')?.getAttribute("data-dir")).toBe(
      "discharge"
    );
  });

  it("charging flips the battery branch direction and kills its glow", () => {
    const { container } = render(
      <InverterFlow snapshot={snap({ pvPower: 1240, batteryPower: 680 })} pvPeakW={5160} />
    );
    expect(container.querySelector('path[data-branch="battery"]')?.getAttribute("data-dir")).toBe(
      "charge"
    );
    expect(
      [...container.querySelectorAll(".flow-glow")].map((el) => el.getAttribute("data-node"))
    ).not.toContain("battery");
  });

  it("shows node values: percent-first for sun and load, SOC and signed watts for battery", () => {
    const { container } = render(
      <InverterFlow
        snapshot={snap({
          pvPower: 380,
          batteryPower: -520,
          batteryCapacity: 58,
          acOutputActivePower: 900,
          mainsPower: 0,
        })}
        pvPeakW={5160}
      />
    );
    const text = container.textContent ?? "";
    expect(text).toContain("7% · 380");
    expect(text).toContain("58% · −520");
    // info.acOutputRatingActivePower в buildSnapshot = 5500 → 900/5500 ≈ 16%
    expect(text).toContain("16% · 900");
  });

  it("grid absence shows the brick 'none' label instead of watts", () => {
    const { container } = render(
      <InverterFlow snapshot={snap({ gridVoltage: 0, mainsPower: 0 })} />
    );
    expect(container.textContent).toContain("немає"); // язык по умолчанию uk
  });

  it("fault: idle branches, brick inverter with the '!' mark", () => {
    const { container } = render(
      <InverterFlow
        snapshot={snap({}, { mode: "Fault", warnings: { active: ["Overload"], raw: "" } })}
      />
    );
    expect(container.querySelectorAll('path[data-active="1"]').length).toBe(0);
    expect(container.querySelector('[data-node="inverter-fault"]')).toBeInTheDocument();
  });
});
