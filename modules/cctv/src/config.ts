import path from "path";
import { envBool, envInt } from "@sweethome/shared";

export interface CameraConfig {
  id: string;
  name: string;
  host: string;
  rtspPath: string;
}

export interface CctvConfig {
  enabled: boolean;
  cameras: CameraConfig[];
  storageDir: string;
  dataDir: string;
  quotaBytes: number;
  segmentSec: number;
  ffmpegPath: string;
  liveIdleSec: number;
  motionEvents: boolean;
  downloadMaxMin: number;
}

/** Путь RTSP у этих камер один и тот же для всех (см. спеку §2.1). */
export const DEFAULT_RTSP_PATH = "live/ch00_0";

/** `drive=192.168.1.93,yard=192.168.1.115` → список камер. Мусор без "=" отбрасывается. */
export function parseCameras(raw: string | undefined): CameraConfig[] {
  if (!raw) return [];
  const out: CameraConfig[] = [];
  for (const part of raw.split(",")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const id = part.slice(0, eq).trim();
    const host = part.slice(eq + 1).trim();
    if (!id || !host) continue;
    out.push({ id, name: id, host, rtspPath: DEFAULT_RTSP_PATH });
  }
  return out;
}

export function loadCctvConfig(rootDataDir: string, env: NodeJS.ProcessEnv = process.env): CctvConfig {
  const prev = process.env;
  process.env = env; // envInt/envBool читают process.env — подменяем на время разбора
  try {
    const cameras = parseCameras(env.CCTV_CAMERAS);
    return {
      enabled: envBool("CCTV_ENABLED", true) && cameras.length > 0,
      cameras,
      storageDir: env.CCTV_STORAGE_DIR || "/mnt/cctv",
      dataDir: path.join(rootDataDir, "cctv"),
      quotaBytes: envInt("CCTV_QUOTA_GB", 500) * 1024 ** 3,
      segmentSec: envInt("CCTV_SEGMENT_SEC", 60),
      ffmpegPath: env.CCTV_FFMPEG || "ffmpeg",
      liveIdleSec: envInt("CCTV_LIVE_IDLE_SEC", 15),
      motionEvents: envBool("CCTV_MOTION_EVENTS", true),
      downloadMaxMin: envInt("CCTV_DOWNLOAD_MAX_MIN", 30),
    };
  } finally {
    process.env = prev;
  }
}
