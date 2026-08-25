import { DEFAULT_RTSP_PATH, type CameraConfig } from "../config";
import { initFileName, liveArgs, probeFfmpeg, recordArgs, rtspUrl } from "./ffmpeg";

const cam: CameraConfig = { id: "drive", name: "drive", host: "192.168.1.93", rtspPath: DEFAULT_RTSP_PATH };

describe("rtspUrl", () => {
  it("собирает адрес потока", () => {
    expect(rtspUrl(cam)).toBe("rtsp://192.168.1.93:554/live/ch00_0");
  });
});

describe("recordArgs", () => {
  const args = recordArgs({ cam, camDir: "/mnt/cctv/drive", segmentSec: 60, runId: "run1" });
  const joined = args.join(" ");

  it("тянет поток по TCP: по UDP эти камеры не отдают поток", () => {
    expect(joined).toContain("-rtsp_transport tcp");
  });

  it("подставляет свои временные метки: камера их не проставляет", () => {
    expect(joined).toContain("-use_wallclock_as_timestamps 1");
  });

  it("копирует поток без перекодирования", () => {
    expect(joined).toContain("-c copy");
    expect(joined).not.toContain("libx264");
  });

  it("звук в записи — тоже по флагу, а не всегда", () => {
    // Та же причина, что и в живом просмотре: пустая дорожка задерживает старт
    // записи на десяток секунд, а после перезапуска это потерянное время.
    expect(joined).toContain("-an");
    const withAudio = recordArgs({ cam, camDir: "/d", segmentSec: 60, runId: "r", withAudio: true });
    expect(withAudio.join(" ")).not.toContain("-an");
  });

  it("режет на фрагментированный MP4 нужной длины", () => {
    expect(joined).toContain("-f hls");
    expect(args[args.indexOf("-hls_time") + 1]).toBe("60");
    expect(joined).toContain("-hls_segment_type fmp4");
    expect(joined).toContain("-hls_list_size 0");
  });

  it("даёт init-сегменту уникальное имя на запуск", () => {
    expect(joined).toContain("-hls_fmp4_init_filename init_run1.mp4");
    expect(initFileName("run1")).toBe("init_run1.mp4");
  });

  it("ставит флаги, без которых индекс не собрать", () => {
    const flags = args[args.indexOf("-hls_flags") + 1];
    expect(flags.split("+")).toEqual(
      expect.arrayContaining(["append_list", "program_date_time", "independent_segments", "temp_file"])
    );
  });

  it("кладёт сегменты и плейлист в каталог камеры", () => {
    expect(joined).toContain("-hls_segment_filename /mnt/cctv/drive/seg_%Y%m%d_%H%M%S.m4s");
    expect(joined).toContain("-strftime 1");
    expect(args[args.length - 1]).toBe("/mnt/cctv/drive/live.m3u8");
  });

  it("адрес камеры идёт как вход", () => {
    expect(args[args.indexOf("-i") + 1]).toBe("rtsp://192.168.1.93:554/live/ch00_0");
  });

  it("учитывает нестандартную длину сегмента", () => {
    const a = recordArgs({ cam, camDir: "/d", segmentSec: 30, runId: "r" });
    expect(a[a.indexOf("-hls_time") + 1]).toBe("30");
  });
});

describe("liveArgs", () => {
  const args = liveArgs({ cam });
  const joined = args.join(" ");

  it("отдаёт поток в stdout", () => {
    expect(args[args.length - 1]).toBe("pipe:1");
  });

  it("нарезает фрагменты чаще, чем идят опорные кадры (иначе задержка ~3 с)", () => {
    expect(args[args.indexOf("-frag_duration") + 1]).toBe("500000");
  });

  it("ставит флаги, без которых браузер не соберёт поток", () => {
    const flags = args[args.indexOf("-movflags") + 1];
    expect(flags.split("+").filter(Boolean)).toEqual(
      expect.arrayContaining(["frag_keyframe", "empty_moov", "default_base_moof"])
    );
  });

  it("по умолчанию звук выброшен, и берётся только по явному флагу", () => {
    // Объявленная камерой дорожка ничего не значит: наши камеры объявляют AAC и
    // молчат в неё, а ffmpeg ждёт этот звук перед первой выдачей — 12 секунд
    // против 2.7 (измерено на малине). Поэтому звук включается только когда
    // проба подтвердила, что он реально идёт.
    expect(joined).toContain("-an");
    expect(joined).toContain("-c copy");
    expect(liveArgs({ cam, withAudio: true }).join(" ")).not.toContain("-an");
  });

  it("длину фрагмента можно переопределить", () => {
    const a = liveArgs({ cam, fragMs: 1000 });
    expect(a[a.indexOf("-frag_duration") + 1]).toBe("1000000");
  });
});

describe("probeFfmpeg", () => {
  it("сообщает версию, когда бинарник на месте", async () => {
    const exec = async () => ({ code: 0, stdout: "ffmpeg version 7.0.2 Copyright (c)\n" });
    expect(await probeFfmpeg("ffmpeg", exec)).toEqual({ ok: true, version: "7.0.2" });
  });

  it("сообщает об отсутствии бинарника", async () => {
    const exec = async () => {
      throw Object.assign(new Error("spawn ffmpeg ENOENT"), { code: "ENOENT" });
    };
    const r = await probeFfmpeg("ffmpeg", exec);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("ENOENT");
  });

  it("считает провалом непонятный вывод", async () => {
    const exec = async () => ({ code: 0, stdout: "not ffmpeg at all" });
    expect((await probeFfmpeg("ffmpeg", exec)).ok).toBe(false);
  });

  it("считает провалом ненулевой код возврата", async () => {
    const exec = async () => ({ code: 127, stdout: "" });
    expect((await probeFfmpeg("ffmpeg", exec)).ok).toBe(false);
  });
});
