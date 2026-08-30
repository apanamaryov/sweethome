"use client";

import { useState } from "react";
import type { DryerSnapshot, Preset, PresetGroup } from "@sweethome/dryer-shared";
import { LIMITS, PRESET_GROUPS } from "@sweethome/dryer-shared";
import { useT } from "@/lib/i18n";
import type { Dict } from "@/lib/i18n/dict";
import { useToast } from "@/lib/toast";
import { startRun, stopRun } from "@/lib/dryer";

const GROUP_KEY: Record<PresetGroup, keyof Dict> = { fruit: "dryerGroupFruit", vegetable: "dryerGroupVegetable", other: "dryerGroupOther" };

export default function RunControls({
  snapshot, isAdmin, presets, onChanged,
}: { snapshot: DryerSnapshot; isAdmin: boolean; presets: Preset[]; onChanged(): void }) {
  const t = useT();
  const { toast } = useToast();
  const [presetId, setPresetId] = useState<number | null>(null);
  const [custom, setCustom] = useState(false);
  const [setpoint, setSetpoint] = useState(60);
  const [maxHours, setMaxHours] = useState(10);
  const [autostop, setAutostop] = useState(true);
  const [busy, setBusy] = useState(false);

  const n = snapshot.node;
  const run = snapshot.run;
  const running = run !== null || n.state === "heating" || n.state === "drying";
  const fault = n.online && n.state === "fault";

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      onChanged();
    } catch (e) {
      toast((e as Error).message, "bad"); // текст сервера дословно (спека §9)
    } finally {
      setBusy(false);
    }
  };

  const canStart = isAdmin && n.online && n.state === "idle" && !busy && (custom || presetId !== null);

  return (
    <section className="card">
      {!isAdmin && <p className="note">{t.dryerViewerOnly}</p>}

      {run && (
        <p className="note">
          {run.presetName ?? (run.startedBy === "button" ? t.dryerStartedByButton : run.startedBy === "recovered" ? t.dryerStartedRecovered : t.dryerCustom)}
          {run.restarts > 0 && <span>{` · ${t.dryerRestarts}: ${run.restarts}`}</span>}
        </p>
      )}
      {run && (
        <p className="tag">
          {!run.autostopEnabled ? t.dryerAutostopOff : run.autostop.gaps ? t.dryerAutostopGaps : run.autostop.reason}
        </p>
      )}

      {fault && (
        <div className="dryer-actions">
          <button className="btn-danger" disabled={!isAdmin || busy} onClick={() => act(stopRun)}>{t.dryerResetFault}</button>
        </div>
      )}

      {!fault && running && (
        <div className="dryer-actions">
          <button className="btn-danger" disabled={!isAdmin || busy} onClick={() => act(stopRun)}>{t.dryerStop}</button>
          {!n.online && <span className="muted">{t.dryerStopWhenBack}</span>}
        </div>
      )}

      {!fault && !running && (
        <>
          <div className="dryer-groups">
            {PRESET_GROUPS.map((g) => {
              const items = presets.filter((p) => p.group === g);
              if (!items.length) return null;
              return (
                <div key={g}>
                  <div className="dryer-group-title">{t[GROUP_KEY[g]] as string}</div>
                  <div className="dryer-chips">
                    {items.map((p) => (
                      <button key={p.id} className={presetId === p.id && !custom ? "active" : ""} disabled={!isAdmin}
                        onClick={() => { setPresetId(p.id); setCustom(false); }}>
                        <span>{p.name}</span> <small>{p.setpoint}°</small>
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
            <div className="dryer-chips">
              <button className={custom ? "active" : ""} disabled={!isAdmin} onClick={() => setCustom((c) => !c)}>{t.dryerCustom}</button>
            </div>
          </div>
          {custom && (
            <div className="dryer-custom">
              <label>{t.dryerSetpoint}<input type="number" min={LIMITS.setpoint.min} max={LIMITS.setpoint.max} step={1} value={setpoint} onChange={(e) => setSetpoint(Number(e.target.value))} /></label>
              <label>{t.dryerMaxHours}<input type="number" min={1} max={48} step={1} value={maxHours} onChange={(e) => setMaxHours(Number(e.target.value))} /></label>
              <label>{t.dryerAutostop}<input type="checkbox" checked={autostop} onChange={(e) => setAutostop(e.target.checked)} /></label>
            </div>
          )}
          <div className="dryer-actions">
            <button className="apply" disabled={!canStart}
              onClick={() => act(() => (custom ? startRun({ setpoint, maxMinutes: maxHours * 60, autostop }) : startRun({ presetId: presetId! })))}>
              {t.dryerStart}
            </button>
            {!n.online && <span className="muted">{t.dryerOfflineIdle}</span>}
          </div>
        </>
      )}
    </section>
  );
}
