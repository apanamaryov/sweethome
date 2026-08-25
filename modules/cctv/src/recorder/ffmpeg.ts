import type { CameraConfig } from "../config";

export function rtspUrl(cam: CameraConfig): string {
  return `rtsp://${cam.host}:554/${cam.rtspPath}`;
}

export function initFileName(runId: string): string {
  return `init_${runId}.mp4`;
}

/**
 * Как брать звук у этих камер.
 *
 * Копировать его нельзя: камера шлёт AAC с негодными метками времени, ffmpeg
 * такие пакеты выбрасывает (на выходе ноль звуковых пакетов), а видео при этом
 * десять секунд ждёт отстающую дорожку — отсюда и «камера открывается вечно».
 * Перекодирование восстанавливает метки: измерено на малине — первая выдача
 * через 2.9 с вместо 12, и звук наконец доходит.
 *
 * 44.1 кГц вместо родных 8 — не прихоть: на такой частоте звук принимают все
 * браузеры, а стоимость пересчёта для моно-дорожки в 32 кбит/с незаметна.
 */
const AUDIO_ARGS = [
  "-c:v", "copy",
  "-c:a", "aac",
  "-ar", "44100",
  "-ac", "1",
  "-b:a", "32k",
  // Страховка: если звук у камеры вдруг замолчит, видео не должно ждать его
  // десять секунд (столько ffmpeg ждёт по умолчанию).
  "-max_interleave_delta", "1000000",
];

/** Без звука — просто копия видео, самый дешёвый и быстрый путь. */
const NO_AUDIO_ARGS = ["-an", "-c", "copy"];

function streamArgs(withAudio: boolean | undefined): string[] {
  return withAudio ? AUDIO_ARGS : NO_AUDIO_ARGS;
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
  /** Брать ли звук. Пустая дорожка дорого стоит — см. `audioProbeArgs`. */
  withAudio?: boolean;
}): string[] {
  const { cam, camDir, segmentSec, runId } = opts;
  return [
    "-nostdin", "-hide_banner", "-loglevel", "error",
    "-rtsp_transport", "tcp",
    "-use_wallclock_as_timestamps", "1",
    "-i", rtspUrl(cam),
    ...streamArgs(opts.withAudio),
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
 *
 * Звук берётся только если камера его действительно шлёт (`withAudio`), и тогда
 * перекодируется — почему именно так, см. AUDIO_ARGS.
 */
export function liveArgs(opts: { cam: CameraConfig; fragMs?: number; withAudio?: boolean }): string[] {
  const fragUs = (opts.fragMs ?? 500) * 1000;
  return [
    "-nostdin", "-hide_banner", "-loglevel", "error",
    "-rtsp_transport", "tcp",
    "-use_wallclock_as_timestamps", "1",
    "-i", rtspUrl(opts.cam),
    ...streamArgs(opts.withAudio),
    "-f", "mp4",
    "-movflags", "+frag_keyframe+empty_moov+default_base_moof",
    "-frag_duration", String(fragUs),
    "pipe:1",
  ];
}

/**
 * Проба звука: слушаем камеру несколько секунд и считаем реальные отсчёты.
 *
 * Наличие дорожки в потоке ничего не значит — наши камеры объявляют AAC 8 кГц и
 * не присылают ни одного пакета. Ориентироваться на объявление нельзя дважды:
 * зритель не услышит ничего, а пустая дорожка ещё и задерживает выдачу видео.
 */
export function audioProbeArgs(cam: CameraConfig, seconds = 4): string[] {
  return [
    "-nostdin", "-hide_banner", "-v", "info",
    "-rtsp_transport", "tcp",
    "-i", rtspUrl(cam),
    "-t", String(seconds),
    "-map", "0:a?",
    "-af", "volumedetect",
    "-f", "null", "-",
  ];
}

/**
 * Сколько звуковых отсчётов насчитал volumedetect. Ноль — звука нет.
 *
 * Строк `n_samples` в выводе несколько: первая приходит от пустого прогона
 * фильтра и всегда нулевая, настоящая — дальше. Берём наибольшую, иначе камера
 * со звуком навсегда числится молчащей (на этом уже обожглись).
 */
export function parseAudioSamples(stderr: string): number {
  let best = 0;
  for (const m of stderr.matchAll(/n_samples:\s*(\d+)/g)) {
    best = Math.max(best, Number(m[1]));
  }
  return best;
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
