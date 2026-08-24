"use client";

import { useEffect, useRef, useState } from "react";
import { wsUrl } from "@/lib/api";

/** Кодек по умолчанию — запасной вариант, если сервер не успел прислать свой mime. */
const DEFAULT_MIME = 'video/mp4; codecs="avc1.4d0032"';
/** Сколько ждать mime от сервера, прежде чем откатиться на дефолт — иначе плеер зависнет навсегда. */
const MIME_FALLBACK_MS = 3000;

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

    // Гейт против устаревших асинхронных срабатываний после размонтирования/смены камеры:
    // без него замыкания держат ссылки на video/MediaSource (утечка) и могут дёрнуть
    // setState на уже размонтированном компоненте.
    let cancelled = false;
    const setErrorSafe = (msg: string | null) => {
      if (!cancelled) setError(msg);
    };

    const ms = new MediaSource();
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
        if (!mime) mime = DEFAULT_MIME;
        tryCreateBuffer();
      }, MIME_FALLBACK_MS);
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

    const ws = new WebSocket(wsUrl("cctv"));
    ws.binaryType = "arraybuffer";

    ws.onopen = () => ws.send(JSON.stringify({ type: "subscribe", cam }));
    ws.onerror = () => setErrorSafe("connection failed");
    ws.onmessage = (ev: MessageEvent) => {
      if (typeof ev.data === "string") {
        const msg = JSON.parse(ev.data) as { type: string; mime?: string; error?: string };
        if (msg.type === "ready" && msg.mime) {
          mime = msg.mime;
          tryCreateBuffer();
        }
        if (msg.type === "error") setErrorSafe(msg.error ?? "stream error");
        return;
      }
      setErrorSafe(null);
      queue.push(ev.data as ArrayBuffer);
      flush();
      void video.play().catch(() => {});
    };

    return () => {
      cancelled = true;
      if (mimeFallbackTimer) clearTimeout(mimeFallbackTimer);
      ms.removeEventListener("sourceopen", openSource);
      if (sb) sb.removeEventListener("updateend", onUpdateEnd);
      video.removeEventListener("error", onVideoError);
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
  }, [cam]);

  return (
    <figure className="cctv-live">
      <figcaption>{label}</figcaption>
      <video ref={videoRef} muted playsInline autoPlay />
      {error && <p className="cctv-error">{error}</p>}
    </figure>
  );
}
