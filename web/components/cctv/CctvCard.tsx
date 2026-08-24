"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { fetchCameras, fetchStorage, type CameraInfo, type StorageInfo } from "@/lib/cctv";
import { useT } from "@/lib/i18n";

export default function CctvCard() {
  const t = useT();
  const [cams, setCams] = useState<CameraInfo[]>([]);
  const [storage, setStorage] = useState<StorageInfo | null>(null);

  useEffect(() => {
    // Обзор — общая страница дома: если модуль выключен или сервер ответил
    // ошибкой, карточка просто показывает пустое состояние, а не роняет страницу.
    fetchCameras().then(setCams).catch(() => setCams([]));
    fetchStorage().then(setStorage).catch(() => setStorage(null));
  }, []);

  const recording = cams.filter((c) => c.recording).length;
  const trouble = storage?.available === false || cams.some((c) => !c.recording);
  const usedPct = storage && storage.quotaBytes > 0
    ? Math.round((storage.usedBytes / storage.quotaBytes) * 100)
    : 0;

  return (
    <Link href="/cctv" className="card cctv-card">
      <h2>{t.navCctv}</h2>
      <p>
        {t.cctvRecording}: {recording} / {cams.length}
      </p>
      {storage && storage.available && (
        <p>
          {usedPct}% · {t.cctvDepthDays}: {storage.depthDays ?? "—"}
        </p>
      )}
      {trouble && (
        <p className="cctv-warn" data-testid="cctv-card-warn">
          {storage?.available === false ? t.cctvStorageUnavailable : t.cctvNotRecording}
        </p>
      )}
    </Link>
  );
}
