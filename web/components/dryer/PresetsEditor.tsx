"use client";

import { useEffect, useState } from "react";
import type { Preset, PresetGroup, PresetInput } from "@sweethome/dryer-shared";
import { LIMITS, PRESET_GROUPS } from "@sweethome/dryer-shared";
import { useT } from "@/lib/i18n";
import type { Dict } from "@/lib/i18n/dict";
import { useToast } from "@/lib/toast";
import { createPreset, deletePreset, fetchPresets, updatePreset } from "@/lib/dryer";

const GROUP_KEY: Record<PresetGroup, keyof Dict> = { fruit: "dryerGroupFruit", vegetable: "dryerGroupVegetable", other: "dryerGroupOther" };
type Draft = PresetInput & { id: number | null; maxHours: number };

const toDraft = (p: Preset): Draft => ({ id: p.id, name: p.name, group: p.group, setpoint: p.setpoint, maxMinutes: p.maxMinutes, maxHours: p.maxMinutes / 60, autostop: p.autostop });
const NEW: Draft = { id: null, name: "", group: "fruit", setpoint: 60, maxMinutes: 600, maxHours: 10, autostop: true };

export default function PresetsEditor() {
  const t = useT();
  const { toast } = useToast();
  const [rows, setRows] = useState<Draft[] | null>(null);

  const reload = () => fetchPresets().then((ps) => setRows(ps.map(toDraft))).catch(() => setRows([]));
  useEffect(() => { reload(); }, []);

  if (!rows) return <p className="muted">{t.connecting}</p>;

  const patch = (i: number, p: Partial<Draft>) => setRows((r) => r!.map((row, j) => (j === i ? { ...row, ...p } : row)));

  const save = async (row: Draft) => {
    const input: PresetInput = { name: row.name, group: row.group, setpoint: row.setpoint, maxMinutes: Math.round(row.maxHours * 60), autostop: row.autostop };
    try {
      if (row.id === null) await createPreset(input);
      else await updatePreset(row.id, input);
      toast(t.dryerSaved, "ok");
      await reload();
    } catch (e) {
      toast((e as Error).message, "bad");
    }
  };

  const remove = async (row: Draft, i: number) => {
    if (row.id === null) return setRows((r) => r!.filter((_, j) => j !== i));
    try {
      await deletePreset(row.id);
      await reload();
    } catch (e) {
      toast((e as Error).message, "bad");
    }
  };

  return (
    <section className="card">
      <div className="card-head"><span className="card-title">{t.dryerPresets}</span></div>
      {rows.map((row, i) => (
        <div className="dryer-form-row" key={row.id ?? `new-${i}`}>
          <label>{t.dryerPresetName}<input name="name" placeholder={t.dryerPresetName} value={row.name} onChange={(e) => patch(i, { name: e.target.value })} /></label>
          <label>{t.dryerGroup}
            <select name="group" value={row.group} onChange={(e) => patch(i, { group: e.target.value as PresetGroup })}>
              {PRESET_GROUPS.map((g) => <option key={g} value={g}>{t[GROUP_KEY[g]] as string}</option>)}
            </select>
          </label>
          <label>{t.dryerSetpoint}<input name="setpoint" type="number" min={LIMITS.setpoint.min} max={LIMITS.setpoint.max} value={row.setpoint} onChange={(e) => patch(i, { setpoint: Number(e.target.value) })} /></label>
          <label>{t.dryerMaxHours}<input name="maxHours" type="number" min={0.5} max={48} step={0.5} value={row.maxHours} onChange={(e) => patch(i, { maxHours: Number(e.target.value) })} /></label>
          <label>{t.dryerAutostop}<input name="autostop" type="checkbox" checked={row.autostop} onChange={(e) => patch(i, { autostop: e.target.checked })} /></label>
          <div className="dryer-actions">
            <button className="apply" onClick={() => save(row)}>{t.dryerSave}</button>
            <button className="btn-danger" onClick={() => remove(row, i)}>{t.dryerDelete}</button>
          </div>
        </div>
      ))}
      <div className="dryer-actions"><button className="ghost-btn" onClick={() => setRows((r) => [...r!, { ...NEW }])}>{t.dryerAddPreset}</button></div>
    </section>
  );
}
