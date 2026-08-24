"use client";

import { useEffect, useRef, useState } from "react";
import { wsUrl } from "@/lib/api";

/**
 * Живой просмотр: фрагменты приходят по WebSocket и складываются в MediaSource.
 * Готового плеера здесь нет намеренно — HLS дал бы задержку в десяток секунд,
 * а так она около секунды (спека §8).
 */
export default function LivePlayer({ cam, label }: { cam: string; label: string }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const ms = new MediaSource();
    video.src = URL.createObjectURL(ms);

    let sb: SourceBuffer | null = null;
    const queue: ArrayBuffer[] = [];
    let mime = 'video/mp4; codecs="avc1.4d0032"';

    const flush = () => {
      if (!sb || sb.updating || queue.length === 0) return;
      try {
        sb.appendBuffer(queue.shift()!);
      } catch {
        // переполнение буфера лечится подрезкой ниже
      }
    };

    const openSource = () => {
      try {
        sb = ms.addSourceBuffer(mime);
        sb.addEventListener("updateend", () => {
          trim();
          flush();
        });
      } catch (e) {
        setError((e as Error).message);
      }
    };

    /** Для живой картинки актуальность важнее истории: держим не больше 30 с. */
    const trim = () => {
      if (!sb || sb.updating || !video.buffered.length) return;
      const end = video.buffered.end(video.buffered.length - 1);
      if (end - video.buffered.start(0) > 30) {
        try {
          sb.remove(0, end - 15);
        } catch {}
      }
      if (end - video.currentTime > 3) video.currentTime = end - 0.5; // догоняем, если отстали
    };

    ms.addEventListener("sourceopen", openSource);

    const ws = new WebSocket(wsUrl("cctv"));
    ws.binaryType = "arraybuffer";

    ws.onopen = () => ws.send(JSON.stringify({ type: "subscribe", cam }));
    ws.onerror = () => setError("connection failed");
    ws.onmessage = (ev: MessageEvent) => {
      if (typeof ev.data === "string") {
        const msg = JSON.parse(ev.data) as { type: string; mime?: string; error?: string };
        if (msg.type === "ready" && msg.mime) mime = msg.mime;
        if (msg.type === "error") setError(msg.error ?? "stream error");
        return;
      }
      setError(null);
      queue.push(ev.data as ArrayBuffer);
      flush();
      void video.play().catch(() => {});
    };

    return () => {
      try {
        ws.send(JSON.stringify({ type: "unsubscribe", cam }));
      } catch {}
      ws.close();
      try {
        if (ms.readyState === "open") ms.endOfStream();
      } catch {}
      // В части сред (в т.ч. jsdom в тестах) revokeObjectURL может не существовать
      // или отсутствовать на уже освобождённом URL — не даём этому свалить размонтирование.
      try {
        URL.revokeObjectURL(video.src);
      } catch {}
    };
  }, [cam]);

  return (
    <figure className="cctv-live">
      <figcaption>{label}</figcaption>
      <video ref={videoRef} muted playsInline autoPlay />
      {error && <p className="cctv-error">{error}</p>}
    </figure>
  );
}
