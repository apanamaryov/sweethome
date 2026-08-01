import type { Application, RequestHandler } from "express";
import { WebSocket } from "ws";
import type { HomeModule, ModuleHealth } from "@sweethome/shared/module";
import type { Snapshot } from "@sweethome/inverter-shared";
import { Inverter } from "./inverter";
import { createStats } from "./stats/recorder";
import { HaMqtt } from "./mqtt";
import { mountMcp } from "./mcp/http";
import { loadInverterConfig } from "./config";
import { createInverterRouter } from "./router";

export function createInverterModule(rootDataDir: string): HomeModule {
  const cfg = loadInverterConfig(rootDataDir);
  const inverter = new Inverter(cfg);
  const stats = createStats(cfg);
  if (stats) stats.attach(inverter);
  console.log(`[inverter] stats: ${stats ? "enabled (stats.db)" : "disabled"}`);
  const mqtt = new HaMqtt(cfg, inverter);

  const clients = new Set<WebSocket>();
  inverter.on("snapshot", (snap: Snapshot) => {
    const msg = JSON.stringify({ type: "snapshot", data: snap });
    for (const c of clients) if (c.readyState === WebSocket.OPEN) c.send(msg);
  });

  return {
    id: "inverter",
    apiRouter: createInverterRouter({ inverter, stats, cfg }),
    ws: {
      onConnection(ws) {
        clients.add(ws);
        ws.on("close", () => clients.delete(ws));
        ws.send(JSON.stringify({ type: "snapshot", data: inverter.getSnapshot() }));
      },
    },
    attachHttp(app: Application, ctx: { authenticate: RequestHandler }) {
      mountMcp(app, { inverter, cfg, stats, authenticate: ctx.authenticate });
    },
    async start() {
      mqtt.start();
      await inverter.start();
      console.log(
        `[inverter] transport=${cfg.transport} baud=${cfg.baudRate} poll=${cfg.pollIntervalMs}ms ` +
          `control=${cfg.allowControl ? "enabled" : "disabled"}`
      );
      const snap = inverter.getSnapshot();
      console.log(
        `[inverter] connection: ${snap.connection.connected ? "connected" : "not connected"} ` +
          `via ${snap.connection.transport}${snap.connection.device ? ` (${snap.connection.device})` : ""}` +
          `${snap.connection.mock ? " [MOCK/demo data]" : ""}`
      );
      if (snap.connection.lastError) console.log(`[inverter] last error: ${snap.connection.lastError}`);
    },
    async stop() {
      mqtt.stop();
      stats?.stop();
      await inverter.stop();
    },
    health(): ModuleHealth {
      const c = inverter.getSnapshot().connection;
      return { ok: true, details: { connected: c.connected, transport: c.transport, mock: c.mock, lastError: c.lastError } };
    },
  };
}
