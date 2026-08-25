import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { localIso, parseTime } from "@sweethome/home-mcp";
import type { CameraInfo } from "@sweethome/cctv-shared";
import type { CctvConfig } from "../config";
import type { CctvDb } from "../index/db";
import { buildSpans, clampSpans } from "../index/spans";
import {
  archiveFrameArgs,
  DEFAULT_FRAME_WIDTH,
  grabFrame,
  liveFrameArgs,
  MAX_FRAME_WIDTH,
  ARCHIVE_TIMEOUT_MS,
  LIVE_TIMEOUT_MS,
  type FrameSpawner,
} from "./snapshot";

/** Что агент должен знать про камеры до первого вызова. */
export const CCTV_INSTRUCTIONS =
  "Cameras: local round-the-clock recording of the yard, read-only — there is nothing to control " +
  "and nothing can be deleted through these tools. Each frame is 1920x2160: two lenses stacked in " +
  "one picture, not two cameras. cctv_snapshot returns an actual image (live, or from the archive " +
  "at a given moment); check cctv_get_timeline first if you need a moment that was recorded. " +
  "Some cameras also record sound (see cctv_get_cameras) — the tools here return frames only, but " +
  "a person watching the pages can listen to it.";

/** Сколько отрезков и меток отдавать максимум — сутки записи это тысячи сегментов. */
const MAX_LISTED = 200;

export interface CctvMcpDeps {
  cfg: CctvConfig;
  db: CctvDb;
  /** Состояние записи — живёт в RecorderManager и появляется только после start(). */
  cameras(): CameraInfo[];
  storageAvailable(): boolean;
  spawn: FrameSpawner;
  openRead(absPath: string): NodeJS.ReadableStream;
  now?: () => number;
}

const gb = (bytes: number): number => Math.round((bytes / 1024 ** 3) * 10) / 10;

/** Исключение в ответ isError, а не в обрыв протокола (как в инструментах инвертора). */
async function guard(
  fn: () => Promise<{ structuredContent: Record<string, unknown>; text: string }>
): Promise<CallToolResult> {
  try {
    const { structuredContent, text } = await fn();
    return { content: [{ type: "text", text }], structuredContent };
  } catch (e) {
    return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true };
  }
}

export function registerCctvTools(server: McpServer, deps: CctvMcpDeps): void {
  const { cfg, db } = deps;
  const now = deps.now ?? (() => Date.now());
  const known = new Set(cfg.cameras.map((c) => c.id));
  const requireCam = (cam: string): void => {
    if (!known.has(cam)) {
      throw new Error(`unknown camera "${cam}"; known cameras: ${[...known].join(", ") || "none"}`);
    }
  };

  server.registerTool(
    "cctv_get_cameras",
    {
      title: "Cameras",
      description:
        "Cameras and whether each is recording right now, when its last recorded segment started, " +
        "how many times its recorder restarted and the last error if there was one.",
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async () =>
      guard(async () => {
        const cams = deps.cameras();
        const rows = cams.map((c) => ({
          ...c,
          lastSegment: c.lastSegmentMs === null ? null : localIso(c.lastSegmentMs),
        }));
        const text = cams.length
          ? cams
              .map(
                (c) =>
                  `${c.id} (${c.name}): ${c.recording ? "recording" : "NOT recording"}` +
                  `${c.lastSegmentMs ? `, last segment ${localIso(c.lastSegmentMs)}` : ", nothing recorded yet"}` +
                  `${c.hasAudio ? ", records sound" : ", no sound"}` +
                  `${c.restarts ? `, ${c.restarts} restart(s)` : ""}${c.lastError ? `, last error: ${c.lastError}` : ""}`
              )
              .join("\n")
          : "No cameras configured.";
        return { structuredContent: { cameras: rows }, text };
      })
  );

  server.registerTool(
    "cctv_get_storage",
    {
      title: "Recording storage",
      description:
        "How much of the storage quota the recordings take, how far back the archive reaches and " +
        "whether the storage is mounted at all.",
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async () =>
      guard(async () => {
        const t = db.totals();
        const spanMs = t.oldestMs !== null && t.newestMs !== null ? t.newestMs - t.oldestMs : 0;
        const perDay = spanMs > 0 ? (t.bytes / spanMs) * 86_400_000 : 0;
        const depthDays = perDay > 0 ? Math.round(cfg.quotaBytes / perDay) : null;
        const available = deps.storageAvailable();
        const out = {
          available,
          usedGB: gb(t.bytes),
          quotaGB: gb(cfg.quotaBytes),
          usedPercent: cfg.quotaBytes > 0 ? Math.round((t.bytes / cfg.quotaBytes) * 100) : 0,
          segments: t.count,
          depthDays,
          oldest: t.oldestMs === null ? null : localIso(t.oldestMs),
          newest: t.newestMs === null ? null : localIso(t.newestMs),
        };
        const text = available
          ? `${out.usedGB} of ${out.quotaGB} GB used (${out.usedPercent}%)` +
            `${depthDays ? `, about ${depthDays} days fit in the quota` : ""}` +
            `${out.oldest ? `; archive from ${out.oldest} to ${out.newest}` : "; archive is empty"}`
          : "Storage is not available — recording is stopped until the mount is back.";
        return { structuredContent: out, text };
      })
  );

  server.registerTool(
    "cctv_get_timeline",
    {
      title: "What was recorded",
      description:
        "Continuous stretches of recording for one camera over a period, the gaps between them and " +
        "any motion marks. Use it to find a moment worth looking at before calling cctv_snapshot.",
      inputSchema: {
        cam: z.string().describe("Camera id, as returned by cctv_get_cameras"),
        from: z
          .union([z.string(), z.number()])
          .optional()
          .describe('Start: unix ms, ISO 8601, "now" or an offset like "-24h"; defaults to 24h ago'),
        to: z.union([z.string(), z.number()]).optional().describe('End; defaults to "now"'),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ cam, from, to }) =>
      guard(async () => {
        requireCam(cam);
        const nowMs = now();
        const toMs = to === undefined ? nowMs : parseTime(to, nowMs);
        const fromMs = from === undefined ? toMs - 86_400_000 : parseTime(from, nowMs);
        if (toMs <= fromMs) throw new Error("`from` must be earlier than `to`");

        const segs = db.segmentsBetween(cam, fromMs, toMs);
        const spans = clampSpans(buildSpans(segs), fromMs, toMs);
        const marks = db.motionBetween(cam, fromMs, toMs);

        // Дыры между отрезками — то, ради чего этот инструмент обычно и зовут.
        const gaps: Array<{ from: string; to: string; minutes: number }> = [];
        for (let i = 1; i < spans.length; i++) {
          const gapMs = spans[i].startMs - spans[i - 1].endMs;
          gaps.push({
            from: localIso(spans[i - 1].endMs),
            to: localIso(spans[i].startMs),
            minutes: Math.round(gapMs / 60_000),
          });
        }

        const bytes = segs.reduce((sum, s) => sum + s.bytes, 0);
        const out = {
          cam,
          from: localIso(fromMs),
          to: localIso(toMs),
          segments: segs.length,
          sizeGB: gb(bytes),
          recorded: spans.slice(0, MAX_LISTED).map((s) => ({
            from: localIso(s.startMs),
            to: localIso(s.endMs),
            minutes: Math.round((s.endMs - s.startMs) / 60_000),
          })),
          gaps: gaps.slice(0, MAX_LISTED),
          motionMarks: marks.slice(0, MAX_LISTED).map((m) => ({ at: localIso(m.tsMs), kind: m.kind })),
          // Молча урезанный список читается как «это всё» — говорим прямо.
          truncated: spans.length > MAX_LISTED || gaps.length > MAX_LISTED || marks.length > MAX_LISTED,
        };

        const text = spans.length
          ? `${cam}: ${spans.length} stretch(es) recorded between ${out.from} and ${out.to}, ` +
            `${gaps.length} gap(s), ${marks.length} motion mark(s), ${out.sizeGB} GB.`
          : `${cam}: nothing recorded between ${out.from} and ${out.to}.`;
        return { structuredContent: out, text };
      })
  );

  server.registerTool(
    "cctv_snapshot",
    {
      title: "Camera frame",
      description:
        "A picture from a camera: the live view when `at` is omitted, or the recorded frame at that " +
        "moment. One frame holds both lenses (top and bottom halves of the image). " +
        "The picture is scaled down before sending; ask for a bigger `width` only when detail matters.",
      inputSchema: {
        cam: z.string().describe("Camera id, as returned by cctv_get_cameras"),
        at: z
          .union([z.string(), z.number()])
          .optional()
          .describe('Moment in the archive: unix ms, ISO 8601 or an offset like "-30m"; live when omitted'),
        width: z
          .number()
          .int()
          .min(160)
          .max(MAX_FRAME_WIDTH)
          .optional()
          .describe(`Picture width in pixels (default ${DEFAULT_FRAME_WIDTH}, max ${MAX_FRAME_WIDTH})`),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ cam, at, width }) => {
      try {
        requireCam(cam);
        const camCfg = cfg.cameras.find((c) => c.id === cam)!;
        const w = width ?? DEFAULT_FRAME_WIDTH;
        const nowMs = now();

        let frame: Buffer;
        let takenAt: string;

        if (at === undefined) {
          frame = await grabFrame({
            spawn: deps.spawn,
            ffmpegPath: cfg.ffmpegPath,
            args: liveFrameArgs(camCfg, w),
            timeoutMs: LIVE_TIMEOUT_MS,
          });
          takenAt = `${localIso(nowMs)} (live)`;
        } else {
          const tsMs = parseTime(at, nowMs);
          // Сегмент, внутри которого лежит запрошенный момент.
          const seg = db.segmentsBetween(cam, tsMs, tsMs + 1)[0];
          if (!seg) {
            throw new Error(
              `nothing recorded for "${cam}" at ${localIso(tsMs)} — call cctv_get_timeline to find a moment that was`
            );
          }
          const init = db.initPathById(seg.initId);
          if (!init) throw new Error("index inconsistency: the stream header of that recording is missing");

          const offsetSec = Math.max(0, (tsMs - seg.startMs) / 1000);
          frame = await grabFrame({
            spawn: deps.spawn,
            ffmpegPath: cfg.ffmpegPath,
            args: archiveFrameArgs(offsetSec, w),
            input: [
              deps.openRead(`${cfg.storageDir}/${init.path}`),
              deps.openRead(`${cfg.storageDir}/${seg.path}`),
            ],
            timeoutMs: ARCHIVE_TIMEOUT_MS,
          });
          takenAt = localIso(tsMs);
        }

        return {
          content: [
            { type: "text", text: `${cam} — ${takenAt}; both lenses in one frame (top and bottom).` },
            { type: "image", data: frame.toString("base64"), mimeType: "image/jpeg" },
          ],
        };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  server.registerResource(
    "cameras",
    "cctv://cameras",
    { title: "Cameras", description: "Cameras and their recording state", mimeType: "application/json" },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(deps.cameras(), null, 2) }],
    })
  );
}
