import type { Snapshot } from "@sweethome/inverter-shared";
import { createHttpGateway } from "./http";
import { GatewayError } from "./types";

const SNAPSHOT = { timestamp: 1, mode: "Battery" } as unknown as Snapshot;

const ME = { username: "bot", role: "admin", mustChangePassword: false, auth: "token", scopes: ["read", "write"] };
const META = {
  session: { username: "bot", role: "admin", mustChangePassword: false },
  allowControl: true,
  outputSourcePriority: {},
  chargerSourcePriority: {},
  maxChargingCurrent: [],
  maxAcChargingCurrent: [],
};

function res(body: unknown, status = 200, text?: string) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => text ?? JSON.stringify(body),
  } as Response;
}

/** fetch-мок, отвечающий по pathname запроса (строгое сравнение: /api/me ≠ /api/meta). */
function fetchMock(routes: Record<string, () => Response>) {
  return jest.fn(async (url: string | URL, _init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const route = routes[path];
    if (!route) throw new Error(`unexpected fetch: ${path}`);
    return route();
  });
}

const BASE_ROUTES = {
  "/api/me": () => res(ME),
  "/api/inverter/meta": () => res(META),
  "/api/inverter/stats/solar-window": () => res({ day: "2026-07-27", start: null, end: null, state: "idle" }),
};

const OPTS = { baseUrl: "http://pi:3000", token: "inv_x" };

describe("HttpGateway", () => {
  it("sends the bearer token and reports capabilities from /api/me and /api/meta", async () => {
    const f = fetchMock(BASE_ROUTES);
    const gw = await createHttpGateway({ ...OPTS, fetchImpl: f as unknown as typeof fetch });

    expect(gw.capabilities()).toEqual({
      role: "admin",
      scopes: ["read", "write"],
      allowControl: true,
      statsEnabled: true,
    });
    const headers = (f.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer inv_x");
    gw.close();
  });

  it("marks stats as unavailable when the service answers 503", async () => {
    const gw = await createHttpGateway({
      ...OPTS,
      fetchImpl: fetchMock({
        ...BASE_ROUTES,
        "/api/inverter/stats/solar-window": () => res({ ok: false }, 503),
      }) as unknown as typeof fetch,
    });
    expect(gw.capabilities().statsEnabled).toBe(false);
    expect(gw.stats).toBeNull();
    gw.close();
  });

  it("fetches a snapshot", async () => {
    const gw = await createHttpGateway({
      ...OPTS,
      fetchImpl: fetchMock({ ...BASE_ROUTES, "/api/inverter/snapshot": () => res(SNAPSHOT) }) as unknown as typeof fetch,
    });
    await expect(gw.snapshot()).resolves.toEqual(SNAPSHOT);
    gw.close();
  });

  it("turns API errors into GatewayError with the server message and status", async () => {
    const gw = await createHttpGateway({
      ...OPTS,
      fetchImpl: fetchMock({
        ...BASE_ROUTES,
        "/api/inverter/control": () => res({ ok: false, error: "Settings are locked (read-only)" }, 400),
      }) as unknown as typeof fetch,
    });
    await expect(gw.control("chargerSourcePriority", 3)).rejects.toBeInstanceOf(GatewayError);
    await expect(gw.control("chargerSourcePriority", 3)).rejects.toThrow(/locked/);
    gw.close();
  });

  it("explains an unreachable service", async () => {
    const failing = jest.fn(async (url: string | URL, _init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      if (path === "/api/inverter/snapshot") throw new Error("ECONNREFUSED");
      return BASE_ROUTES[path as keyof typeof BASE_ROUTES]();
    });
    const gw = await createHttpGateway({ ...OPTS, fetchImpl: failing as unknown as typeof fetch });

    await expect(gw.snapshot()).rejects.toThrow(/http:\/\/pi:3000 is unreachable/);
    gw.close();
  });

  it("passes preview through to /api/inverter/control", async () => {
    const preview = { register: 331, rawValue: 3, label: "Only PV", currentValue: 1, baselineValue: 1 };
    const f = fetchMock({ ...BASE_ROUTES, "/api/inverter/control": () => res({ ok: true, preview: true, ...preview }) });
    const gw = await createHttpGateway({ ...OPTS, fetchImpl: f as unknown as typeof fetch });

    await expect(gw.previewControl("chargerSourcePriority", 3)).resolves.toEqual(preview);
    const body = JSON.parse((f.mock.calls.at(-1)![1] as RequestInit).body as string);
    expect(body).toEqual({ type: "chargerSourcePriority", value: 3, preview: true });
    gw.close();
  });

  it("builds stats queries with the expected query string", async () => {
    const f = fetchMock({ ...BASE_ROUTES, "/api/inverter/stats/series": () => res([{ t: 1, pvPower: 100 }]) });
    const gw = await createHttpGateway({ ...OPTS, fetchImpl: f as unknown as typeof fetch });

    await gw.stats!.series({ fields: ["pvPower", "batteryPower"], from: 10, to: 20, res: "minute" });
    const url = String(f.mock.calls.at(-1)![0]);
    expect(url).toContain("/api/inverter/stats/series?fields=pvPower%2CbatteryPower&from=10&to=20&res=minute");
    gw.close();
  });

  it("caps a huge CSV export and reports the truncation", async () => {
    const huge = "x".repeat(6 * 1024 * 1024);
    const f = fetchMock({ ...BASE_ROUTES, "/api/inverter/stats/export.csv": () => res(null, 200, huge) });
    const gw = await createHttpGateway({ ...OPTS, fetchImpl: f as unknown as typeof fetch });

    const r = await gw.stats!.exportCsv({ from: 1, to: 2, res: "minute" });
    expect(r.truncated).toBe(true);
    expect(r.csv.length).toBe(5 * 1024 * 1024);
    gw.close();
  });

  it("subscribes over WebSocket with the bearer header and stops on unsubscribe", async () => {
    const handlers: Record<string, (arg: unknown) => void> = {};
    const sock = {
      on: (ev: string, cb: (arg: unknown) => void) => {
        handlers[ev] = cb;
      },
      close: jest.fn(),
      removeAllListeners: jest.fn(),
    };
    const ctorArgs: unknown[] = [];
    const FakeWs = function (this: unknown, url: string, init: unknown) {
      ctorArgs.push([url, init]);
      return sock;
    } as unknown as typeof import("ws").WebSocket;

    const gw = await createHttpGateway({
      ...OPTS,
      fetchImpl: fetchMock(BASE_ROUTES) as unknown as typeof fetch,
      webSocketImpl: FakeWs,
    });

    const seen: Snapshot[] = [];
    const off = gw.onSnapshot((s) => seen.push(s));

    expect(String((ctorArgs[0] as [string, unknown])[0])).toBe("ws://pi:3000/ws");
    expect((ctorArgs[0] as [string, { headers: Record<string, string> }])[1].headers.Authorization).toBe(
      "Bearer inv_x"
    );

    handlers.message(JSON.stringify({ type: "snapshot", data: SNAPSHOT }));
    expect(seen).toEqual([SNAPSHOT]);

    handlers.message("not json"); // мусор не должен ронять подписку
    expect(seen).toHaveLength(1);

    off();
    expect(sock.close).toHaveBeenCalled();
    gw.close();
  });
});
