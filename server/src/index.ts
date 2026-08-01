import { loadConfig } from "./config";
import { createServer } from "./server";
import { Inverter, HaMqtt, createStats, loadInverterConfig } from "@sweethome/inverter";

// Safety net: a long-running device service must survive stray async errors
// from native transports (e.g. a benign serialport 'error' after unplug) rather
// than flap under systemd. Log and keep running.
process.on("unhandledRejection", (reason) => {
  console.error("[inverter-monitor] unhandledRejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[inverter-monitor] uncaughtException:", err);
});

async function main(): Promise<void> {
  const cfg = loadConfig();
  const invCfg = loadInverterConfig(cfg.dataDir);
  const inverter = new Inverter(invCfg);

  const stats = createStats(invCfg);
  if (stats) stats.attach(inverter);
  console.log(`[inverter-monitor] stats: ${stats ? "enabled (stats.db)" : "disabled"}`);

  const server = createServer(inverter, cfg, invCfg, stats);
  // A failed bind (e.g. port already in use) must be fatal: the global
  // uncaughtException guard would otherwise keep a listener-less process
  // alive, hiding the failure from systemd.
  server.on("error", (e) => {
    console.error("[inverter-monitor] HTTP server failed:", (e as Error).message);
    process.exit(1);
  });
  server.listen(cfg.port, cfg.host, () => {
    console.log(`[inverter-monitor] HTTP/WS listening on http://${cfg.host}:${cfg.port}`);
    console.log(
      `[inverter-monitor] transport=${invCfg.transport} baud=${invCfg.baudRate} poll=${invCfg.pollIntervalMs}ms ` +
        `control=${invCfg.allowControl ? "enabled" : "disabled"}`
    );
  });

  const mqtt = new HaMqtt(invCfg, inverter);
  mqtt.start();

  await inverter.start();
  const snap = inverter.getSnapshot();
  console.log(
    `[inverter-monitor] connection: ${snap.connection.connected ? "connected" : "not connected"} ` +
      `via ${snap.connection.transport}${snap.connection.device ? ` (${snap.connection.device})` : ""}` +
      `${snap.connection.mock ? " [MOCK/demo data]" : ""}`
  );
  if (snap.connection.lastError) console.log(`[inverter-monitor] last error: ${snap.connection.lastError}`);

  const shutdown = async (sig: string) => {
    console.log(`\n[inverter-monitor] ${sig} received, shutting down...`);
    mqtt.stop();
    stats?.stop();
    await inverter.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((e) => {
  console.error("[inverter-monitor] fatal:", e);
  process.exit(1);
});
