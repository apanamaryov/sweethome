import { fmt } from "./format";

describe("fmt", () => {
  it("renders null as an em dash", () => {
    expect(fmt(null)).toBe("—");
  });

  it("renders undefined as an em dash", () => {
    expect(fmt(undefined)).toBe("—");
  });

  it("renders NaN as an em dash", () => {
    expect(fmt(NaN)).toBe("—");
  });

  it("defaults to 0 digits and rounds", () => {
    expect(fmt(232.7)).toBe("233");
  });

  it("formats with the requested digit count", () => {
    expect(fmt(232.456, 1)).toBe("232.5");
    expect(fmt(5.6789, 2)).toBe("5.68");
  });

  it("formats zero", () => {
    expect(fmt(0)).toBe("0");
    expect(fmt(0, 2)).toBe("0.00");
  });

  it("formats negative numbers", () => {
    expect(fmt(-3.456, 1)).toBe("-3.5");
  });

  it("pads with trailing zeros to match requested digits", () => {
    expect(fmt(5, 2)).toBe("5.00");
  });
});
