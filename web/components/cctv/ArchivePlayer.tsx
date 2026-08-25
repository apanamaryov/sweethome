"use client";

import { useEffect, useRef, useState } from "react";
import Hls from "hls.js";
import { playlistUrl } from "@/lib/cctv";
import { useT } from "@/lib/i18n";

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
  onSeekRequest,
  locale,
  expanded,
  onToggleSize,
  hasAudio = false,
}: {
  cam: string;
  /** С какого момента играть: начало суток или точка, куда ткнули на ленте. */
  startMs: number;
  toMs: number;
  /** Текущая позиция в реальном времени — для курсора на ленте. */
  onPositionMs?: (ms: number) => void;
  /** Перемотка: просим страницу перезапустить плеер с другого момента. */
  onSeekRequest?: (ms: number) => void;
  locale: string;
  /** Картинка увеличена. Состоянием владеет страница: перемотка пересоздаёт
   *  плеер, и своё состояние он потерял бы на каждом переходе. */
  expanded?: boolean;
  onToggleSize?: () => void;
  /** Есть ли у камеры звук: без него кнопка громкости — обманка. */
  hasAudio?: boolean;
}) {
  const t = useT();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  // Реальное время текущего кадра: шкала самого плеера всегда начинается с нуля,
  // потому что после каждой перемотки он получает новый плейлист.
  const [nowMs, setNowMs] = useState(startMs);
  // Заглушено по умолчанию — как и в живом просмотре: архив часто открывают,
  // чтобы просто посмотреть, а не слушать.
  const [muted, setMuted] = useState(true);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    // Новый источник — прошлая ошибка к нему не относится.
    setError(null);

    const onPlaying = () => {
      setError(null);
      setPlaying(true);
    };
    const onPause = () => setPlaying(false);
    const onVideoError = () => {
      const code = video.error?.code;
      setError(`playback failed${code ? ` (code ${code})` : ""}`);
    };
    // Позиция плеера отсчитывается от начала плейлиста, а лента живёт в реальном
    // времени — пересчитываем одно в другое здесь, в одном месте.
    const onTimeUpdate = () => {
      const real = startMs + video.currentTime * 1000;
      setNowMs(real);
      onPositionMs?.(real);
    };

    video.addEventListener("playing", onPlaying);
    video.addEventListener("pause", onPause);
    video.addEventListener("error", onVideoError);
    video.addEventListener("timeupdate", onTimeUpdate);

    const cleanupVideo = () => {
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("error", onVideoError);
      video.removeEventListener("timeupdate", onTimeUpdate);
      // src не трогаем: элемент всё равно уничтожается вместе с компонентом
      // (страница пересоздаёт его на каждый новый момент), а video.load() до
      // hls.destroy() оставлял плеер в состоянии, из которого он больше не
      // запускался — ни сам, ни по кнопке.
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
      // Сначала отцепляем плеер, потом снимаем слушатели: обратный порядок
      // оставлял ManagedMediaSource на iPhone в состоянии, из которого
      // воспроизведение уже не поднималось.
      hls.destroy();
      cleanupVideo();
    };
  }, [cam, startMs, toMs, onPositionMs]);

  const toggle = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) void video.play()?.catch(() => {});
    else video.pause();
  };

  const jump = (deltaSec: number) => onSeekRequest?.(nowMs + deltaSec * 1000);

  return (
    <div className={`cctv-archive-player${expanded ? " cctv-expanded" : ""}`}>
      {/* Штатных контролов нет намеренно: их ползунок перематывает внутри
          плейлиста, а на наших записях после такой перемотки воспроизведение
          не восстанавливается. Единственный способ сдвинуться по времени —
          перезапуск с нужного момента, что и делают эти кнопки и лента внизу.

          Клик по картинке увеличивает её, а не ставит на паузу: пауза живёт на
          кнопке в баре, и делить один жест на два действия незачем. */}
      <video ref={videoRef} muted={muted} playsInline className="cctv-archive-video" onClick={onToggleSize} />
      <div className="cctv-player-bar">
        <button onClick={() => jump(-60)} aria-label="-1 min">−1м</button>
        <button onClick={() => jump(-10)} aria-label="-10 s">−10с</button>
        <button onClick={toggle} className="cctv-play">{playing ? "❚❚" : "▶"}</button>
        <button onClick={() => jump(10)} aria-label="+10 s">+10с</button>
        <button onClick={() => jump(60)} aria-label="+1 min">+1м</button>
        {hasAudio && (
          <button
            className="cctv-sound"
            aria-label={muted ? t.cctvUnmute : t.cctvMute}
            onClick={() => setMuted((m) => !m)}
          >
            {muted ? "🔇" : "🔊"}
          </button>
        )}
        <span className="cctv-clock">
          {new Date(nowMs).toLocaleTimeString(locale)}
        </span>
      </div>
      {error && <p className="cctv-error">{error}</p>}
    </div>
  );
}
