"use client";

import { useEffect, useState } from "react";
import LivePlayer from "@/components/cctv/LivePlayer";
import { fetchCameras, type CameraInfo } from "@/lib/cctv";
import { useT } from "@/lib/i18n";

export default function CctvPage() {
  const t = useT();
  const [cams, setCams] = useState<CameraInfo[] | null>(null);

  useEffect(() => {
    fetchCameras().then(setCams).catch(() => setCams([]));
  }, []);

  if (cams === null) return <p>{t.connecting}</p>;
  if (cams.length === 0) return <p>{t.cctvNoCameras}</p>;

  return (
    <main className="cctv-page">
      <h1>{t.navCctv}</h1>
      <div className="cctv-grid">
        {cams.map((c) => (
          <div key={c.id}>
            <LivePlayer cam={c.id} label={c.name} />
            {!c.recording && <p className="cctv-warn">{t.cctvNotRecording}</p>}
          </div>
        ))}
      </div>
      <p>
        <a href="/cctv/archive">{t.cctvOpenArchive}</a>
      </p>
    </main>
  );
}
