import { parseTime, parseDay, localDay, localIso } from "./time";

const NOW = Date.UTC(2026, 6, 27, 12, 0, 0); // 2026-07-27T12:00:00Z

describe("parseTime", () => {
  it("accepts unix ms as number and as string", () => {
    expect(parseTime(1_700_000_000_000, NOW)).toBe(1_700_000_000_000);
    expect(parseTime("1700000000000", NOW)).toBe(1_700_000_000_000);
  });

  it("accepts ISO 8601", () => {
    expect(parseTime("2026-07-27T00:00:00Z", NOW)).toBe(Date.UTC(2026, 6, 27));
  });

  it("accepts now and relative offsets", () => {
    expect(parseTime("now", NOW)).toBe(NOW);
    expect(parseTime("-1h", NOW)).toBe(NOW - 3_600_000);
    expect(parseTime("-90m", NOW)).toBe(NOW - 90 * 60_000);
    expect(parseTime("-7d", NOW)).toBe(NOW - 7 * 86_400_000);
    expect(parseTime("-30s", NOW)).toBe(NOW - 30_000);
  });

  it("rejects garbage with a helpful message", () => {
    expect(() => parseTime("yesterday-ish", NOW)).toThrow(/unix ms/);
    expect(() => parseTime("", NOW)).toThrow(/unix ms/);
    expect(() => parseTime("+1h", NOW)).toThrow(/unix ms/);
  });
});

describe("parseDay", () => {
  it("passes through YYYY-MM-DD", () => {
    expect(parseDay("2026-01-05", NOW)).toBe("2026-01-05");
  });

  it("resolves today, yesterday and negative day offsets in local time", () => {
    expect(parseDay("today", NOW)).toBe(localDay(NOW));
    expect(parseDay("yesterday", NOW)).toBe(localDay(NOW - 86_400_000));
    expect(parseDay("-3d", NOW)).toBe(localDay(NOW - 3 * 86_400_000));
  });

  it("rejects garbage", () => {
    expect(() => parseDay("07/27/2026", NOW)).toThrow(/YYYY-MM-DD/);
  });
});

describe("localIso", () => {
  it("отдаёт местное время со сдвигом, а не UTC", () => {
    // Агент читает ответ вместе с человеком: «вчера в 21:40» должно совпасть с
    // тем, что видно в интерфейсе, поэтому час берётся местный, а сдвиг пишется явно.
    const ms = new Date(2026, 7, 25, 9, 7, 5).getTime();
    const iso = localIso(ms);
    expect(iso).toMatch(/^2026-08-25T09:07:05[+-]\d{2}:\d{2}$/);
    // Разбор обратно даёт ту же точку во времени — значение однозначно.
    expect(Date.parse(iso)).toBe(ms);
  });
});
