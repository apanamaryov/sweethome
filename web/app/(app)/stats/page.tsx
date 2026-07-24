"use client";

import { useEffect, useMemo, useState } from "react";
import uPlot from "uplot";
import TimeChart, { ChartSeries } from "@/components/TimeChart";
import { useT, warnLabel } from "@/lib/i18n";
import {
  DailyRow,
  fetchDaily,
  fetchEvents,
  fetchSeries,
  SeriesPoint,
  StatsEvent,
} from "@/lib/stats";

type PeriodKind = "day" | "week" | "month";

const SERIES_FIELDS = [
  "pvPower", "acOutputActivePower", "mainsPower", "batteryPower",
  "batteryCapacity", "batteryVoltage", "dcdcTemperature", "heatSinkTemperature",
] as const;

function rangeFor(kind: PeriodKind, anchor: Date): { from: Date; to: Date } {
  const from = new Date(anchor);
  from.setHours(0, 0, 0, 0);
  const to = new Date(from);
  if (kind === "day") {
    to.setDate(to.getDate() + 1);
  } else if (kind === "week") {
    from.setDate(from.getDate() - ((from.getDay() + 6) % 7)); // понедельник
    to.setTime(from.getTime());
    to.setDate(to.getDate() + 7);
  } else {
    from.setDate(1);
    to.setTime(from.getTime());
    to.setMonth(to.getMonth() + 1);
  }
  return { from, to };
}

function shift(kind: PeriodKind, anchor: Date, dir: 1 | -1): Date {
  const d = new Date(anchor);
  if (kind === "day") d.setDate(d.getDate() + dir);
  else if (kind === "week") d.setDate(d.getDate() + 7 * dir);
  else {
    // Сначала на 1-е число: setMonth с 29–31-го числа перескакивает месяц
    // (31 июля +1 мес → «31 сентября» → 1 октября).
    d.setDate(1);
    d.setMonth(d.getMonth() + dir);
  }
  return d;
}

function dayKey(d: Date): string {
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function aligned(rows: SeriesPoint[], fields: readonly string[]): uPlot.AlignedData {
  return [
    rows.map((r) => r.t / 1000),
    ...fields.map((f) => rows.map((r) => (r[f] === null ? null : Number(r[f])))),
  ] as uPlot.AlignedData;
}

const kwh = (wh: number | null | undefined) =>
  wh === null || wh === undefined ? "—" : (wh / 1000).toFixed(1);

export default function StatsPage() {
  const t = useT();
  const [kind, setKind] = useState<PeriodKind>("day");
  const [anchor, setAnchor] = useState<Date>(() => new Date());
  const [rows, setRows] = useState<SeriesPoint[] | null>(null);
  const [daily, setDaily] = useState<DailyRow[]>([]);
  const [events, setEvents] = useState<StatsEvent[]>([]);
  const [evType, setEvType] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  const { from, to } = useMemo(() => rangeFor(kind, anchor), [kind, anchor]);

  useEffect(() => {
    let alive = true;
    setRows(null);
    setError(null);
    setDaily([]);
    setEvents([]);
    Promise.all([
      fetchSeries([...SERIES_FIELDS], from.getTime(), to.getTime()),
      fetchDaily(dayKey(from), dayKey(new Date(to.getTime() - 1))),
      fetchEvents(from.getTime(), to.getTime(), evType || undefined),
    ])
      .then(([s, d, e]) => {
        if (!alive) return;
        setRows(s);
        setDaily(d);
        setEvents(e);
      })
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [from, to, evType]);

  const powerSeries: ChartSeries[] = [
    { label: t.stSeriesPv, stroke: "#f59e0b", unit: t.capW },
    { label: t.stSeriesLoad, stroke: "#3b82f6", unit: t.capW },
    { label: t.stSeriesGrid, stroke: "#8b5cf6", unit: t.capW },
    { label: t.stSeriesBatt, stroke: "#10b981", unit: t.capW },
  ];
  const battSeries: ChartSeries[] = [
    { label: t.stSeriesSoc, stroke: "#10b981", scale: "pct", unit: "%" },
    { label: t.stSeriesBattV, stroke: "#3b82f6", unit: t.capV },
  ];
  const tempSeries: ChartSeries[] = [
    { label: t.stSeriesTempDcdc, stroke: "#f59e0b", unit: "°C" },
    { label: t.stSeriesTempInv, stroke: "#ef4444", unit: "°C" },
  ];

  const evLabel = (type: string): string =>
    ((
      {
        "mode-change": t.stEvModeChange,
        "grid-loss": t.stEvGridLoss,
        "grid-restore": t.stEvGridRestore,
        "fault-set": t.stEvFaultSet,
        "fault-clear": t.stEvFaultClear,
        "warning-set": t.stEvWarnSet,
        "warning-clear": t.stEvWarnClear,
        "conn-lost": t.stEvConnLost,
        "conn-restored": t.stEvConnRestored,
        "device-changed": t.stEvDeviceChanged,
      } as Record<string, string>
    )[type] ?? type);

  const evText = (e: StatsEvent): string => {
    let d: Record<string, unknown> = {};
    try {
      d = JSON.parse(e.detail);
    } catch {
      /* ignore */
    }
    const dict = t as unknown as Record<string, string>;
    switch (e.type) {
      case "mode-change":
        return `${dict["mode" + String(d.from)] ?? String(d.from)} → ${dict["mode" + String(d.to)] ?? String(d.to)}`;
      case "grid-loss":
      case "grid-restore":
        return `${d.gridVoltage ?? "—"} ${t.capV}`;
      case "fault-set":
      case "fault-clear":
      case "warning-set":
      case "warning-clear":
        return warnLabel(t, String(d.bit ?? ""));
      case "conn-lost":
        return String(d.lastError ?? "");
      case "conn-restored":
        return String(d.device ?? d.transport ?? "");
      case "device-changed":
        return `${d.from} → ${d.to}`;
      default:
        return e.detail;
    }
  };

  const maxWh = Math.max(1, ...daily.map((r) => Math.max(r.pv_wh, r.load_wh, r.grid_wh)));
  const fmtT = (ms: number) => new Date(ms).toLocaleString(t.langLocale);
  const periodLabel =
    kind === "day"
      ? from.toLocaleDateString(t.langLocale)
      : `${from.toLocaleDateString(t.langLocale)} — ${new Date(to.getTime() - 1).toLocaleDateString(t.langLocale)}`;
  const exportQs = `from=${from.getTime()}&to=${to.getTime()}`;

  return (
    <main className="stats">
      <div className="stats-controls">
        <span className="seg">
          {(["day", "week", "month"] as const).map((k) => (
            <button key={k} className={kind === k ? "active" : ""} onClick={() => setKind(k)}>
              {k === "day" ? t.stPeriodDay : k === "week" ? t.stPeriodWeek : t.stPeriodMonth}
            </button>
          ))}
        </span>
        <span className="seg">
          <button onClick={() => setAnchor(shift(kind, anchor, -1))}>{t.stPrev}</button>
          <button onClick={() => setAnchor(shift(kind, anchor, 1))}>{t.stNext}</button>
        </span>
        <strong className="stats-period">{periodLabel}</strong>
        <span className="stats-export">
          <a href={`/api/stats/export.csv?${exportQs}&res=raw`} download>{t.stExportRaw}</a>
          {" · "}
          <a href={`/api/stats/export.csv?${exportQs}&res=minute`} download>{t.stExportMinute}</a>
        </span>
      </div>

      {error && <div className="banner">{t.stUnavailable}</div>}
      {!error && rows === null && <div className="muted">{t.stLoading}</div>}
      {!error && rows !== null && rows.length === 0 && <div className="muted">{t.stNoData}</div>}

      {rows !== null && rows.length > 0 && (
        <>
          <section className="stats-section">
            <h3>{t.stChartPower}</h3>
            <div className="chart-box">
              <TimeChart
                data={aligned(rows, ["pvPower", "acOutputActivePower", "mainsPower", "batteryPower"])}
                series={powerSeries}
              />
            </div>
          </section>
          <section className="stats-section">
            <h3>{t.stChartBattery}</h3>
            <div className="chart-box">
              <TimeChart data={aligned(rows, ["batteryCapacity", "batteryVoltage"])} series={battSeries} />
            </div>
          </section>
          <section className="stats-section">
            <h3>{t.stChartTemp}</h3>
            <div className="chart-box">
              <TimeChart
                data={aligned(rows, ["dcdcTemperature", "heatSinkTemperature"])}
                series={tempSeries}
                height={160}
              />
            </div>
          </section>
        </>
      )}

      {daily.length > 0 && (
        <section className="stats-section">
          <h3>{t.stDailyTitle}</h3>
          <div className="table-scroll">
            <table className="stats-table stats-daily">
              <thead>
                <tr>
                  <th>{t.stThDay}</th>
                  <th></th>
                  <th>{t.stThPv}</th>
                  <th>{t.stThLoad}</th>
                  <th>{t.stThGrid}</th>
                  <th>{t.stThCharge}</th>
                  <th>{t.stThDischarge}</th>
                  <th>{t.stThSoc}</th>
                </tr>
              </thead>
              <tbody>
                {daily.map((r) => (
                  <tr key={r.day}>
                    <td>{r.day}</td>
                    <td className="stats-bar-cell">
                      <span className="stats-bar" style={{ width: `${(r.pv_wh / maxWh) * 100}%` }} />
                    </td>
                    <td>{kwh(r.pv_wh)}</td>
                    <td>{kwh(r.load_wh)}</td>
                    <td>{kwh(r.grid_wh)}</td>
                    <td>{kwh(r.batt_charge_wh)}</td>
                    <td>{kwh(r.batt_discharge_wh)}</td>
                    <td>
                      {r.soc_min ?? "—"}/{r.soc_max ?? "—"}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="stats-section">
        <h3>{t.stEventsTitle}</h3>
        <select value={evType} onChange={(e) => setEvType(e.target.value)}>
          <option value="">{t.stEvAll}</option>
          {["mode-change", "grid-loss", "grid-restore", "fault-set", "fault-clear",
            "warning-set", "warning-clear", "conn-lost", "conn-restored", "device-changed"].map((k) => (
            <option key={k} value={k}>{evLabel(k)}</option>
          ))}
        </select>
        {events.length === 0 ? (
          <div className="muted">{t.stNoData}</div>
        ) : (
          <div className="table-scroll">
            <table className="stats-table stats-events">
              <tbody>
                {events.map((e) => (
                  <tr key={e.id}>
                    <td>{fmtT(e.ts)}</td>
                    <td>{evLabel(e.type)}</td>
                    <td>{evText(e)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
