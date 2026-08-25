/**
 * Звук в потоке: определяем по заголовку, а не по настройкам.
 *
 * Камеры у нас разные — две отдают звук (AAC 8 кГц моно), третья только видео.
 * Гадать нельзя: если объявить браузеру звуковой кодек, которого в потоке нет,
 * MediaSource не откроется вовсе. Поэтому смотрим, что реально прислал ffmpeg.
 */

/** H.264 Main level 5.0 — измерено разведкой (спека §2.1). */
export const VIDEO_CODEC = "avc1.4d0032";
/** AAC-LC — то, что отдают камеры со звуком. */
export const AUDIO_CODEC = "mp4a.40.2";

/**
 * Есть ли звуковая дорожка в заголовке фрагментированного MP4 (`ftyp`+`moov`).
 *
 * Ищем метку `mp4a` — имя бокса описания звуковой дорожки. Заголовок приходит
 * первым фрагментом живого потока и лежит в init-файле каждой записи, так что
 * одна и та же проверка отвечает и за живой просмотр, и за архив.
 */
export function headerHasAudio(header: Buffer | string): boolean {
  // Байты ASCII переживают декодирование в utf8 даже посреди двоичного мусора,
  // поэтому строковый заголовок (так его читает сканер) проверяется так же.
  return typeof header === "string" ? header.includes("mp4a") : header.includes("mp4a");
}

/** MIME для MediaSource: со звуком или без — по факту содержимого. */
export function liveMime(hasAudio: boolean): string {
  const codecs = hasAudio ? `${VIDEO_CODEC},${AUDIO_CODEC}` : VIDEO_CODEC;
  return `video/mp4; codecs="${codecs}"`;
}
