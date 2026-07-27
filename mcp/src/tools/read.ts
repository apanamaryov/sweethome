import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { diffSettings } from "@inverter/shared";
import type { McpContext } from "../server";
import { summarizeSnapshot } from "../format";
import { NOOP_LOGGER, type Logger } from "../logging";

/** Обёртка: превращает исключение шлюза в ответ isError, а не в обрыв протокола. */
export async function guard(
  fn: () => Promise<{ structuredContent: Record<string, unknown>; text: string }>,
  logger: Logger = NOOP_LOGGER
): Promise<CallToolResult> {
  try {
    const { structuredContent, text } = await fn();
    return { content: [{ type: "text", text }], structuredContent };
  } catch (e) {
    const message = (e as Error).message;
    logger.error("gateway", { error: message });
    return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
  }
}

const SECTIONS = ["connection", "status", "settings", "flags", "warnings", "baseline"] as const;

export function registerReadTools(server: McpServer, ctx: McpContext, logger: Logger = NOOP_LOGGER): void {
  const gw = ctx.gateway;
  const run = (fn: () => Promise<{ structuredContent: Record<string, unknown>; text: string }>) =>
    guard(fn, logger);

  server.registerTool(
    "get_snapshot",
    {
      title: "Inverter snapshot",
      description:
        "Current inverter state: connection, live measurements, settings, flags, alarms and the settings baseline. " +
        "Pass `sections` to fetch only what you need.",
      inputSchema: {
        sections: z
          .array(z.enum(SECTIONS))
          .optional()
          .describe("Subset of sections to return; all of them when omitted"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ sections }) =>
      run(async () => {
        const snap = await gw.snapshot();
        const want = new Set<string>(sections ?? SECTIONS);
        const out: Record<string, unknown> = {
          timestamp: snap.timestamp,
          mode: snap.mode,
          control: snap.control,
        };
        if (want.has("connection")) out.connection = snap.connection;
        if (want.has("status")) out.status = snap.status;
        if (want.has("settings")) out.settings = snap.info;
        if (want.has("flags")) out.flags = snap.flags;
        if (want.has("warnings")) out.warnings = snap.warnings;
        if (want.has("baseline")) out.baseline = snap.baseline;
        return { structuredContent: out, text: summarizeSnapshot(snap, Date.now()) };
      })
  );

  server.registerTool(
    "get_settings_diff",
    {
      title: "Settings vs baseline",
      description:
        "Every inverter setting next to the 'as-found' baseline captured when the device first connected, " +
        "with drifted values flagged.",
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async () =>
      run(async () => {
        const snap = await gw.snapshot();
        const d = diffSettings(snap.info, snap.flags, snap.baseline);
        const drifted = [...d.settings.filter((r) => r.drifted), ...d.flags.filter((r) => r.drifted)];
        const text = !snap.info
          ? "Settings have not been read yet."
          : d.driftCount === 0
            ? `All ${d.settings.length} settings match the baseline.`
            : `${d.driftCount} setting(s) drifted from the baseline: ${drifted.map((r) => r.name).join(", ")}`;
        return { structuredContent: d as unknown as Record<string, unknown>, text };
      })
  );

  server.registerTool(
    "get_alarms",
    {
      title: "Active alarms",
      description: "Active fault and warning bits decoded into names (registers 100/101 and 108/109).",
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async () =>
      run(async () => {
        const snap = await gw.snapshot();
        const active = snap.warnings?.active ?? [];
        return {
          structuredContent: { active, raw: snap.warnings?.raw ?? null, count: active.length },
          text: active.length ? `Active alarms: ${active.join(", ")}` : "No active alarms.",
        };
      })
  );

  server.registerTool(
    "get_meta",
    {
      title: "Control metadata",
      description:
        "Allowed values for every control command, whether writes are enabled on the server, " +
        "and the role/scopes of the current credentials.",
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async () =>
      run(async () => {
        const meta = await gw.meta();
        const caps = gw.capabilities();
        return {
          structuredContent: {
            allowControl: meta.allowControl,
            role: caps.role,
            scopes: caps.scopes,
            statsEnabled: caps.statsEnabled,
            outputSourcePriority: meta.outputSourcePriority,
            chargerSourcePriority: meta.chargerSourcePriority,
            maxChargingCurrent: meta.maxChargingCurrent,
            maxAcChargingCurrent: meta.maxAcChargingCurrent,
          },
          text:
            `Role ${caps.role}, scopes [${caps.scopes.join(", ")}]; ` +
            `writes ${meta.allowControl ? "enabled" : "disabled (ALLOW_CONTROL=false)"}.`,
        };
      })
  );

  server.registerTool(
    "get_health",
    {
      title: "Service health",
      description:
        "Is the service reachable, is the inverter actually connected, which transport is in use and how fresh the data is.",
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async () =>
      run(async () => {
        const snap = await gw.snapshot();
        const ageMs = Date.now() - snap.timestamp;
        const h = {
          serviceReachable: true,
          connected: snap.connection.connected,
          transport: snap.connection.transport,
          device: snap.connection.device,
          mock: snap.connection.mock,
          snapshotAgeMs: ageMs,
          lastError: snap.connection.lastError,
          writeLocked: snap.control.locked,
          allowControl: snap.control.allowControl,
        };
        const text = snap.connection.mock
          ? "Service is up, but serving demo data — no inverter attached."
          : snap.connection.connected
            ? `Connected via ${snap.connection.transport} (${snap.connection.device ?? "?"}), data ${Math.round(ageMs / 1000)} s old.`
            : `Service is up, inverter not connected${snap.connection.lastError ? `: ${snap.connection.lastError}` : ""}.`;
        return { structuredContent: h, text };
      })
  );

  server.registerTool(
    "read_registers",
    {
      title: "Read Modbus registers",
      description:
        "Read raw holding registers (Modbus function 0x03). Always safe. See inverter://registers/map for the address list.",
      inputSchema: {
        address: z.number().int().min(0).max(65535).describe("First register address"),
        count: z.number().int().min(1).max(32).default(1).describe("How many consecutive registers to read"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ address, count }) =>
      run(async () => {
        const n = count ?? 1;
        const reply = await gw.raw(`R ${address} ${n}`);
        return { structuredContent: { address, count: n, reply }, text: reply };
      })
  );
}
