import express from "express";
import type { HomeModule } from "@sweethome/shared/module";
import { ModuleHost } from "./host";

const fakeModule = (id: string, over: Partial<HomeModule> = {}): HomeModule => ({
  id,
  apiRouter: express.Router(),
  start: async () => {},
  stop: async () => {},
  health: () => ({ ok: true }),
  ...over,
});

describe("ModuleHost", () => {
  it("starts all modules and aggregates health", async () => {
    const host = new ModuleHost([fakeModule("a"), fakeModule("b")]);
    await host.startAll();
    expect(host.health()).toEqual({ ok: true, modules: { a: { ok: true }, b: { ok: true } } });
  });

  it("isolates a start() failure: the process keeps other modules alive and health reports it", async () => {
    const boom = fakeModule("boom", { start: async () => { throw new Error("no serial"); } });
    let bStarted = false;
    const host = new ModuleHost([boom, fakeModule("b", { start: async () => { bStarted = true; } })]);
    await host.startAll(); // не бросает
    expect(bStarted).toBe(true);
    const h = host.health();
    expect(h.ok).toBe(false);
    expect(h.modules.boom).toEqual({ ok: false, details: { error: "no serial" } });
    expect(h.modules.b.ok).toBe(true);
  });

  it("stopAll survives a throwing stop()", async () => {
    const host = new ModuleHost([
      fakeModule("bad", { stop: async () => { throw new Error("x"); } }),
      fakeModule("ok"),
    ]);
    await expect(host.stopAll()).resolves.toBeUndefined();
  });
});
