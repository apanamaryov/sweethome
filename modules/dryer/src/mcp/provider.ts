import type { ModuleMcpProvider } from "@sweethome/home-mcp";
import type { Dryer } from "../dryer";
import type { DryerStore } from "../store";

export interface DryerMcpDeps {
  dryer: Dryer;
  store: DryerStore;
}

export function createDryerMcpProvider(_deps: DryerMcpDeps): ModuleMcpProvider {
  return { register() {} };
}
