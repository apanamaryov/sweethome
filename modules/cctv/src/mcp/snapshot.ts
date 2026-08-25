import type { CameraConfig } from "../config";
import { rtspUrl } from "../recorder/ffmpeg";

/** Кадр отдаётся агенту в ответе, поэтому по умолчанию он маленький. */
export const DEFAULT_FRAME_WIDTH = 640;
export const MAX_FRAME_WIDTH = 1920;
/** Потолок на ответ: base64 раздувает картинку в полтора раза. */
export const MAX_FRAME_BYTES = 2 * 1024 * 1024;
/** Живой кадр требует подключения к камере по RTSP — это заметно дольше, чем чтение с диска. */
export const LIVE_TIMEOUT_MS = 20_000;
export const ARCHIVE_TIMEOUT_MS = 20_000;

/** Общий хвост команды: один кадр, уменьшенный, в JPEG на stdout. */
function encodeArgs(width: number): string[] {
  return [
    "-frames:v", "1",
    // -2 вместо -1: высота округляется до чётной, иначе jpeg-кодировщик ругается
    // на нечётный размер при некоторых входных разрешениях.
    "-vf", `scale=${width}:-2`,
    "-c:v", "mjpeg",
    // Измерено на малине: кадр 640×720 с этих камер весит ~150 КБ при q:v 4,
    // ~120 при 6 и ~90 при 8, а разницы на глаз почти нет — картинка уходит в
    // ответ агенту, так что лишние килобайты дороже лишней детализации.
    "-q:v", "8",
    "-f", "image2",
    "pipe:1",
  ];
}

/** Кадр прямо сейчас — отдельное подключение к камере, запись при этом не трогается. */
export function liveFrameArgs(cam: CameraConfig, width: number): string[] {
  return [
    "-nostdin", "-hide_banner", "-loglevel", "error",
    "-rtsp_transport", "tcp",
    "-i", rtspUrl(cam),
    ...encodeArgs(width),
  ];
}

/**
 * Кадр из архива. На вход идёт побайтовая склейка init+сегмент через stdin —
 * тот же приём, что у /download: фрагментированный MP4 для того и придуман.
 *
 * Перемотка только выходная (-ss после -i): на трубе входная не работает, а
 * сегмент короткий (по умолчанию минута), так что декодировать с начала дёшево.
 */
export function archiveFrameArgs(offsetSec: number, width: number): string[] {
  return [
    "-nostdin", "-hide_banner", "-loglevel", "error",
    "-i", "pipe:0",
    "-ss", offsetSec.toFixed(3),
    ...encodeArgs(width),
  ];
}

export interface FrameChild {
  stdout: NodeJS.ReadableStream | null;
  stdin: NodeJS.WritableStream | null;
  stderr: { on(ev: "data", cb: (c: Buffer) => void): void } | null;
  on(ev: "exit" | "error", cb: (arg?: unknown) => void): void;
  kill(sig?: NodeJS.Signals): void;
}

export type FrameSpawner = (cmd: string, args: string[]) => FrameChild;

export interface GrabOptions {
  spawn: FrameSpawner;
  ffmpegPath: string;
  args: string[];
  /** Что скормить на stdin по порядку — для архива это init и сегмент. */
  input?: NodeJS.ReadableStream[];
  timeoutMs: number;
  maxBytes?: number;
}

/**
 * Запуск ffmpeg ради одного кадра.
 *
 * Отдельная функция, а не метод: тут три вещи, каждая из которых уже кусалась в
 * этом модуле — необработанный "error" у процесса роняет весь монолит, ffmpeg
 * может не завершиться сам, а stdin рвётся сразу после первого кадра.
 */
export function grabFrame(opts: GrabOptions): Promise<Buffer> {
  const maxBytes = opts.maxBytes ?? MAX_FRAME_BYTES;
  return new Promise<Buffer>((resolve, reject) => {
    let child: FrameChild;
    try {
      child = opts.spawn(opts.ffmpegPath, opts.args);
    } catch (e) {
      reject(new Error(`cannot start ffmpeg: ${(e as Error).message}`));
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    let stderrTail = "";
    let done = false;

    const finish = (err: Error | null, buf?: Buffer) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(buf!);
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error(`ffmpeg did not produce a frame within ${Math.round(opts.timeoutMs / 1000)}s`));
    }, opts.timeoutMs);

    child.stdout?.on("data", (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) {
        child.kill("SIGKILL");
        finish(new Error(`frame is larger than ${maxBytes} bytes — ask for a smaller width`));
        return;
      }
      chunks.push(c);
    });
    // Хвост stderr — единственное, что объясняет пустой ответ ffmpeg.
    child.stderr?.on("data", (c: Buffer) => {
      stderrTail = (stderrTail + c.toString()).slice(-500);
    });

    child.on("error", (e) => finish(new Error(`ffmpeg failed: ${(e as Error)?.message ?? String(e)}`)));
    child.on("exit", (code) => {
      const buf = Buffer.concat(chunks);
      if (buf.length > 0) return finish(null, buf); // кадр получен — код выхода уже неважен
      finish(new Error(`ffmpeg produced no frame${stderrTail ? `: ${stderrTail.trim()}` : ` (exit ${code})`}`));
    });

    const input = opts.input;
    if (input && child.stdin) {
      const stdin = child.stdin;
      // ffmpeg закрывает вход, как только набрал кадр: EPIPE здесь — норма,
      // а не ошибка, и уж точно не повод отклонять готовый результат.
      stdin.on("error", () => {});
      void (async () => {
        try {
          for (const src of input) {
            await new Promise<void>((res, rej) => {
              src.on("error", rej);
              src.on("end", res);
              src.pipe(stdin, { end: false });
            });
          }
          stdin.end();
        } catch (e) {
          if (!done) finish(new Error(`cannot read recording: ${(e as Error).message}`));
        }
      })();
    }
  });
}
