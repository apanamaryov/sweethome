import type { ControlType } from "./api";
import type { InverterRatedInfo } from "./types";

/**
 * Сезонные профили — набор управляющих команд, которые применяются одним действием.
 *
 * Зима: дом питается от сети (SUB), батарея стоит заряженной в резерве, дозаряжает её сеть.
 * Лето: дом питается от солнца и батареи (SBU), сеть подхватывает только при перегрузе
 * или в пасмурную погоду; заряжает батарею в первую очередь солнце.
 *
 * Значения — коды регистров 301 и 331 (см. OUTPUT_SOURCE_PRIORITY / CHARGER_SOURCE_PRIORITY).
 * Само применение живёт в `Inverter.applyProfile`: здесь только чистые данные и сравнение.
 */

export type SeasonProfile = "winter" | "summer";

export const SEASON_PROFILE_NAMES: readonly SeasonProfile[] = ["winter", "summer"];

/** Один шаг профиля — та же пара (команда, значение), что принимает POST /api/inverter/control. */
export interface ProfileStep {
  type: ControlType;
  value: number;
}

/** Шаг профиля вместе с тем, что стоит в инверторе сейчас (null — настройки ещё не прочитаны). */
export interface ProfileChange extends ProfileStep {
  current: number | null;
}

export const SEASON_PROFILES: Record<SeasonProfile, ProfileStep[]> = {
  winter: [
    { type: "outputSourcePriority", value: 3 }, // SUB: сеть питает дом, батарея в резерве
    { type: "chargerSourcePriority", value: 0 }, // Utility first: сеть держит батарею заряженной
  ],
  summer: [
    { type: "outputSourcePriority", value: 2 }, // SBU: солнце → батарея → сеть
    { type: "chargerSourcePriority", value: 1 }, // PV first: заряд от солнца, сеть — подстраховка
  ],
};

export function isSeasonProfile(value: unknown): value is SeasonProfile {
  return typeof value === "string" && (SEASON_PROFILE_NAMES as readonly string[]).includes(value);
}

/** Шаги профиля, которые ещё не применены; пустой список — профиль уже стоит. */
export function profileChanges(info: InverterRatedInfo | null, profile: SeasonProfile): ProfileChange[] {
  return SEASON_PROFILES[profile]
    .map((step) => ({ ...step, current: info ? (info[step.type as keyof InverterRatedInfo] as number) : null }))
    .filter((change) => change.current !== change.value);
}

/** Какой профиль стоит в инверторе сейчас; null — настройки не совпали ни с одним. */
export function detectSeasonProfile(info: InverterRatedInfo | null): SeasonProfile | null {
  if (!info) return null;
  return SEASON_PROFILE_NAMES.find((name) => profileChanges(info, name).length === 0) ?? null;
}

/** Шаг профиля с живым значением регистра — ответ предпросмотра. */
export interface ProfilePreviewStep extends ProfileStep {
  register: number;
  rawValue: number;
  label: string;
  currentValue: number | null;
  alreadyApplied: boolean;
}

export interface ProfilePreview {
  profile: SeasonProfile;
  steps: ProfilePreviewStep[];
}

export interface ProfileApplyResult {
  ok: boolean;
  profile: SeasonProfile;
  applied: Array<ProfileStep & { command: string }>;
  skipped: ProfileStep[];
}
