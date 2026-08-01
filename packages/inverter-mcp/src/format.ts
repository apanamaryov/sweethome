import type { Snapshot } from "@sweethome/inverter-shared";

/** Ватты в читаемом виде: до киловатта — W, дальше — kW с двумя знаками. */
export function formatWatts(w: number): string {
  return Math.abs(w) >= 1000 ? `${(w / 1000).toFixed(2)} kW` : `${Math.round(w)} W`;
}

/** Одна строка о текущем состоянии — то, что человек читает в клиенте MCP. */
export function summarizeSnapshot(snap: Snapshot, now: number): string {
  if (!snap.connection.connected || !snap.status) {
    const why = snap.connection.lastError ? ` (${snap.connection.lastError})` : "";
    return `Inverter: no connection${why}`;
  }
  const s = snap.status;
  const age = Math.max(0, Math.round((now - snap.timestamp) / 1000));
  // Выведенный источник дописываем только когда он отличается от сырого режима:
  // "Solar" инвертор не сообщает, его считает сервер (shared/src/source.ts).
  // Проверка на пустоту — на случай снапшота от сервера постарее, где поля ещё нет.
  const modePart =
    snap.powerSource && snap.powerSource !== snap.mode
      ? `Mode: ${snap.mode} · source: ${snap.powerSource}`
      : `Mode: ${snap.mode}`;
  const parts = [
    modePart,
    `SOC ${s.batteryCapacity}%`,
    `battery ${s.batteryVoltage} V / ${formatWatts(s.batteryPower)}`,
    `PV ${formatWatts(s.pvPower)}`,
    `load ${formatWatts(s.acOutputActivePower)} (${s.outputLoadPercent}%)`,
    `grid ${s.gridVoltage} V / ${s.gridFrequency} Hz`,
    `${age} s ago`,
  ];
  if (snap.connection.mock) parts.push("demo data");
  if (snap.control.locked) parts.push("write locked");
  if (snap.warnings?.active.length) parts.push(`alarms: ${snap.warnings.active.join(", ")}`);
  return parts.join(" · ");
}
