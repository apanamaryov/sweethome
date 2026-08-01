import { Transport } from "./types";
import { SerialTransport } from "./serial";
import { MockTransport } from "./mock";
import { InverterConfig } from "../config";

/**
 * Produce an ordered list of candidate transports to probe. The Inverter class
 * opens each in turn, sends a probe request, and keeps the first that answers.
 * A MockTransport is always appended last so the app is never dead in the water.
 */
export async function detectTransports(cfg: InverterConfig): Promise<Transport[]> {
  const candidates: Transport[] = [];

  if (cfg.transport === "mock") {
    return [new MockTransport()];
  }

  const wantSerial = cfg.transport === "auto" || cfg.transport === "serial";

  if (wantSerial && SerialTransport.isAvailable()) {
    if (cfg.serialDevice) {
      candidates.push(new SerialTransport(cfg.serialDevice, cfg.baudRate));
    } else {
      const ports = await SerialTransport.list();
      const usable = rankSerialPorts(ports.filter(isUsbSerial));
      for (const p of usable) candidates.push(new SerialTransport(p, cfg.baudRate));
    }
  }

  if (cfg.allowMock) candidates.push(new MockTransport());
  return candidates;
}

/**
 * Keep only USB-attached serial ports. The Pi's onboard UARTs (ttyAMA0, ttyS0,
 * serial0/1) are the GPIO/console/Bluetooth lines — never the inverter over USB,
 * and probing the console UART can error. To use a GPIO UART deliberately, set
 * INVERTER_SERIAL_DEVICE explicitly (which bypasses this filter).
 */
function isUsbSerial(p: string): boolean {
  return /ttyUSB|ttyACM|\/by-id\//.test(p);
}

function rankSerialPorts(ports: string[]): string[] {
  const score = (p: string) => {
    if (p.includes("/by-id/")) return 0;
    if (/ttyUSB/.test(p)) return 1;
    if (/ttyACM/.test(p)) return 2;
    return 3;
  };
  return [...ports].sort((a, b) => score(a) - score(b));
}
