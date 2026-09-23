import type { ControlType } from "./api";
import type { InverterRatedInfo, NightTariffPhase } from "./types";

/**
 * Сезонные профили — набор управляющих команд, которые применяются одним действием.
 *
 * Зима: дом питается от сети (SUB), батарея стоит заряженной в резерве, дозаряжает её сеть.
 * Лето: дом питается от солнца и батареи (SBU), сеть подхватывает только при перегрузе
 * или в пасмурную погоду; заряжает батарею в первую очередь солнце.
 * Ночной тариф ("night"): зима, но сеть заряжает батарею только в дешёвые часы
 * (23:00–07:00); днём — только солнце. Это единственный профиль, который зависит от
 * времени: его держит в силе планировщик в `Inverter` (см. `nightTariffPhase`).
 *
 * Значения — коды регистров 301 и 331 (см. OUTPUT_SOURCE_PRIORITY / CHARGER_SOURCE_PRIORITY).
 * Само применение живёт в `Inverter.applyProfile`: здесь только чистые данные и сравнение.
 */

export type SeasonProfile = "winter" | "night" | "summer";

export const SEASON_PROFILE_NAMES: readonly SeasonProfile[] = ["winter", "night", "summer"];

/**
 * Один шаг профиля — та же пара (команда, значение), что принимает POST /api/inverter/control.
 * Тип сужен до команд, которые видны и в прочитанных настройках: иначе `profileChanges`
 * не смогло бы сказать, применён шаг или нет, и молча считало бы его неприменённым.
 */
export interface ProfileStep {
  type: ControlType & keyof InverterRatedInfo;
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
  // Дневная фаза ночного тарифа; ночью и при низком заряде см. nightTariffSteps.
  night: [
    { type: "outputSourcePriority", value: 3 }, // SUB, как зимой
    { type: "chargerSourcePriority", value: 3 }, // Only PV: днём сеть батарею не заряжает
  ],
  summer: [
    { type: "outputSourcePriority", value: 2 }, // SBU: солнце → батарея → сеть
    { type: "chargerSourcePriority", value: 1 }, // PV first: заряд от солнца, сеть — подстраховка
  ],
};

/**
 * Ночной тариф: часы дешёвой сети (по местному времени сервера) и подстраховка по заряду.
 * Если днём заряд упал до `backupOnSoc` (например, после отключения света), сеть
 * дозаряжает батарею до `backupOffSoc`, не дожидаясь ночи.
 */
export const NIGHT_TARIFF = {
  startHour: 23,
  endHour: 7,
  backupOnSoc: 30,
  backupOffSoc: 50,
} as const;

export function isNightTariffTime(now: Date): boolean {
  const h = now.getHours();
  return h >= NIGHT_TARIFF.startHour || h < NIGHT_TARIFF.endHour;
}

/**
 * Фаза ночного тарифа. `prev` нужен для гистерезиса подстраховки: начавшийся дневной
 * дозаряд продолжается до `backupOffSoc`, а не обрывается на 31%. `soc` = null (заряд
 * неизвестен) фазу не меняет: нет повода ни начинать дозаряд, ни бросать начатый.
 */
export function nightTariffPhase(now: Date, soc: number | null, prev: NightTariffPhase | null): NightTariffPhase {
  if (isNightTariffTime(now)) return "night";
  if (soc === null) return prev === "backup" ? "backup" : "day";
  if (soc <= NIGHT_TARIFF.backupOnSoc) return "backup";
  if (prev === "backup" && soc < NIGHT_TARIFF.backupOffSoc) return "backup";
  return "day";
}

/** Шаги профиля "night" для фазы: сеть заряжает (Utility first) ночью и при подстраховке. */
export function nightTariffSteps(phase: NightTariffPhase): ProfileStep[] {
  return [
    { type: "outputSourcePriority", value: 3 },
    { type: "chargerSourcePriority", value: phase === "day" ? 3 : 0 },
  ];
}

/** Шаги профиля; для "night" — в заданной фазе (у остальных фаза ни на что не влияет). */
export function profileSteps(profile: SeasonProfile, phase: NightTariffPhase = "day"): ProfileStep[] {
  return profile === "night" ? nightTariffSteps(phase) : SEASON_PROFILES[profile];
}

export function isSeasonProfile(value: unknown): value is SeasonProfile {
  return typeof value === "string" && (SEASON_PROFILE_NAMES as readonly string[]).includes(value);
}

/** Шаги профиля, которые ещё не применены; пустой список — профиль уже стоит. */
export function profileChanges(
  info: InverterRatedInfo | null,
  profile: SeasonProfile,
  phase: NightTariffPhase = "day"
): ProfileChange[] {
  // Сравнение в человеческих единицах, как их отдаёт снапшот. У нынешних шагов профиля
  // (коды регистров 301/331) шкалы нет, поэтому оно совпадает с сырым сравнением в
  // Inverter.previewProfile; шаг со шкалой (ток, напряжение) развёл бы эти две проверки.
  return profileSteps(profile, phase)
    .map((step) => ({ ...step, current: info ? info[step.type] : null }))
    .filter((change) => change.current !== change.value);
}

/**
 * Какой профиль стоит в инверторе сейчас; null — настройки не совпали ни с одним.
 * Ночной тариф по регистрам не узнать (ночью он неотличим от зимы), поэтому о нём
 * говорит только флаг сервера `nightTariffEnabled` (из `Snapshot.nightTariff`).
 */
export function detectSeasonProfile(
  info: InverterRatedInfo | null,
  nightTariffEnabled = false
): SeasonProfile | null {
  if (nightTariffEnabled) return "night";
  if (!info) return null;
  const fixed: SeasonProfile[] = ["winter", "summer"];
  return fixed.find((name) => profileChanges(info, name).length === 0) ?? null;
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
