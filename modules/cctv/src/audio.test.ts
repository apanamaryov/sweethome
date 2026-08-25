import { headerHasAudio, liveMime } from "./audio";

describe("определение звука по заголовку", () => {
  it("находит звуковую дорожку по метке mp4a", () => {
    const withAudio = Buffer.concat([Buffer.from("ftypisom"), Buffer.alloc(40), Buffer.from("mp4a")]);
    expect(headerHasAudio(withAudio)).toBe(true);
  });

  it("не выдумывает звук там, где его нет", () => {
    const videoOnly = Buffer.concat([Buffer.from("ftypisom"), Buffer.alloc(40), Buffer.from("avc1")]);
    expect(headerHasAudio(videoOnly)).toBe(false);
  });

  it("так же работает с заголовком, прочитанным как текст", () => {
    // Сканер читает файлы в utf8; байты ASCII переживают это даже посреди мусора.
    expect(headerHasAudio(Buffer.concat([Buffer.alloc(20, 0xff), Buffer.from("mp4a")]).toString("utf8"))).toBe(true);
  });
});

describe("MIME живого потока", () => {
  it("объявляет звуковой кодек только когда звук действительно есть", () => {
    // Объявить кодек, которого в потоке нет, хуже, чем не объявить: MediaSource
    // тогда не открывается вообще, и зритель видит пустой прямоугольник.
    expect(liveMime(true)).toBe('video/mp4; codecs="avc1.4d0032,mp4a.40.2"');
    expect(liveMime(false)).toBe('video/mp4; codecs="avc1.4d0032"');
  });
});
