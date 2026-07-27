import { downsample } from "./downsample";

const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ t: i }));

describe("downsample", () => {
  it("returns the input untouched when it already fits", () => {
    expect(downsample(rows(10), 10)).toEqual({ rows: rows(10), downsampled: false, sourcePoints: 10 });
  });

  it("thins the series down to at most maxPoints (plus the kept last point)", () => {
    const r = downsample(rows(1000), 100);
    expect(r.downsampled).toBe(true);
    expect(r.sourcePoints).toBe(1000);
    expect(r.rows.length).toBeLessThanOrEqual(101);
  });

  it("always keeps the first and the last point", () => {
    const r = downsample(rows(1000), 7);
    expect(r.rows[0]).toEqual({ t: 0 });
    expect(r.rows[r.rows.length - 1]).toEqual({ t: 999 });
  });

  it("handles empty input and maxPoints below 2", () => {
    expect(downsample([], 100)).toEqual({ rows: [], downsampled: false, sourcePoints: 0 });
    const one = downsample(rows(5), 1);
    expect(one.rows).toEqual([{ t: 0 }, { t: 4 }]);
    expect(one.downsampled).toBe(true);
  });
});
