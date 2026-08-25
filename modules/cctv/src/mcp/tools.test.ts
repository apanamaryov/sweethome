import { Readable } from "stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CameraInfo } from "@sweethome/cctv-shared";
import type { CctvConfig } from "../config";
import { CctvDb } from "../index/db";
import { registerCctvTools, type CctvMcpDeps } from "./tools";
import type { FrameChild } from "./snapshot";

const NOW = new Date(2026, 7, 25, 12, 0, 0).getTime();

const CFG: CctvConfig = {
  enabled: true,
  cameras: [{ id: "drive", name: "Въезд", host: "10.0.0.9", rtspPath: "live/ch00_0" }],
  storageDir: "/store",
  dataDir: "/data/cctv",
  quotaBytes: 500 * 1024 ** 3,
  segmentSec: 60,
  ffmpegPath: "ffmpeg",
  liveIdleSec: 15,
  motionEvents: true,
  downloadMaxMin: 30,
};

const CAMERAS: CameraInfo[] = [
  { id: "drive", name: "Въезд", recording: true, lastSegmentMs: NOW - 30_000, restarts: 2 },
];

/** Поддельный ffmpeg: всегда отдаёт «картинку» и запоминает, чем его звали. */
class FakeChild implements FrameChild {
  static last: FakeChild | null = null;
  static lastArgs: string[] = [];
  written: Buffer[] = [];
  stdout = {
    on: (_ev: "data", cb: (c: Buffer) => void) => setTimeout(() => cb(Buffer.from("JPEG")), 0),
  } as unknown as NodeJS.ReadableStream;
  stderr = { on: () => {} };
  stdin = {
    on: () => {},
    write: (chunk: Buffer, _e: unknown, cb?: () => void) => {
      this.written.push(Buffer.from(chunk));
      cb?.();
      return true;
    },
    end: () => {},
    once: () => {},
    emit: () => false,
    removeListener: () => {},
  } as unknown as NodeJS.WritableStream;
  on(ev: "exit" | "error", cb: (arg?: unknown) => void): void {
    if (ev === "exit") setTimeout(() => cb(0), 1);
  }
  kill(): void {}
  constructor() {
    FakeChild.last = this;
  }
}

async function connect(over: Partial<CctvMcpDeps> = {}) {
  const db = over.db ?? new CctvDb(":memory:");
  const deps: CctvMcpDeps = {
    cfg: CFG,
    db,
    cameras: () => CAMERAS,
    storageAvailable: () => true,
    spawn: (_cmd, args) => {
      FakeChild.lastArgs = args;
      return new FakeChild();
    },
    openRead: (abs) => Readable.from([Buffer.from(`<${abs}>`)]),
    now: () => NOW,
    ...over,
  };
  const server = new McpServer({ name: "test", version: "1" });
  registerCctvTools(server, deps);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return { client, db, deps };
}

/** Запись за интервал: сегменты по минуте подряд. */
function fillRecording(db: CctvDb, fromMs: number, minutes: number): number {
  const initId = db.upsertInit("drive", "drive/init_1.mp4", 800, fromMs);
  for (let i = 0; i < minutes; i++) {
    db.addSegment({
      cam: "drive",
      initId,
      path: `drive/seg_${i}.m4s`,
      startMs: fromMs + i * 60_000,
      durMs: 60_000,
      bytes: 4_000_000,
    });
  }
  return initId;
}

describe("инструменты камер", () => {
  it("cctv_get_cameras показывает, пишется ли камера прямо сейчас", async () => {
    const { client } = await connect();
    const r = await client.callTool({ name: "cctv_get_cameras", arguments: {} });
    const text = String((r.content as Array<{ text: string }>)[0].text);
    expect(text).toContain("drive");
    expect(text).toContain("recording");
    expect(text).toContain("2 restart(s)");
    // Время — местное со сдвигом: ответ читает человек, а дом живёт в своей зоне.
    expect(text).toMatch(/T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}/);
  });

  it("cctv_get_storage считает занятое место и глубину архива", async () => {
    const { client, db } = await connect();
    // Сутки записи по 4 МБ в минуту.
    fillRecording(db, NOW - 86_400_000, 1440);
    const r = await client.callTool({ name: "cctv_get_storage", arguments: {} });
    const out = r.structuredContent as { usedGB: number; depthDays: number | null; available: boolean };
    expect(out.available).toBe(true);
    expect(out.usedGB).toBeCloseTo(5.5, 0);
    expect(out.depthDays).toBeGreaterThan(80); // 500 ГБ при ~5.5 ГБ в сутки
  });

  it("cctv_get_timeline показывает отснятое и дыры между кусками", async () => {
    const { client, db } = await connect();
    fillRecording(db, NOW - 3_600_000, 10); // час назад, 10 минут
    const initId = db.upsertInit("drive", "drive/init_2.mp4", 800, NOW - 1_800_000);
    db.addSegment({
      cam: "drive",
      initId,
      path: "drive/seg_late.m4s",
      startMs: NOW - 1_800_000,
      durMs: 60_000,
      bytes: 4_000_000,
    });

    const r = await client.callTool({ name: "cctv_get_timeline", arguments: { cam: "drive", from: "-2h" } });
    const out = r.structuredContent as {
      recorded: Array<{ minutes: number }>;
      gaps: Array<{ minutes: number }>;
      truncated: boolean;
    };
    expect(out.recorded).toHaveLength(2);
    expect(out.recorded[0].minutes).toBe(10);
    // Дыра между кусками — обычно ровно то, ради чего инструмент и зовут.
    expect(out.gaps).toHaveLength(1);
    expect(out.gaps[0].minutes).toBe(20);
    expect(out.truncated).toBe(false);
  });

  it("незнакомая камера — ошибка со списком известных, а не пустой ответ", async () => {
    const { client } = await connect();
    const r = await client.callTool({ name: "cctv_get_timeline", arguments: { cam: "garage" } });
    expect(r.isError).toBe(true);
    expect(String((r.content as Array<{ text: string }>)[0].text)).toContain("drive");
  });

  it("cctv_snapshot без времени берёт живой кадр и отдаёт картинку", async () => {
    const { client } = await connect();
    const r = await client.callTool({ name: "cctv_snapshot", arguments: { cam: "drive" } });
    const parts = r.content as Array<{ type: string; data?: string; mimeType?: string; text?: string }>;
    const image = parts.find((p) => p.type === "image")!;
    expect(image.mimeType).toBe("image/jpeg");
    expect(Buffer.from(image.data!, "base64").toString()).toBe("JPEG");
    expect(FakeChild.lastArgs).toContain("rtsp://10.0.0.9:554/live/ch00_0");
    // Агент должен знать, что в кадре две линзы, а не одна картинка двора.
    expect(parts.find((p) => p.type === "text")!.text).toMatch(/lenses/i);
  });

  it("cctv_snapshot с временем читает архив и перематывает внутрь сегмента", async () => {
    const { client, db } = await connect();
    const start = NOW - 3_600_000;
    fillRecording(db, start, 10);

    // 90 секунд от начала записи — это второй сегмент, 30 секунд внутрь него.
    const at = start + 90_000;
    const r = await client.callTool({ name: "cctv_snapshot", arguments: { cam: "drive", at } });
    expect(r.isError).toBeFalsy();
    expect(FakeChild.lastArgs[FakeChild.lastArgs.indexOf("-ss") + 1]).toBe("30.000");
    // На вход ушли заголовок потока и сам сегмент — именно в таком порядке.
    expect(Buffer.concat(FakeChild.last!.written).toString()).toBe("</store/drive/init_1.mp4></store/drive/seg_1.m4s>");
  });

  it("кадр из момента без записи — понятная ошибка с подсказкой, чем искать", async () => {
    const { client, db } = await connect();
    fillRecording(db, NOW - 3_600_000, 10);
    const r = await client.callTool({ name: "cctv_snapshot", arguments: { cam: "drive", at: NOW - 7_200_000 } });
    expect(r.isError).toBe(true);
    expect(String((r.content as Array<{ text: string }>)[0].text)).toContain("cctv_get_timeline");
  });

  it("ширину кадра можно попросить больше, но не бесконечную", async () => {
    const { client } = await connect();
    await client.callTool({ name: "cctv_snapshot", arguments: { cam: "drive", width: 1280 } });
    expect(FakeChild.lastArgs[FakeChild.lastArgs.indexOf("-vf") + 1]).toBe("scale=1280:-2");

    const tooBig = await client.callTool({ name: "cctv_snapshot", arguments: { cam: "drive", width: 4000 } });
    expect(tooBig.isError).toBe(true);
  });

  it("ресурс cctv://cameras отдаёт камеры без вызова инструмента", async () => {
    const { client } = await connect();
    const uris = (await client.listResources()).resources.map((r) => r.uri);
    expect(uris).toContain("cctv://cameras");
    const res = await client.readResource({ uri: "cctv://cameras" });
    const body = res.contents[0] as { text: string };
    expect(JSON.parse(body.text)[0].id).toBe("drive");
  });
});
