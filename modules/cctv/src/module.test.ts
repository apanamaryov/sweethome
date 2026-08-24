import request from "supertest";
import express from "express";
import { createCctvModule } from "./module";
import { CctvDb } from "./index/db";
import { loadCctvConfig } from "./config";
import type { ChildLike } from "./recorder/process";

class FakeChild implements ChildLike {
  stderr = { on: () => {} };
  stdout = { on: () => {} };
  killed = false;
  private exitCb: ((code: number | null) => void) | null = null;
  on(_ev: "exit", cb: (code: number | null) => void): void {
    this.exitCb = cb;
  }
  kill(): void {
    this.killed = true;
    this.exitCb?.(null);
  }
}

const noopTimers = {
  setTimeout: () => 0 as unknown,
  clearTimeout: () => {},
  now: () => 0,
};

const fakeFs = {
  async readFile() {
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  },
  async stat() {
    return { size: 0 };
  },
  async readdir() {
    return [] as string[];
  },
  async unlink() {},
  async mkdir() {
    return undefined;
  },
  async access() {},
};

function build(env: NodeJS.ProcessEnv, probeOk = true) {
  const db = new CctvDb(":memory:");
  const mod = createCctvModule("/data", {
    cfg: loadCctvConfig("/data", env),
    db,
    spawn: () => new FakeChild(),
    liveSpawn: () => new FakeChild(),
    timers: noopTimers,
    fs: fakeFs,
    probe: async () => (probeOk ? { ok: true, version: "7.0.2" } : { ok: false, error: "ENOENT" }),
  });
  return { mod, db };
}

describe("createCctvModule", () => {
  it("имеет id cctv и роутер", () => {
    const { mod, db } = build({ CCTV_CAMERAS: "drive=10.0.0.1" });
    expect(mod.id).toBe("cctv");
    expect(mod.apiRouter).toBeDefined();
    expect(mod.ws).toBeDefined();
    db.close();
  });

  it("выключенный модуль стартует и говорит об этом в health", async () => {
    const { mod, db } = build({ CCTV_CAMERAS: "" });
    await mod.start();
    const h = mod.health();
    expect(h.ok).toBe(true);
    expect(h.details).toMatchObject({ enabled: false });
    await mod.stop();
    db.close();
  });

  it("без ffmpeg модуль не падает, но health не ok", async () => {
    const { mod, db } = build({ CCTV_CAMERAS: "drive=10.0.0.1" }, false);
    await mod.start();
    const h = mod.health();
    expect(h.ok).toBe(false);
    expect(JSON.stringify(h.details)).toContain("ffmpeg");
    await mod.stop();
    db.close();
  });

  it("с камерами и ffmpeg health ok и перечисляет камеры", async () => {
    const { mod, db } = build({ CCTV_CAMERAS: "drive=10.0.0.1,yard=10.0.0.2" });
    await mod.start();
    const h = mod.health();
    expect(h.ok).toBe(true);
    expect(h.details).toMatchObject({ enabled: true, ffmpeg: "7.0.2" });
    expect((h.details as { cameras: unknown[] }).cameras).toHaveLength(2);
    await mod.stop();
    db.close();
  });

  it("роутер модуля отвечает на /cameras", async () => {
    const { mod, db } = build({ CCTV_CAMERAS: "drive=10.0.0.1" });
    await mod.start();
    const a = express();
    a.use("/api/cctv", mod.apiRouter);
    const res = await request(a).get("/api/cctv/cameras").expect(200);
    expect(res.body.cameras[0].id).toBe("drive");
    await mod.stop();
    db.close();
  });

  it("stop() дважды не падает", async () => {
    const { mod, db } = build({ CCTV_CAMERAS: "drive=10.0.0.1" });
    await mod.start();
    await mod.stop();
    await mod.stop();
    db.close();
  });

  it("WS: подписка на камеру и отключение не бросают исключений", async () => {
    const { mod, db } = build({ CCTV_CAMERAS: "drive=10.0.0.1" });
    await mod.start();

    const sent: unknown[] = [];
    let closeCb: (() => void) | null = null;
    let msgCb: ((data: unknown) => void) | null = null;
    const ws = {
      readyState: 1,
      send: (d: unknown) => sent.push(d),
      on(ev: string, cb: (arg?: unknown) => void) {
        if (ev === "close") closeCb = cb as () => void;
        if (ev === "message") msgCb = cb;
      },
    };

    mod.ws!.onConnection(ws as never);
    msgCb!(Buffer.from(JSON.stringify({ type: "subscribe", cam: "drive" })));
    expect(sent.length).toBeGreaterThan(0);

    msgCb!(Buffer.from("не json"));      // мусор не должен ронять соединение
    msgCb!(Buffer.from(JSON.stringify({ type: "unsubscribe", cam: "drive" })));
    closeCb!();

    await mod.stop();
    db.close();
  });
});
