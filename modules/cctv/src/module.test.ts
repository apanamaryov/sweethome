import request from "supertest";
import express from "express";
import { createCctvModule } from "./module";
import { CctvDb } from "./index/db";
import { loadCctvConfig } from "./config";
import type { ChildLike } from "./recorder/process";
import type { LiveChild } from "./live/hub";

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

/**
 * Отдельная заглушка для живого просмотра (не для записи): у LiveChild, в
 * отличие от ChildLike, есть событие "error" — неудачный спавн ffmpeg обычно
 * шлёт только его, без "exit". Два отдельных callback'а, а не общий: реальный
 * child_process тоже не подменяет один слушатель другим.
 */
class FakeLiveChild implements LiveChild {
  stdout = { on: () => {} };
  killed = false;
  private exitCb: ((arg?: unknown) => void) | null = null;
  private errorCb: ((arg?: unknown) => void) | null = null;
  on(ev: "exit" | "error", cb: (arg?: unknown) => void): void {
    if (ev === "exit") this.exitCb = cb;
    else this.errorCb = cb;
  }
  kill(): void {
    this.killed = true;
    this.exitCb?.(null);
  }
  /** Неудачный спавн: только "error", без "exit" — как у настоящего ENOENT. */
  triggerError(err: unknown): void {
    this.errorCb?.(err);
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

/** Минимальная поддельная WS-сессия для новых тестов ниже — не трогает существующие. */
function fakeWs() {
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
  return {
    ws,
    sent,
    message: (m: unknown) => msgCb!(Buffer.from(JSON.stringify(m))),
    raw: (buf: Buffer) => msgCb!(buf),
    close: () => closeCb!(),
  };
}

function build(env: NodeJS.ProcessEnv, probeOk = true) {
  const db = new CctvDb(":memory:");
  const mod = createCctvModule("/data", {
    cfg: loadCctvConfig("/data", env),
    db,
    spawn: () => new FakeChild(),
    liveSpawn: () => new FakeLiveChild(),
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

  it("без ffmpeg подписка по WS не создаёт процесс живого просмотра", async () => {
    const db = new CctvDb(":memory:");
    let liveSpawnCalls = 0;
    const mod = createCctvModule("/data", {
      cfg: loadCctvConfig("/data", { CCTV_CAMERAS: "drive=10.0.0.1" }),
      db,
      spawn: () => new FakeChild(),
      liveSpawn: () => {
        liveSpawnCalls++;
        return new FakeLiveChild();
      },
      timers: noopTimers,
      fs: fakeFs,
      probe: async () => ({ ok: false, error: "ENOENT" }), // ffmpeg недоступен
    });
    await mod.start();

    const { ws, sent, message } = fakeWs();
    mod.ws!.onConnection(ws as never);
    message({ type: "subscribe", cam: "drive" });

    expect(liveSpawnCalls).toBe(0); // не пытались спавнить заведомо несуществующий процесс
    expect(sent.length).toBeGreaterThan(0);
    expect(JSON.parse(sent[0] as string)).toMatchObject({ type: "error" });

    await mod.stop();
    db.close();
  });

  it("неудачный запуск живого потока не оставляет мёртвую сессию", async () => {
    const db = new CctvDb(":memory:");
    const children: FakeLiveChild[] = [];
    const mod = createCctvModule("/data", {
      cfg: loadCctvConfig("/data", { CCTV_CAMERAS: "drive=10.0.0.1" }),
      db,
      spawn: () => new FakeChild(),
      liveSpawn: () => {
        const c = new FakeLiveChild();
        children.push(c);
        return c;
      },
      timers: noopTimers,
      fs: fakeFs,
      probe: async () => ({ ok: true, version: "7.0.2" }),
    });
    await mod.start();

    const { ws, sent, message } = fakeWs();
    mod.ws!.onConnection(ws as never);

    message({ type: "subscribe", cam: "drive" });
    expect(children).toHaveLength(1);

    // Неудачный спавн (ENOENT и т.п.): "exit" в этом случае обычно не приходит вовсе.
    children[0].triggerError(new Error("ENOENT"));

    const messages = sent.map((s) => JSON.parse(s as string));
    expect(messages.some((m) => m.type === "error")).toBe(true);

    // Новая подписка не переиспользует мёртвую сессию — запускает процесс заново.
    message({ type: "subscribe", cam: "drive" });
    expect(children).toHaveLength(2);

    await mod.stop();
    db.close();
  });

  it("null и не-объектный JSON по WS не роняют обработчик", async () => {
    const { mod, db } = build({ CCTV_CAMERAS: "drive=10.0.0.1" });
    await mod.start();

    const { ws, raw } = fakeWs();
    mod.ws!.onConnection(ws as never);

    expect(() => raw(Buffer.from("null"))).not.toThrow();
    expect(() => raw(Buffer.from("42"))).not.toThrow();
    expect(() => raw(Buffer.from('"just a string"'))).not.toThrow();

    await mod.stop();
    db.close();
  });

  it("повторный start() не создаёт второй набор процессов записи", async () => {
    const db = new CctvDb(":memory:");
    let spawnCalls = 0;
    const mod = createCctvModule("/data", {
      cfg: loadCctvConfig("/data", { CCTV_CAMERAS: "drive=10.0.0.1" }),
      db,
      spawn: () => {
        spawnCalls++;
        return new FakeChild();
      },
      liveSpawn: () => new FakeLiveChild(),
      timers: noopTimers,
      fs: fakeFs,
      probe: async () => ({ ok: true, version: "7.0.2" }),
    });

    await mod.start();
    expect(spawnCalls).toBe(1);

    await mod.start(); // повторный вызов без stop() — должен быть no-op
    expect(spawnCalls).toBe(1);

    await mod.stop();
    db.close();
  });
});
