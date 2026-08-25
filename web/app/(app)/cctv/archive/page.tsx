"use client";

import { useEffect, useMemo, useState } from "react";
import ArchivePlayer from "@/components/cctv/ArchivePlayer";
import Timeline from "@/components/cctv/Timeline";
import { useExpandable } from "@/components/cctv/useExpandable";
import {
  dayRange,
  downloadUrl,
  fetchCameras,
  fetchTimeline,
  msToTimeOfDay,
  timeOfDayToMs,
  type CameraInfo,
  type TimelineResponse,
} from "@/lib/cctv";
import { useT } from "@/lib/i18n";

export default function CctvArchivePage() {
  const t = useT();
  const [cams, setCams] = useState<CameraInfo[]>([]);
  const [cam, setCam] = useState<string>("");
  const [day, setDay] = useState<Date>(() => new Date());
  const [tl, setTl] = useState<TimelineResponse | null>(null);
  // Точка, с которой играет плеер (она же начало запрашиваемого плейлиста),
  // и текущая позиция воспроизведения — курсор на ленте ходит по ней.
  const [startMs, setStartMs] = useState<number | null>(null);
  const [positionMs, setPositionMs] = useState<number | null>(null);
  const [gapNotice, setGapNotice] = useState(false);
  // Пока в поле времени что-то набирают, оно живёт своим значением: иначе
  // воспроизведение переписывало бы его прямо во время ввода.
  const [editingTime, setEditingTime] = useState<string | null>(null);
  // Увеличенная картинка живёт здесь, а не в плеере: каждая перемотка
  // пересоздаёт плеер, и своё состояние он терял бы на каждом переходе.
  const { expanded, toggle: toggleSize } = useExpandable();

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
    setStartMs(null);
    setPositionMs(null);
    setGapNotice(false);
  };

  const selectCam = (id: string) => {
    setCam(id);
    setStartMs(null);
    setPositionMs(null);
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
    // Перемотка = новый плейлист с этого момента: сдвиг позиции внутри длинного
    // плейлиста на наших записях останавливает воспроизведение намертво.
    setStartMs(tsMs);
    setPositionMs(tsMs);
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

        {/* Прыжок к моменту без ленты: на телефоне это привычный барабан
            выбора времени. Пока поле не трогают, оно показывает текущую позицию;
            во время ввода не обновляется — иначе значение прыгало бы под пальцем. */}
        <input
          type="time"
          className="cctv-time-input"
          aria-label={t.cctvGoToTime}
          value={editingTime ?? msToTimeOfDay(positionMs ?? startMs ?? fromMs)}
          onFocus={(e) => setEditingTime(e.target.value)}
          onBlur={() => setEditingTime(null)}
          onChange={(e) => {
            setEditingTime(e.target.value);
            const ms = timeOfDayToMs(day, e.target.value);
            if (ms !== null) seekTo(ms);
          }}
        />

        {positionMs !== null && (
          <a href={downloadUrl(cam, positionMs, Math.min(positionMs + 5 * 60_000, toMs))} download>
            {t.cctvDownload5min}
          </a>
        )}
      </div>

      {cam &&
        (() => {
          const playFrom = startMs ?? tl?.spans[0]?.startMs ?? fromMs;
          // key заставляет React выбросить старый <video> и создать новый на
          // каждый новый момент. Переиспользование элемента после перемотки
          // оставляло плеер в состоянии, из которого он не запускался ни сам,
          // ни по кнопке — а первый старт при этом всегда работал.
          return (
            <ArchivePlayer
              key={`${cam}:${playFrom}`}
              cam={cam}
              startMs={playFrom}
              toMs={toMs}
              locale={t.langLocale}
              onPositionMs={setPositionMs}
              onSeekRequest={seekTo}
              expanded={expanded}
              onToggleSize={toggleSize}
            />
          );
        })()}

      <Timeline
        spans={tl?.spans ?? []}
        marks={tl?.marks ?? []}
        fromMs={fromMs}
        toMs={toMs}
        positionMs={positionMs ?? fromMs}
        onSeek={seekTo}
      />

      {gapNotice && <p className="cctv-gap-notice">{t.cctvNoFootageHere}</p>}

      {tl && tl.segments === 0 && <p>{t.cctvNothingThisDay}</p>}
    </main>
  );
}
