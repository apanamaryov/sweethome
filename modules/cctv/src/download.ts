import type { SegmentRow } from "./index/db";

/** Экранирование для concat-демуксера: внутри одинарных кавычек. */
const quote = (p: string) => `'${p.replace(/'/g, `'\\''`)}'`;

/**
 * Список файлов для `-f concat`. Init-сегмент идёт первым: без него в склейке нет
 * заголовков потока и файл не откроется.
 */
export function buildConcatList(segs: SegmentRow[], storageDir: string, initPath?: string): string {
  if (segs.length === 0) return "";
  const lines: string[] = [];
  if (initPath) lines.push(`file ${quote(`${storageDir}/${initPath}`)}`);
  for (const s of segs) lines.push(`file ${quote(`${storageDir}/${s.path}`)}`);
  return lines.join("\n") + "\n";
}

export function concatArgs(opts: { listPath: string }): string[] {
  return [
    "-nostdin", "-hide_banner", "-loglevel", "error",
    "-f", "concat", "-safe", "0",
    "-i", opts.listPath,
    "-c", "copy",
    "-movflags", "+frag_keyframe+empty_moov+default_base_moof",
    "-f", "mp4",
    "pipe:1",
  ];
}

export function downloadFileName(cam: string, fromMs: number): string {
  const d = new Date(fromMs);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${cam}_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.mp4`;
}
