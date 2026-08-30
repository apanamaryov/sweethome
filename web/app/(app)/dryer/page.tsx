"use client";

import { useEffect, useState } from "react";
import type { Preset } from "@sweethome/dryer-shared";
import { useDryer } from "@/lib/dryer-state";
import { useSession } from "@/lib/session";
import { useT } from "@/lib/i18n";
import { fetchPresets, markEventSeen } from "@/lib/dryer";
import DryerStatus from "@/components/dryer/DryerStatus";
import RunControls from "@/components/dryer/RunControls";
import RunChart from "@/components/dryer/RunChart";
import EventsList from "@/components/dryer/EventsList";

export default function DryerPage() {
  const t = useT();
  const { snapshot, error, refresh } = useDryer();
  const session = useSession();
  const isAdmin = session?.role === "admin"; // роль не загрузилась — считаем viewer
  const [presets, setPresets] = useState<Preset[]>([]);

  useEffect(() => {
    fetchPresets().then(setPresets).catch(() => setPresets([]));
  }, []);

  if (error && !snapshot) return <p className="banner">{`${t.dryerError}: ${error}`}</p>;
  if (!snapshot) return <p>{t.connecting}</p>;

  return (
    <main className="grid">
      <DryerStatus snapshot={snapshot} />
      <RunControls snapshot={snapshot} isAdmin={isAdmin} presets={presets} onChanged={refresh} />
      {snapshot.run && <RunChart run={snapshot.run} />}
      <EventsList events={snapshot.events} onSeen={(id) => markEventSeen(id).then(refresh).catch(() => {})} />
    </main>
  );
}
