"use client";

import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n";
import { fetchSolarWindow, SolarWindow } from "@/lib/stats";

export function SolarToday() {
  const t = useT();
  const [win, setWin] = useState<SolarWindow | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () => fetchSolarWindow().then((w) => alive && setWin(w)).catch(() => {});
    load();
    const id = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const hhmm = (ms: number) =>
    new Date(ms).toLocaleTimeString(t.langLocale, { hour: "2-digit", minute: "2-digit" });

  let body: string;
  if (!win || win.state === "idle" || win.start === null) {
    body = t.solarNotStarted;
  } else if (win.state === "active" || win.end === null) {
    body = `${t.solarOngoing} ${hhmm(win.start)}`;
  } else {
    body = `${hhmm(win.start)} → ${hhmm(win.end)}`;
  }

  return (
    <div className="solar-today">
      <span className="cap">{t.solarTodayTitle}</span>
      <strong className="st-val">{body}</strong>
    </div>
  );
}
