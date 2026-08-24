import { loadConfig } from "./config";
import { createServer } from "./server";
import { ModuleHost } from "./host";
import { createInverterModule } from "@sweethome/inverter";
import { createCctvModule } from "@sweethome/cctv";

process.on("unhandledRejection", (reason) => {
  console.error("[sweethome] unhandledRejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[sweethome] uncaughtException:", err);
});

async function main(): Promise<void> {
  const cfg = loadConfig();
  const host = new ModuleHost([createInverterModule(cfg.dataDir), createCctvModule(cfg.dataDir)]);

  const server = createServer(host, cfg);
  server.on("error", (e) => {
    console.error("[sweethome] HTTP server failed:", (e as Error).message);
    process.exit(1);
  });
  server.listen(cfg.port, cfg.host, () => {
    console.log(`[sweethome] HTTP/WS listening on http://${cfg.host}:${cfg.port}`);
  });

  await host.startAll();

  const shutdown = async (sig: string) => {
    console.log(`\n[sweethome] ${sig} received, shutting down...`);
    await host.stopAll();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((e) => {
  console.error("[sweethome] fatal:", e);
  process.exit(1);
});
