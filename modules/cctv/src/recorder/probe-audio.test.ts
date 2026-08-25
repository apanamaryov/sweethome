import { DEFAULT_RTSP_PATH, type CameraConfig } from "../config";
import { audioProbeArgs, parseAudioSamples } from "./ffmpeg";
import { probeAudio } from "./probe-audio";
import type { ChildLike } from "./process";

const cam: CameraConfig = { id: "drive", name: "drive", host: "10.0.0.9", rtspPath: DEFAULT_RTSP_PATH };

class FakeChild implements ChildLike {
  errCb: ((c: Buffer) => void) | null = null;
  exitCb: ((arg?: unknown) => void) | null = null;
  errorCb: ((arg?: unknown) => void) | null = null;
  killed: NodeJS.Signals | undefined | null = null;
  stderr = {
    on: (_ev: "data", cb: (c: Buffer) => void) => {
      this.errCb = cb;
    },
  };
  on(ev: "exit" | "error", cb: (arg?: unknown) => void): void {
    if (ev === "exit") this.exitCb = cb;
    else this.errorCb = cb;
  }
  kill(sig?: NodeJS.Signals): void {
    this.killed = sig ?? "SIGTERM";
  }
}

/** Управляемые таймеры: проба не должна ждать по-настоящему. */
function fakeTimers() {
  let fire: (() => void) | null = null;
  return {
    timers: {
      setTimeout: (cb: () => void) => {
        fire = cb;
        return 1;
      },
      clearTimeout: () => {
        fire = null;
      },
      now: () => 0,
    },
    expire: () => fire?.(),
  };
}

describe("аргументы пробы", () => {
  it("слушает только звук и ограничен по времени", () => {
    const a = audioProbeArgs(cam, 4);
    expect(a[a.indexOf("-map") + 1]).toBe("0:a?");
    expect(a[a.indexOf("-t") + 1]).toBe("4");
    expect(a).toContain("volumedetect");
    expect(a[a.indexOf("-i") + 1]).toBe("rtsp://10.0.0.9:554/live/ch00_0");
  });
});

describe("parseAudioSamples", () => {
  it("читает число отсчётов из вывода ffmpeg", () => {
    expect(parseAudioSamples("[Parsed_volumedetect_0 @ 0x1] n_samples: 32000")).toBe(32000);
  });

  it("нет строки — считаем, что звука нет", () => {
    expect(parseAudioSamples("Output file is empty")).toBe(0);
  });

  it("ноль отсчётов — это и есть наш случай: дорожка есть, звука нет", () => {
    expect(parseAudioSamples("n_samples: 0")).toBe(0);
  });
});

describe("probeAudio", () => {
  const run = (over: Partial<{ spawn: () => ChildLike }> = {}) => {
    const child = new FakeChild();
    const { timers, expire } = fakeTimers();
    const p = probeAudio({
      cam,
      ffmpegPath: "ffmpeg",
      spawn: over.spawn ?? (() => child),
      timers,
    });
    return { p, child, expire };
  };

  it("отсчёты есть — звук есть", async () => {
    const { p, child } = run();
    child.errCb?.(Buffer.from("n_samples: 32000\nmean_volume: -40.0 dB"));
    child.exitCb?.(0);
    await expect(p).resolves.toBe(true);
  });

  it("отсчётов ноль — звука нет, даже если дорожка объявлена", async () => {
    const { p, child } = run();
    child.errCb?.(Buffer.from("Stream #0:1: Audio: aac, 8000 Hz\nn_samples: 0"));
    child.exitCb?.(0);
    await expect(p).resolves.toBe(false);
  });

  it("молчащую камеру добивает по таймауту, а не ждёт вечно", async () => {
    // Без звуковых пакетов ffmpeg не доходит до -t и читает поток бесконечно.
    const { p, child, expire } = run();
    child.errCb?.(Buffer.from("n_samples: 0"));
    expire();
    await expect(p).resolves.toBe(false);
    expect(child.killed).toBe("SIGKILL");
  });

  it("неудачный запуск ffmpeg — просто «звука нет», без исключения", async () => {
    const { p, child } = run();
    child.errorCb?.(new Error("ENOENT"));
    await expect(p).resolves.toBe(false);
  });
});
