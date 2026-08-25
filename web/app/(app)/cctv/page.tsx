"use client";

import { useCallback, useEffect, useState } from "react";
import LivePlayer from "@/components/cctv/LivePlayer";
import { fetchCameras, type CameraInfo } from "@/lib/cctv";
import { useT } from "@/lib/i18n";

export default function CctvPage() {
  const t = useT();
  const [cams, setCams] = useState<CameraInfo[] | null>(null);
  const [active, setActive] = useState<string>("");
  // Звук по умолчанию выключен: открытая вкладка не должна начинать орать,
  // да и автозапуск браузеры разрешают только беззвучный.
  const [muted, setMuted] = useState(true);
  // Что реально пришло в потоке. Список камер тоже это знает (по записи), но
  // здесь важен именно живой поток — на нём и держится кнопка.
  const [hasAudio, setHasAudio] = useState(false);

  useEffect(() => {
    fetchCameras()
      .then((list) => {
        setCams(list);
        if (list.length > 0) setActive((a) => a || list[0].id);
      })
      .catch(() => setCams([]));
  }, []);

  // Ссылка должна быть стабильной: плеер держит её в зависимостях эффекта, а
  // новая функция на каждый рендер пересоздавала бы соединение с камерой.
  const onAudioAvailable = useCallback((has: boolean) => setHasAudio(has), []);

  if (cams === null) return <p>{t.connecting}</p>;
  if (cams.length === 0) return <p>{t.cctvNoCameras}</p>;

  const current = cams.find((c) => c.id === active) ?? cams[0];

  return (
    <main className="cctv-page">
      <h1>{t.navCctv}</h1>

      {/* Одна строка на всё управление: выбор камеры слева, звук и архив справа.
          Камеры показываются по одной — это не выбор оформления: iOS не умеет
          воспроизводить больше одного видео одновременно, вторая картинка на
          айфоне остаётся чёрной. Заодно на малине живёт один процесс вместо двух. */}
      <div className="cctv-bar">
        {cams.length > 1 && (
          <div className="cctv-tabs nav-tabs">
            {cams.map((c) => (
              <button
                key={c.id}
                className={c.id === current.id ? "active" : ""}
                onClick={() => {
                  setActive(c.id);
                  // У новой камеры звука может не быть — кнопка вернётся, когда
                  // придёт её поток, а не останется от предыдущей.
                  setHasAudio(false);
                }}
              >
                {c.name}
              </button>
            ))}
          </div>
        )}

        <div className="cctv-bar-actions">
          {hasAudio && (
            <button
              className="cctv-sound"
              aria-label={muted ? t.cctvUnmute : t.cctvMute}
              title={muted ? t.cctvUnmute : t.cctvMute}
              onClick={() => setMuted((m) => !m)}
            >
              {muted ? "🔇" : "🔊"}
            </button>
          )}
          <a
            className="cctv-icon-link"
            href="/cctv/archive"
            aria-label={t.cctvOpenArchive}
            title={t.cctvOpenArchive}
          >
            🎞️
          </a>
        </div>
      </div>

      <LivePlayer
        key={current.id}
        cam={current.id}
        label={current.name}
        muted={muted}
        onAudioAvailable={onAudioAvailable}
      />
      {!current.recording && <p className="cctv-warn">{t.cctvNotRecording}</p>}
    </main>
  );
}
