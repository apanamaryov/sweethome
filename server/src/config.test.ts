/**
 * Unit tests for loadConfig() (server/src/config.ts) — env var parsing.
 *
 * After the module extraction (see modules/inverter/src/config.ts), the host
 * Config only carries what the host itself needs: the HTTP bind (port/host),
 * the data root (dataDir — modules get their own subdirectory under it, e.g.
 * `<dataDir>/inverter`), and auth session TTL. Everything inverter-specific
 * (transport/baud/slaveId/stats/mcp/mqtt/...) moved to
 * modules/inverter/src/config.test.ts and is exercised there via
 * loadInverterConfig().
 *
 * How config.ts actually works (read from source, not assumed):
 *   - loadConfig() is the ONLY place in the host that reads process.env for
 *     its own fields; it returns a fully-populated Config snapshot, never
 *     touching env again after that point.
 *   - envInt(name, def): process.env[name] undefined -> def; otherwise
 *     parseInt(v, 10), falling back to def if the result isn't finite (NaN).
 *
 * Every test controls process.env directly (saved/restored around each
 * test) so this file is immune to whatever happens to be set in the real
 * shell/CI environment, and never leaks env vars to other test files.
 */

import { loadConfig } from "./config";

const ORIGINAL_ENV = process.env;

beforeEach(() => {
  process.env = {};
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
});

describe("loadConfig — defaults on empty env", () => {
  it("defaults port/host/dataDir", () => {
    const cfg = loadConfig();

    expect(cfg.port).toBe(3000);
    expect(cfg.host).toBe("0.0.0.0");
    expect(cfg.dataDir).toBe("data");
  });

  it("defaults the auth group", () => {
    const cfg = loadConfig();

    expect(cfg.auth).toEqual({ sessionTtlDays: 30 });
  });
});

describe("loadConfig — env overrides", () => {
  it("applies DATA_DIR string override", () => {
    process.env.DATA_DIR = "/var/lib/inverter";

    const cfg = loadConfig();

    expect(cfg.dataDir).toBe("/var/lib/inverter");
  });
});
