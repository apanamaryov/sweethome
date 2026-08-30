"use client";

import type { DryerSnapshot } from "@sweethome/dryer-shared";
import { useT } from "@/lib/i18n";
import { fmt } from "@/lib/format";
import { faultLabel, fmtHm } from "@/lib/dryer";
import StateChip from "./StateChip";

/** Крупно — камера и уставка; мельче — влажность, избыток, комната, пластина, нагрев, вытяжка. null → «—». */
export default function DryerStatus({ snapshot }: { snapshot: DryerSnapshot }) {
  const t = useT();
  const n = snapshot.node;
  const run = snapshot.run;
  const setpoint = run?.setpoint ?? n.setpoint;
  const deadline = run ? new Date(run.startedAt + run.maxMinutes * 60_000).toLocaleTimeString(t.langLocale) : null;

  return (
    <section className="card">
      <div className="dryer-head">
        <div className="big-metric">
          <span className="big-val">{fmt(n.chamber.temp, 1)}</span>
          <span className="big-unit">{setpoint !== null ? `→ ${fmt(setpoint, 0)} °C` : "°C"}</span>
        </div>
        <StateChip node={n} />
      </div>

      {!n.online && !run && <p className="banner">{t.dryerOfflineIdle}</p>}
      {!n.online && run && (
        <p className="banner amber">{`${t.dryerOfflineRunning} ${deadline}`}</p>
      )}
      {n.online && n.state === "fault" && <p className="banner brick">{faultLabel(t, n.stopReason)}</p>}
      {n.online && n.state === "cooldown" && <p className="note">{`${t.dryerCooldownInfo} ${fmt(n.plateTemp, 0)} °C`}</p>}

      <div className="dryer-metrics">
        {n.chamber.rh !== null && (
          <div className="dryer-metric"><span className="cap">{t.dryerChamber}</span><b>{fmt(n.chamber.rh, 0)} % RH</b></div>
        )}
        <div className="dryer-metric"><span className="cap">{t.dryerExcess}</span><b>{fmt(n.excess, 1)}</b></div>
        <div className="dryer-metric"><span className="cap">{t.dryerAmbient}</span><b>{fmt(n.ambient.temp, 1)} °C{n.ambient.rh !== null ? ` / ${fmt(n.ambient.rh, 0)} %` : ""}</b></div>
        <div className="dryer-metric"><span className="cap">{t.dryerPlate}</span><b>{fmt(n.plateTemp, 0)} °C</b></div>
        <div className="dryer-metric"><span className="cap">{t.dryerHeater}</span><b>{fmt(n.heaterDuty, 0)} %</b></div>
        <div className="dryer-metric"><span className="cap">{t.dryerExhaust}</span><b>{fmt(n.exhaustDuty, 0)} %{n.exhaustRpm !== null ? ` · ${fmt(n.exhaustRpm, 0)} ${t.dryerRpm}` : ""}</b></div>
        {run && (
          <div className="dryer-metric">
            <span className="cap">{t.dryerElapsed}</span>
            <b>{`${fmtHm(snapshot.now - run.startedAt)} ${t.dryerOf} ${fmtHm(run.maxMinutes * 60_000)}`}</b>
          </div>
        )}
      </div>
    </section>
  );
}
