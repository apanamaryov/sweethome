import {
  crc16,
  buildReadRequest,
  buildWriteRequest,
  expectedResponseLength,
  parseReadResponse,
  parseWriteResponse,
  toSigned,
  ModbusError,
} from "./modbus";

const hex = (s: string) => Buffer.from(s.replace(/\s+/g, ""), "hex");

describe("crc16", () => {
  it("matches live read request CRC (LE 54 34)", () => {
    expect(crc16(hex("01 03 00 c9 00 01"))).toBe(0x3454);
  });
});

describe("buildReadRequest", () => {
  it("builds live etalon frame for reg 201", () => {
    expect(buildReadRequest(1, 201, 1)).toEqual(hex("01 03 00 c9 00 01 54 34"));
  });
  it("builds live etalon frame for reg 215", () => {
    expect(buildReadRequest(1, 215, 1)).toEqual(hex("01 03 00 d7 00 01 34 32"));
  });
});

describe("parseReadResponse — live etalon frames", () => {
  it.each([
    ["mode", "01 03 02 00 03 f8 45", 3],
    ["ac voltage", "01 03 02 09 17 fe 1a", 2327],
    ["battery voltage", "01 03 02 02 0a 39 23", 522],
    ["soc", "01 03 02 00 48 b8 72", 72],
  ])("decodes %s", (_name, frame, value) => {
    const [v] = parseReadResponse(hex(frame as string), 1, 1);
    expect(v).toBe(value);
  });

  it("rejects bad CRC", () => {
    expect(() => parseReadResponse(hex("01 03 02 00 03 f8 46"), 1, 1)).toThrow(/CRC/);
  });

  it("throws ModbusError with exception code on exception frame", () => {
    const exBody = Buffer.from([1, 0x83, 0x02]);
    const c = crc16(exBody);
    const ex = Buffer.concat([exBody, Buffer.from([c & 0xff, (c >> 8) & 0xff])]);
    expect(() => parseReadResponse(ex, 1, 1)).toThrow(
      expect.objectContaining({ exceptionCode: 2 }) as unknown as Error
    );
    try {
      parseReadResponse(ex, 1, 1);
    } catch (e) {
      expect(e).toBeInstanceOf(ModbusError);
    }
  });
});

describe("buildWriteRequest / parseWriteResponse", () => {
  it("uses fn 0x10 and correct length", () => {
    const w = buildWriteRequest(1, 331, [3]);
    expect(w[1]).toBe(0x10);
    expect(w.length).toBe(11);
    expect(expectedResponseLength(w)).toBe(8);
  });
  it("accepts a valid write echo", () => {
    const echoBody = Buffer.from([1, 0x10, 331 >> 8, 331 & 0xff, 0, 1]);
    const c = crc16(echoBody);
    const echo = Buffer.concat([echoBody, Buffer.from([c & 0xff, (c >> 8) & 0xff])]);
    expect(() => parseWriteResponse(echo, 1, 331, 1)).not.toThrow();
  });
  it("rejects echo with wrong address", () => {
    const echoBody = Buffer.from([1, 0x10, 0, 99, 0, 1]);
    const c = crc16(echoBody);
    const echo = Buffer.concat([echoBody, Buffer.from([c & 0xff, (c >> 8) & 0xff])]);
    expect(() => parseWriteResponse(echo, 1, 331, 1)).toThrow(/echo mismatch/);
  });
});

describe("expectedResponseLength", () => {
  it("computes read length for 17 registers", () => {
    expect(expectedResponseLength(buildReadRequest(1, 201, 17))).toBe(3 + 34 + 2);
  });
  it("throws on unsupported function", () => {
    const bogus = Buffer.from([1, 0x06, 0, 0, 0, 0, 0, 0]);
    expect(() => expectedResponseLength(bogus)).toThrow(/Unsupported function/);
  });
});

describe("toSigned", () => {
  it.each([
    [0xfff6, -10],
    [0x020a, 522],
    [0x8000, -32768],
    [0x7fff, 32767],
  ])("toSigned(0x%s)", (input, expected) => {
    expect(toSigned(input as number)).toBe(expected);
  });
});
