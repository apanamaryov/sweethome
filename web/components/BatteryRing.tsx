"use client";

const RING_SEGS = 20; // по 5% на сектор
const RING_GAP_DEG = 4.5;

function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const a = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

function segPath(cx: number, cy: number, r1: number, r2: number, a1: number, a2: number): string {
  const [x1, y1] = polar(cx, cy, r2, a1);
  const [x2, y2] = polar(cx, cy, r2, a2);
  const [x3, y3] = polar(cx, cy, r1, a2);
  const [x4, y4] = polar(cx, cy, r1, a1);
  const f = (n: number) => n.toFixed(2);
  return `M${f(x1)} ${f(y1)} A${r2} ${r2} 0 0 1 ${f(x2)} ${f(y2)} L${f(x3)} ${f(y3)} A${r1} ${r1} 0 0 0 ${f(x4)} ${f(y4)} Z`;
}

const STEP = 360 / RING_SEGS;
const SEG_PATHS = Array.from({ length: RING_SEGS }, (_, i) =>
  segPath(60, 60, 39, 55, i * STEP + RING_GAP_DEG / 2, (i + 1) * STEP - RING_GAP_DEG / 2)
);

/** Ячейки дизеринга Байера для паттернов p1..p5 (координаты 2×2-точек). */
const DITHER_CELLS: Array<Array<[number, number]>> = [
  [[0, 0], [4, 4]],
  [[0, 0], [4, 4], [4, 0], [0, 4], [2, 2]],
  [[0, 0], [4, 4], [4, 0], [0, 4], [2, 2], [6, 6], [6, 2], [2, 6]],
  [[0, 0], [4, 4], [4, 0], [0, 4], [2, 2], [6, 6], [6, 2], [2, 6], [2, 0], [6, 4], [6, 0]],
  [[0, 0], [4, 4], [4, 0], [0, 4], [2, 2], [6, 6], [6, 2], [2, 6], [2, 0], [6, 4], [6, 0], [2, 4], [0, 2], [4, 6]],
];

export function BatteryRing({ soc, label, ariaLabel }: { soc: number; label: string; ariaLabel: string }) {
  const clamped = Number.isNaN(soc) ? 0 : Math.max(0, Math.min(100, soc));
  const filled = Math.round((clamped / 100) * RING_SEGS);
  return (
    <div className={"ring-wrap" + (clamped <= 20 ? " low" : "")} role="img" aria-label={ariaLabel}>
      <svg viewBox="0 0 120 120" aria-hidden="true">
        <defs>
          {DITHER_CELLS.map((cells, p) => (
            <pattern key={p} id={`dith-p${p + 1}`} patternUnits="userSpaceOnUse" width="8" height="8">
              <g fill="var(--ring-c, #55795d)">
                {cells.map(([x, y], i) => (
                  <rect key={i} width="2" height="2" x={x} y={y} />
                ))}
              </g>
            </pattern>
          ))}
        </defs>
        <g>
          {SEG_PATHS.map((d, i) => (
            <path key={i} d={d} className={`seg d${Math.floor(i / 4) + 1}${i < filled ? " on" : ""}`} />
          ))}
        </g>
      </svg>
      <div className="ring-label">
        <span className="ring-value">{label}</span>
        <span className="ring-unit">%</span>
      </div>
    </div>
  );
}
