"use client";

import { useEffect, useRef, useState } from "react";
import Hls from "hls.js";
import { playlistUrl } from "@/lib/cctv";

/**
 * Плеер архива.
 *
 * Перемотка сделана не сдвигом позиции внутри длинного плейлиста, а загрузкой
 * нового плейлиста, начинающегося с нужного момента. Причина не в удобстве:
 * перемотка внутри плейлиста на наших записях не работает — воспроизведение
 * встаёт и больше не запускается (проверено на устройстве и повторено ffmpeg
 * на самой малине). Тот же контент, поданный плейлистом с нужной точки,
 * играет нормально — на этом и строимся.
 */
export default function ArchivePlayer({
  cam,
  startMs,
  toMs,
  onPositionMs,
}: {
  cam: string;
  /** С какого момента играть: начало суток или точка, куда ткнули на ленте. */
  startMs: number;
  toMs: number;
  /** Текущая позиция в реальном времени — для курсора на ленте. */
  onPositionMs?: (ms: number) => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    // Новый источник — прошлая ошибка к нему не относится.
    setError(null);

    const onPlaying = () => setError(null);
    const onVideoError = () => {
      const code = video.error?.code;
      setError(`playback failed${code ? ` (code ${code})` : ""}`);
    };
    // Позиция плеера отсчитывается от начала плейлиста, а лента живёт в реальном
    // времени — пересчитываем одно в другое здесь, в одном месте.
    const onTimeUpdate = () => onPositionMs?.(startMs + video.currentTime * 1000);

    video.addEventListener("playing", onPlaying);
    video.addEventListener("error", onVideoError);
    video.addEventListener("timeupdate", onTimeUpdate);

    const cleanupVideo = () => {
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("error", onVideoError);
      video.removeEventListener("timeupdate", onTimeUpdate);
      video.removeAttribute("src");
      video.load();
    };

    const url = playlistUrl(cam, startMs, toMs);

    // hls.js идёт первым даже там, где браузер умеет HLS сам: встроенный плеер
    // Safari на наших плейлистах играет только первый фрагмент.
    if (!Hls.isSupported()) {
      // Остаётся встроенный плеер: на iPhone до iOS 17.1 другого варианта нет.
      video.src = url;
      void video.play()?.catch(() => {});
      return cleanupVideo;
    }

    // На iPhone hls.js работает через ManagedMediaSource, а тот открывается
    // только при отключённом удалённом воспроизведении — требование Apple.
    video.disableRemotePlayback = true;

    const hls = new Hls({ enableWorker: false });
    hls.on(Hls.Events.ERROR, (_evt, data) => {
      // Нефатальные hls.js лечит сам; показываем только то, после чего
      // воспроизведение само не восстановится.
      if (data.fatal) setError(`playback failed: ${data.details}`);
    });
    // Как только манифест разобран, запускаем сами: после перемотки источник
    // меняется, и без этого зритель остаётся смотреть на замерший кадр.
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      void video.play()?.catch(() => {});
    });
    hls.loadSource(url);
    hls.attachMedia(video);

    return () => {
      cleanupVideo();
      hls.destroy();
    };
  }, [cam, startMs, toMs, onPositionMs]);

  return (
    <div className="cctv-archive-player">
      <video ref={videoRef} controls playsInline className="cctv-archive-video" />
      {error && <p className="cctv-error">{error}</p>}
    </div>
  );
}
