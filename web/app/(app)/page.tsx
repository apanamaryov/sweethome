"use client";

import Link from "next/link";
import { useSnapshot } from "@/lib/snapshot";
import { useT, useDocTitle, modeLabel } from "@/lib/i18n";
import { fmt } from "@/lib/format";

export default function HomePage() {
  const t = useT();
  useDocTitle("title"); // общий заголовок приложения; union-тип useDocTitle не расширяем
  const { snapshot } = useSnapshot();
  const s = snapshot?.status ?? null;
  const source = snapshot?.powerSource ?? snapshot?.mode ?? "Unknown";

  // Обзор = статус с одного взгляда: карточка всегда видна (как карточки
  // дашборда в inverter/page.tsx), никакого сворачиваемого Panel — тот
  // предназначен для второстепенного/advanced-контента (diagnostics, settings).
  return (
    <main className="grid home-grid">
      <section className="card home-card">
        <div className="card-head">
          <span className="card-title">{t.navInverter}</span>
          <span className={"mode-badge mode-" + source}>{modeLabel(t, source)}</span>
        </div>
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
              <span>{fmt(s.pvPower, 0)}</span>
              <span className="cap">{t.capW}</span>
            </div>
          </div>
        )}
        <Link href="/inverter" className="home-card-link">
          {t.homeInverterCardOpen}
        </Link>
      </section>
    </main>
  );
}
