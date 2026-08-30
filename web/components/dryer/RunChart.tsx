"use client";

import { useEffect, useState } from "react";
import type { Run, Sample } from "@sweethome/dryer-shared";
import TimeChart from "@/components/TimeChart";
import { useT } from "@/lib/i18n";
import { chartData, fetchRunSamples } from "@/lib/dryer";

const REFRESH_MS = 60_000;

/** График одной сушки: пока она идёт — перечитывает замеры раз в минуту, после остановки — как есть. */
export default function RunChart({ run }: { run: Run }) {
  const t = useT();
  const [samples, setSamples] = useState<Sample[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => fetchRunSamples(run.id).then((r) => { if (!cancelled) setSamples(r.samples); }).catch(() => {});
    load();
    const timer = run.endedAt === null ? setInterval(load, REFRESH_MS) : null;
    return () => { cancelled = true; if (timer) clearInterval(timer); };
  }, [run.id, run.endedAt]);

  if (!samples) return <p className="muted">{t.connecting}</p>;
  if (samples.length === 0) return <p className="muted">{t.dryerNoChart}</p>;
  return (
    <div className="chart-box">
      <TimeChart
        data={chartData(samples, run.setpoint)}
        series={[
          { label: t.dryerChartTemp, stroke: "#b5542d", unit: "°C" },
          { label: t.dryerChartSetpoint, stroke: "#8899aa", unit: "°C" },
          { label: t.dryerChartExcess, stroke: "#2d6fb5", unit: "" },
          { label: t.dryerChartHeater, stroke: "#6b8e23", scale: "pct", unit: "%" },
        ]}
      />
    </div>
  );
}
