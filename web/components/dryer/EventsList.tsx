"use client";

import type { DryerEvent } from "@sweethome/dryer-shared";
import { useT } from "@/lib/i18n";

export default function EventsList({ events, onSeen }: { events: DryerEvent[]; onSeen(id: number): void }) {
  const t = useT();
  if (!events.length) return null;
  return (
    <section className="card">
      <div className="card-head"><span className="card-title">{t.dryerEvents}</span></div>
      <ul className="dryer-events">
        {events.map((e) => (
          <li key={e.id}>
            <span><time>{new Date(e.ts).toLocaleString(t.langLocale)}</time> {e.text}</span>
            <button className="ghost-btn" aria-label={t.dryerMarkSeen} title={t.dryerMarkSeen} onClick={() => onSeen(e.id)}>✕</button>
          </li>
        ))}
      </ul>
    </section>
  );
}
