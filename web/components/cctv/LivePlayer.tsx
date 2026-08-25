"use client";

import { useEffect, useRef, useState } from "react";
import { wsUrl } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { useExpandable } from "./useExpandable";

/**
 * На iPhone обычного MediaSource нет вовсе: Apple даёт только ManagedMediaSource,
 * и то начиная с iOS 17.1. Поэтому берём ту реализацию, которая есть, а если нет
 * ни одной — честно говорим об этом вместо падения всей страницы.
 */
function pickMediaSource(): (new () => MediaSource) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as Record<string, unknown>;
  return ((w.ManagedMediaSource ?? w.MediaSource) as (new () => MediaSource) | undefined) ?? null;
}
/**
 * Сколько ждать первого фрагмента, прежде чем честно сказать, что потока нет.
 *
 * Раньше по этому таймеру подставлялся зашитый кодек, но угадывать больше нельзя:
 * состав дорожек у камер разный (у одной звука нет вовсе), а неверно объявленный
 * кодек не даёт открыть источник вообще. Пятнадцать секунд — с запасом на
 * подключение к камере и ожидание опорного кадра (~3 с).
 */
const NO_STREAM_MS = 15_000;

/**
 * Живой просмотр: фрагменты приходят по WebSocket и складываются в MediaSource.
 * Готового плеера здесь нет намеренно — HLS дал бы задержку в десяток секунд,
 * а так она около секунды (спека §8).
 */
export default function LivePlayer({
  cam,
  label,
  muted = true,
  onAudioAvailable,
}: {
  cam: string;
  label: string;
  /** Звуком владеет страница: кнопка живёт в строке камер, рядом с архивом. */
  muted?: boolean;
  /** Сообщаем странице, что в потоке реально есть звуковая дорожка. */
  onAudioAvailable?: (has: boolean) => void;
}) {
  const t = useT();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { expanded, toggle: toggleSize } = useExpandable();

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    // Гейт против устаревших асинхронных срабатываний после размонтирования/смены камеры:
    // без него замыкания держат ссылки на video/MediaSource (утечка) и могут дёрнуть
    // setState на уже размонтированном компоненте.
    let cancelled = false;
    const setErrorSafe = (msg: string | null) => {
      if (!cancelled) setError(msg);
    };
    const setHasAudioSafe = (v: boolean) => {
      if (!cancelled) onAudioAvailable?.(v);
    };

    const MediaSourceImpl = pickMediaSource();
    if (!MediaSourceImpl) {
      setError(t.cctvLiveUnsupported);
      return;
    }

    // ManagedMediaSource работает только при отключённом удалённом воспроизведении
    // (иначе Safari оставляет за собой AirPlay и источник не открывается).
    video.disableRemotePlayback = true;

    const ms = new MediaSourceImpl();
    video.src = URL.createObjectURL(ms);

    let sb: SourceBuffer | null = null;
    const queue: ArrayBuffer[] = [];

    // sourceopen — событие локальное, оно срабатывает, как только браузер начал открывать
    // blob-адрес, то есть заведомо раньше, чем пройдёт рукопожатие WebSocket и придёт ответ
    // сервера {type:"ready", mime}. Поэтому буфер создаём только когда известны обе вещи —
    // и открытый источник, и реальный кодек камеры; до этого момента фрагменты просто копятся
    // в очереди и выгрузятся при первом flush().
    let sourceOpen = false;
    let mime: string | null = null;
    let mimeFallbackTimer: ReturnType<typeof setTimeout> | null = null;

    const flush = () => {
      if (!sb || sb.updating || queue.length === 0) return;
      try {
        sb.appendBuffer(queue.shift()!);
      } catch {
        // переполнение буфера лечится подрезкой ниже
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

    const onUpdateEnd = () => {
      trim();
      flush();
    };

    const tryCreateBuffer = () => {
      if (cancelled || sb || !sourceOpen || !mime) return;
      try {
        sb = ms.addSourceBuffer(mime);
        sb.addEventListener("updateend", onUpdateEnd);
      } catch (e) {
        setErrorSafe((e as Error).message);
      }
    };

    const openSource = () => {
      if (cancelled) return;
      sourceOpen = true;
      // Если сервер за MIME_FALLBACK_MS не прислал mime — не зависаем навсегда молча,
      // откатываемся на зашитый кодек.
      mimeFallbackTimer = setTimeout(() => {
        if (!mime) setErrorSafe(t.cctvNoStream);
      }, NO_STREAM_MS);
      tryCreateBuffer();
    };

    ms.addEventListener("sourceopen", openSource);

    // Сбой декодирования (битый сегмент, несовпавший кодек) приходит через события самого
    // <video>, а не WebSocket/MediaSource — без этого обработчика пользователь увидит
    // ровно то, чего спека запрещает: чёрный квадрат без объяснений.
    const onVideoError = () => {
      const code = video.error?.code;
      setErrorSafe(`playback failed${code ? ` (code ${code})` : ""}`);
    };
    video.addEventListener("error", onVideoError);

    // Ошибку гасим не по приходу данных — сервер шлёт сегменты и тогда, когда браузер их
    // не смог декодировать, — а по факту, что картинка реально пошла. Иначе плашка гаснет
    // через один интервал сегмента, а зритель дальше смотрит на чёрный прямоугольник без
    // объяснений — ровно то, чего спека запрещает.
    const onPlaying = () => setErrorSafe(null);
    video.addEventListener("playing", onPlaying);

    const ws = new WebSocket(wsUrl("cctv"));
    ws.binaryType = "arraybuffer";

    ws.onopen = () => ws.send(JSON.stringify({ type: "subscribe", cam }));
    ws.onerror = () => setErrorSafe("connection failed");
    ws.onmessage = (ev: MessageEvent) => {
      if (typeof ev.data === "string") {
        const msg = JSON.parse(ev.data) as { type: string; mime?: string; error?: string };
        if (msg.type === "ready" && msg.mime) {
          mime = msg.mime;
          // Кнопка звука появляется только там, где звук реально есть: сервер
          // объявляет дорожки по факту потока (см. modules/cctv/src/audio.ts).
          setHasAudioSafe(mime.includes("mp4a"));
          tryCreateBuffer();
        }
        if (msg.type === "error") setErrorSafe(msg.error ?? "stream error");
        return;
      }
      queue.push(ev.data as ArrayBuffer);
      flush();
      // Опциональная цепочка — не только на случай отказа самого play() (спека это
      // допускает), но и потому, что не все реализации HTMLMediaElement возвращают из play()
      // промис (jsdom в тестах, к примеру, возвращает undefined) — обработчик сообщения не
      // должен падать из-за этого.
      void video.play()?.catch(() => {});
    };

    return () => {
      cancelled = true;
      if (mimeFallbackTimer) clearTimeout(mimeFallbackTimer);
      ms.removeEventListener("sourceopen", openSource);
      if (sb) sb.removeEventListener("updateend", onUpdateEnd);
      video.removeEventListener("error", onVideoError);
      video.removeEventListener("playing", onPlaying);
      try {
        ws.send(JSON.stringify({ type: "unsubscribe", cam }));
      } catch {}
      ws.close();
      try {
        if (ms.readyState === "open") ms.endOfStream();
      } catch {}
      // Клинап при размонтировании не имеет права падать ни при каких обстоятельствах —
      // зритель уже ушёл со страницы и не сможет починить вылетевшее из хука исключение
      // (тот же довод, по которому выше обёрнут endOfStream()).
      try {
        URL.revokeObjectURL(video.src);
      } catch {}
    };
  }, [cam, t, onAudioAvailable]);

  return (
    // Подписи под картинкой нет намеренно: какая камера выбрана, видно по
    // подсвеченной кнопке в строке выше. Имя остаётся для читалок с экрана.
    <figure className={`cctv-live${expanded ? " cctv-expanded" : ""}`} aria-label={label}>
      {/* Клик увеличивает картинку — тот же жест, что и в архиве. */}
      <video ref={videoRef} muted={muted} playsInline autoPlay onClick={toggleSize} />
      {error && <p className="cctv-error">{error}</p>}
    </figure>
  );
}
