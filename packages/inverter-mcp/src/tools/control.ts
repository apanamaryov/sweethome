import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ControlType, SeasonProfile } from "@sweethome/inverter-shared";
import { SEASON_PROFILE_NAMES } from "@sweethome/inverter-shared";
import { canWrite, type McpContext } from "../server";
import { NOOP_LOGGER, type Logger } from "../logging";

const CONTROL_TYPES = [
  "outputSourcePriority",
  "chargerSourcePriority",
  "maxChargingCurrent",
  "maxAcChargingCurrent",
  "batteryRechargeVoltage",
  "batteryRedischargeVoltage",
] as const;

const WRITE_ANNOTATIONS = { readOnlyHint: false, destructiveHint: true, idempotentHint: false } as const;

/** Ошибку блокировки превращаем в подсказку — агент иначе не догадается про set_lock. */
function explain(e: Error): string {
  const msg = e.message;
  if (/locked/i.test(msg)) {
    return `${msg} Call set_lock with locked=false first; the lock re-engages automatically after a successful write.`;
  }
  return msg;
}

/** Записи логируются всегда: журнал клиента должен видеть, что агент менял. */
async function guardWrite(
  fn: () => Promise<{ structuredContent: Record<string, unknown>; text: string }>,
  logger: Logger
): Promise<CallToolResult> {
  try {
    const { structuredContent, text } = await fn();
    logger.info("control", structuredContent);
    return { content: [{ type: "text", text }], structuredContent };
  } catch (e) {
    const message = explain(e as Error);
    logger.error("control", { error: message });
    return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
  }
}

export function registerControlTools(server: McpServer, ctx: McpContext, logger: Logger = NOOP_LOGGER): void {
  if (!canWrite(ctx)) return; // без прав инструменты записи не существуют
  const gw = ctx.gateway;
  const run = (fn: () => Promise<{ structuredContent: Record<string, unknown>; text: string }>) =>
    guardWrite(fn, logger);

  server.registerTool(
    "set_control",
    {
      title: "Change a setting",
      description:
        "Write one whitelisted setting to the inverter. Use preview=true first to see the register, the raw value " +
        "and the current one. Changing charging currents and voltage thresholds affects battery health — change one " +
        "thing at a time.",
      inputSchema: {
        type: z.enum(CONTROL_TYPES).describe("Which setting to change"),
        value: z.number().describe("New value in human units (A, V or the code from get_meta)"),
        preview: z.boolean().default(false).describe("Show what would be written without writing"),
      },
      annotations: WRITE_ANNOTATIONS,
    },
    async ({ type, value, preview }) =>
      run(async () => {
        if (preview) {
          const p = await gw.previewControl(type as ControlType, value);
          return {
            structuredContent: { preview: true, type, value, ...p },
            text:
              `Would write register ${p.register} := ${p.rawValue} (${p.label}); ` +
              `current ${p.currentValue ?? "?"}, baseline ${p.baselineValue ?? "?"}. Nothing was written.`,
          };
        }
        const r = await gw.control(type as ControlType, value);
        return {
          structuredContent: { preview: false, ok: r.ok, command: r.command ?? null, reply: r.reply ?? null },
          text: `Wrote ${type} = ${value}. ${r.command ?? ""} ${r.reply ?? ""}`.trim(),
        };
      })
  );

  server.registerTool(
    "set_season_profile",
    {
      title: "Apply a season profile",
      description:
        "Switch the inverter between the season profiles in one action. 'winter' keeps the house on the grid " +
        "(SUB) with the battery charged from utility as a reserve; 'night' is winter on a two-rate meter: the " +
        "grid charges the battery only in the cheap hours 23:00-07:00 (and during the day only if the charge " +
        "drops to 30%, up to 50%), otherwise only PV charges it — the server keeps switching the charger " +
        "priority on schedule until another profile or a manual priority change turns it off; 'summer' runs " +
        "the house from PV and battery (SBU) and charges from PV first, falling back to the grid only when the " +
        "sun is not enough. Each profile writes the output source priority (register 301) and the charger " +
        "source priority (register 331); a setting that already matches is left alone. Use preview=true " +
        "first to see what would change.",
      inputSchema: {
        profile: z
          .enum(SEASON_PROFILE_NAMES as unknown as [SeasonProfile, ...SeasonProfile[]])
          .describe("Which season profile to apply"),
        preview: z.boolean().default(false).describe("Show what would change without writing"),
      },
      annotations: WRITE_ANNOTATIONS,
    },
    async ({ profile, preview }) =>
      run(async () => {
        if (preview) {
          const p = await gw.previewProfile(profile as SeasonProfile);
          const pending = p.steps.filter((s) => !s.alreadyApplied);
          const lines = p.steps.map((s) =>
            s.alreadyApplied
              ? `- ${s.label}: register ${s.register} already holds ${s.rawValue}`
              : `- ${s.label}: register ${s.register} ${s.currentValue ?? "?"} -> ${s.rawValue}`
          );
          return {
            structuredContent: { preview: true, ...p } as unknown as Record<string, unknown>,
            text:
              `Profile ${p.profile}: ${pending.length} of ${p.steps.length} settings would change.\n` +
              `${lines.join("\n")}\nNothing was written.`,
          };
        }
        const r = await gw.applyProfile(profile as SeasonProfile);
        const wrote = r.applied.map((s) => s.command).join("; ");
        return {
          structuredContent: { preview: false, ...r } as unknown as Record<string, unknown>,
          text:
            `Applied the ${r.profile} profile: wrote ${r.applied.length}, ` +
            `left ${r.skipped.length} already matching.${wrote ? " " + wrote : ""}`,
        };
      })
  );

  server.registerTool(
    "set_lock",
    {
      title: "Write lock",
      description:
        "Engage or release the write lock. The service starts locked and re-locks after every successful write " +
        "(AUTO_RELOCK).",
      inputSchema: { locked: z.boolean().describe("true = read-only, false = writes allowed") },
      annotations: WRITE_ANNOTATIONS,
    },
    async ({ locked }) =>
      run(async () => {
        const r = await gw.setLock(locked);
        return {
          structuredContent: { ...r },
          text: r.locked
            ? "Write lock engaged — the inverter is read-only."
            : "Write lock released — writes are allowed.",
        };
      })
  );

  server.registerTool(
    "recapture_baseline",
    {
      title: "Recapture baseline",
      description:
        "Re-read all settings and overwrite the stored 'as-found' baseline. Does not change the inverter, but the " +
        "previous baseline is lost.",
      annotations: WRITE_ANNOTATIONS,
    },
    async () =>
      run(async () => {
        const b = await gw.recaptureBaseline();
        return {
          structuredContent: { ...b } as unknown as Record<string, unknown>,
          text: `Baseline recaptured for device ${b.deviceId} at ${new Date(b.capturedAt).toISOString()}.`,
        };
      })
  );

  server.registerTool(
    "write_register",
    {
      title: "Write a raw register",
      description:
        "Write a raw value to a Modbus register (function 0x10). No whitelist beyond the service's own gates — " +
        "prefer set_control. Use preview=true to see the current value first. See inverter://registers/map.",
      inputSchema: {
        address: z.number().int().min(0).max(65535).describe("Register address"),
        value: z.number().int().min(0).max(65535).describe("Raw value as stored in the register (mind the scale)"),
        preview: z.boolean().default(false).describe("Read the current value instead of writing"),
      },
      annotations: WRITE_ANNOTATIONS,
    },
    async ({ address, value, preview }) =>
      run(async () => {
        if (preview) {
          const current = await gw.raw(`R ${address} 1`);
          return {
            structuredContent: { preview: true, address, value, current },
            text: `Register ${address} currently reads:\n${current}\nWould write ${value}. Nothing was written.`,
          };
        }
        const reply = await gw.raw(`W ${address} ${value}`);
        return { structuredContent: { preview: false, address, value, reply }, text: reply };
      })
  );
}
