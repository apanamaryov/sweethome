import { initSegmentLength } from "./init-segment";

/** Собирает MP4-бокс с заданным типом и содержимым. */
function box(type: string, payload = Buffer.alloc(0)): Buffer {
  const b = Buffer.alloc(8 + payload.length);
  b.writeUInt32BE(8 + payload.length, 0);
  b.write(type, 4, "latin1");
  payload.copy(b, 8);
  return b;
}

describe("initSegmentLength", () => {
  const ftyp = box("ftyp", Buffer.from("isom"));
  const moov = box("moov", Buffer.concat([box("trak", Buffer.from("avc1")), box("trak", Buffer.from("mp4a"))]));

  it("находит конец заголовка сразу за moov", () => {
    const buf = Buffer.concat([ftyp, moov, box("moof")]);
    expect(initSegmentLength(buf)).toBe(ftyp.length + moov.length);
  });

  it("пока moov не дочитан, честно говорит, что заголовка ещё нет", () => {
    // Ровно этот случай и был на живых камерах: ftyp приезжает отдельным
    // куском, и по нему нельзя ни узнать дорожки, ни инициализировать плеер.
    expect(initSegmentLength(ftyp)).toBeNull();
    expect(initSegmentLength(Buffer.concat([ftyp, moov.subarray(0, 10)]))).toBeNull();
  });

  it("понимает 64-битную длину бокса", () => {
    const big = Buffer.alloc(16 + 4);
    big.writeUInt32BE(1, 0);
    big.write("ftyp", 4, "latin1");
    big.writeBigUInt64BE(BigInt(20), 8);
    const buf = Buffer.concat([big, moov]);
    expect(initSegmentLength(buf)).toBe(big.length + moov.length);
  });

  it("на битой длине не выдумывает результат", () => {
    const broken = Buffer.alloc(8);
    broken.writeUInt32BE(3, 0); // меньше самого заголовка бокса
    broken.write("ftyp", 4, "latin1");
    expect(initSegmentLength(broken)).toBeNull();
  });
});
