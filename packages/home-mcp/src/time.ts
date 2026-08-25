/**
 * Разбор временных аргументов инструментов. Агент может передать unix ms,
 * ISO 8601 или относительное смещение — все три формы приводятся к unix ms.
 * Чистая функция: «сейчас» приходит аргументом, поэтому тестируется без моков.
 */

const REL_RE = /^-(\d+)(s|m|h|d)$/;
const UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseTime(input: string | number, now: number): number {
  if (typeof input === "number" && Number.isFinite(input)) return input;
  const s = String(input ?? "").trim();
  if (s === "now") return now;

  const rel = s.match(REL_RE);
  if (rel) return now - Number(rel[1]) * UNIT_MS[rel[2]];

  if (/^\d+$/.test(s)) return Number(s);

  const iso = Date.parse(s);
  if (Number.isFinite(iso)) return iso;

  throw new Error(
    `Cannot parse time "${s}": use unix ms, ISO 8601 (2026-07-27T00:00:00Z), "now" or an offset like "-24h"`
  );
}

/** Локальный день (YYYY-MM-DD) — как его понимает статистика сервера. */
export function localDay(ms: number): string {
  const d = new Date(ms);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** День из YYYY-MM-DD, "today"/"yesterday" или смещения "-3d". */
export function parseDay(input: string, now: number): string {
  const s = String(input ?? "").trim();
  if (DAY_RE.test(s)) return s;

  if (s === "today") return localDay(now);
  if (s === "yesterday") return localDay(now - 86_400_000);

  const rel = s.match(/^-(\d+)d$/);
  if (rel) return localDay(now - Number(rel[1]) * 86_400_000);

  throw new Error(`Cannot parse day "${s}": use YYYY-MM-DD, "today", "yesterday" or "-3d"`);
}

/**
 * Местное время с явным сдвигом (2026-08-25T09:07:05+03:00).
 *
 * Не UTC: агент читает ответ вместе с человеком, а дом живёт в своей зоне —
 * «вчера в 21:40» должно совпадать с тем, что видно в интерфейсе. Сдвиг
 * указывается явно, чтобы значение оставалось однозначным.
 */
export function localIso(ms: number): string {
  const d = new Date(ms);
  const p = (x: number) => String(x).padStart(2, "0");
  const offMin = -d.getTimezoneOffset();
  const sign = offMin >= 0 ? "+" : "-";
  const abs = Math.abs(offMin);
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` +
    `${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`
  );
}
