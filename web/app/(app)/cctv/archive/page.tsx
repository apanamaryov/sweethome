"use client";

import { useEffect, useMemo, useState } from "react";
import ArchivePlayer from "@/components/cctv/ArchivePlayer";
import Timeline from "@/components/cctv/Timeline";
import { dayRange, downloadUrl, fetchCameras, fetchTimeline, type CameraInfo, type TimelineResponse } from "@/lib/cctv";
import { useT } from "@/lib/i18n";

export default function CctvArchivePage() {
  const t = useT();
  const [cams, setCams] = useState<CameraInfo[]>([]);
  const [cam, setCam] = useState<string>("");
  const [day, setDay] = useState<Date>(() => new Date());
  const [tl, setTl] = useState<TimelineResponse | null>(null);
  const [seekToMs, setSeekToMs] = useState<number | null>(null);

  const { fromMs, toMs } = useMemo(() => dayRange(day), [day]);

  useEffect(() => {
    fetchCameras()
      .then((list) => {
        setCams(list);
        if (list.length > 0) setCam((c) => c || list[0].id);
      })
      .catch(() => setCams([]));
  }, []);

  useEffect(() => {
    if (!cam) return;
    fetchTimeline(cam, fromMs, toMs).then(setTl).catch(() => setTl(null));
  }, [cam, fromMs, toMs]);

  const shiftDay = (delta: number) => {
    const d = new Date(day);
    d.setDate(d.getDate() + delta);
    setDay(d);
    setSeekToMs(null);
  };

  return (
    <main className="cctv-archive">
      <h1>{t.cctvArchiveTitle}</h1>

      <div className="cctv-controls">
        <select value={cam} onChange={(e) => setCam(e.target.value)} aria-label={t.cctvCamera}>
          {cams.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
        <button onClick={() => shiftDay(-1)}>←</button>
        <span>{day.toLocaleDateString(t.langLocale)}</span>
        <button onClick={() => shiftDay(1)}>→</button>
        {seekToMs !== null && (
          <a href={downloadUrl(cam, seekToMs, Math.min(seekToMs + 5 * 60_000, toMs))} download>
            {t.cctvDownload5min}
          </a>
        )}
      </div>

      {cam && <ArchivePlayer cam={cam} fromMs={fromMs} toMs={toMs} spans={tl?.spans ?? []} seekToMs={seekToMs} />}

      <Timeline
        spans={tl?.spans ?? []}
        marks={tl?.marks ?? []}
        fromMs={fromMs}
        toMs={toMs}
        positionMs={seekToMs ?? fromMs}
        onSeek={setSeekToMs}
      />

      {tl && tl.segments === 0 && <p>{t.cctvNothingThisDay}</p>}
    </main>
  );
}
