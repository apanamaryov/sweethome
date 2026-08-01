"use client";

import { useEffect, useState } from "react";
import type { ControlType, InverterRatedInfo, Snapshot } from "@sweethome/inverter-shared";
import { useT } from "@/lib/i18n";
import { flagLabel } from "@/lib/i18n";
import type { Dict } from "@/lib/i18n/dict";
import { useSnapshot } from "@/lib/snapshot";
import { useMeta } from "@/lib/meta";
import { useToast } from "@/lib/toast";
import { postJson } from "@/lib/api";
import { Panel } from "@/components/Panel";
import { ConfirmDialog } from "@/components/ConfirmDialog";

interface SettingRow {
  key: keyof InverterRatedInfo;
  labelKey: keyof Dict;
  coded?: "osp" | "csp";
  unit?: "A" | "V" | "pct";
  map?: Record<number, string>;
}

const BATTERY_TYPES: Record<number, string> = {
  0: "AGM",
  1: "Flooded",
  2: "User",
  3: "Li1",
  4: "Li2",
  5: "Li3",
  6: "Li4",
  8: "Lib",
};

const SETTINGS_ROWS: SettingRow[] = [
  { key: "outputSourcePriority", labelKey: "sOsp", coded: "osp" },
  { key: "chargerSourcePriority", labelKey: "sCsp", coded: "csp" },
  { key: "maxChargingCurrent", labelKey: "sMcc", unit: "A" },
  { key: "maxAcChargingCurrent", labelKey: "sMacc", unit: "A" },
  { key: "batteryRechargeVoltage", labelKey: "sRecharge", unit: "V" },
  { key: "batteryRedischargeVoltage", labelKey: "sRedischarge", unit: "V" },
  { key: "batteryBulkVoltage", labelKey: "sBulk", unit: "V" },
  { key: "batteryFloatVoltage", labelKey: "sFloat", unit: "V" },
  { key: "batteryUnderVoltage", labelKey: "sCutoff", unit: "V" },
  { key: "socBackToUtility", labelKey: "sSocBackUtility", unit: "pct" },
  { key: "socBackToBattery", labelKey: "sSocBackBattery", unit: "pct" },
  { key: "socLowCutoff", labelKey: "sSocCutoff", unit: "pct" },
  { key: "batteryType", labelKey: "sBatType", map: BATTERY_TYPES },
];

type Meta = NonNullable<ReturnType<typeof useMeta>>;

/** Локализованная метка кодового значения; фолбэк — серверная метка из meta, затем число. */
function codedValue(t: Dict, meta: Meta | null, coded: "osp" | "csp", value: number): string {
  if (t[coded][value] !== undefined) return t[coded][value];
  const metaMap = coded === "osp" ? meta?.outputSourcePriority : meta?.chargerSourcePriority;
  if (metaMap && metaMap[value] !== undefined) return metaMap[value];
  return String(value);
}

function settingDisplay(t: Dict, meta: Meta | null, row: SettingRow, value: number | undefined): string {
  if (value === undefined || value === null || Number.isNaN(value)) return "—";
  if (row.coded) return codedValue(t, meta, row.coded, value);
  if (row.map && row.map[value] !== undefined) return row.map[value];
  const unit = row.unit ? " " + (t[("unit_" + row.unit) as keyof Dict] as string) : "";
  return value + unit;
}

function BaselineNote({ snapshot, t }: { snapshot: Snapshot | null; t: Dict }) {
  const b = snapshot?.baseline;
  if (!b) return <p className="note">{t.blNone}</p>;
  return (
    <p className="note">
      {t.blTakenAt}
      <b>{new Date(b.capturedAt).toLocaleString(t.langLocale)}</b>
      {t.blDevice}
      <code>{b.deviceId}</code>
      {t.blHint}
    </p>
  );
}

function SettingsTable() {
  const t = useT();
  const meta = useMeta();
  const { snapshot } = useSnapshot();
  const { toast } = useToast();
  const info = snapshot?.info ?? null;
  const base = snapshot?.baseline?.info ?? null;
  const flags = snapshot?.flags?.flags ?? [];

  const recapture = async () => {
    try {
      const data = await (await postJson("/api/baseline/recapture", {})).json();
      if (data.ok) toast(t.toastBaselineOk, "ok");
      else toast(data.error || t.toastError, "bad");
    } catch (e) {
      toast(t.toastNetErr + (e as Error).message, "bad");
    }
  };

  return (
    <>
      <BaselineNote snapshot={snapshot} t={t} />
      <div className="settings-table">
        {!info ? (
          <div className="srow">
            <span className="muted">{t.blNotRead}</span>
          </div>
        ) : (
          <>
            <div className="srow shead">
              <span>{t.thParam}</span>
              <span>{t.thCurrent}</span>
              <span>{t.thBaseline}</span>
            </div>
            {SETTINGS_ROWS.map((row) => {
              const cur = info[row.key] as number;
              const bas = base ? (base[row.key] as number) : undefined;
              const bothNaN = Number.isNaN(Number(cur)) && Number.isNaN(Number(bas));
              const drift = base !== null && !bothNaN && Number(cur) !== Number(bas);
              return (
                <div key={row.key} className={"srow" + (drift ? " drift" : "")}>
                  <span className="slabel">{t[row.labelKey] as string}</span>
                  <span className="scur">{settingDisplay(t, meta, row, cur)}</span>
                  <span className="sbase">{base ? settingDisplay(t, meta, row, bas) : "—"}</span>
                </div>
              );
            })}
          </>
        )}
      </div>
      <div className="flags-block">
        <div className="flags-title">{t.flagsTitle}</div>
        <div className="flags-list">
          {!flags.length ? (
            <span className="muted">—</span>
          ) : (
            flags.map((f) => (
              <span key={f.key} className={"flag-chip " + (f.enabled ? "on" : "off")}>
                {(f.enabled ? "✓ " : "✕ ") + flagLabel(t, f.key, f.name)}
              </span>
            ))
          )}
        </div>
      </div>
      <button className="apply ghost-btn" onClick={recapture}>
        {t.recaptureBtn}
      </button>
    </>
  );
}

function ControlPanel() {
  const t = useT();
  const meta = useMeta();
  const { snapshot } = useSnapshot();
  const { toast } = useToast();

  const control = snapshot?.control ?? null;
  const allowControl = !!control?.allowControl;
  const locked = !control || control.locked || !allowControl;
  const info = snapshot?.info ?? null;

  const [pending, setPending] = useState<{ type: ControlType; value: number; label: string } | null>(null);
  const [mcc, setMcc] = useState("");
  const [macc, setMacc] = useState("");

  // Отражать текущие значения в селектах только пока заблокировано:
  // при разблокировке пользователь выбирает значение, и его нельзя перетирать снапшотами.
  useEffect(() => {
    if (!info || !locked) return;
    if (Number.isFinite(info.maxChargingCurrent)) setMcc(String(info.maxChargingCurrent));
    if (Number.isFinite(info.maxAcChargingCurrent)) setMacc(String(info.maxAcChargingCurrent));
  }, [info, locked]);

  const request = (type: ControlType, value: number, label: string) => {
    if (!allowControl) return;
    if (control?.locked) {
      toast(t.toastLockFirst, "bad");
      return;
    }
    setPending({ type, value, label });
  };

  const send = async () => {
    const a = pending;
    setPending(null);
    if (!a) return;
    try {
      const data = await (await postJson("/api/control", { type: a.type, value: a.value })).json();
      if (data.ok) toast(t.toastDone + data.command + " → ACK", "ok");
      else toast(t.toastRejected + (data.error || data.reply || "NAK"), "bad");
    } catch (e) {
      toast(t.toastNetErr + (e as Error).message, "bad");
    }
  };

  const toggleLock = async () => {
    const currentlyLocked = control?.locked !== false;
    try {
      const data = await (await postJson("/api/lock", { locked: !currentlyLocked })).json();
      if (data.ok) toast(data.locked ? t.toastLocked : t.toastUnlocked, data.locked ? "ok" : "");
      else toast(data.error || t.toastError, "bad");
    } catch (e) {
      toast(t.toastNetErr + (e as Error).message, "bad");
    }
  };

  const segment = (coded: "osp" | "csp", type: ControlType, current: number | undefined, values: Record<number, string>) => (
    <div className="segmented">
      {Object.keys(values).map((k) => {
        const v = Number(k);
        const label = codedValue(t, meta, coded, v);
        return (
          <button
            key={k}
            disabled={locked}
            className={current === v ? "active" : ""}
            onClick={() => request(type, v, label)}
          >
            {label}
          </button>
        );
      })}
    </div>
  );

  return (
    <>
      <div className="lock-bar">
        {!allowControl ? (
          <span className="lock-status locked">{t.lockDisabledServer}</span>
        ) : control?.locked ? (
          <>
            <span className="lock-status locked">{t.lockLocked}</span>
            <button className="lock-toggle unlock" onClick={toggleLock}>
              {t.btnUnlock}
            </button>
          </>
        ) : (
          <>
            <span className="lock-status unlocked">{t.lockUnlocked}</span>
            <button className="lock-toggle lock" onClick={toggleLock}>
              {t.btnLock}
            </button>
          </>
        )}
      </div>
      <p className="note">{t.controlNote}</p>

      <div className="control">
        <label>{t.ctlOsp}</label>
        {meta && segment("osp", "outputSourcePriority", info?.outputSourcePriority, meta.outputSourcePriority)}
      </div>
      <div className="control">
        <label>{t.ctlCsp}</label>
        {meta && segment("csp", "chargerSourcePriority", info?.chargerSourcePriority, meta.chargerSourcePriority)}
      </div>

      <div className="control">
        <label>{t.ctlMcc}</label>
        <div className="row">
          <select value={mcc} disabled={locked} onChange={(e) => setMcc(e.target.value)}>
            {(meta?.maxChargingCurrent ?? []).map((v) => (
              <option key={v} value={String(v)}>
                {v}
              </option>
            ))}
          </select>
          <button
            className="apply"
            disabled={locked}
            onClick={() => request("maxChargingCurrent", Number(mcc), `${t.ctlMcc}: ${mcc}`)}
          >
            {t.apply}
          </button>
        </div>
      </div>
      <div className="control">
        <label>{t.ctlMacc}</label>
        <div className="row">
          <select value={macc} disabled={locked} onChange={(e) => setMacc(e.target.value)}>
            {(meta?.maxAcChargingCurrent ?? []).map((v) => (
              <option key={v} value={String(v)}>
                {v}
              </option>
            ))}
          </select>
          <button
            className="apply"
            disabled={locked}
            onClick={() => request("maxAcChargingCurrent", Number(macc), `${t.ctlMacc}: ${macc}`)}
          >
            {t.apply}
          </button>
        </div>
      </div>

      {pending && (
        <ConfirmDialog
          text={t.modalConfirm.replace("{label}", pending.label)}
          okLabel={t.modalOk}
          cancelLabel={t.modalCancel}
          onOk={send}
          onCancel={() => setPending(null)}
        />
      )}
    </>
  );
}

export default function SettingsPage() {
  const t = useT();
  return (
    <div>
      <Panel title={t.panelSettings}>
        <SettingsTable />
      </Panel>
      <Panel title={t.panelControls}>
        <ControlPanel />
      </Panel>
    </div>
  );
}
