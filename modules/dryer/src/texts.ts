import type { EndReason } from "@sweethome/dryer-shared";

/** Расшифровки fault:* — те же формулировки, что в словаре веба (dryerFault*), но по-русски для событий. */
const FAULT_TEXT: Record<string, string> = {
  plate_overheat: "перегрев пластины (> 110 °C)",
  overheat: "перегрев камеры (> 85 °C) — проверь реле",
  sensor: "датчик не отвечает",
  heater: "нагреватель не греет — проверь коврик, реле и термистор",
  exhaust: "вытяжка не крутится",
  node_reboot_loop: "нода перезагружается по кругу",
};

export function faultText(reason: string): string {
  const code = reason.startsWith("fault:") ? reason.slice("fault:".length) : reason;
  return FAULT_TEXT[code] ?? `ошибка ноды: ${code}`;
}

/** «9 ч 40 м» / «40 м». Секунды не показываем — сушка идёт часами. */
export function fmtDuration(ms: number): string {
  const totalMin = Math.max(0, Math.floor(ms / 60_000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h} ч ${m} м` : `${m} м`;
}

export function runTitle(presetName: string | null): string {
  return `«${presetName ?? "свои параметры"}»`;
}

export function endReasonText(reason: EndReason): string {
  switch (reason) {
    case "autostop":
      return "завершена автостопом";
    case "stopped":
      return "остановлена";
    case "timeout":
      return "остановлена по таймеру";
    case "node_lost":
      return "закрыта: связь с нодой потеряна";
    default:
      return `прервана: ${faultText(reason)}`;
  }
}
