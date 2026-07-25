import { fetchSeries, fetchDaily, fetchEvents, fetchEnergy } from "./stats";

function mockFetchOk(data: unknown): void {
  (global.fetch as jest.Mock).mockResolvedValue({
    status: 200,
    ok: true,
    json: async () => data,
  });
}

beforeEach(() => {
  global.fetch = jest.fn();
});

describe("fetchSeries", () => {
  it("requests /api/stats/series with fields/from/to/res=auto and parses the response", async () => {
    const points = [
      { t: 1000, pv: 10, soc: 80 },
      { t: 2000, pv: 20, soc: 81 },
    ];
    mockFetchOk(points);

    const result = await fetchSeries(["pv", "soc"], 1000, 2000);

    expect(global.fetch).toHaveBeenCalledWith("/api/stats/series?fields=pv,soc&from=1000&to=2000&res=auto");
    expect(result).toEqual(points);
  });
});

describe("fetchDaily", () => {
  it("requests /api/stats/daily with from/to day strings and parses the response", async () => {
    const rows = [
      {
        day: "2024-01-01",
        pv_wh: 1000,
        load_wh: 500,
        grid_wh: 100,
        batt_charge_wh: 200,
        batt_discharge_wh: 150,
        soc_min: 40,
        soc_max: 90,
        grid_loss_count: 0,
        sample_count: 1440,
      },
    ];
    mockFetchOk(rows);

    const result = await fetchDaily("2024-01-01", "2024-01-31");

    expect(global.fetch).toHaveBeenCalledWith("/api/stats/daily?from=2024-01-01&to=2024-01-31");
    expect(result).toEqual(rows);
  });
});

describe("fetchEvents", () => {
  it("omits the type param when no type is given", async () => {
    mockFetchOk([]);

    await fetchEvents(100, 200);

    expect(global.fetch).toHaveBeenCalledWith("/api/stats/events?from=100&to=200&limit=200");
  });

  it("appends an URL-encoded type param when a type is given", async () => {
    mockFetchOk([]);

    await fetchEvents(100, 200, "grid loss");

    expect(global.fetch).toHaveBeenCalledWith(
      "/api/stats/events?from=100&to=200&limit=200&type=grid%20loss"
    );
  });

  it("parses the returned event list", async () => {
    const events = [{ id: 1, ts: 100, type: "mode_change", detail: "{}" }];
    mockFetchOk(events);

    const result = await fetchEvents(0, 1000);

    expect(result).toEqual(events);
  });
});

describe("fetchEnergy", () => {
  it("requests with bucket=hour", async () => {
    mockFetchOk([]);
    await fetchEnergy(100, 200, "hour");
    expect(global.fetch).toHaveBeenCalledWith("/api/stats/energy?from=100&to=200&bucket=hour");
  });

  it("requests with bucket=day and parses the response", async () => {
    const buckets = [{ t: 0, pv_wh: 1, load_wh: 2, grid_wh: 3, batt_charge_wh: 4, batt_discharge_wh: 5 }];
    mockFetchOk(buckets);

    const result = await fetchEnergy(100, 200, "day");

    expect(global.fetch).toHaveBeenCalledWith("/api/stats/energy?from=100&to=200&bucket=day");
    expect(result).toEqual(buckets);
  });
});

describe("error handling (shared getJson plumbing)", () => {
  it("rejects when fetch itself rejects (network error)", async () => {
    (global.fetch as jest.Mock).mockRejectedValue(new Error("network down"));

    await expect(fetchSeries(["pv"], 0, 1)).rejects.toThrow("network down");
  });

  it("rejects with HTTP <status> when the response is not ok", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ status: 500, ok: false });

    await expect(fetchDaily("2024-01-01", "2024-01-02")).rejects.toThrow("HTTP 500");
  });
});
