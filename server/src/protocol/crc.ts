/**
 * CRC-16/XMODEM as used by the Voltronic (PI30 / "HS") inverter protocol.
 *
 * Polynomial 0x1021, init 0x0000. The Voltronic quirk: any resulting CRC byte
 * that collides with a protocol control byte (0x28 '(', 0x0d CR, 0x0a LF) is
 * incremented by one, on each byte independently. This matches the widely used
 * reverse-engineered implementations (mpp-solar, skymax).
 */

export function crc16(data: Buffer): Buffer {
  let crc = 0x0000;
  for (const byte of data) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) {
      if (crc & 0x8000) {
        crc = (crc << 1) ^ 0x1021;
      } else {
        crc = crc << 1;
      }
      crc &= 0xffff;
    }
  }

  let hi = (crc >> 8) & 0xff;
  let lo = crc & 0xff;

  const bump = (b: number) => (b === 0x28 || b === 0x0d || b === 0x0a ? b + 1 : b);
  hi = bump(hi);
  lo = bump(lo);

  return Buffer.from([hi, lo]);
}

/**
 * Build a full command frame: ASCII command + CRC-16 + carriage return.
 * e.g. "QPIGS" -> <"QPIGS"><crcHi><crcLo><0x0d>
 */
export function buildFrame(command: string): Buffer {
  const cmd = Buffer.from(command, "ascii");
  const crc = crc16(cmd);
  return Buffer.concat([cmd, crc, Buffer.from([0x0d])]);
}

/**
 * Validate and strip a response frame. Voltronic responses look like:
 *   "(" <payload> <crcHi> <crcLo> <CR>
 * Returns the payload string (without the leading "(" and trailing CRC/CR),
 * or throws if the framing/CRC is invalid.
 */
export function parseFrame(raw: Buffer): string {
  // Trim trailing CR and anything after it.
  let end = raw.indexOf(0x0d);
  const frame = end >= 0 ? raw.subarray(0, end) : raw;

  if (frame.length < 3 || frame[0] !== 0x28 /* "(" */) {
    throw new Error(`Malformed response frame: ${JSON.stringify(frame.toString("latin1"))}`);
  }

  const body = frame.subarray(0, frame.length - 2); // includes leading "("
  const received = frame.subarray(frame.length - 2);
  const expected = crc16(body);

  if (!received.equals(expected)) {
    // Some firmwares omit/garble CRC on short ACK/NAK replies; accept those
    // explicitly so control commands still work, but reject anything else.
    const payloadNoCrc = frame.subarray(1).toString("ascii").trim();
    if (payloadNoCrc === "ACK" || payloadNoCrc === "NAK") {
      return payloadNoCrc;
    }
    throw new Error(
      `CRC mismatch: got ${received.toString("hex")}, expected ${expected.toString("hex")} ` +
        `for payload ${JSON.stringify(body.toString("latin1"))}`
    );
  }

  return body.subarray(1).toString("ascii"); // drop leading "("
}

/**
 * Build a well-formed response frame for a given payload string.
 * Used by the mock transport to emit responses the parser accepts.
 */
export function buildResponse(payload: string): Buffer {
  const body = Buffer.concat([Buffer.from("(", "ascii"), Buffer.from(payload, "ascii")]);
  const crc = crc16(body);
  return Buffer.concat([body, crc, Buffer.from([0x0d])]);
}

/** Extract the ASCII command from an outgoing frame (strip trailing CRC + CR). */
export function commandFromFrame(frame: Buffer): string {
  let end = frame.indexOf(0x0d);
  const f = end >= 0 ? frame.subarray(0, end) : frame;
  // Last two bytes are CRC.
  return f.subarray(0, Math.max(0, f.length - 2)).toString("ascii");
}
