import path from "path";
import { loadCctvConfig } from "./config";

const base = { CCTV_CAMERAS: "" } as NodeJS.ProcessEnv;

describe("loadCctvConfig", () => {
  it("выключен, когда камеры не заданы", () => {
    const cfg = loadCctvConfig("/data", { ...base });
    expect(cfg.cameras).toEqual([]);
    expect(cfg.enabled).toBe(false);
  });

  it("разбирает список камер id=host", () => {
    const cfg = loadCctvConfig("/data", { CCTV_CAMERAS: "drive=192.168.1.93,yard=192.168.1.115" });
    expect(cfg.cameras).toEqual([
      { id: "drive", name: "drive", host: "192.168.1.93", rtspPath: "live/ch00_0" },
      { id: "yard", name: "yard", host: "192.168.1.115", rtspPath: "live/ch00_0" },
    ]);
    expect(cfg.enabled).toBe(true);
  });

  it("терпит пробелы и пустые элементы, отбрасывает мусор без '='", () => {
    const cfg = loadCctvConfig("/data", { CCTV_CAMERAS: " drive = 192.168.1.93 , , broken ," });
    expect(cfg.cameras).toEqual([
      { id: "drive", name: "drive", host: "192.168.1.93", rtspPath: "live/ch00_0" },
    ]);
  });

  it("CCTV_ENABLED=false выключает модуль даже при заданных камерах", () => {
    const cfg = loadCctvConfig("/data", { CCTV_CAMERAS: "drive=192.168.1.93", CCTV_ENABLED: "false" });
    expect(cfg.enabled).toBe(false);
    expect(cfg.cameras).toHaveLength(1);
  });

  it("значения по умолчанию соответствуют спеке", () => {
    const cfg = loadCctvConfig("/data", { ...base });
    expect(cfg.storageDir).toBe("/mnt/cctv");
    expect(cfg.quotaBytes).toBe(500 * 1024 ** 3);
    expect(cfg.segmentSec).toBe(60);
    expect(cfg.ffmpegPath).toBe("ffmpeg");
    expect(cfg.liveIdleSec).toBe(15);
    expect(cfg.motionEvents).toBe(true);
    expect(cfg.downloadMaxMin).toBe(30);
    expect(cfg.dataDir).toBe(path.join("/data", "cctv"));
  });

  it("переопределения из env применяются", () => {
    const cfg = loadCctvConfig("/data", {
      CCTV_CAMERAS: "a=1.2.3.4",
      CCTV_STORAGE_DIR: "/srv/video",
      CCTV_QUOTA_GB: "100",
      CCTV_SEGMENT_SEC: "30",
      CCTV_FFMPEG: "/usr/local/bin/ffmpeg",
      CCTV_LIVE_IDLE_SEC: "5",
      CCTV_MOTION_EVENTS: "false",
      CCTV_DOWNLOAD_MAX_MIN: "10",
    });
    expect(cfg.storageDir).toBe("/srv/video");
    expect(cfg.quotaBytes).toBe(100 * 1024 ** 3);
    expect(cfg.segmentSec).toBe(30);
    expect(cfg.ffmpegPath).toBe("/usr/local/bin/ffmpeg");
    expect(cfg.liveIdleSec).toBe(5);
    expect(cfg.motionEvents).toBe(false);
    expect(cfg.downloadMaxMin).toBe(10);
  });
});
