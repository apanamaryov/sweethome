/**
 * Modbus RTU: сборка/разбор кадров для инвертора SMG II.
 *
 * Кадр запроса чтения (fn 0x03 Read Holding Registers):
 *   <slave> 0x03 <addrHi> <addrLo> <cntHi> <cntLo> <crcLo> <crcHi>
 * Кадр записи (fn 0x10 Write Multiple Registers — устройство НЕ поддерживает
 * fn 0x06, см. use_write_multiple в esphome-smg-ii):
 *   <slave> 0x10 <addrHi> <addrLo> <cntHi> <cntLo> <bytes> <data…> <crc>
 * Ответ-исключение: <slave> <fn|0x80> <code> <crc> (5 байт).
 */

/** CRC-16/Modbus: poly 0xA001 (reflected 0x8005), init 0xFFFF, LE в кадре. */
export function crc16(data: Buffer): number {
  let crc = 0xffff;
  for (const b of data) {
    crc ^= b;
    for (let i = 0; i < 8; i++) {
      crc = crc & 1 ? (crc >> 1) ^ 0xa001 : crc >> 1;
    }
  }
  return crc & 0xffff;
}

function withCrc(body: Buffer): Buffer {
  const c = crc16(body);
  return Buffer.concat([body, Buffer.from([c & 0xff, (c >> 8) & 0xff])]);
}

/** Ошибка протокола; для Modbus-исключений содержит код. */
export class ModbusError extends Error {
  readonly exceptionCode: number | null;
  constructor(message: string, exceptionCode: number | null = null) {
    super(message);
    this.exceptionCode = exceptionCode;
  }
}

const EXCEPTION_NAMES: Record<number, string> = {
  1: "Illegal function",
  2: "Illegal data address",
  3: "Illegal data value",
  4: "Slave device failure",
  5: "Acknowledge",
  6: "Slave device busy",
};

export function buildReadRequest(slave: number, addr: number, count: number): Buffer {
  return withCrc(
    Buffer.from([slave, 0x03, (addr >> 8) & 0xff, addr & 0xff, (count >> 8) & 0xff, count & 0xff])
  );
}

export function buildWriteRequest(slave: number, addr: number, values: number[]): Buffer {
  const head = Buffer.from([
    slave,
    0x10,
    (addr >> 8) & 0xff,
    addr & 0xff,
    (values.length >> 8) & 0xff,
    values.length & 0xff,
    values.length * 2,
  ]);
  const data = Buffer.alloc(values.length * 2);
  values.forEach((v, i) => data.writeUInt16BE(v & 0xffff, i * 2));
  return withCrc(Buffer.concat([head, data]));
}

/** Полная длина нормального ответа на данный запрос (для чтения из порта). */
export function expectedResponseLength(request: Buffer): number {
  const fn = request[1];
  if (fn === 0x03) {
    const count = request.readUInt16BE(4);
    return 3 + count * 2 + 2; // slave, fn, byteCount, data, crc
  }
  if (fn === 0x10) return 8; // echo: slave, fn, addr, count, crc
  throw new ModbusError(`Unsupported function 0x${fn.toString(16)}`);
}

/** Общая валидация ответа: slave, CRC, исключение. Возвращает кадр без CRC. */
function validate(frame: Buffer, slave: number, fn: number): Buffer {
  if (frame.length >= 5 && frame[0] === slave && frame[1] === (fn | 0x80)) {
    const code = frame[2];
    throw new ModbusError(
      `Modbus exception ${code}${EXCEPTION_NAMES[code] ? ` (${EXCEPTION_NAMES[code]})` : ""}`,
      code
    );
  }
  if (frame.length < 4) throw new ModbusError(`Short response (${frame.length} bytes)`);
  if (frame[0] !== slave) throw new ModbusError(`Wrong slave id in response: ${frame[0]} != ${slave}`);
  if (frame[1] !== fn) throw new ModbusError(`Wrong function in response: 0x${frame[1].toString(16)}`);
  const body = frame.subarray(0, frame.length - 2);
  const got = frame.readUInt16LE(frame.length - 2);
  const want = crc16(body);
  if (got !== want) {
    throw new ModbusError(
      `CRC mismatch: got ${got.toString(16)}, expected ${want.toString(16)} for ${body.toString("hex")}`
    );
  }
  return body;
}

/** Разбор ответа на чтение: массив u16-значений. */
export function parseReadResponse(frame: Buffer, slave: number, count: number): number[] {
  const body = validate(frame, slave, 0x03);
  const byteCount = body[2];
  if (byteCount !== count * 2 || body.length !== 3 + byteCount) {
    throw new ModbusError(`Unexpected read response length: byteCount=${byteCount}, want ${count * 2}`);
  }
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(body.readUInt16BE(3 + i * 2));
  return out;
}

/** Разбор эха записи: проверяет адрес/количество, бросает при ошибке. */
export function parseWriteResponse(frame: Buffer, slave: number, addr: number, count: number): void {
  const body = validate(frame, slave, 0x10);
  const echoAddr = body.readUInt16BE(2);
  const echoCount = body.readUInt16BE(4);
  if (echoAddr !== addr || echoCount !== count) {
    throw new ModbusError(`Write echo mismatch: addr=${echoAddr}/${addr}, count=${echoCount}/${count}`);
  }
}

/** u16 → знаковое (S_WORD в карте регистров). */
export function toSigned(u16: number): number {
  return u16 >= 0x8000 ? u16 - 0x10000 : u16;
}
