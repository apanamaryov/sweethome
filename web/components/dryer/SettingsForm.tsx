"use client";

import { useEffect, useState } from "react";
import type { DryerSettings, SettingsPatch } from "@sweethome/dryer-shared";
import { LIMITS } from "@sweethome/dryer-shared";
import { useT } from "@/lib/i18n";
import type { Dict } from "@/lib/i18n/dict";
import { useToast } from "@/lib/toast";
import { fetchSettings, saveSettings } from "@/lib/dryer";

type Field = { key: keyof Dict; path: ["autostop", keyof DryerSettings["autostop"]] | [Exclude<keyof DryerSettings, "autostop">]; limit: { min: number; max: number }; step: number };

const FIELDS: Field[] = [
  { key: "dryerExcessThreshold", path: ["autostop", "excessThreshold"], limit: LIMITS.excessThreshold, step: 0.5 },
  { key: "dryerHoldMinutes", path: ["autostop", "holdMinutes"], limit: LIMITS.holdMinutes, step: 1 },
  { key: "dryerMinRunMinutes", path: ["autostop", "minRunMinutes"], limit: LIMITS.minRunMinutes, step: 5 },
  { key: "dryerExhaustMin", path: ["exhaustMin"], limit: LIMITS.exhaustMin, step: 1 },
  { key: "dryerExhaustGain", path: ["exhaustGain"], limit: LIMITS.exhaustGain, step: 0.5 },
  { key: "dryerStaleAfter", path: ["staleAfterSeconds"], limit: LIMITS.staleAfterSeconds, step: 10 },
];

const read = (s: DryerSettings, f: Field): number => (f.path.length === 2 ? s.autostop[f.path[1]] : s[f.path[0]]);

/** Форма глобальных настроек: PUT уходит ЧАСТИЧНЫЙ — только изменённые поля; ошибка сервера — дословно, поле не сбрасывается. */
export default function SettingsForm() {
  const t = useT();
  const { toast } = useToast();
  const [saved, setSaved] = useState<DryerSettings | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    fetchSettings()
      .then((s) => { setSaved(s); setDraft(Object.fromEntries(FIELDS.map((f) => [f.key, String(read(s, f))]))); })
      .catch((e) => setLoadError((e as Error).message));
  }, []);

  if (loadError) return <p className="banner">{`${t.dryerError}: ${loadError}`}</p>;
  if (!saved) return <p className="muted">{t.connecting}</p>;

  const submit = async () => {
    const patch: SettingsPatch = {};
    for (const f of FIELDS) {
      const v = Number(draft[f.key]);
      if (!Number.isFinite(v) || v === read(saved, f)) continue;
      if (f.path.length === 2) patch.autostop = { ...(patch.autostop ?? {}), [f.path[1]]: v };
      else patch[f.path[0]] = v;
    }
    if (Object.keys(patch).length === 0) return;
    try {
      const s = await saveSettings(patch);
      setSaved(s);
      toast(t.dryerSaved, "ok");
    } catch (e) {
      toast((e as Error).message, "bad");
    }
  };

  return (
    <section className="card">
      <div className="card-head"><span className="card-title">{t.dryerAutostop} / {t.dryerExhaust}</span></div>
      <div className="dryer-custom">
        {FIELDS.map((f) => (
          <label key={f.key}>
            {t[f.key] as string}
            <input type="number" aria-label={t[f.key] as string} min={f.limit.min} max={f.limit.max} step={f.step}
              value={draft[f.key] ?? ""} onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))} />
          </label>
        ))}
      </div>
      <div className="dryer-actions"><button className="apply" onClick={submit}>{t.dryerSave}</button></div>
    </section>
  );
}
