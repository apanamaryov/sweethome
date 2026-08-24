"use client";

import type { MotionMark, Span } from "@sweethome/cctv-shared";
import { ratioAt, spanBars, timeAtRatio } from "@/lib/cctv";

export default function Timeline({
  spans,
  marks,
  fromMs,
  toMs,
  positionMs,
  onSeek,
}: {
  spans: Span[];
  marks: MotionMark[];
  fromMs: number;
  toMs: number;
  positionMs: number;
  onSeek: (tsMs: number) => void;
}) {
  const bars = spanBars(spans, fromMs, toMs);

  const click = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    onSeek(timeAtRatio((e.clientX - rect.left) / rect.width, fromMs, toMs));
  };

  return (
    <div className="cctv-timeline" data-testid="cctv-track" onClick={click}>
      {bars.map((b, i) => (
        <span
          key={i}
          data-testid="cctv-span"
          className="cctv-span"
          style={{ left: `${b.leftPct}%`, width: `${b.widthPct}%` }}
        />
      ))}
      {marks.map((m, i) => (
        <span
          key={i}
          data-testid="cctv-mark"
          className="cctv-mark"
          style={{ left: `${ratioAt(m.tsMs, fromMs, toMs) * 100}%` }}
        />
      ))}
      <span
        data-testid="cctv-cursor"
        className="cctv-cursor"
        style={{ left: `${ratioAt(positionMs, fromMs, toMs) * 100}%` }}
      />
    </div>
  );
}
