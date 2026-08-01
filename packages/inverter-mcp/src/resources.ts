import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SubscribeRequestSchema, UnsubscribeRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  ALLOWED_MAX_AC_CHARGE_CURRENT,
  ALLOWED_MAX_CHARGE_CURRENT,
  CHARGER_SOURCE_PRIORITY,
  OUTPUT_SOURCE_PRIORITY,
  REGISTER_DOCS,
  registerDocsMarkdown,
} from "@sweethome/inverter-shared";
import type { McpContext } from "./server";

const SNAPSHOT_URI = "inverter://snapshot";
/** Поллер ходит раз в 5 с; чаще уведомлять бессмысленно. */
const NOTIFY_INTERVAL_MS = 5000;
const RECENT_EVENTS = 100;

const json = (uri: string, value: unknown) => ({
  contents: [{ uri, mimeType: "application/json", text: JSON.stringify(value, null, 2) }],
});

function controlContractMarkdown(): string {
  const enumRows = (map: Record<number, string>) =>
    Object.entries(map)
      .map(([k, v]) => `  - \`${k}\` — ${v}`)
      .join("\n");
  const reg = (key: string) => REGISTER_DOCS.find((d) => d.key === key)?.addr ?? "?";

  return [
    "# Control contract",
    "",
    "Only these settings can be written through `set_control`. Every write goes through the",
    "service whitelist, needs the write lock released, and re-locks afterwards.",
    "",
    `## outputSourcePriority (register ${reg("outputSourcePriority")})`,
    "Which source powers the load first.",
    enumRows(OUTPUT_SOURCE_PRIORITY),
    "",
    `## chargerSourcePriority (register ${reg("chargerSourcePriority")})`,
    "Where charging energy comes from.",
    enumRows(CHARGER_SOURCE_PRIORITY),
    "",
    `## maxChargingCurrent (register ${reg("maxChargingCurrent")}, amps)`,
    `Allowed values: ${ALLOWED_MAX_CHARGE_CURRENT.join(", ")}.`,
    "Too high a current for the battery bank shortens its life — match the battery datasheet.",
    "",
    `## maxAcChargingCurrent (register ${reg("maxAcChargingCurrent")}, amps)`,
    `Allowed values: ${ALLOWED_MAX_AC_CHARGE_CURRENT.join(", ")}.`,
    "Bounded by the grid connection as well as by the battery.",
    "",
    `## batteryRechargeVoltage (register ${reg("batteryRechargeVoltage")}, volts)`,
    "Voltage at which the inverter switches the load back to the grid. Setting it too low",
    "deep-discharges the battery; too high keeps the system on the grid permanently.",
    "",
    `## batteryRedischargeVoltage (register ${reg("batteryRedischargeVoltage")}, volts)`,
    "Voltage at which the inverter returns to battery power. Keep a sensible gap from",
    "batteryRechargeVoltage, otherwise the system oscillates between grid and battery.",
    "",
    "## Safety rules",
    "",
    "- Preview first (`set_control` with `preview: true`).",
    "- Change one parameter at a time and verify with `get_snapshot`.",
    "- For lithium banks the SOC thresholds (registers 341–343) govern switching rather than",
    "  the voltage ones; they are not writable here — change them on the inverter's own panel.",
    "- `write_register` bypasses the value whitelist. Use it only for registers you have",
    "  looked up in `inverter://registers/map`.",
    "",
  ].join("\n");
}

/** Регистрирует ресурсы и подписки; возвращает функцию остановки. */
export function registerResources(server: McpServer, ctx: McpContext): () => void {
  const gw = ctx.gateway;

  server.registerResource(
    "snapshot",
    SNAPSHOT_URI,
    {
      title: "Live snapshot",
      description: "Full inverter state, updated on every poll. Subscribe to be notified about changes.",
      mimeType: "application/json",
    },
    async () => json(SNAPSHOT_URI, await gw.snapshot())
  );

  server.registerResource(
    "settings",
    "inverter://settings",
    {
      title: "Current settings",
      description: "Settings and function flags as currently read from the inverter.",
      mimeType: "application/json",
    },
    async () => {
      const s = await gw.snapshot();
      return json("inverter://settings", { info: s.info, flags: s.flags });
    }
  );

  server.registerResource(
    "baseline",
    "inverter://baseline",
    {
      title: "Settings baseline",
      description: "The 'as-found' settings captured when the device first connected.",
      mimeType: "application/json",
    },
    async () => json("inverter://baseline", await gw.baseline())
  );

  server.registerResource(
    "alarms",
    "inverter://alarms",
    { title: "Active alarms", description: "Decoded fault and warning bits.", mimeType: "application/json" },
    async () => {
      const s = await gw.snapshot();
      return json("inverter://alarms", s.warnings ?? { active: [], raw: null });
    }
  );

  server.registerResource(
    "registers-map",
    "inverter://registers/map",
    {
      title: "SMG II register map",
      description: "Addresses, units, scales and access for every documented register.",
      mimeType: "text/markdown",
    },
    async () => ({
      contents: [{ uri: "inverter://registers/map", mimeType: "text/markdown", text: registerDocsMarkdown() }],
    })
  );

  server.registerResource(
    "control-contract",
    "inverter://docs/control-contract",
    {
      title: "Control contract",
      description: "What can be written, allowed values and why each setting is risky.",
      mimeType: "text/markdown",
    },
    async () => ({
      contents: [
        { uri: "inverter://docs/control-contract", mimeType: "text/markdown", text: controlContractMarkdown() },
      ],
    })
  );

  const stats = gw.stats;
  if (stats) {
    server.registerResource(
      "recent-events",
      "inverter://events/recent",
      {
        title: "Recent events",
        description: `Last ${RECENT_EVENTS} events from the log.`,
        mimeType: "application/json",
      },
      async () => json("inverter://events/recent", await stats.events({ limit: RECENT_EVENTS, offset: 0 }))
    );

    server.registerResource(
      "daily",
      new ResourceTemplate("inverter://stats/daily/{day}", { list: undefined }),
      { title: "Daily totals", description: "Totals for one day (YYYY-MM-DD).", mimeType: "application/json" },
      async (uri, { day }) => json(uri.href, await stats.daily(String(day), String(day)))
    );

    server.registerResource(
      "export",
      new ResourceTemplate("inverter://stats/export/{res}/{from}/{to}.csv", { list: undefined }),
      { title: "CSV export", description: "Raw or per-minute samples as CSV, capped at 5 MB.", mimeType: "text/csv" },
      async (uri, { res, from, to }) => {
        const kind = String(res) === "raw" ? ("raw" as const) : ("minute" as const);
        const r = await stats.exportCsv({ from: Number(from), to: Number(to), res: kind });
        if (r.truncated) {
          throw new Error("Export exceeds the 5 MB limit — narrow the time range or use res=minute.");
        }
        return { contents: [{ uri: uri.href, mimeType: "text/csv", text: r.csv }] };
      }
    );
  }

  // --- Подписки: McpServer их не обрабатывает, вешаем сами на низкоуровневый сервер ---
  const subscribers = new Set<string>();
  let unsubscribeGateway: (() => void) | null = null;
  let lastNotifiedAt = 0;

  const startFeed = () => {
    if (unsubscribeGateway) return;
    unsubscribeGateway = gw.onSnapshot(() => {
      const now = Date.now();
      if (now - lastNotifiedAt < NOTIFY_INTERVAL_MS) return;
      lastNotifiedAt = now;
      if (subscribers.has(SNAPSHOT_URI)) {
        void server.server.sendResourceUpdated({ uri: SNAPSHOT_URI }).catch(() => undefined);
      }
    });
  };

  const stopFeed = () => {
    unsubscribeGateway?.();
    unsubscribeGateway = null;
  };

  server.server.setRequestHandler(SubscribeRequestSchema, async ({ params }) => {
    subscribers.add(params.uri);
    if (params.uri === SNAPSHOT_URI) startFeed();
    return {};
  });

  server.server.setRequestHandler(UnsubscribeRequestSchema, async ({ params }) => {
    subscribers.delete(params.uri);
    if (!subscribers.has(SNAPSHOT_URI)) stopFeed();
    return {};
  });

  return () => {
    subscribers.clear();
    stopFeed();
  };
}
