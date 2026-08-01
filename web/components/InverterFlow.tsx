"use client";

import { useRef } from "react";
import type { Snapshot } from "@sweethome/inverter-shared";
import { useT } from "@/lib/i18n";
import { fmt } from "@/lib/format";

export interface FlowState {
  sunActive: boolean;
  gridActive: boolean;
  batteryDischarging: boolean;
  batteryCharging: boolean;
  gridAbsent: boolean;
  bypass: boolean;
  fault: boolean;
  overloadFault: boolean;
  overload: boolean;
}

/** Правило свечения/потоков: активность — по фактической отдаче мощности,
 *  а не по одному выведенному powerSource (источники работают одновременно). */
export function flowState(s: Snapshot): FlowState {
  const st = s.status;
  const fault = s.mode === "Fault";
  return {
    sunActive: !fault && (st?.pvPower ?? 0) > 0,
    gridActive: !fault && (st?.mainsPower ?? 0) > 0,
    batteryDischarging: !fault && (st?.batteryPower ?? 0) < 0,
    batteryCharging: !fault && (st?.batteryPower ?? 0) > 0,
    gridAbsent: (st?.gridVoltage ?? 0) < 100,
    bypass: s.mode === "Bypass",
    fault,
    overloadFault: fault && (s.warnings?.active ?? []).includes("Overload"),
    overload: (st?.outputLoadPercent ?? 0) > 100,
  };
}

/** «7%» от пика; null — пик не задан, процент скрывается. */
export function pctLabel(watts: number, peak?: number | null): string | null {
  if (!peak || peak <= 0) return null;
  return `${Math.round((watts / peak) * 100)}%`;
}

export function WarnChip({ tone, label }: { tone: "amber" | "brick"; label: string }) {
  return (
    <span className={`warnchip ${tone}`}>
      <svg
        width="11"
        height="11"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M12 3 L22 20 H2 Z" />
        <line x1="12" y1="9.5" x2="12" y2="14.5" />
        <circle cx="12" cy="17.5" r="0.6" fill="currentColor" />
      </svg>
      {label}
    </span>
  );
}

/* Геометрия — из согласованного макета (flow-variant-v19): viewBox 320×250,
   инвертор 140,100 40×40; узлы: солнце (48,44), сеть (272,44), батарея (48,196),
   нагрузка (272,196). Ветки рисуются ОТ источника К приёмнику — CSS-анимация
   штрихов течёт по направлению пути, т.е. по направлению энергии. */

const GLOW = { wide: 24, tight: 18, disc: 16 };

function NodeGlow({ x, y, color, node }: { x: number; y: number; color: string; node: string }) {
  return (
    <>
      <circle
        className="flow-glow"
        data-node={node}
        cx={x}
        cy={y}
        r={GLOW.wide}
        fill={color}
        opacity="0.30"
        filter="url(#flowGlowWide)"
      />
      <circle cx={x} cy={y} r={GLOW.tight} fill={color} opacity="0.45" filter="url(#flowGlowTight)" />
    </>
  );
}

export function InverterFlow({ snapshot, pvPeakW }: { snapshot: Snapshot; pvPeakW?: number }) {
  const t = useT();
  const f = flowState(snapshot);
  const st = snapshot.status;
  const rated = snapshot.info?.acOutputRatingActivePower;
  // Последняя ненулевая нагрузка — для «0 Вт · було N» в аварии.
  const lastLoad = useRef(0);
  const loadW = st?.acOutputActivePower ?? 0;
  if (loadW > 0) lastLoad.current = loadW;

  const pvW = st?.pvPower ?? 0;
  const battW = st?.batteryPower ?? 0;
  const mainsW = st?.mainsPower ?? 0;
  const soc = st?.batteryCapacity ?? 0;

  const sunPct = pctLabel(pvW, pvPeakW);
  const loadPct = pctLabel(loadW, rated);
  const w = ` ${t.capW}`;

  const sunVal = sunPct ? `${sunPct} · ${fmt(pvW, 0)}${w}` : `${fmt(pvW, 0)}${w}`;
  const battVal = `${fmt(soc, 0)}% · ${battW > 0 ? "+" : battW < 0 ? "−" : ""}${fmt(Math.abs(battW), 0)}${w}`;
  const gridVal = f.gridAbsent ? t.flowGridAbsent : `${fmt(mainsW, 0)}${w}`;
  const gridValClass = f.gridAbsent ? "val-alarm" : mainsW > 0 ? "val-grid" : "val-off";
  const loadVal = f.fault
    ? lastLoad.current > 0
      ? `0${w} · ${t.flowWas} ${fmt(lastLoad.current, 0)}`
      : `0${w}`
    : loadPct
      ? `${loadPct} · ${fmt(loadW, 0)}${w}`
      : `${fmt(loadW, 0)}${w}`;

  const loadAlarm = f.overload || f.fault;
  const battActive = f.batteryDischarging || f.batteryCharging;
  const battPath = f.batteryDischarging ? "M66 178 L140 136" : "M140 136 L66 178";
  const line = (active: boolean, boost = false) =>
    active ? `flow-line${boost ? " boost" : ""}` : "flow-line-idle";

  // viewBox с боковыми полями (−24…344): значения центрированы под краевыми
  // узлами (x=48 и x=272) и при длинных строках («100% · −5500 Вт») выходят
  // за 0…320 — без запаса SVG их клипает по краю карточки.
  return (
    <svg className="flow-svg" viewBox="-24 0 368 250" role="img" aria-label={t.navInverter}>
      <defs>
        <filter id="flowGlowWide" x="-80%" y="-80%" width="260%" height="260%">
          <feGaussianBlur stdDeviation="7" />
        </filter>
        <filter id="flowGlowTight" x="-80%" y="-80%" width="260%" height="260%">
          <feGaussianBlur stdDeviation="3" />
        </filter>
      </defs>

      {/* ветки */}
      <path
        data-branch="sun"
        data-active={f.sunActive ? "1" : "0"}
        className={`${line(f.sunActive, true)} flow-sun`}
        d="M66 62 L140 104"
      />
      <path
        data-branch="grid"
        data-active={f.gridActive ? "1" : "0"}
        className={`${line(f.gridActive, true)} flow-grid`}
        d="M254 62 L180 104"
      />
      <path
        data-branch="battery"
        data-active={battActive ? "1" : "0"}
        data-dir={f.batteryDischarging ? "discharge" : "charge"}
        className={`${line(battActive, f.batteryDischarging)} flow-moss`}
        d={battPath}
      />
      <path
        data-branch="load"
        data-active={!f.fault && loadW > 0 ? "1" : "0"}
        className={`${line(!f.fault && loadW > 0)} ${loadAlarm ? "flow-brick" : "flow-slate"}`}
        d="M180 136 L254 178"
      />

      {/* инвертор в центре */}
      {f.bypass && (
        <>
          <rect
            className="flow-glow"
            data-node="inverter"
            x="130"
            y="90"
            width="60"
            height="60"
            rx="10"
            fill="var(--sun)"
            opacity="0.30"
            filter="url(#flowGlowWide)"
          />
          <rect
            x="136"
            y="96"
            width="48"
            height="48"
            rx="7"
            fill="var(--sun)"
            opacity="0.40"
            filter="url(#flowGlowTight)"
          />
        </>
      )}
      <g
        className={f.fault ? "flow-inv-fault" : f.bypass ? "flow-inv-bypass" : "flow-inv"}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      >
        <rect x="140" y="100" width="40" height="40" rx="4" strokeWidth="2" className="flow-inv-body" />
        <line x1="144" y1="136" x2="176" y2="104" strokeWidth="1.6" />
        <line x1="147" y1="109" x2="159" y2="109" strokeWidth="2" />
        <line x1="147" y1="113.5" x2="159" y2="113.5" strokeWidth="2" strokeDasharray="2.6 2.2" />
        <path d="M161 128.5 q3.75 -6.5 7.5 0 t7.5 0" strokeWidth="2" />
      </g>
      {f.fault && (
        <g data-node="inverter-fault">
          <circle cx="180" cy="100" r="9" fill="var(--brick)" />
          <text x="180" y="104" textAnchor="middle" className="flow-fault-mark">
            !
          </text>
        </g>
      )}

      {/* солнце */}
      {f.sunActive && <NodeGlow x={48} y={44} color="var(--sun)" node="sun" />}
      <circle cx="48" cy="44" r={GLOW.disc} className={f.sunActive ? "flow-disc disc-sun" : "flow-disc disc-off"} />
      <g className="flow-icon" strokeLinecap="round">
        <circle cx="48" cy="44" r="5.5" />
        <path d="M48 33v3.5M48 51.5v3.5M37 44h3.5M55.5 44h3.5M40 36l2.5 2.5M53.5 49.5l2.5 2.5M56 36l-2.5 2.5M42.5 49.5L40 52" />
      </g>
      <text className={`flow-lab${f.sunActive ? " on" : ""}`} x="48" y="76" textAnchor="middle">
        {t.flowSun}
      </text>
      <text className="flow-val val-sun" x="48" y="90" textAnchor="middle">
        {f.sunActive || pvW > 0 ? sunVal : `0${w}`}
      </text>

      {/* сеть: опора ЛЭП */}
      {f.gridActive && <NodeGlow x={272} y={44} color="var(--plum)" node="grid" />}
      <circle
        cx="272"
        cy="44"
        r={GLOW.disc}
        className={f.gridActive ? "flow-disc disc-grid" : "flow-disc disc-off"}
      />
      <g className="flow-icon thin" strokeLinecap="round" strokeLinejoin="round">
        <path d="M267 53 L271.2 34 h1.6 L277 53" />
        <path d="M264 39 H280" />
        <path d="M266 39 v3 M278 39 v3" />
        <path d="M268.6 46 H275.4 M268.6 46 L275.4 50.5 M275.4 46 L268.6 50.5 M268 50.5 H276" />
      </g>
      <text
        className={`flow-lab${f.gridActive ? " on" : ""}${f.gridAbsent ? " alarm" : ""}`}
        x="272"
        y="76"
        textAnchor="middle"
      >
        {t.cardGrid}
      </text>
      <text className={`flow-val ${gridValClass}`} x="272" y="90" textAnchor="middle">
        {gridVal}
      </text>

      {/* батарея */}
      {f.batteryDischarging && <NodeGlow x={48} y={196} color="var(--moss)" node="battery" />}
      <circle cx="48" cy="196" r={GLOW.disc} className="flow-disc disc-batt" />
      <g className="flow-icon" strokeLinecap="round">
        <rect x="39" y="191" width="16" height="10" rx="1.5" />
        <line x1="57.5" y1="193.5" x2="57.5" y2="198.5" />
        <rect x="41.5" y="193.5" width="8" height="5" className="flow-icon-fill" />
      </g>
      <text className={`flow-lab${f.batteryDischarging ? " on" : ""}`} x="48" y="226" textAnchor="middle">
        {t.cardBattery}
      </text>
      <text className="flow-val val-batt" x="48" y="240" textAnchor="middle">
        {battVal}
      </text>

      {/* нагрузка: домик */}
      <circle
        cx="272"
        cy="196"
        r={GLOW.disc}
        className={`flow-disc ${loadAlarm ? "disc-alarm" : f.fault ? "disc-off" : "disc-load"}`}
      />
      <g className="flow-icon house" strokeLinecap="round" strokeLinejoin="round">
        <path d="M262.5 197.5 L272 188 L281.5 197.5" />
        <path d="M265.5 196 V204.5 H278.5 V196" />
        <path d="M270.5 204.5 V200 H273.5 V204.5" />
      </g>
      <text className={`flow-lab${loadAlarm ? " alarm" : ""}`} x="272" y="226" textAnchor="middle">
        {t.cardLoad}
      </text>
      <text className={`flow-val ${loadAlarm ? "val-alarm" : "val-load"}`} x="272" y="240" textAnchor="middle">
        {loadVal}
      </text>
    </svg>
  );
}
