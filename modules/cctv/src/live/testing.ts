/**
 * Заголовок потока для тестов.
 *
 * Настоящий ffmpeg отдаёт `ftyp` и `moov` отдельными кусками, и разбирается это
 * по длинам boxes — значит и в тестах нужен настоящий по структуре заголовок, а
 * не строка-заглушка: иначе тесты проходят там, где живой поток не собирается.
 */
function box(type: string, payload: Buffer = Buffer.alloc(0)): Buffer {
  const b = Buffer.alloc(8 + payload.length);
  b.writeUInt32BE(8 + payload.length, 0);
  b.write(type, 4, "latin1");
  payload.copy(b, 8);
  return b;
}

export function fakeFtyp(): Buffer {
  return box("ftyp", Buffer.from("isomiso2avc1"));
}

/** `moov` с видеодорожкой и, по желанию, звуковой — как у камер со звуком. */
export function fakeMoov(withAudio: boolean): Buffer {
  const tracks = [box("trak", Buffer.from("avc1 video track"))];
  if (withAudio) tracks.push(box("trak", Buffer.from("mp4a sound track")));
  return box("moov", Buffer.concat(tracks));
}

/** Целый заголовок одним куском. */
export function fakeInitSegment(withAudio = false): Buffer {
  return Buffer.concat([fakeFtyp(), fakeMoov(withAudio)]);
}

/** Кусок данных, который идёт после заголовка. */
export function fakeFragment(marker = "frag"): Buffer {
  return box("moof", Buffer.from(marker));
}
