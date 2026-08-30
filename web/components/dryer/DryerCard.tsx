"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { DryerSnapshot } from "@sweethome/dryer-shared";
import { useT } from "@/lib/i18n";
import { fmt } from "@/lib/format";
import { fetchDryerState, fmtHm } from "@/lib/dryer";
import StateChip from "./StateChip";

/** Карточка на обзоре: статус с одного взгляда (спека §9). Один GET, без WS — обзор не должен держать сокет на каждый модуль. */
export default function DryerCard() {
  const t = useT();
  const [snap, setSnap] = useState<DryerSnapshot | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    fetchDryerState().then(setSnap).catch(() => setFailed(true));
  }, []);

  const n = snap?.node;
  const run = snap?.run ?? null;
  return (
    <Link href="/dryer" className="home-card-link-wrap">
      <section className="card home-card">
        <div className="card-head">
          <span className="card-title">{t.navDryer}</span>
          {(n || failed) && <StateChip node={n ?? { online: false, state: null }} />}
        </div>
        {!snap && !failed ? (
          <p className="muted">{t.connecting}</p>
        ) : snap && n ? (
          <div className="home-card-rows">
            <div className="home-card-row"><span>{t.dryerChamber}</span><span>{`${fmt(n.chamber.temp, 1)}${run ? ` → ${fmt(run.setpoint, 0)}` : ""} °C`}</span></div>
            {n.chamber.rh !== null && <div className="home-card-row"><span>{t.dryerExcess}</span><span>{`${fmt(n.chamber.rh, 0)} % · ${fmt(n.excess, 1)}`}</span></div>}
            {run && <div className="home-card-row"><span>{run.presetName ?? t.dryerCustom}</span><span>{`${fmtHm(snap.now - run.startedAt)} ${t.dryerOf} ${fmtHm(run.maxMinutes * 60_000)}`}</span></div>}
            {snap.events[0] && <p className="note">{snap.events[0].text}</p>}
          </div>
        ) : null}
      </section>
    </Link>
  );
}
