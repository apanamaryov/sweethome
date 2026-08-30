"use client";

import { useEffect, useState } from "react";
import type { Run } from "@sweethome/dryer-shared";
import { useT } from "@/lib/i18n";
import { endReasonLabel, fetchRuns, fmtHm } from "@/lib/dryer";
import RunChart from "@/components/dryer/RunChart";

const DAY = 86_400_000;
const toInput = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export default function HistoryPage() {
  const t = useT();
  const [from, setFrom] = useState(toInput(Date.now() - 30 * DAY));
  const [to, setTo] = useState(toInput(Date.now() + DAY));
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [selected, setSelected] = useState<Run | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fromMs = new Date(from).getTime();
    const toMs = new Date(to).getTime();
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return;
    fetchRuns(fromMs, toMs)
      .then((r) => { setRuns(r); setError(null); })
      .catch((e: Error) => setError(e.message));
  }, [from, to]);

  return (
    <main className="grid">
      <section className="card">
        <div className="dryer-actions">
          <label>{t.dryerHistoryFrom} <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
          <label>{t.dryerHistoryTo} <input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        </div>
        {error && <p className="banner">{`${t.dryerError}: ${error}`}</p>}
        {runs === null && !error && <p className="muted">{t.connecting}</p>}
        {runs && runs.length === 0 && <p className="muted">{t.dryerHistoryEmpty}</p>}
        {runs && runs.length > 0 && (
          <div className="table-scroll">
            <table className="dryer-table">
              <thead>
                <tr><th>{t.dryerColStarted}</th><th>{t.dryerColPreset}</th><th>°C</th><th>{t.dryerColDuration}</th><th>{t.dryerColEnd}</th><th>{t.dryerRestarts}</th></tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id} className={"clickable" + (selected?.id === r.id ? " active" : "")} onClick={() => setSelected(r)}>
                    <td>{new Date(r.startedAt).toLocaleString(t.langLocale)}</td>
                    <td>{r.presetName ?? t.dryerCustom}</td>
                    <td>{r.setpoint}</td>
                    <td>{fmtHm((r.endedAt ?? Date.now()) - r.startedAt)}</td>
                    <td>{endReasonLabel(t, r.endReason)}</td>
                    <td>{r.restarts || ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {selected && <RunChart run={selected} />}
    </main>
  );
}
