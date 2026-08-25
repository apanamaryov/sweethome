import type { SegmentRow } from "./index/db";
import { GAP_TOLERANCE_MS } from "./index/spans";

const defaultSegmentUrl = (id: number) => `/api/cctv/segment/${id}`;
const defaultInitUrl = (id: number) => `/api/cctv/init/${id}`;

/**
 * Сегменты из индекса → VOD-плейлист.
 *
 * `PLAYLIST-TYPE:VOD` даёт плееру всю длину сразу, поэтому ползунок работает по
 * всему запрошенному интервалу. Разрывы записи и смена init-сегмента помечаются
 * `EXT-X-DISCONTINUITY`: без этого плеер считает пропущенное время записанным и
 * перемотка «съезжает» относительно реального времени.
 */
export function buildVodPlaylist(
  segs: SegmentRow[],
  opts: {
    segmentUrl?: (id: number) => string;
    initUrl?: (id: number) => string;
    gapToleranceMs?: number;
  } = {}
): string {
  const segmentUrl = opts.segmentUrl ?? defaultSegmentUrl;
  const initUrl = opts.initUrl ?? defaultInitUrl;
  const tolerance = opts.gapToleranceMs ?? GAP_TOLERANCE_MS;
  const sorted = [...segs].sort((a, b) => a.startMs - b.startMs);

  const target = sorted.reduce((max, s) => Math.max(max, s.durMs), 0);
  const lines: string[] = [
    "#EXTM3U",
    "#EXT-X-VERSION:7",
    `#EXT-X-TARGETDURATION:${Math.ceil(target / 1000)}`,
    "#EXT-X-MEDIA-SEQUENCE:0",
    "#EXT-X-PLAYLIST-TYPE:VOD",
    "#EXT-X-INDEPENDENT-SEGMENTS",
  ];

  let curInit: number | null = null;
  let expectedStart: number | null = null;

  for (const s of sorted) {
    const initChanged = s.initId !== curInit;
    const gapped = expectedStart !== null && Math.abs(s.startMs - expectedStart) > tolerance;

    if ((initChanged && curInit !== null) || gapped) lines.push("#EXT-X-DISCONTINUITY");
    if (initChanged) {
      lines.push(`#EXT-X-MAP:URI="${initUrl(s.initId)}"`);
      curInit = s.initId;
    }
    if (initChanged || gapped || expectedStart === null) {
      lines.push(`#EXT-X-PROGRAM-DATE-TIME:${new Date(s.startMs).toISOString()}`);
    }

    lines.push(`#EXTINF:${(s.durMs / 1000).toFixed(3)},`);
    lines.push(segmentUrl(s.id));
    expectedStart = s.startMs + s.durMs;
  }

  lines.push("#EXT-X-ENDLIST");
  return lines.join("\n") + "\n";
}
