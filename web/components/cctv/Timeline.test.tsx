import { render, screen, fireEvent } from "@testing-library/react";
import Timeline from "./Timeline";

const T = new Date(2026, 7, 24, 0, 0, 0).getTime();
const H = 3_600_000;

describe("Timeline", () => {
  const spans = [{ startMs: T + 6 * H, endMs: T + 12 * H }];

  it("рисует полоску на каждый отрезок записи", () => {
    render(<Timeline spans={spans} marks={[]} fromMs={T} toMs={T + 24 * H} positionMs={T} onSeek={() => {}} />);
    const bars = screen.getAllByTestId("cctv-span");
    expect(bars).toHaveLength(1);
    expect(bars[0]).toHaveStyle({ left: "25%", width: "25%" });
  });

  it("рисует метки движения", () => {
    render(
      <Timeline
        spans={spans}
        marks={[{ tsMs: T + 9 * H, kind: "motion" }]}
        fromMs={T}
        toMs={T + 24 * H}
        positionMs={T}
        onSeek={() => {}}
      />
    );
    expect(screen.getAllByTestId("cctv-mark")).toHaveLength(1);
  });

  it("без меток не рисует ничего лишнего", () => {
    render(<Timeline spans={spans} marks={[]} fromMs={T} toMs={T + 24 * H} positionMs={T} onSeek={() => {}} />);
    expect(screen.queryAllByTestId("cctv-mark")).toHaveLength(0);
  });

  it("клик по ленте отдаёт время этой точки", () => {
    const onSeek = jest.fn();
    render(<Timeline spans={spans} marks={[]} fromMs={T} toMs={T + 24 * H} positionMs={T} onSeek={onSeek} />);
    const track = screen.getByTestId("cctv-track");
    jest.spyOn(track, "getBoundingClientRect").mockReturnValue({
      left: 0, width: 1000, top: 0, height: 10, right: 1000, bottom: 10, x: 0, y: 0, toJSON: () => ({}),
    });
    fireEvent.click(track, { clientX: 500 });
    expect(onSeek).toHaveBeenCalledWith(T + 12 * H);
  });

  it("показывает текущую позицию", () => {
    render(
      <Timeline spans={spans} marks={[]} fromMs={T} toMs={T + 24 * H} positionMs={T + 6 * H} onSeek={() => {}} />
    );
    expect(screen.getByTestId("cctv-cursor")).toHaveStyle({ left: "25%" });
  });
});
