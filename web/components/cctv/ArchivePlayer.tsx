"use client";

import { useEffect, useRef } from "react";
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

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const url = playlistUrl(cam, fromMs, toMs);

    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = url; // Safari умеет HLS сам
      return;
    }
    if (!Hls.isSupported()) return;

    const hls = new Hls({ enableWorker: false });
    hlsRef.current = hls;
    hls.loadSource(url);
    hls.attachMedia(video);
    return () => {
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

  return <video ref={videoRef} controls playsInline className="cctv-archive-video" />;
}
