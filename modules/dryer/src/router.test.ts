import express from "express";
import request from "supertest";
import type { Role, TokenScope } from "@sweethome/shared";
import "@sweethome/shared/module";
import { loadDryerConfig } from "./config";
import { Dryer } from "./dryer";
import { MockNodeLink } from "./node/mock";
import { createDryerRouter } from "./router";
import { RunError } from "./runs";
import { DryerStore } from "./store";
import { FakeTimers } from "./testing/fake-timers";

type Who = { role: Role; kind: "session" | "token"; scopes: TokenScope[] };
const ADMIN: Who = { role: "admin", kind: "session", scopes: ["read", "write"] };
const VIEWER: Who = { role: "viewer", kind: "session", scopes: ["read", "write"] };
const RO_TOKEN: Who = { role: "admin", kind: "token", scopes: ["read"] };

function make(who: Who = ADMIN, over: { dryer?: Dryer } = {}) {
  const timers = new FakeTimers();
  timers.now = Date.UTC(2026, 7, 30, 12, 0, 0);
  const now = () => timers.now;
  const store = new DryerStore(":memory:");
  store.seedPresetsIfEmpty();
  const link = new MockNodeLink({ now, timers, excessTauMs: 60_000 });
  const cfg = loadDryerConfig("/data", { DRYER_TRANSPORT: "mock" });
  const dryer = over.dryer ?? new Dryer({ cfg, store, link, timers, now, log: () => {} });
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    req.user = { userId: 1, username: who.role === "admin" ? "alex" : "guest", role: who.role, mustChangePassword: false, expiresAt: 0 };
    req.auth = { kind: who.kind, scopes: who.scopes, tokenName: who.kind === "token" ? "laptop" : undefined };
    next();
  });
  a.use("/api/dryer", createDryerRouter({ dryer, store }));
  return { a, store, link, dryer, timers };
}

describe("GET /state, /presets, /settings", () => {
  it("state — снапшот целиком, доступен viewer", async () => {
    const { a } = make(VIEWER);
    const r = await request(a).get("/api/dryer/state");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ node: { online: true, state: "idle" }, run: null, events: [] });
    expect(r.body.settings.autostop.holdMinutes).toBe(30);
  });
  it("presets — 30 штук по группам", async () => {
    const { a } = make(VIEWER);
    const r = await request(a).get("/api/dryer/presets");
    expect(r.status).toBe(200);
    expect(r.body.presets).toHaveLength(30);
    expect(r.body.presets[0]).toMatchObject({ name: "Яблоки", group: "fruit" });
  });
});

describe("пресеты — только admin", () => {
  it("создать, изменить, удалить", async () => {
    const { a } = make();
    let r = await request(a).post("/api/dryer/presets").send({ name: "Инжир", group: "fruit", setpoint: 58, maxMinutes: 900 });
    expect(r.status).toBe(201);
    const id = r.body.preset.id;
    expect(r.body.preset).toMatchObject({ name: "Инжир", autostop: true, sort: 31 });
    r = await request(a).put(`/api/dryer/presets/${id}`).send({ setpoint: 57 });
    expect(r.status).toBe(200);
    expect(r.body.preset.setpoint).toBe(57);
    r = await request(a).delete(`/api/dryer/presets/${id}`);
    expect(r.status).toBe(200);
    r = await request(a).delete(`/api/dryer/presets/${id}`);
    expect(r.status).toBe(404);
  });
  it("валидация — 400 с русским текстом; дубль имени — 409", async () => {
    const { a } = make();
    let r = await request(a).post("/api/dryer/presets").send({ name: "X", group: "fruit", setpoint: 90, maxMinutes: 60 });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ ok: false, error: "Поле «уставка» вне допустимого диапазона 35…75" });
    r = await request(a).post("/api/dryer/presets").send({ name: "Яблоки", group: "fruit", setpoint: 60, maxMinutes: 60 });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("Пресет с таким названием уже есть");
    r = await request(a).put("/api/dryer/presets/abc").send({ setpoint: 50 });
    expect(r.status).toBe(400);
  });
  it("viewer получает 403", async () => {
    const { a } = make(VIEWER);
    const r = await request(a).post("/api/dryer/presets").send({ name: "X", group: "fruit", setpoint: 60, maxMinutes: 60 });
    expect(r.status).toBe(403);
  });
});

describe("сушки", () => {
  it("старт по пресету → 200 со снапшотом, started_by ui:<user>", async () => {
    const { a, store } = make();
    const apples = store.listPresets().find((p) => p.name === "Яблоки")!;
    const r = await request(a).post("/api/dryer/runs").send({ presetId: apples.id });
    expect(r.status).toBe(200);
    expect(r.body.run).toMatchObject({ presetName: "Яблоки", startedBy: "ui:alex" });
    expect(r.body.node.state).toBe("heating");
  });
  it("старт со своими параметрами и стоп", async () => {
    const { a, store } = make();
    let r = await request(a).post("/api/dryer/runs").send({ setpoint: 45, maxMinutes: 120, autostop: false });
    expect(r.status).toBe(200);
    expect(r.body.run).toMatchObject({ setpoint: 45, maxMinutes: 120, autostopEnabled: false, presetName: null });
    r = await request(a).post("/api/dryer/runs/current/stop");
    expect(r.status).toBe(200);
    expect(r.body.run).toBeNull();
    expect(store.listRuns(0, Date.now() * 2)[0].endReason).toBe("stopped");
  });
  it("повторный старт → 409 already_running; неизвестный пресет → 404; пустое тело → 400", async () => {
    const { a } = make();
    await request(a).post("/api/dryer/runs").send({ setpoint: 60, maxMinutes: 120 });
    let r = await request(a).post("/api/dryer/runs").send({ setpoint: 60, maxMinutes: 120 });
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ ok: false, code: "already_running", error: "Сушка уже идёт" });
    r = await request(a).post("/api/dryer/runs").send({ presetId: 999 });
    expect(r.status).toBe(404);
    r = await request(a).post("/api/dryer/runs").send({});
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("Укажи пресет либо уставку и максимум минут");
  });
  it("нода не ответила → 504 node_unresponsive (маппинг RunError)", async () => {
    const stub = { startRun: async () => { throw new RunError("node_unresponsive", 504, "Сушилка не ответила на команду"); } } as unknown as Dryer;
    const { a } = make(ADMIN, { dryer: stub });
    const r = await request(a).post("/api/dryer/runs").send({ setpoint: 60, maxMinutes: 120 });
    expect(r.status).toBe(504);
    expect(r.body.code).toBe("node_unresponsive");
  });
  it("viewer → 403; токен без write → 403 scope_required; токен с write пишет token:<name>", async () => {
    let r = await request(make(VIEWER).a).post("/api/dryer/runs").send({ setpoint: 60, maxMinutes: 120 });
    expect(r.status).toBe(403);
    r = await request(make(RO_TOKEN).a).post("/api/dryer/runs").send({ setpoint: 60, maxMinutes: 120 });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("scope_required");
    const { a } = make({ role: "admin", kind: "token", scopes: ["read", "write"] });
    r = await request(a).post("/api/dryer/runs").send({ setpoint: 60, maxMinutes: 120 });
    expect(r.status).toBe(200);
    expect(r.body.run.startedBy).toBe("token:laptop");
  });
  it("история и замеры сушки; кривой диапазон → 400; чужой id → 404", async () => {
    const { a, timers, dryer } = make(VIEWER);
    const admin = make();
    // Сушка создаётся напрямую через Dryer — роутер здесь под viewer'ом.
    await dryer.startRun({ setpoint: 60, maxMinutes: 120 }, "ui:alex");
    timers.now += 10_000;
    dryer.tick();
    const from = timers.now - 3600_000;
    const to = timers.now + 1;
    let r = await request(a).get(`/api/dryer/runs?from=${from}&to=${to}`);
    expect(r.status).toBe(200);
    expect(r.body.runs).toHaveLength(1);
    const id = r.body.runs[0].id;
    r = await request(a).get(`/api/dryer/runs/${id}/samples`);
    expect(r.status).toBe(200);
    expect(r.body.samples.length).toBeGreaterThanOrEqual(1);
    expect(r.body.samples[0]).toHaveProperty("excess");
    r = await request(a).get(`/api/dryer/runs?from=${to}&to=${from}`);
    expect(r.status).toBe(400);
    r = await request(a).get("/api/dryer/runs/999/samples");
    expect(r.status).toBe(404);
    expect(admin).toBeDefined();
  });
});

describe("настройки и события", () => {
  it("PUT /settings частичный, admin; viewer — 403; мусор — 400", async () => {
    const { a } = make();
    let r = await request(a).put("/api/dryer/settings").send({ autostop: { holdMinutes: 45 } });
    expect(r.status).toBe(200);
    expect(r.body.settings.autostop.holdMinutes).toBe(45);
    expect(r.body.settings.exhaustMin).toBe(25);
    r = await request(a).put("/api/dryer/settings").send({ exhaustMin: 5 });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("Поле «минимум вытяжки» вне допустимого диапазона 20…100");
    r = await request(make(VIEWER).a).put("/api/dryer/settings").send({ exhaustMin: 30 });
    expect(r.status).toBe(403);
    r = await request(make(VIEWER).a).get("/api/dryer/settings");
    expect(r.status).toBe(200);
  });
  it("POST /events/:id/seen — любой роли; повторно и чужой id → 404", async () => {
    const { a, store } = make(VIEWER);
    const e = store.addEvent(1, "node_offline", "Нет связи с сушилкой", null);
    let r = await request(a).post(`/api/dryer/events/${e.id}/seen`);
    expect(r.status).toBe(200);
    r = await request(a).post(`/api/dryer/events/${e.id}/seen`);
    expect(r.status).toBe(404);
    expect((await request(a).get("/api/dryer/state")).body.events).toEqual([]);
  });
});
