"use client";

import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n";
import { fetchSolarWindow, type DailyRow, type SolarWindow } from "@/lib/stats";
import { formatDuration, formatMinutesOfDay, summarizeSolarDays } from "@/lib/solar";

export interface SolarWindowPanelProps {
  /** Режим страницы статистики. */
  kind: "day" | "week" | "month";
  /** Выбранный день (YYYY-MM-DD) — используется только при kind="day". */
  day: string;
  /** Суточные строки уже загруженного диапазона — источник сводки для недели/месяца. */
  daily: DailyRow[];
}

/**
 * Окно солнечного дня на странице статистики. Для одного дня спрашивает
 * `/api/stats/solar-window` (сегодняшнее окно приходит живым, ещё не закрытым);
 * для недели и месяца считает сводку из уже загруженной суточной таблицы —
 * лишних запросов не делает.
 */
export function SolarWindowPanel({ kind, day, daily }: SolarWindowPanelProps) {
  const t = useT();
  const [win, setWin] = useState<SolarWindow | null>(null);

  useEffect(() => {
    if (kind !== "day") {
      setWin(null);
      return;
    }
    let alive = true;
    setWin(null);
    fetchSolarWindow(day)
      .then((w) => alive && setWin(w))
      .catch(() => {
        /* статистика может быть недоступна — панель просто молчит */
      });
    return () => {
      alive = false;
    };
  }, [kind, day]);

  const hhmm = (ms: number) =>
    new Date(ms).toLocaleTimeString(t.langLocale, { hour: "2-digit", minute: "2-digit" });
  const dur = (min: number) => formatDuration(min, t.unitHour, t.unitMinute);

  if (kind === "day") {
    if (!win) return null;
    let body: string;
    if (win.state === "idle" || win.start === null) {
      body = t.solarNotStarted;
    } else if (win.state === "active" || win.end === null) {
      body = `${t.solarOngoing} ${hhmm(win.start)}`;
    } else {
      const minutes = Math.max(0, Math.round((win.end - win.start) / 60_000));
      body = `${hhmm(win.start)} → ${hhmm(win.end)} · ${t.solarDuration} ${dur(minutes)}`;
    }
    return (
      <div className="solar-panel">
        <span className="cap">{t.solarPanelTitle}</span>
        <strong className="st-val">{body}</strong>
      </div>
    );
  }

  const s = summarizeSolarDays(daily);
  if (!s) {
    return (
      <div className="solar-panel">
        <span className="cap">{t.solarPanelTitle}</span>
        <strong className="st-val">{t.solarNoData}</strong>
      </div>
    );
  }
  return (
    <div className="solar-panel solar-panel-range">
      <span className="cap">{t.solarPanelTitle}</span>
      <div className="solar-range-grid">
        <div>
          <span className="cap">{t.solarEarliest}</span>
          <strong className="st-val">{formatMinutesOfDay(s.earliestStartMin)}</strong>
        </div>
        <div>
          <span className="cap">{t.solarLatest}</span>
          <strong className="st-val">{formatMinutesOfDay(s.latestEndMin)}</strong>
        </div>
        <div>
          <span className="cap">{t.solarAvgDur}</span>
          <strong className="st-val">{dur(s.avgDurationMin)}</strong>
        </div>
        <div>
          <span className="cap">{t.solarDaysCounted}</span>
          <strong className="st-val">{s.days}</strong>
        </div>
      </div>
    </div>
  );
}
