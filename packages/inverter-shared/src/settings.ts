import type { Baseline, InverterFlags, InverterRatedInfo } from "./types";
import { CHARGER_SOURCE_PRIORITY, OUTPUT_SOURCE_PRIORITY } from "./api";
import { REGISTER_DOCS } from "./registers";

/**
 * Сравнение текущих настроек с эталоном «как нашли». Чистая функция без i18n:
 * подписи — английские имена из карты регистров, локализация остаётся делом UI.
 */

export interface SettingDiffRow {
  key: string;
  name: string;
  addr: number | null;
  current: number;
  currentLabel: string;
  baseline: number | null;
  baselineLabel: string | null;
  drifted: boolean;
}

export interface SettingFlagDiffRow {
  key: string;
  name: string;
  current: boolean;
  baseline: boolean | null;
  drifted: boolean;
}

export interface SettingsDiff {
  capturedAt: number | null;
  deviceId: string | null;
  settings: SettingDiffRow[];
  flags: SettingFlagDiffRow[];
  driftCount: number;
}

const BATTERY_TYPES: Record<number, string> = {
  0: "AGM", 1: "Flooded", 2: "User", 3: "Li1", 4: "Li2", 5: "Li3", 6: "Li4", 8: "Lib",
};

const CODED: Record<string, Record<number, string>> = {
  outputSourcePriority: OUTPUT_SOURCE_PRIORITY,
  chargerSourcePriority: CHARGER_SOURCE_PRIORITY,
  batteryType: BATTERY_TYPES,
};

function label(key: string, value: number, unit: string): string {
  const coded = CODED[key];
  if (coded && coded[value] !== undefined) return coded[value];
  return unit ? `${value} ${unit}` : String(value);
}

export function diffSettings(
  info: InverterRatedInfo | null,
  flags: InverterFlags | null,
  baseline: Baseline | null
): SettingsDiff {
  const docs = new Map(REGISTER_DOCS.map((d) => [d.key, d]));
  const base = baseline?.info ?? null;

  const settings: SettingDiffRow[] = info
    ? Object.entries(info)
        .filter(([key, v]) => key !== "raw" && typeof v === "number")
        .map(([key, v]) => {
          const doc = docs.get(key);
          const unit = doc?.unit ?? "";
          const current = v as number;
          const raw = base ? (base as unknown as Record<string, number>)[key] : undefined;
          const baseVal = typeof raw === "number" ? raw : null;
          const bothNaN = Number.isNaN(current) && baseVal !== null && Number.isNaN(baseVal);
          return {
            key,
            name: doc?.name ?? key,
            addr: doc?.addr ?? null,
            current,
            currentLabel: label(key, current, unit),
            baseline: baseVal,
            baselineLabel: baseVal === null ? null : label(key, baseVal, unit),
            drifted: baseVal !== null && !bothNaN && current !== baseVal,
          };
        })
    : [];

  const baseFlags = new Map((baseline?.flags?.flags ?? []).map((f) => [f.key, f.enabled]));
  const flagRows: SettingFlagDiffRow[] = (flags?.flags ?? []).map((f) => {
    const b = baseFlags.has(f.key) ? baseFlags.get(f.key)! : null;
    return { key: f.key, name: f.name, current: f.enabled, baseline: b, drifted: b !== null && b !== f.enabled };
  });

  return {
    capturedAt: baseline?.capturedAt ?? null,
    deviceId: baseline?.deviceId ?? null,
    settings,
    flags: flagRows,
    driftCount: settings.filter((r) => r.drifted).length + flagRows.filter((r) => r.drifted).length,
  };
}
