"use client";

import { useT } from "@/lib/i18n";
import { useSnapshot } from "@/lib/snapshot";
import { fmt } from "@/lib/format";
import { BatteryRing } from "@/components/BatteryRing";
import { SolarToday } from "@/components/SolarToday";

export default function DashboardPage() {
  const t = useT();
  const { snapshot } = useSnapshot();
  const s = snapshot?.status ?? null;

  const charging = !!s && s.batteryChargingCurrent > 0;
  const discharging = !!s && s.batteryDischargeCurrent > 0;
  const batStateClass = charging ? "state-charge" : discharging ? "state-discharge" : "state-idle";
  const batStateText = !s ? "—" : charging ? t.charging : discharging ? t.discharging : t.idle;

  return (
    <main className="grid">
      <section className="card card-battery">
        <div className="card-head">
          <span className="card-title">{t.cardBattery}</span>
          <span className={"tag " + batStateClass}>{batStateText}</span>
        </div>
        <BatteryRing soc={s ? s.batteryCapacity : NaN} label={fmt(s?.batteryCapacity, 0)} ariaLabel={t.ringAria} />
        <div className="sub-metrics center">
          <div>
            <span>{fmt(s?.batteryVoltage, 2)}</span>
            <span className="cap">{t.capV}</span>
          </div>
          <div>
            <span>{fmt(s?.batteryChargingCurrent, 0)}</span>
            <span className="cap">{t.capChargeA}</span>
          </div>
          <div>
            <span>{fmt(s?.batteryDischargeCurrent, 0)}</span>
            <span className="cap">{t.capDischargeA}</span>
          </div>
        </div>
      </section>

      <section className="card card-solar">
        <div className="card-head">
          <span className="card-title">{t.cardSolar}</span>
        </div>
        <div className="big-metric">
          <span className="big-val">{fmt(s?.pvPower, 0)}</span>
          <span className="big-unit">{t.capW}</span>
        </div>
        <div className="sub-metrics">
          <div>
            <span>{fmt(s?.pvInputVoltage, 1)}</span>
            <span className="cap">{t.capV}</span>
          </div>
          <div>
            <span>{fmt(s?.pvInputCurrent, 1)}</span>
            <span className="cap">{t.unit_A}</span>
          </div>
        </div>
        <SolarToday />
      </section>

      <section className="card card-load">
        <div className="card-head">
          <span className="card-title">{t.cardLoad}</span>
          <span className="tag">{s ? fmt(s.outputLoadPercent, 0) + "%" : "—"}</span>
        </div>
        <div className="big-metric">
          <span className="big-val">{fmt(s?.acOutputActivePower, 0)}</span>
          <span className="big-unit">{t.capW}</span>
        </div>
        <div className="sub-metrics">
          <div>
            <span>{fmt(s?.acOutputVoltage, 1)}</span>
            <span className="cap">{t.capVout}</span>
          </div>
          <div>
            <span>{fmt(s?.acOutputFrequency, 1)}</span>
            <span className="cap">{t.capHz}</span>
          </div>
          <div>
            <span>{fmt(s?.acOutputApparentPower, 0)}</span>
            <span className="cap">{t.capVA}</span>
          </div>
        </div>
      </section>

      <section className="card card-grid">
        <div className="card-head">
          <span className="card-title">{t.cardGrid}</span>
        </div>
        <div className="big-metric">
          <span className="big-val">{fmt(s?.mainsPower, 0)}</span>
          <span className="big-unit">{t.capW}</span>
        </div>
        <div className="sub-metrics">
          <div>
            <span>{fmt(s?.gridVoltage, 1)}</span>
            <span className="cap">{t.capV}</span>
          </div>
          <div>
            <span>{fmt(s?.gridFrequency, 1)}</span>
            <span className="cap">{t.capHz}</span>
          </div>
          <div>
            <span>{fmt(s?.heatSinkTemperature, 0)}</span>
            <span className="cap">{t.capTemp}</span>
          </div>
        </div>
      </section>
    </main>
  );
}
