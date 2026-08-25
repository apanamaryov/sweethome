import type { CameraConfig } from "../config";
import { audioProbeArgs, parseAudioSamples } from "./ffmpeg";
import type { ChildLike, Spawner, Timers } from "./process";

/** Проба не должна висеть вечно: без звуковых пакетов ffmpeg сам не закончит. */
export const PROBE_SECONDS = 4;
export const PROBE_TIMEOUT_MS = 15_000;

export interface ProbeAudioDeps {
  cam: CameraConfig;
  ffmpegPath: string;
  spawn: Spawner;
  timers: Timers;
  seconds?: number;
  timeoutMs?: number;
}

/**
 * Шлёт ли камера звук на самом деле.
 *
 * Спрашивать об этом сам поток бесполезно: наши камеры объявляют дорожку AAC и
 * молчат в неё. Поэтому слушаем несколько секунд и считаем отсчёты. Ответ важен
 * дважды: без него зритель включает звук и не слышит ничего, а ещё пустая
 * дорожка задерживает первую выдачу видео на десяток секунд (измерено).
 */
export function probeAudio(deps: ProbeAudioDeps): Promise<boolean> {
  const seconds = deps.seconds ?? PROBE_SECONDS;
  const timeoutMs = deps.timeoutMs ?? PROBE_TIMEOUT_MS;

  return new Promise<boolean>((resolve) => {
    let child: ChildLike;
    let done = false;
    let stderr = "";

    const finish = (result: boolean) => {
      if (done) return;
      done = true;
      deps.timers.clearTimeout(timer);
      resolve(result);
    };

    // Без звуковых пакетов ffmpeg может не дойти до -t и читать поток вечно.
    const timer = deps.timers.setTimeout(() => {
      child?.kill("SIGKILL");
      finish(parseAudioSamples(stderr) > 0);
    }, timeoutMs);

    try {
      child = deps.spawn(deps.ffmpegPath, audioProbeArgs(deps.cam, seconds));
    } catch {
      finish(false); // нет бинарника — считаем, что звука нет; молча и быстро
      return;
    }

    child.stderr?.on("data", (c: Buffer) => {
      stderr += c.toString();
    });
    // Неудачный спавн шлёт "error" без "exit" — без этого обработчика он стал бы
    // необработанным исключением и уронил бы весь монолит.
    child.on("error", () => finish(false));
    child.on("exit", () => finish(parseAudioSamples(stderr) > 0));
  });
}
