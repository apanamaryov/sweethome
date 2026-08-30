import { EventEmitter } from "events";
import { WebSocket } from "ws";
import type { DryerSnapshot } from "@sweethome/dryer-shared";
import { loadDryerConfig } from "./config";
import { createDryerModule } from "./module";
import { DryerStore } from "./store";
import { FakeTimers } from "./testing/fake-timers";

class FakeWs extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  frames: DryerSnapshot[] = [];
  send(data: string): void {
    this.frames.push(JSON.parse(data));
  }
}

function make(env: NodeJS.ProcessEnv = {}) {
  const timers = new FakeTimers();
  timers.now = Date.UTC(2026, 7, 30, 12, 0, 0);
  const store = new DryerStore(":memory:");
  const cfg = loadDryerConfig("/data", { DRYER_TRANSPORT: "mock", DRYER_TICK_MS: "10000", ...env });
  const mod = createDryerModule("/data", { cfg, store, timers, now: () => timers.now });
  return { mod, timers, store };
}

describe("createDryerModule", () => {
  it("id, роутер, mcp и ws на месте", () => {
    const { mod } = make();
    expect(mod.id).toBe("dryer");
    expect(mod.apiRouter).toBeDefined();
    expect(typeof mod.mcp.register).toBe("function");
    expect(mod.ws).toBeDefined();
  });

  it("WS: первый кадр сразу, дальше по тику; после close кадры не идут", async () => {
    const { mod, timers } = make();
    await mod.start();
    const ws = new FakeWs();
    mod.ws!.onConnection(ws as unknown as WebSocket);
    expect(ws.frames).toHaveLength(1);
    expect(ws.frames[0]).toMatchObject({ node: { state: "idle", online: true }, run: null });
    await timers.advance(20_000);
    expect(ws.frames).toHaveLength(3);
    ws.emit("close");
    await timers.advance(10_000);
    expect(ws.frames).toHaveLength(3);
    await mod.stop();
  });

  it("health: выключенный модуль — ok с enabled:false; включённый — детали от Dryer", async () => {
    const off = make({ DRYER_ENABLED: "false" });
    await off.mod.start();
    expect(off.mod.health()).toEqual({ ok: true, details: { enabled: false } });
    const on = make();
    await on.mod.start();
    expect(on.mod.health()).toMatchObject({ ok: true, details: { enabled: true, transport: "mock", nodeOnline: true } });
    await on.mod.stop();
  });

  it("повторный start() без stop() игнорируется; start после stop работает", async () => {
    const { mod, store } = make();
    await mod.start();
    await mod.start();
    await mod.stop();
    await mod.start();
    expect(store.listPresets()).toHaveLength(30);
    await mod.stop();
  });
});
