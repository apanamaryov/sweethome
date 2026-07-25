import { render, screen } from "@testing-library/react";
import TimeChart, { ChartSeries } from "./TimeChart";

// jsdom has no ResizeObserver. TimeChart creates one in a useEffect to keep
// the chart's width in sync with its container, so it needs a stub here
// (unlike matchMedia, which uplot needs at import time and is stubbed
// globally in jest.setup.ts).
class MockResizeObserver {
  observe = jest.fn();
  unobserve = jest.fn();
  disconnect = jest.fn();
}

let roInstances: MockResizeObserver[] = [];

beforeEach(() => {
  roInstances = [];
  (global as unknown as { ResizeObserver: unknown }).ResizeObserver = jest.fn().mockImplementation(() => {
    const ro = new MockResizeObserver();
    roInstances.push(ro);
    return ro;
  });
});

const series: ChartSeries[] = [{ label: "Battery", stroke: "#0f0", unit: "В" }];

describe("TimeChart", () => {
  it("renders the empty placeholder and no chart canvas when data has no points", () => {
    const { container, unmount } = render(<TimeChart data={[[]]} series={series} />);

    expect(screen.getByText("—")).toBeInTheDocument();
    expect(container.querySelector(".chart")).not.toBeInTheDocument();
    expect(container.querySelector("canvas")).not.toBeInTheDocument();
    unmount();
  });

  it("mounts a real uplot instance (draws to canvas) for non-empty data, and cleans up on unmount", () => {
    const data: [number[], number[]] = [
      [1000, 1001, 1002],
      [10, 20, 30.4],
    ];
    const { container, unmount } = render(<TimeChart data={data} series={series} />);

    const chartEl = container.querySelector(".chart");
    expect(chartEl).toBeInTheDocument();
    expect(chartEl!.querySelector("canvas")).toBeInTheDocument();
    expect(roInstances).toHaveLength(1);
    expect(roInstances[0].observe).toHaveBeenCalledTimes(1);

    unmount();

    expect(roInstances[0].disconnect).toHaveBeenCalledTimes(1);
  });

  it("shows its own legend with the label and the latest rounded value + unit", () => {
    const data: [number[], number[]] = [
      [1000, 1001, 1002],
      [10, 20, 30.44],
    ];
    render(<TimeChart data={data} series={series} />);

    const legendItem = screen.getByText("Battery").closest(".lg-item")!;
    expect(legendItem).toHaveTextContent("Battery");
    expect(legendItem).toHaveTextContent("30.4 В");
  });

  it("falls back to an em dash in the legend when the series has no numeric values", () => {
    const data: [number[], (number | null)[]] = [[1000, 1001], [null, null]];
    render(<TimeChart data={data} series={series} />);

    const legendItem = screen.getByText("Battery").closest(".lg-item")!;
    expect(legendItem).toHaveTextContent("—");
  });

  it("hides the legend when legend={false}", () => {
    const data: [number[], number[]] = [[1000, 1001], [10, 20]];
    const { container } = render(<TimeChart data={data} series={series} legend={false} />);

    expect(container.querySelector(".chart-legend")).not.toBeInTheDocument();
    expect(container.querySelector(".chart")).toBeInTheDocument();
  });

  it("renders in bars mode without throwing (used for energy charts)", () => {
    const data: [number[], number[]] = [
      [1000, 1001, 1002],
      [5, 8, 3],
    ];
    const { container, unmount } = render(<TimeChart data={data} series={series} bars />);

    expect(container.querySelector(".chart canvas")).toBeInTheDocument();
    unmount();
  });

  it("renders a percent-scale series (e.g. SOC) alongside a normal series without throwing", () => {
    const data: [number[], number[], number[]] = [
      [1000, 1001, 1002],
      [100, 200, 150],
      [40, 42, 45],
    ];
    const mixedSeries: ChartSeries[] = [
      { label: "Load", stroke: "#f00" },
      { label: "SOC", stroke: "#00f", scale: "pct", unit: "%" },
    ];
    const { container, unmount } = render(<TimeChart data={data} series={mixedSeries} />);

    expect(container.querySelector(".chart canvas")).toBeInTheDocument();
    unmount();
  });
});
