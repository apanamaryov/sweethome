"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { fetchCameras, fetchStorage, type CameraInfo, type StorageInfo } from "@/lib/cctv";
import { useT } from "@/lib/i18n";

/**
 * Карточка раздела на обзоре дома. Структура повторяет карточку инвертора
 * (обёртка-ссылка + card/card-head/строки): без этого браузер рисует её как
 * обычную ссылку — подчёркнутой и фиолетовой.
 */
export default function CctvCard() {
  const t = useT();
  const [cams, setCams] = useState<CameraInfo[]>([]);
  const [storage, setStorage] = useState<StorageInfo | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    // Обзор — общая страница дома: если модуль выключен или сервер ответил
    // ошибкой, карточка показывает пустое состояние, а не роняет страницу.
    Promise.allSettled([fetchCameras(), fetchStorage()]).then(([c, s]) => {
      if (c.status === "fulfilled") setCams(c.value);
      if (s.status === "fulfilled") setStorage(s.value);
      setLoaded(true);
    });
  }, []);

  const recording = cams.filter((c) => c.recording).length;
  const trouble = storage?.available === false || (cams.length > 0 && recording < cams.length);
  const usedPct =
    storage && storage.quotaBytes > 0
      ? Math.round((storage.usedBytes / storage.quotaBytes) * 100)
      : null;

  return (
    <Link href="/cctv" className="home-card-link-wrap">
      <section className="card home-card">
        <div className="card-head">
          <span className="card-title">{t.navCctv}</span>
        </div>

        {!loaded ? (
          <p className="muted">{t.connecting}</p>
        ) : cams.length === 0 ? (
          <p className="muted">{t.cctvNoCameras}</p>
        ) : (
          <div className="home-card-rows">
            <div className="home-card-row">
              <span>{t.cctvRecording}</span>
              <span>
                {recording} / {cams.length}
              </span>
            </div>
            {storage?.available && (
              <>
                <div className="home-card-row">
                  <span>{t.cctvDepthDays}</span>
                  <span>{storage.depthDays ?? "—"}</span>
                </div>
                {usedPct !== null && (
                  <div className="home-card-row">
                    <span>{t.cctvStorageUsed}</span>
                    <span>{usedPct}%</span>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {trouble && (
          <p className="cctv-warn" data-testid="cctv-card-warn">
            {storage?.available === false ? t.cctvStorageUnavailable : t.cctvNotRecording}
          </p>
        )}
      </section>
    </Link>
  );
}
