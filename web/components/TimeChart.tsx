"use client";

import { useEffect, useRef } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";

export interface ChartSeries {
  label: string;
  stroke: string;
  /** "pct" — правая ось 0–100 (для SOC); по умолчанию левая "y". */
  scale?: string;
  /** Единица измерения для подписи текущего значения в легенде (Вт, В, % …). */
  unit?: string;
}

/** Последнее непустое значение серии, округлённое до 0.1 (для легенды). */
function latest(data: uPlot.AlignedData, seriesIdx: number): string {
  const col = data[seriesIdx] as ReadonlyArray<number | null> | undefined;
  if (!col) return "—";
  for (let i = col.length - 1; i >= 0; i--) {
    const v = col[i];
    if (v != null && !Number.isNaN(v)) return String(Number(v.toFixed(1)));
  }
  return "—";
}

/** Обёртка uPlot: data — [timestamps(сек), ...значения по сериям]. */
export default function TimeChart({
  data,
  series,
  height = 220,
  bars = false,
  legend = true,
}: {
  data: uPlot.AlignedData;
  series: ChartSeries[];
  height?: number;
  /** Рисовать столбиками (для энергии), а не линиями. */
  bars?: boolean;
  /** Показывать свою легенду с текущими значениями. */
  legend?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !data[0]?.length) return;
    const hasPct = series.some((s) => s.scale === "pct");
    const barsPath = bars && uPlot.paths.bars ? uPlot.paths.bars({ size: [0.8, 44] }) : undefined;
    const u = new uPlot(
      {
        width: el.clientWidth || 600,
        height,
        // Встроенная легенда uPlot «живая» — без курсора (и всегда на тач-экране)
        // показывает «--». Вместо неё рисуем свою с текущими значениями (ниже).
        legend: { show: false },
        cursor: bars ? { points: { show: false } } : undefined,
        series: [
          {},
          ...series.map((s) => ({
            label: s.label,
            stroke: s.stroke,
            fill: bars ? s.stroke : undefined, // столбики — заливкой, линии — без
            width: bars ? 1 : 2,
            scale: s.scale ?? "y",
            points: { show: false },
            ...(barsPath ? { paths: barsPath } : {}),
          })),
        ],
        scales: {
          // Энергия неотрицательна — начинаем шкалу столбиков от нуля.
          ...(bars
            ? { y: { range: (_u, _min, max) => [0, max <= 0 ? 1 : max * 1.08] as [number, number] } }
            : {}),
          ...(hasPct ? { pct: { range: [0, 100] as [number, number] } } : {}),
        },
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
  }, [data, series, height, bars]);

  if (!data[0]?.length) return <div className="muted">—</div>;
  return (
    <>
      {legend && (
        <div className="chart-legend">
          {series.map((s, i) => (
            <span key={s.label} className="lg-item">
              <span className="lg-swatch" style={{ background: s.stroke }} />
              {s.label}
              <b className="lg-val">
                {latest(data, i + 1)}
                {s.unit ? ` ${s.unit}` : ""}
              </b>
            </span>
          ))}
        </div>
      )}
      <div className="chart" ref={ref} />
    </>
  );
}
