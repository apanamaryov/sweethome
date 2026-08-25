"use client";

import { useEffect, useState } from "react";
import LivePlayer from "@/components/cctv/LivePlayer";
import { fetchCameras, type CameraInfo } from "@/lib/cctv";
import { useT } from "@/lib/i18n";

export default function CctvPage() {
  const t = useT();
  const [cams, setCams] = useState<CameraInfo[] | null>(null);
  const [active, setActive] = useState<string>("");

  useEffect(() => {
    fetchCameras()
      .then((list) => {
        setCams(list);
        if (list.length > 0) setActive((a) => a || list[0].id);
      })
      .catch(() => setCams([]));
  }, []);

  if (cams === null) return <p>{t.connecting}</p>;
  if (cams.length === 0) return <p>{t.cctvNoCameras}</p>;

  const current = cams.find((c) => c.id === active) ?? cams[0];

  return (
    <main className="cctv-page">
      <h1>{t.navCctv}</h1>

      {/* Камеры показываются по одной. Это не выбор оформления: iOS не умеет
          воспроизводить больше одного видео одновременно — вторая картинка на
          айфоне остаётся чёрной. Заодно на малине живёт один процесс вместо двух. */}
      {cams.length > 1 && (
        <div className="cctv-tabs nav-tabs">
          {cams.map((c) => (
            <button
              key={c.id}
              className={c.id === current.id ? "active" : ""}
              onClick={() => setActive(c.id)}
            >
              {c.name}
            </button>
          ))}
        </div>
      )}

      <LivePlayer key={current.id} cam={current.id} label={current.name} />
      {!current.recording && <p className="cctv-warn">{t.cctvNotRecording}</p>}

      <p>
        <a href="/cctv/archive">{t.cctvOpenArchive}</a>
      </p>
    </main>
  );
}
