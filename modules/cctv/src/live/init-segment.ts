/**
 * Где кончается заголовок потока (`ftyp` + `moov`).
 *
 * ffmpeg пишет его в трубу несколькими вызовами, и первый кусок из stdout — не
 * весь заголовок: на живых камерах `ftyp` приезжал отдельно, а `moov` (в нём и
 * описание дорожек) — следующим куском. Из-за этого состав дорожек читался не
 * полностью, а зритель, подключившийся к уже идущей сессии, получал обрезанный
 * заголовок, которым нечего инициализировать.
 *
 * Разбираем boxes по их длинам, а не гадаем по размеру куска.
 */
export function initSegmentLength(buf: Buffer): number | null {
  let off = 0;
  while (off + 8 <= buf.length) {
    let size = buf.readUInt32BE(off);
    const type = buf.toString("latin1", off + 4, off + 8);
    let headerLen = 8;

    // size = 1 означает 64-битную длину следом за типом.
    if (size === 1) {
      if (off + 16 > buf.length) return null;
      size = Number(buf.readBigUInt64BE(off + 8));
      headerLen = 16;
    }

    // Битая длина: не притворяемся, что разобрали — пусть лучше заголовок
    // никогда не соберётся и сессия честно умрёт по таймауту у зрителя.
    if (size < headerLen) return null;
    if (off + size > buf.length) return null; // бокс ещё не дочитан

    off += size;
    if (type === "moov") return off; // init кончается ровно за moov
  }
  return null;
}

/** Больше этого заголовок не бывает: дальше — явно не то, что мы разбираем. */
export const MAX_INIT_BYTES = 1024 * 1024;
