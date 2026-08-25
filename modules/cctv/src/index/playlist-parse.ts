export interface ParsedEntry {
  file: string;
  initFile: string;
  startMs: number;
  durMs: number;
}

/**
 * Разбор плейлиста, который ведёт сам ffmpeg (`-f hls` + `program_date_time`).
 *
 * Метку времени ffmpeg ставит перед каждым сегментом, но полагаться только на
 * это нельзя: при `append_list` после перезапуска встречаются участки, где метка
 * стоит один раз на группу. Поэтому время следующего сегмента при отсутствии
 * метки досчитывается от предыдущего.
 */
export function parseHlsPlaylist(text: string, fallbackSegmentSec = 60): ParsedEntry[] {
  const out: ParsedEntry[] = [];
  let initFile: string | null = null;
  let pendingStart: number | null = null;
  let pendingDur: number | null = null;
  let nextStart: number | null = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith("#EXT-X-MAP:")) {
      const m = /URI="([^"]+)"/.exec(line);
      if (m) initFile = m[1];
      continue;
    }
    if (line.startsWith("#EXT-X-PROGRAM-DATE-TIME:")) {
      const t = Date.parse(line.slice("#EXT-X-PROGRAM-DATE-TIME:".length).trim());
      if (Number.isFinite(t)) pendingStart = t;
      continue;
    }
    if (line.startsWith("#EXTINF:")) {
      const sec = parseFloat(line.slice("#EXTINF:".length));
      if (Number.isFinite(sec)) pendingDur = Math.round(sec * 1000);
      continue;
    }
    if (line.startsWith("#")) continue; // прочие теги нам не нужны

    // Не тег и не пусто — это имя файла сегмента.
    const startMs: number | null = pendingStart ?? nextStart;
    const durMs: number = pendingDur ?? fallbackSegmentSec * 1000;
    if (initFile !== null && startMs !== null) {
      out.push({ file: line, initFile, startMs, durMs });
      nextStart = startMs + durMs;
    }
    pendingStart = null;
    pendingDur = null;
  }
  return out;
}
