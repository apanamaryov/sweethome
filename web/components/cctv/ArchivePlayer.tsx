"use client";

import { useEffect, useRef, useState } from "react";
import Hls from "hls.js";
import type { Span } from "@sweethome/cctv-shared";
import { offsetInSpans, playlistUrl } from "@/lib/cctv";

/**
 * Архив играется одним плейлистом на весь запрошенный интервал, поэтому границы
 * минутных файлов не чувствуются, а ползунок ходит по всему дню.
 */
export default function ArchivePlayer({
  cam,
  fromMs,
  toMs,
  spans,
  seekToMs,
}: {
  cam: string;
  fromMs: number;
  toMs: number;
  spans: Span[];
  seekToMs: number | null;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    // Новая камера или новые сутки — это новый источник; сообщение об ошибке от
    // предыдущего плейлиста к нему не относится.
    setError(null);

    // Ошибку гасим не по приходу данных, а по факту, что картинка реально пошла —
    // тот же довод, что и в LivePlayer: иначе плашка гаснет через кадр, а зритель
    // смотрит на чёрный прямоугольник без объяснений.
    const onPlaying = () => setError(null);
    const onVideoError = () => {
      const code = video.error?.code;
      setError(`playback failed${code ? ` (code ${code})` : ""}`);
    };
    video.addEventListener("playing", onPlaying);
    video.addEventListener("error", onVideoError);
    const cleanupVideo = () => {
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("error", onVideoError);
    };

    const url = playlistUrl(cam, fromMs, toMs);

    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = url; // Safari умеет HLS сам — второй плеер не создаём
      return cleanupVideo;
    }
    if (!Hls.isSupported()) return cleanupVideo;

    const hls = new Hls({ enableWorker: false });
    hlsRef.current = hls;
    hls.on(Hls.Events.ERROR, (_evt, data) => {
      // Нефатальные hls.js лечит сам (докачает сегмент, пересинхронизируется);
      // показываем только то, после чего воспроизведение само не восстановится.
      if (data.fatal) setError(`playback failed: ${data.details}`);
    });
    hls.loadSource(url);
    hls.attachMedia(video);
    return () => {
      cleanupVideo();
      hls.destroy();
      hlsRef.current = null;
    };
  }, [cam, fromMs, toMs]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || seekToMs === null) return;
    const offset = offsetInSpans(seekToMs, spans);
    if (offset !== null) video.currentTime = offset;
  }, [seekToMs, spans]);

  return (
    <div className="cctv-archive-player">
      <video ref={videoRef} controls playsInline className="cctv-archive-video" />
      {error && <p className="cctv-error">{error}</p>}
    </div>
  );
}
