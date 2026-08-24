import type { CameraConfig } from "../config";

export function rtspUrl(cam: CameraConfig): string {
  return `rtsp://${cam.host}:554/${cam.rtspPath}`;
}

export function initFileName(runId: string): string {
  return `init_${runId}.mp4`;
}

/**
 * Команда записи. Каждый ключ здесь обоснован разведкой (спека §2.1, §5):
 * TCP — потому что по UDP поток не поднимается; свои метки времени — потому что
 * камера их не ставит; fmp4 — потому что обычный MP4 не склеивается в ленту.
 */
export function recordArgs(opts: {
  cam: CameraConfig;
  camDir: string;
  segmentSec: number;
  runId: string;
}): string[] {
  const { cam, camDir, segmentSec, runId } = opts;
  return [
    "-nostdin", "-hide_banner", "-loglevel", "error",
    "-rtsp_transport", "tcp",
    "-use_wallclock_as_timestamps", "1",
    "-i", rtspUrl(cam),
    "-c", "copy",
    "-f", "hls",
    "-hls_time", String(segmentSec),
    "-hls_list_size", "0",
    "-hls_segment_type", "fmp4",
    "-hls_fmp4_init_filename", initFileName(runId),
    "-hls_flags", "append_list+program_date_time+independent_segments+temp_file",
    "-hls_segment_filename", `${camDir}/seg_%Y%m%d_%H%M%S.m4s`,
    "-strftime", "1",
    `${camDir}/live.m3u8`,
  ];
}

/**
 * Команда живого просмотра: фрагменты идут в stdout по 0.5 с, чтобы задержка не
 * равнялась интервалу опорных кадров (~2.9 с у этих камер).
 */
export function liveArgs(opts: { cam: CameraConfig; fragMs?: number }): string[] {
  const fragUs = (opts.fragMs ?? 500) * 1000;
  return [
    "-nostdin", "-hide_banner", "-loglevel", "error",
    "-rtsp_transport", "tcp",
    "-use_wallclock_as_timestamps", "1",
    "-i", rtspUrl(opts.cam),
    "-an",
    "-c", "copy",
    "-f", "mp4",
    "-movflags", "+frag_keyframe+empty_moov+default_base_moof",
    "-frag_duration", String(fragUs),
    "pipe:1",
  ];
}

export type ExecLike = (cmd: string, args: string[]) => Promise<{ code: number; stdout: string }>;

/** Проверка, что ffmpeg вообще есть: без него модуль стартует, но честно не работает. */
export async function probeFfmpeg(
  bin: string,
  exec: ExecLike
): Promise<{ ok: boolean; version?: string; error?: string }> {
  try {
    const { code, stdout } = await exec(bin, ["-hide_banner", "-version"]);
    if (code !== 0) return { ok: false, error: `ffmpeg exited with code ${code}` };
    const m = /^ffmpeg version (\S+)/.exec(stdout);
    if (!m) return { ok: false, error: "unexpected output from ffmpeg -version" };
    return { ok: true, version: m[1] };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
