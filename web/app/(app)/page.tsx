"use client";

import Link from "next/link";
import { useSnapshot } from "@/lib/snapshot";
import { MetaProvider, useMeta } from "@/lib/meta";
import { useT, useDocTitle, seasonLabel } from "@/lib/i18n";
import { detectSeasonProfile } from "@sweethome/inverter-shared";
import { InverterFlow, WarnChip, flowState } from "@/components/InverterFlow";
import CctvCard from "@/components/cctv/CctvCard";
import DryerCard from "@/components/dryer/DryerCard";

function InverterCard() {
  const t = useT();
  const { snapshot } = useSnapshot();
  const meta = useMeta();
  const f = snapshot ? flowState(snapshot) : null;
  const night = snapshot?.nightTariff;
  // Режим работы (сезонный профиль): пока настройки не прочитаны, его не знаем — не показываем.
  const season =
    snapshot?.info || night?.enabled ? seasonLabel(t, detectSeasonProfile(snapshot?.info ?? null, !!night?.enabled)) : null;
  const phase = night?.enabled && night.phase ? t.nightPhaseShort[night.phase] : null;

  // Обзор = статус с одного взгляда: карточка всегда видна, вся её площадь —
  // ссылка в раздел инвертора; бейджа источника нет — активные источники
  // показывает свечение на диаграмме, особые режимы — чип в шапке.
  return (
    <Link href="/inverter" className="home-card-link-wrap">
      <section className="card home-card">
        <div className="card-head">
          <span className="card-title">{t.navInverter}</span>
          {season && <span className="pill pill-season card-season">{phase ? `${season} · ${phase}` : season}</span>}
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
