import { mkdirSync } from "fs";
import { connect as mqttConnect } from "mqtt";
import { WebSocket } from "ws";
import type { McpCapable } from "@sweethome/home-mcp";
import type { HomeModule, ModuleHealth } from "@sweethome/shared/module";
import type { DryerSnapshot } from "@sweethome/dryer-shared";
import { loadDryerConfig, type DryerConfig } from "./config";
import { Dryer } from "./dryer";
import { createDryerMcpProvider } from "./mcp/provider";
import type { NodeLink } from "./node/link";
import { MockNodeLink } from "./node/mock";
import { MqttNodeLink, type MqttClientLike, type MqttConnect } from "./node/mqtt";
import { createDryerRouter } from "./router";
import { DryerStore } from "./store";
import { realTimers, type Timers } from "./timers";

export interface DryerModuleOverrides {
  cfg?: DryerConfig;
  store?: DryerStore;
  link?: NodeLink;
  timers?: Timers;
  now?: () => number;
  /** Фабрика MQTT-клиента — в тестах подделка, в бою mqtt.js. */
  connect?: MqttConnect;
}

const realConnect: MqttConnect = (url, opts) => mqttConnect(url, opts) as unknown as MqttClientLike;

export function createDryerModule(rootDataDir: string, over: DryerModuleOverrides = {}): HomeModule & McpCapable {
  const cfg = over.cfg ?? loadDryerConfig(rootDataDir);
  const timers = over.timers ?? realTimers;
  const now = over.now ?? (() => Date.now());

  // База открывается здесь, а не в start(): роутеру и MCP она нужна уже при сборке.
  // Владеем ею (закрываем в stop()) только если её не подсунули через overrides.
  const ownsStore = over.store === undefined;
  if (ownsStore) mkdirSync(cfg.dataDir, { recursive: true });
  const dbFile = `${cfg.dataDir}/dryer.db`;
  const store = over.store ?? new DryerStore(dbFile);
  let storeClosed = false;

  const link: NodeLink =
    over.link ??
    (cfg.transport === "mock"
      ? new MockNodeLink({ now, timers })
      : new MqttNodeLink({
          url: cfg.mqttUrl,
          user: cfg.mqttUser,
          pass: cfg.mqttPass,
          prefix: cfg.prefix,
          connect: over.connect ?? realConnect,
          now,
        }));

  const dryer = new Dryer({ cfg, store, link, timers, now });
  let started = false;

  return {
    id: "dryer",
    apiRouter: createDryerRouter({ dryer, store }),
    mcp: createDryerMcpProvider({ dryer, store }),
    ws: {
      onConnection(ws: WebSocket) {
        // Тот же объект, что GET /state, без обёртки (спека §8): первый кадр сразу, дальше каждый тик.
        const send = (s: DryerSnapshot) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(s));
        };
        send(dryer.snapshot());
        const unsub = dryer.subscribe(send);
        ws.on("close", unsub);
        // "error" без слушателя у `ws` — брошенное исключение (урок cctv): отписываем как при close.
        ws.on("error", unsub);
      },
    },

    async start() {
      if (started) {
        console.warn("[dryer] start() called again without stop() — ignoring");
        return;
      }
      started = true;
      if (!cfg.enabled) {
        console.log("[dryer] disabled (DRYER_ENABLED=false)");
        return;
      }
      if (ownsStore && storeClosed) {
        store.reopen(dbFile);
        storeClosed = false;
      }
      dryer.start();
      console.log(`[dryer] transport=${cfg.transport}${cfg.transport === "mqtt" ? ` broker=${cfg.mqttUrl} prefix=${cfg.prefix}` : ""}`);
    },

    async stop() {
      dryer.stop();
      if (ownsStore && !storeClosed) {
        store.close();
        storeClosed = true;
      }
      started = false;
    },

    health(): ModuleHealth {
      if (!cfg.enabled) return { ok: true, details: { enabled: false } };
      return dryer.health();
    },
  };
}
