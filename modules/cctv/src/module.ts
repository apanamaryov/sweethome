import express from "express";
import type { HomeModule, ModuleHealth } from "@sweethome/shared/module";
import { loadCctvConfig, type CctvConfig } from "./config";

export function createCctvModule(rootDataDir: string): HomeModule {
  const cfg: CctvConfig = loadCctvConfig(rootDataDir);
  const router = express.Router();
  router.get("/cameras", (_req, res) => res.json({ cameras: [] }));

  return {
    id: "cctv",
    apiRouter: router,
    async start() {
      if (!cfg.enabled) {
        console.log("[cctv] disabled (no cameras configured)");
        return;
      }
      console.log(`[cctv] cameras=${cfg.cameras.map((c) => c.id).join(",")} storage=${cfg.storageDir}`);
    },
    async stop() {},
    health(): ModuleHealth {
      return { ok: true, details: { enabled: cfg.enabled, cameras: cfg.cameras.length } };
    },
  };
}
