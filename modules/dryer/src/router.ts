import express, { Router } from "express";
import type { Dryer } from "./dryer";
import type { DryerStore } from "./store";

export interface DryerRouterDeps {
  dryer: Dryer;
  store: DryerStore;
}

export function createDryerRouter(_deps: DryerRouterDeps): Router {
  return express.Router();
}
