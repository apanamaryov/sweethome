import express from "express";
import type { HomeModule, ModuleHealth } from "@sweethome/shared/module";
import { loadDryerConfig, type DryerConfig } from "./config";

export interface DryerModuleOverrides {
  cfg?: DryerConfig;
}

export function createDryerModule(rootDataDir: string, over: DryerModuleOverrides = {}): HomeModule {
  const cfg = over.cfg ?? loadDryerConfig(rootDataDir);
  return {
    id: "dryer",
    apiRouter: express.Router(),
    async start() {
      if (!cfg.enabled) console.log("[dryer] disabled (DRYER_ENABLED=false)");
    },
    async stop() {},
    health(): ModuleHealth {
      return { ok: true, details: { enabled: cfg.enabled } };
    },
  };
}
