"use client";

import { useEffect, useRef } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";

export interface ChartSeries {
  label: string;
  stroke: string;
  /** "pct" — правая ось 0–100 (для SOC); по умолчанию левая "y". */
  scale?: string;
}

/** Обёртка uPlot: data — [timestamps(сек), ...значения по сериям]. */
export default function TimeChart({
  data,
  series,
  height = 220,
}: {
  data: uPlot.AlignedData;
  series: ChartSeries[];
  height?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !data[0]?.length) return;
    const hasPct = series.some((s) => s.scale === "pct");
    const u = new uPlot(
      {
        width: el.clientWidth || 600,
        height,
        series: [
          {},
          ...series.map((s) => ({
            label: s.label,
            stroke: s.stroke,
            width: 2,
            scale: s.scale ?? "y",
            points: { show: false },
          })),
        ],
        scales: hasPct ? { pct: { range: [0, 100] as [number, number] } } : undefined,
        axes: [
          { stroke: "#8899aa", grid: { stroke: "#88888833", width: 1 } },
          { scale: "y", stroke: "#8899aa", grid: { stroke: "#88888833", width: 1 } },
          ...(hasPct
            ? [{ scale: "pct", side: 1 as const, stroke: "#8899aa", grid: { show: false } }]
            : []),
        ],
      },
      data,
      el
    );
    const ro = new ResizeObserver(() => u.setSize({ width: el.clientWidth || 600, height }));
    ro.observe(el);
    return () => {
      ro.disconnect();
      u.destroy();
    };
  }, [data, series, height]);
  if (!data[0]?.length) return <div className="muted">—</div>;
  return <div ref={ref} />;
}
