"use client";

import Link from "next/link";
import { useSnapshot } from "@/lib/snapshot";
import { MetaProvider, useMeta } from "@/lib/meta";
import { useT, useDocTitle } from "@/lib/i18n";
import { InverterFlow, WarnChip, flowState } from "@/components/InverterFlow";
import CctvCard from "@/components/cctv/CctvCard";
import DryerCard from "@/components/dryer/DryerCard";

function InverterCard() {
  const t = useT();
  const { snapshot } = useSnapshot();
  const meta = useMeta();
  const f = snapshot ? flowState(snapshot) : null;

  // Обзор = статус с одного взгляда: карточка всегда видна, вся её площадь —
  // ссылка в раздел инвертора; бейджа источника нет — активные источники
  // показывает свечение на диаграмме, особые режимы — чип в шапке.
  return (
    <Link href="/inverter" className="home-card-link-wrap">
      <section className="card home-card">
        <div className="card-head">
          <span className="card-title">{t.navInverter}</span>
          {f?.bypass && <WarnChip tone="amber" label={t.flowChipBypass} />}
          {f?.fault && (
            <WarnChip tone="brick" label={f.overloadFault ? t.flowChipOverload : t.flowChipFault} />
          )}
        </div>
        {!snapshot?.status ? (
          <p className="muted">{t.connecting}</p>
        ) : (
          <InverterFlow snapshot={snapshot} pvPeakW={meta?.pvPeakW} />
        )}
      </section>
    </Link>
  );
}

export default function HomePage() {
  useDocTitle("title");
  return (
    <main className="grid home-grid">
      <MetaProvider>
        <InverterCard />
      </MetaProvider>
      <CctvCard />
      <DryerCard />
    </main>
  );
}
