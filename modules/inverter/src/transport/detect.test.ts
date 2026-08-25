/**
 * Unit tests for detectTransports (modules/inverter/src/transport/detect.ts).
 *
 * How detect.ts actually works (read from source, not assumed):
 *   - detectTransports(cfg: InverterConfig) takes an already-loaded InverterConfig object —
 *     it never touches process.env itself. Env is read once by
 *     config.ts's loadInverterConfig() (INVERTER_TRANSPORT, INVERTER_SERIAL_DEVICE,
 *     INVERTER_BAUD, ALLOW_MOCK) and the resulting InverterConfig is what detect.ts
 *     consumes. So most tests below build InverterConfig objects directly to
 *     exercise detect.ts's own branching; a separate "integration" section
 *     goes through the real loadInverterConfig() with mocked process.env to prove
 *     the env → InverterConfig → detectTransports pipeline as a whole.
 *   - It returns Promise<Transport[]> — an ORDERED CANDIDATE LIST, not a
 *     single chosen transport. (The Inverter class, elsewhere, opens each
 *     candidate in turn and keeps the first that answers a probe.) "Mock is
 *     chosen" in the fallback sense means the array is [MockTransport];
 *     "mock last" means it's appended after any serial candidates.
 *   - cfg.transport === "mock" short-circuits to exactly [new MockTransport()]
 *     — it returns immediately, without even calling SerialTransport.list().
 *   - Otherwise, if serial is wanted ("auto" | "serial") and
 *     SerialTransport.isAvailable():
 *       - cfg.serialDevice set → push a single SerialTransport(serialDevice,
 *         baudRate) directly, bypassing SerialTransport.list() and the UART
 *         filter entirely (this is how one deliberately points at a GPIO
 *         UART).
 *       - else → await SerialTransport.list(), filter to USB-only paths via
 *         isUsbSerial() (matches /ttyUSB|ttyACM|\/by-id\//), and push one
 *         SerialTransport per surviving port, ordered by rankSerialPorts()
 *         (by-id symlink first, then ttyUSB, then ttyACM).
 *   - Finally, if cfg.allowMock, a MockTransport is pushed last — always
 *     after any serial candidates.
 *
 * Port listing goes through SerialTransport.list() (./serial.ts), which
 * lazily require()s "serialport" and calls its static SerialPort.list().
 * We mock the "serialport" module the same way serial.test.ts does (a
 * factory intercepting every require("serialport") call), so
 * SerialTransport.list() resolves to whatever fake port paths each test
 * configures — no real device/native binding is ever touched, and
 * SerialTransport.isAvailable()'s require.resolve("serialport") still
 * succeeds against the mocked module.
 */

jest.mock("serialport", () => ({
  SerialPort: {
    list: jest.fn(),
  },
}));

import { detectTransports } from "./detect";
import { SerialTransport } from "./serial";
import { MockTransport } from "./mock";
import { InverterConfig, loadInverterConfig } from "../config";

const serialportMock = jest.requireMock("serialport") as {
  SerialPort: { list: jest.Mock };
};

/** A complete, valid InverterConfig with sane defaults; override only what a test cares about. */
function baseConfig(overrides: Partial<InverterConfig> = {}): InverterConfig {
  return {
    transport: "auto",
    serialDevice: null,
    baudRate: 9600,
    slaveId: 1,
    pollIntervalMs: 5000,
    commandTimeoutMs: 3000,
    allowMock: true,
    pvPeakW: 0,
    allowControl: true,
    startupLocked: true,
    autoRelock: true,
    dataDir: "data",
    stats: { enabled: true, rawDays: 30, minuteDays: 730, solarThresholdW: 200, solarDwellMin: 15 },
    mqtt: {
      url: null,
      username: null,
      password: null,
      baseTopic: "inverter",
      discoveryPrefix: "homeassistant",
      nodeId: "sk5500p48l",
      deviceName: "Inverter SK-5500P-48L",
      enableControl: false,
    },
    ...overrides,
  };
}

/** Configures the mocked SerialPort.list() to resolve to the given device paths. */
function setListedPorts(paths: string[]): void {
  serialportMock.SerialPort.list.mockResolvedValue(paths.map((path) => ({ path })));
}

beforeEach(() => {
  serialportMock.SerialPort.list.mockReset();
  setListedPorts([]); // default: nothing plugged in unless a test says otherwise
});

describe("detectTransports — INVERTER_TRANSPORT=mock", () => {
  it("returns exactly one MockTransport, without listing serial ports at all", async () => {
    const cfg = baseConfig({ transport: "mock" });

    const result = await detectTransports(cfg);

    expect(result).toHaveLength(1);
    expect(result[0]).toBeInstanceOf(MockTransport);
    expect(serialportMock.SerialPort.list).not.toHaveBeenCalled();
  });

  it("short-circuits to mock-only even if a real serialDevice is also configured", async () => {
    // cfg.transport === "mock" returns before serialDevice is ever consulted.
    const cfg = baseConfig({ transport: "mock", serialDevice: "/dev/ttyUSB0" });

    const result = await detectTransports(cfg);

    expect(result).toEqual([expect.any(MockTransport)]);
  });
});

describe("detectTransports — auto, no USB-serial ports", () => {
  it("falls back to mock as the sole candidate when the port list is empty", async () => {
    setListedPorts([]);
    const cfg = baseConfig({ transport: "auto" });

    const result = await detectTransports(cfg);

    expect(result).toHaveLength(1);
    expect(result[0]).toBeInstanceOf(MockTransport);
  });

  it("also falls back to mock when only onboard Pi UARTs are listed (ttyAMA*/ttyS0 filtered out)", async () => {
    setListedPorts(["/dev/ttyAMA0", "/dev/ttyS0"]);
    const cfg = baseConfig({ transport: "auto" });

    const result = await detectTransports(cfg);

    expect(result).toHaveLength(1);
    expect(result[0]).toBeInstanceOf(MockTransport);
  });
});

describe("detectTransports — auto with a USB-serial port present", () => {
  it("prefers the USB-serial transport, with mock appended last as fallback", async () => {
    setListedPorts(["/dev/ttyAMA0", "/dev/ttyUSB0"]); // one onboard UART + one real USB adapter
    const cfg = baseConfig({ transport: "auto", baudRate: 19200 });

    const result = await detectTransports(cfg);

    expect(result).toHaveLength(2);
    expect(result[0]).toBeInstanceOf(SerialTransport);
    expect((result[0] as SerialTransport).device).toBe("/dev/ttyUSB0"); // ttyAMA0 filtered out
    expect(result[1]).toBeInstanceOf(MockTransport);
  });

  it("ranks multiple USB-serial candidates: /by-id/ symlink first, then ttyUSB, then ttyACM", async () => {
    setListedPorts(["/dev/ttyACM0", "/dev/ttyUSB1", "/dev/serial/by-id/usb-FTDI_FT231X-if00-port0"]);
    const cfg = baseConfig({ transport: "auto" });

    const result = await detectTransports(cfg);

    expect(result).toHaveLength(4); // 3 serial candidates + mock fallback
    const devices = result.slice(0, 3).map((t) => (t as SerialTransport).device);
    expect(devices).toEqual([
      "/dev/serial/by-id/usb-FTDI_FT231X-if00-port0",
      "/dev/ttyUSB1",
      "/dev/ttyACM0",
    ]);
    expect(result[3]).toBeInstanceOf(MockTransport);
  });

  it("does not append mock when allowMock is false, even with a USB port present", async () => {
    setListedPorts(["/dev/ttyUSB0"]);
    const cfg = baseConfig({ transport: "auto", allowMock: false });

    const result = await detectTransports(cfg);

    expect(result).toHaveLength(1);
    expect(result[0]).toBeInstanceOf(SerialTransport);
  });
});

describe("detectTransports — explicit INVERTER_SERIAL_DEVICE bypasses the UART filter", () => {
  it("uses the configured device even though it is an onboard UART, without calling list()", async () => {
    const cfg = baseConfig({ transport: "auto", serialDevice: "/dev/ttyAMA0" });

    const result = await detectTransports(cfg);

    expect(result).toHaveLength(2);
    expect(result[0]).toBeInstanceOf(SerialTransport);
    expect((result[0] as SerialTransport).device).toBe("/dev/ttyAMA0");
    expect(result[1]).toBeInstanceOf(MockTransport);
    expect(serialportMock.SerialPort.list).not.toHaveBeenCalled();
  });

  it("also applies when transport is explicitly \"serial\" rather than \"auto\"", async () => {
    const cfg = baseConfig({ transport: "serial", serialDevice: "/dev/ttyS0" });

    const result = await detectTransports(cfg);

    expect(result[0]).toBeInstanceOf(SerialTransport);
    expect((result[0] as SerialTransport).device).toBe("/dev/ttyS0");
  });
});

describe("detectTransports — integration with loadInverterConfig() env parsing", () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.INVERTER_TRANSPORT;
    delete process.env.INVERTER_SERIAL_DEVICE;
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it("INVERTER_TRANSPORT=mock round-trips through loadInverterConfig() into a mock-only candidate list", async () => {
    process.env.INVERTER_TRANSPORT = "mock";

    const cfg = loadInverterConfig("data");
    expect(cfg.transport).toBe("mock");

    const result = await detectTransports(cfg);
    expect(result).toHaveLength(1);
    expect(result[0]).toBeInstanceOf(MockTransport);
  });

  it("INVERTER_SERIAL_DEVICE in env round-trips through loadInverterConfig() to bypass the UART filter", async () => {
    process.env.INVERTER_TRANSPORT = "auto";
    process.env.INVERTER_SERIAL_DEVICE = "/dev/ttyAMA0";

    const cfg = loadInverterConfig("data");
    expect(cfg.serialDevice).toBe("/dev/ttyAMA0");

    const result = await detectTransports(cfg);
    expect(result[0]).toBeInstanceOf(SerialTransport);
    expect((result[0] as SerialTransport).device).toBe("/dev/ttyAMA0");
    expect(serialportMock.SerialPort.list).not.toHaveBeenCalled();
  });
});
