import {
  LIMITS,
  PRESET_GROUPS,
  type PresetGroup,
  type PresetInput,
  type SettingsPatch,
  type StartRunRequest,
} from "@sweethome/dryer-shared";

export type Valid<T> = { ok: true; value: T } | { ok: false; error: string };

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Число в диапазоне; `integer` — дополнительно целое. Сообщение готово к показу пользователю. */
function num(v: unknown, label: string, r: { min: number; max: number }, integer = false): Valid<number> {
  if (typeof v !== "number" || !Number.isFinite(v)) return fail(`Поле «${label}» должно быть числом`);
  if (integer && !Number.isInteger(v)) return fail(`Поле «${label}» должно быть целым числом`);
  if (v < r.min || v > r.max) return fail(`Поле «${label}» вне допустимого диапазона ${r.min}…${r.max}`);
  return { ok: true, value: v };
}

function name(v: unknown): Valid<string> {
  if (typeof v !== "string" || v.trim() === "") return fail("Поле «название» обязательно");
  return { ok: true, value: v.trim() };
}

function group(v: unknown): Valid<PresetGroup> {
  if (typeof v !== "string" || !(PRESET_GROUPS as readonly string[]).includes(v)) {
    return fail(`Поле «группа» должно быть одним из: ${PRESET_GROUPS.join(", ")}`);
  }
  return { ok: true, value: v as PresetGroup };
}

function bool(v: unknown, label: string): Valid<boolean> {
  if (typeof v !== "boolean") return fail(`Поле «${label}» должно быть true или false`);
  return { ok: true, value: v };
}

export function validatePresetInput(body: unknown): Valid<PresetInput> {
  if (!isObj(body)) return fail("Ожидается объект");
  const n = name(body.name);
  if (!n.ok) return n;
  const g = group(body.group);
  if (!g.ok) return g;
  const sp = num(body.setpoint, "уставка", LIMITS.setpoint);
  if (!sp.ok) return sp;
  const mm = num(body.maxMinutes, "максимум минут", LIMITS.maxMinutes, true);
  if (!mm.ok) return mm;
  const as = body.autostop === undefined ? { ok: true as const, value: true } : bool(body.autostop, "автостоп");
  if (!as.ok) return as;
  return { ok: true, value: { name: n.value, group: g.value, setpoint: sp.value, maxMinutes: mm.value, autostop: as.value } };
}

export function validatePresetPatch(body: unknown): Valid<Partial<PresetInput>> {
  if (!isObj(body)) return fail("Ожидается объект");
  const out: Partial<PresetInput> = {};
  if (body.name !== undefined) {
    const n = name(body.name);
    if (!n.ok) return n;
    out.name = n.value;
  }
  if (body.group !== undefined) {
    const g = group(body.group);
    if (!g.ok) return g;
    out.group = g.value;
  }
  if (body.setpoint !== undefined) {
    const sp = num(body.setpoint, "уставка", LIMITS.setpoint);
    if (!sp.ok) return sp;
    out.setpoint = sp.value;
  }
  if (body.maxMinutes !== undefined) {
    const mm = num(body.maxMinutes, "максимум минут", LIMITS.maxMinutes, true);
    if (!mm.ok) return mm;
    out.maxMinutes = mm.value;
  }
  if (body.autostop !== undefined) {
    const as = bool(body.autostop, "автостоп");
    if (!as.ok) return as;
    out.autostop = as.value;
  }
  if (Object.keys(out).length === 0) return fail("Нет ни одного поля для изменения");
  return { ok: true, value: out };
}

export function validateSettingsPatch(body: unknown): Valid<SettingsPatch> {
  if (!isObj(body)) return fail("Ожидается объект");
  const out: SettingsPatch = {};
  if (body.autostop !== undefined) {
    if (!isObj(body.autostop)) return fail("Поле «autostop» должно быть объектом");
    const a = body.autostop;
    const sub: NonNullable<SettingsPatch["autostop"]> = {};
    if (a.excessThreshold !== undefined) {
      const v = num(a.excessThreshold, "порог избытка", LIMITS.excessThreshold);
      if (!v.ok) return v;
      sub.excessThreshold = v.value;
    }
    if (a.holdMinutes !== undefined) {
      const v = num(a.holdMinutes, "окно удержания", LIMITS.holdMinutes, true);
      if (!v.ok) return v;
      sub.holdMinutes = v.value;
    }
    if (a.minRunMinutes !== undefined) {
      const v = num(a.minRunMinutes, "минимальное время сушки", LIMITS.minRunMinutes, true);
      if (!v.ok) return v;
      sub.minRunMinutes = v.value;
    }
    if (Object.keys(sub).length > 0) out.autostop = sub;
  }
  if (body.exhaustMin !== undefined) {
    const v = num(body.exhaustMin, "минимум вытяжки", LIMITS.exhaustMin);
    if (!v.ok) return v;
    out.exhaustMin = v.value;
  }
  if (body.exhaustGain !== undefined) {
    const v = num(body.exhaustGain, "коэффициент вытяжки", LIMITS.exhaustGain);
    if (!v.ok) return v;
    out.exhaustGain = v.value;
  }
  if (body.staleAfterSeconds !== undefined) {
    const v = num(body.staleAfterSeconds, "устаревание данных", LIMITS.staleAfterSeconds, true);
    if (!v.ok) return v;
    out.staleAfterSeconds = v.value;
  }
  if (Object.keys(out).length === 0) return fail("Нет ни одного поля для изменения");
  return { ok: true, value: out };
}

export function validateStartRequest(body: unknown): Valid<StartRunRequest> {
  if (!isObj(body)) return fail("Ожидается объект");
  const hasPreset = body.presetId !== undefined;
  const hasCustom = body.setpoint !== undefined || body.maxMinutes !== undefined;
  if (hasPreset && hasCustom) return fail("Укажи пресет либо уставку и максимум минут, но не оба");
  if (hasPreset) {
    const id = num(body.presetId, "пресет", { min: 1, max: Number.MAX_SAFE_INTEGER }, true);
    if (!id.ok) return id;
    return { ok: true, value: { presetId: id.value } };
  }
  if (body.setpoint === undefined || body.maxMinutes === undefined) return fail("Укажи пресет либо уставку и максимум минут");
  const sp = num(body.setpoint, "уставка", LIMITS.setpoint);
  if (!sp.ok) return sp;
  const mm = num(body.maxMinutes, "максимум минут", LIMITS.maxMinutes, true);
  if (!mm.ok) return mm;
  const out: StartRunRequest = { setpoint: sp.value, maxMinutes: mm.value };
  if (body.autostop !== undefined) {
    const as = bool(body.autostop, "автостоп");
    if (!as.ok) return as;
    out.autostop = as.value;
  }
  return { ok: true, value: out };
}
