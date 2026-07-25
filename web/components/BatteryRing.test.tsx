import { render, screen } from "@testing-library/react";
import { BatteryRing } from "./BatteryRing";

describe("BatteryRing", () => {
  it("renders the label text and an accessible image with the given aria-label", () => {
    const { container } = render(<BatteryRing soc={75} label="75" ariaLabel="Battery state of charge" />);

    const img = screen.getByRole("img", { name: "Battery state of charge" });
    expect(img).toBeInTheDocument();
    expect(container.querySelector(".ring-value")).toHaveTextContent("75");
    expect(container.querySelector(".ring-unit")).toHaveTextContent("%");
  });

  it("fills roughly soc% of the ring segments", () => {
    const { container: c50 } = render(<BatteryRing soc={50} label="50" ariaLabel="soc" />);
    const { container: c100 } = render(<BatteryRing soc={100} label="100" ariaLabel="soc" />);
    const { container: c0 } = render(<BatteryRing soc={0} label="0" ariaLabel="soc" />);

    // 20 segments total (RING_SEGS): 50% -> 10 filled, 100% -> all 20, 0% -> none.
    expect(c50.querySelectorAll("path.seg.on").length).toBe(10);
    expect(c100.querySelectorAll("path.seg.on").length).toBe(20);
    expect(c0.querySelectorAll("path.seg.on").length).toBe(0);
  });

  it("adds the low class when soc is at or below 20%", () => {
    const { container: low } = render(<BatteryRing soc={20} label="20" ariaLabel="soc" />);
    const { container: notLow } = render(<BatteryRing soc={21} label="21" ariaLabel="soc" />);

    expect(low.querySelector(".ring-wrap")).toHaveClass("low");
    expect(notLow.querySelector(".ring-wrap")).not.toHaveClass("low");
  });

  it("clamps out-of-range and NaN soc instead of crashing", () => {
    const { container: negative } = render(<BatteryRing soc={-40} label="0" ariaLabel="soc" />);
    const { container: over } = render(<BatteryRing soc={140} label="100" ariaLabel="soc" />);
    const { container: nan } = render(<BatteryRing soc={NaN} label="—" ariaLabel="soc" />);

    expect(negative.querySelectorAll("path.seg.on").length).toBe(0);
    expect(negative.querySelector(".ring-wrap")).toHaveClass("low");
    expect(over.querySelectorAll("path.seg.on").length).toBe(20);
    expect(nan.querySelectorAll("path.seg.on").length).toBe(0);
  });
});
