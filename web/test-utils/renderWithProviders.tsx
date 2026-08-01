import { ReactElement, ReactNode } from "react";
import { render, act, RenderResult } from "@testing-library/react";
import type {
  ApiMeta,
  Baseline,
  InverterFlags,
  InverterRatedInfo,
  InverterStatus,
  Role,
  SessionUser,
  Snapshot,
} from "@sweethome/inverter-shared";
import {
  ALLOWED_MAX_AC_CHARGE_CURRENT,
  ALLOWED_MAX_CHARGE_CURRENT,
  CHARGER_SOURCE_PRIORITY,
  OUTPUT_SOURCE_PRIORITY,
} from "@sweethome/inverter-shared";
import { LangProvider } from "@/lib/i18n";
import { SnapshotProvider } from "@/lib/snapshot";
import { MetaProvider } from "@/lib/meta";
import { SessionProvider } from "@/lib/session";
import { ToastProvider } from "@/lib/toast";

/**
 * next/navigation mock, shared across every test file that imports this helper
 * (jest.mock() here runs when this module is first required, which happens
 * before the page-under-test's own `import ... from "next/navigation"` since
 * test files import this helper first). Only `usePathname` is actually used
 * in the app today (app/(app)/layout.tsx); `useRouter`/`redirect` are stubbed
 * for forward-compatibility per the task brief.
 */
export const mockRouterPush = jest.fn();
export const mockRedirect = jest.fn();
export const mockUsePathname = jest.fn(() => "/");

jest.mock("next/navigation", () => ({
  usePathname: () => mockUsePathname(),
  useRouter: () => ({
    push: mockRouterPush,
    replace: jest.fn(),
    back: jest.fn(),
    forward: jest.fn(),
    refresh: jest.fn(),
    prefetch: jest.fn(),
  }),
  redirect: (url: string) => mockRedirect(url),
}));

/** Sets the pathname next/navigation's mocked `usePathname()` returns. */
export function setMockPathname(path: string): void {
  mockUsePathname.mockReturnValue(path);
}

/**
 * Fake WebSocket: same shape as the one in lib/snapshot.test.tsx (constructor +
 * on* setters + instances registry), swapped in globally so SnapshotProvider's
 * `new WebSocket(wsUrl(module))` doesn't blow up under jsdom (which has none).
 */
export class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  url: string;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  closeCalls = 0;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  close(): void {
    this.closeCalls++;
  }
}

export function installFakeWebSocket(): void {
  FakeWebSocket.instances = [];
  (global as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket;
}

const originalLocation = window.location;

/** Replaces window.location with a plain settable stub (no real jsdom navigation). */
export function setLocation(overrides: Partial<Location> = {}): void {
  Object.defineProperty(window, "location", {
    writable: true,
    configurable: true,
    value: { href: "", protocol: "http:", host: "localhost:3000", ...overrides },
  });
}

export function restoreLocation(): void {
  Object.defineProperty(window, "location", {
    writable: true,
    configurable: true,
    value: originalLocation,
  });
}

/** Flushes pending microtasks (fetch/json resolutions) without touching fake timers. */
export async function flushMicrotasks(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

/** Minimal fetch Response stand-in good enough for getJson/postJson + the providers. */
export function jsonResponse(status: number, body: unknown): Response {
  const res = {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    clone() {
      return res;
    },
  };
  return res as unknown as Response;
}

/**
 * Installs a global.fetch that answers /api/inverter/snapshot, /api/inverter/meta and
 * /api/me (consumed by SnapshotProvider/MetaProvider/SessionProvider on mount) and
 * delegates everything else to whatever global.fetch the test already set up (if
 * any). `snapshot`/`meta`/`session` set to null means "never resolves this endpoint" —
 * the provider stays in its initial loading state, same as a real backend that's
 * briefly unreachable.
 */
export function wrapProviderFetch(opts: {
  snapshot?: Snapshot | null;
  meta?: ApiMeta | null;
  session?: SessionUser | null;
}): void {
  const existing = global.fetch as unknown as
    | ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>)
    | undefined;

  const handler = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/inverter/snapshot") {
      return opts.snapshot
        ? Promise.resolve(jsonResponse(200, opts.snapshot))
        : Promise.reject(new Error("renderWithProviders: no snapshot configured"));
    }
    if (url === "/api/inverter/meta") {
      return opts.meta
        ? Promise.resolve(jsonResponse(200, opts.meta))
        : Promise.reject(new Error("renderWithProviders: no meta configured"));
    }
    if (url === "/api/me") {
      return opts.session
        ? Promise.resolve(jsonResponse(200, opts.session))
        : Promise.reject(new Error("renderWithProviders: no session configured"));
    }
    if (existing) return existing(input, init);
    return Promise.reject(new Error(`renderWithProviders: unmocked fetch to ${url}`));
  });
  global.fetch = handler as unknown as typeof fetch;
}

/** Full InverterStatus fixture (all live-status fields) with overridable fields. */
export function buildStatus(overrides: Partial<InverterStatus> = {}): InverterStatus {
  return {
    gridVoltage: 230.5,
    gridFrequency: 50.02,
    mainsPower: 120,
    inverterPower: -120,
    acOutputVoltage: 230.1,
    acOutputFrequency: 50.01,
    acOutputActivePower: 350,
    acOutputApparentPower: 400,
    outputLoadPercent: 12,
    batteryVoltage: 53.6,
    batteryPower: 200,
    batteryChargingCurrent: 4,
    batteryDischargeCurrent: 0,
    batteryCapacity: 87,
    pvInputVoltage: 120.3,
    pvInputCurrent: 3.2,
    pvPower: 420,
    pvChargingPower: 380,
    dcdcTemperature: 34,
    heatSinkTemperature: 38,
    raw: "201=3 202=2305",
    ...overrides,
  };
}

/** Full InverterRatedInfo fixture (settings/registers 300-343 + 643). */
export function buildRatedInfo(overrides: Partial<InverterRatedInfo> = {}): InverterRatedInfo {
  return {
    outputMode: 0,
    outputSourcePriority: 0,
    inputVoltageRange: 0,
    buzzerMode: 0,
    lcdBacklight: 1,
    acOutputRatingVoltage: 230,
    acOutputRatingFrequency: 50,
    batteryType: 1,
    batteryOverVoltage: 64,
    batteryBulkVoltage: 56.4,
    batteryFloatVoltage: 54,
    batteryRedischargeVoltage: 52,
    batteryRechargeVoltage: 50,
    batteryUnderVoltage: 44,
    chargerSourcePriority: 1,
    maxChargingCurrent: 60,
    maxAcChargingCurrent: 30,
    eqChargingVoltage: 57,
    socBackToUtility: 20,
    socBackToBattery: 80,
    socLowCutoff: 10,
    acOutputRatingActivePower: 5500,
    raw: "300=0 301=0",
    ...overrides,
  };
}

export function buildFlags(overrides: Partial<InverterFlags> = {}): InverterFlags {
  return {
    flags: [
      { key: "lcdHome", name: "LCD return to home", enabled: true },
      { key: "ecoMode", name: "ECO mode", enabled: false },
    ],
    raw: "306=1 307=0",
    ...overrides,
  };
}

export function buildBaseline(overrides: Partial<Baseline> = {}): Baseline {
  return {
    deviceId: "device-1",
    capturedAt: Date.UTC(2026, 0, 1, 12, 0, 0),
    info: buildRatedInfo(),
    flags: buildFlags(),
    ...overrides,
  };
}

/** Full Snapshot fixture; defaults to a "connected, unlocked, everything read" state. */
export function buildSnapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    timestamp: Date.now(),
    connection: {
      connected: true,
      transport: "mock",
      device: null,
      deviceId: "device-1",
      mock: true,
      lastError: null,
    },
    control: { allowControl: true, locked: false },
    mode: "Line",
    powerSource: "Line",
    status: buildStatus(),
    info: buildRatedInfo(),
    flags: buildFlags(),
    warnings: { active: [], raw: "100=0 108=0" },
    baseline: null,
    ...overrides,
  };
}

/** Full ApiMeta fixture for a given role; the priority maps/current arrays mirror shared/api.ts. */
export function buildMeta(role: Role = "admin", overrides: Partial<ApiMeta> = {}): ApiMeta {
  return {
    session: {
      username: role === "admin" ? "admin" : "viewer",
      role,
      mustChangePassword: false,
    },
    allowControl: true,
    outputSourcePriority: { ...OUTPUT_SOURCE_PRIORITY },
    chargerSourcePriority: { ...CHARGER_SOURCE_PRIORITY },
    maxChargingCurrent: [...ALLOWED_MAX_CHARGE_CURRENT],
    maxAcChargingCurrent: [...ALLOWED_MAX_AC_CHARGE_CURRENT],
    ...overrides,
  };
}

/** Full SessionUser fixture (the /api/me shape) for a given role. */
export function buildSession(role: Role = "admin", overrides: Partial<SessionUser> = {}): SessionUser {
  return {
    username: role === "admin" ? "admin" : "viewer",
    role,
    mustChangePassword: false,
    ...overrides,
  };
}

export interface RenderWithProvidersOptions {
  /** Role baked into the default ApiMeta/SessionUser; ignored if `meta`/`session` is passed explicitly. */
  role?: Role;
  /** Wrap in SnapshotProvider and answer /api/inverter/snapshot with this (default: none configured -> stays loading). */
  withSnapshot?: boolean;
  snapshot?: Snapshot | null;
  /** Wrap in MetaProvider and answer /api/inverter/meta with this (default: built from `role`). */
  withMeta?: boolean;
  meta?: ApiMeta | null;
  /** Wrap in SessionProvider and answer /api/me with this (default: off — most pages don't need it). */
  withSession?: boolean;
  session?: SessionUser | null;
  /** What next/navigation's mocked usePathname() reports. */
  pathname?: string;
}

function Providers({
  children,
  withSnapshot,
  withMeta,
  withSession,
}: {
  children: ReactNode;
  withSnapshot: boolean;
  withMeta: boolean;
  withSession: boolean;
}) {
  let tree = <ToastProvider>{children}</ToastProvider>;
  if (withMeta) tree = <MetaProvider>{tree}</MetaProvider>;
  if (withSnapshot) tree = <SnapshotProvider>{tree}</SnapshotProvider>;
  if (withSession) tree = <SessionProvider>{tree}</SessionProvider>;
  return <LangProvider>{tree}</LangProvider>;
}

/**
 * Renders `ui` inside the real i18n/toast providers, and optionally the real
 * snapshot/meta/session providers (driven by a mocked global.fetch + fake WebSocket
 * so they resolve deterministically instead of hitting the network). Awaits the
 * initial provider fetches before returning, wrapped in `act`.
 *
 * Any global.fetch the test already installed (e.g. for a page's own POST
 * calls) is preserved and used as the fallback for URLs other than
 * /api/inverter/snapshot, /api/inverter/meta and /api/me.
 */
export async function renderWithProviders(
  ui: ReactElement,
  options: RenderWithProvidersOptions = {}
): Promise<RenderResult> {
  const {
    role = "admin",
    withSnapshot = true,
    snapshot = null,
    withMeta = true,
    meta = buildMeta(role),
    withSession = false,
    session = buildSession(role),
    pathname = "/",
  } = options;

  setMockPathname(pathname);
  setLocation({});
  if (withSnapshot || withMeta || withSession) {
    installFakeWebSocket();
    wrapProviderFetch({ snapshot, meta, session });
  }

  let utils!: RenderResult;
  await act(async () => {
    utils = render(
      <Providers withSnapshot={withSnapshot} withMeta={withMeta} withSession={withSession}>
        {ui}
      </Providers>
    );
    await flushMicrotasks();
  });
  return utils;
}
