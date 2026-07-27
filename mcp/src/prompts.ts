import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { completable } from "@modelcontextprotocol/sdk/server/completable.js";
import type { McpContext } from "./server";
import { parseDay } from "./time";

const CONTROL_TYPES = [
  "outputSourcePriority",
  "chargerSourcePriority",
  "maxChargingCurrent",
  "maxAcChargingCurrent",
  "batteryRechargeVoltage",
  "batteryRedischargeVoltage",
];

const user = (text: string) => ({ role: "user" as const, content: { type: "text" as const, text } });

export function registerPrompts(server: McpServer, ctx: McpContext): void {
  const gw = ctx.gateway;

  server.registerPrompt(
    "diagnose-connection",
    {
      title: "Diagnose the inverter link",
      description: "Systematic check when the dashboard shows demo data or no connection.",
    },
    () => ({
      messages: [
        user(
          [
            "Diagnose why the inverter monitor is not talking to the inverter. Work through this checklist and",
            "report findings with the evidence you gathered:",
            "",
            "1. Call `get_health`. Note `transport`, `mock`, `connected`, `snapshotAgeMs` and `lastError`.",
            "2. If `mock` is true, the service found no serial device: the USB-RS232 adapter is missing, not permitted",
            "   (the service user must be in the `dialout` group), or filtered out as an onboard Pi UART.",
            "3. If a serial device is present but every request times out, the likely causes in order are:",
            "   wrong Modbus ID (inverter menu setting #25 must match MODBUS_SLAVE_ID, default 1),",
            "   wrong baud rate (this inverter answers only at 9600), or the stock SmartESS dongle still",
            "   occupying the RS232 port.",
            "4. If replies arrive but CRC fails, suspect cabling: the RJ45 crimp, the DB9 junction, or interference.",
            "5. Remember the hardware trap: cheap CH340 'USB-RS232' dongles are actually USB-TTL (0/3.3 V) and are",
            "   physically incompatible — the port opens and the line stays silent. A working adapter idles at",
            "   −5…−12 V on TX (DB9 pin 3) and needs a real RS232 level shifter (FTDI FT231X is verified working).",
            "6. Try `read_registers` with address 201, count 1 — register 201 is the device mode and the cheapest probe.",
            "",
            "Do not write anything to the inverter while diagnosing.",
          ].join("\n")
        ),
      ],
    })
  );

  if (gw.stats) {
    server.registerPrompt(
      "daily-report",
      {
        title: "Daily report",
        description: "Summarize one day: generation, consumption, grid dependence, solar window and events.",
        argsSchema: {
          day: completable(
            z.string().describe('Day as YYYY-MM-DD, "today", "yesterday" or "-3d"'),
            async (value) => {
              try {
                const now = Date.now();
                const rows = await gw.stats!.daily(parseDay("-30d", now), parseDay("today", now));
                return rows
                  .map((r) => String(r.day))
                  .filter((d) => d.startsWith(String(value ?? "")))
                  .slice(0, 30);
              } catch {
                return [];
              }
            }
          ),
        },
      },
      ({ day }) => ({
        messages: [
          user(
            [
              `Produce a report for ${day}.`,
              "",
              `1. \`get_daily\` with from=${day} and to=${day} for the energy totals and SOC range.`,
              `2. \`get_solar_window\` with day=${day} for when solar output started and stopped.`,
              "3. `get_events` for that day to catch mode changes, grid loss and alarms.",
              "4. Optionally `get_series` for pvPower and acOutputActivePower to describe the shape of the day.",
              "",
              "Report: how much solar was generated, how much the load consumed, how much came from the grid,",
              "how deep the battery was cycled, and anything unusual. Numbers in kWh with two decimals.",
            ].join("\n")
          ),
        ],
      })
    );
  }

  server.registerPrompt(
    "battery-health-check",
    {
      title: "Battery health check",
      description: "Compare live battery behaviour against the configured thresholds and the battery type.",
    },
    () => ({
      messages: [
        user(
          [
            "Assess the battery configuration and behaviour.",
            "",
            "1. `get_snapshot` — battery voltage, current, SOC, power, and the configured battery type.",
            "2. `get_settings_diff` — check the voltage thresholds and SOC thresholds against the baseline.",
            "3. `get_series` for batteryCapacity and batteryVoltage over the last 7 days at minute resolution.",
            "",
            "Then check for these specific problems and say which apply:",
            "- SOC repeatedly dropping to or below socLowCutoff (deep cycling shortens lithium life).",
            "- batteryRechargeVoltage and batteryRedischargeVoltage too close together (the system will",
            "  oscillate between grid and battery).",
            "- batteryUnderVoltage set below what the pack's BMS allows.",
            "- maxChargingCurrent far above what the bank is rated for.",
            "- For lithium types (Li1…Li4, Lib) the SOC thresholds govern switching, not the voltage ones —",
            "  say which set is actually in charge.",
            "",
            "Report findings and recommendations. Do not change anything.",
          ].join("\n")
        ),
      ],
    })
  );

  server.registerPrompt(
    "plan-setting-change",
    {
      title: "Plan a setting change",
      description: "Work out — without writing — what changing one setting would do.",
      argsSchema: {
        type: completable(z.string().describe("Which setting to plan a change for"), (value) =>
          CONTROL_TYPES.filter((t) => t.startsWith(String(value ?? "")))
        ),
      },
    },
    ({ type }) => ({
      messages: [
        user(
          [
            `Plan a change to \`${type}\`. Do not write anything — this is analysis only.`,
            "",
            "1. Read `inverter://docs/control-contract` for the allowed values and the risk of this setting.",
            "2. `get_snapshot` and `get_settings_diff` for the current value and how it compares to the baseline.",
            "3. `get_meta` for the exact set of values the service will accept.",
            "4. `set_control` with `preview: true` for the candidate value — it shows the register and raw value",
            "   without writing.",
            "",
            "Then explain: what the current value does, what the new value would do, what could go wrong,",
            "and the exact steps to apply it safely (release the lock, write one value, verify, the lock re-engages).",
          ].join("\n")
        ),
      ],
    })
  );
}
