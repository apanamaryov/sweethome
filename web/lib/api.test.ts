import { wsUrl, getJson, postJson } from "./api";

const originalNodeEnv = process.env.NODE_ENV;
const originalLocation = window.location;

// next/types/global.d.ts declares NODE_ENV as `readonly` for app code safety;
// tests still need to flip it, so go through an untyped view of process.env.
const mutableEnv = process.env as unknown as Record<string, string | undefined>;
function setNodeEnv(value: string): void {
  mutableEnv.NODE_ENV = value;
}

/** Заменяет window.location упрощённым мок-объектом без реальной навигации jsdom. */
function setLocation(overrides: Partial<Location>): void {
  Object.defineProperty(window, "location", {
    writable: true,
    configurable: true,
    value: { href: "", protocol: "http:", host: "localhost:3000", ...overrides },
  });
}

function restoreLocation(): void {
  Object.defineProperty(window, "location", {
    writable: true,
    configurable: true,
    value: originalLocation,
  });
}

afterEach(() => {
  setNodeEnv(originalNodeEnv ?? "test");
  restoreLocation();
});

describe("wsUrl", () => {
  it("returns the fixed dev URL when NODE_ENV=development, ignoring window.location", () => {
    setNodeEnv("development");
    setLocation({ protocol: "https:", host: "example.com" });
    expect(wsUrl("inverter")).toBe("ws://localhost:3000/ws/inverter");
  });

  it("derives ws:// from window.location when not in development and page is http", () => {
    setNodeEnv("production");
    setLocation({ protocol: "http:", host: "192.168.1.112:3000" });
    expect(wsUrl("inverter")).toBe("ws://192.168.1.112:3000/ws/inverter");
  });

  it("derives wss:// from window.location when the page is https", () => {
    setNodeEnv("production");
    setLocation({ protocol: "https:", host: "inverter.example.com" });
    expect(wsUrl("inverter")).toBe("wss://inverter.example.com/ws/inverter");
  });
});

describe("getJson", () => {
  beforeEach(() => {
    global.fetch = jest.fn();
  });

  it("fetches the given path and returns the parsed JSON body", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => ({ hello: "world" }),
    });

    const result = await getJson<{ hello: string }>("/api/foo");

    expect(global.fetch).toHaveBeenCalledWith("/api/foo");
    expect(result).toEqual({ hello: "world" });
  });

  it("redirects to /login and throws on 401", async () => {
    setLocation({});
    (global.fetch as jest.Mock).mockResolvedValue({ status: 401, ok: false });

    await expect(getJson("/api/foo")).rejects.toThrow("Unauthorized");
    expect(window.location.href).toBe("/login");
  });

  it("redirects to /change-password on 403 must_change_password", async () => {
    setLocation({});
    (global.fetch as jest.Mock).mockResolvedValue({
      status: 403,
      ok: false,
      clone: () => ({ json: async () => ({ code: "must_change_password" }) }),
    });

    await expect(getJson("/api/foo")).rejects.toThrow("Password change required");
    expect(window.location.href).toBe("/change-password");
  });

  it("does not redirect on a plain 403 without the must_change_password code", async () => {
    setLocation({});
    (global.fetch as jest.Mock).mockResolvedValue({
      status: 403,
      ok: false,
      clone: () => ({ json: async () => ({ code: "forbidden" }) }),
    });

    await expect(getJson("/api/foo")).rejects.toThrow("HTTP 403");
    expect(window.location.href).toBe("");
  });

  it("throws HTTP <status> on other non-ok responses", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ status: 500, ok: false });

    await expect(getJson("/api/foo")).rejects.toThrow("HTTP 500");
  });

  it("propagates a network-level fetch rejection", async () => {
    (global.fetch as jest.Mock).mockRejectedValue(new Error("network down"));

    await expect(getJson("/api/foo")).rejects.toThrow("network down");
  });
});

describe("postJson", () => {
  beforeEach(() => {
    global.fetch = jest.fn();
  });

  it("posts a JSON-encoded body with the correct method/headers and returns the response", async () => {
    const okResponse = { status: 200, ok: true };
    (global.fetch as jest.Mock).mockResolvedValue(okResponse);

    const res = await postJson("/api/foo", { a: 1 });

    expect(global.fetch).toHaveBeenCalledWith("/api/foo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ a: 1 }),
    });
    expect(res).toBe(okResponse);
  });

  it("redirects to /login and throws on 401", async () => {
    setLocation({});
    (global.fetch as jest.Mock).mockResolvedValue({ status: 401, ok: false });

    await expect(postJson("/api/foo", {})).rejects.toThrow("Unauthorized");
    expect(window.location.href).toBe("/login");
  });

  it("redirects to /change-password on 403 must_change_password", async () => {
    setLocation({});
    (global.fetch as jest.Mock).mockResolvedValue({
      status: 403,
      ok: false,
      clone: () => ({ json: async () => ({ code: "must_change_password" }) }),
    });

    await expect(postJson("/api/foo", {})).rejects.toThrow("Password change required");
    expect(window.location.href).toBe("/change-password");
  });
});
