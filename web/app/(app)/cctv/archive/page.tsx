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
  const [gapNotice, setGapNotice] = useState(false);

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
    setGapNotice(false);
  };

  const selectCam = (id: string) => {
    setCam(id);
    setSeekToMs(null);
    setGapNotice(false);
  };

  // Разрывы должны читаться как разрывы: клик в пустой участок не двигает курсор
  // (позиционировать нечего) и не предлагает скачать заведомо пустой кусок — вместо
  // этого короткое пояснение.
  const seekTo = (tsMs: number) => {
    const spans = tl?.spans ?? [];
    const hasFootage = spans.some((s) => tsMs >= s.startMs && tsMs < s.endMs);
    if (!hasFootage) {
      setGapNotice(true);
      return;
    }
    setGapNotice(false);
    setSeekToMs(tsMs);
  };

  return (
    <main className="cctv-archive">
      <h1>{t.cctvArchiveTitle}</h1>

      <div className="cctv-controls">
        <select value={cam} onChange={(e) => selectCam(e.target.value)} aria-label={t.cctvCamera}>
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

      {cam && (
        <ArchivePlayer
          cam={cam}
          fromMs={fromMs}
          toMs={toMs}
          spans={tl?.spans ?? []}
          playlistStartMs={tl?.playlistStartMs ?? null}
          seekToMs={seekToMs}
        />
      )}

      <Timeline
        spans={tl?.spans ?? []}
        marks={tl?.marks ?? []}
        fromMs={fromMs}
        toMs={toMs}
        positionMs={seekToMs ?? fromMs}
        onSeek={seekTo}
      />

      {gapNotice && <p className="cctv-gap-notice">{t.cctvNoFootageHere}</p>}

      {tl && tl.segments === 0 && <p>{t.cctvNothingThisDay}</p>}
    </main>
  );
}
