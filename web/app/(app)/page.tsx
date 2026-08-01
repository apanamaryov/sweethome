"use client";

import Link from "next/link";
import { useSnapshot } from "@/lib/snapshot";
import { useT, useDocTitle, modeLabel } from "@/lib/i18n";
import { Panel } from "@/components/Panel";
import { fmt } from "@/lib/format";

export default function HomePage() {
  const t = useT();
  useDocTitle("title"); // общий заголовок приложения; union-тип useDocTitle не расширяем
  const { snapshot } = useSnapshot();
  const s = snapshot?.status ?? null;
  const source = snapshot?.powerSource ?? snapshot?.mode ?? "Unknown";

  return (
    <main className="grid home-grid">
      <Panel title={t.navInverter}>
        <div className="home-card">
          <span className={"mode-badge mode-" + source}>{modeLabel(t, source)}</span>
          {!s ? (
            <p className="muted">{t.connecting}</p>
          ) : (
            <div className="home-card-rows">
              <div className="home-card-row">
                <span className="cap">{t.cardBattery}</span>
                <span>{fmt(s.batteryCapacity, 0)}</span>
                <span className="cap">{t.unit_pct}</span>
              </div>
              <div className="home-card-row">
                <span className="cap">{t.cardLoad}</span>
                <span>{fmt(s.acOutputActivePower, 0)}</span>
                <span className="cap">{t.capW}</span>
              </div>
              <div className="home-card-row">
                <span className="cap">{t.cardSolar}</span>
                <span>{fmt(s.pvChargingPower, 0)}</span>
                <span className="cap">{t.capW}</span>
              </div>
            </div>
          )}
        </div>
        <Link href="/inverter" className="home-card-link">
          {t.homeInverterCardOpen}
        </Link>
      </Panel>
    </main>
  );
}
