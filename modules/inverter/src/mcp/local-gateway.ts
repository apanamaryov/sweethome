import type { GatewayCapabilities, InverterGateway, StatsGateway } from "@sweethome/inverter-mcp";
import {
  ALLOWED_MAX_AC_CHARGE_CURRENT,
  ALLOWED_MAX_CHARGE_CURRENT,
  CHARGER_SOURCE_PRIORITY,
  OUTPUT_SOURCE_PRIORITY,
} from "@sweethome/inverter-shared";
import type { ControlType, Snapshot } from "@sweethome/inverter-shared";
import type { Inverter } from "../inverter";
import type { InverterConfig } from "../config";
import type { StatsRecorder } from "../stats/recorder";
import { GAUGE_FIELDS, type GaugeField, localDay } from "../stats/db";

const CSV_LIMIT_BYTES = 5 * 1024 * 1024;
const EXPORT_CHUNK = 10_000;

/**
 * Шлюз без HTTP-хопа: /mcp живёт в том же процессе, что и Inverter, поэтому
 * ходить к себе по сети незачем. Гейты записи остаются серверные — они внутри
 * Inverter.control()/rawQuery().
 */
export function createLocalGateway(
  inverter: Inverter,
  cfg: InverterConfig,
  stats: StatsRecorder | null,
  caps: GatewayCapabilities,
  source: string
): InverterGateway {
  const statsGateway: StatsGateway | null = stats
    ? {
        async series(q) {
          const fields = q.fields.filter((f): f is GaugeField =>
            (GAUGE_FIELDS as readonly string[]).includes(f)
          );
          return stats.db.querySeries(fields, q.from, q.to, q.res);
        },
        async daily(from, to) {
          return stats.db.queryDaily(from, to);
        },
        async energy(from, to, bucket) {
          return stats.db.queryEnergy(from, to, bucket) as unknown as Array<Record<string, number>>;
        },
        async events(q) {
          return stats.db.queryEvents(q);
        },
        async solarWindow(day) {
          const now = Date.now();
          const today = localDay(now);
          const d = day ?? today;
          return { day: d, ...stats.db.querySolarWindow(d, d === today ? now : undefined) };
        },
        async exportCsv(q) {
          const cols = stats.db.exportColumns(q.res);
          const parts = [cols.join(",")];
          let size = parts[0].length;
          let after = q.from - 1;
          let truncated = false;
          for (;;) {
            const chunk = stats.db.exportChunk(q.res, after, q.to, EXPORT_CHUNK);
            if (!chunk.length) break;
            for (const row of chunk) {
              const line = cols.map((c) => row[c] ?? "").join(",");
              size += line.length + 1;
              if (size > CSV_LIMIT_BYTES) {
                truncated = true;
                break;
              }
              parts.push(line);
            }
            if (truncated) break;
            after = Number(chunk[chunk.length - 1].ts);
          }
          return { csv: parts.join("\n") + "\n", truncated };
        },
      }
    : null;

  return {
    async snapshot() {
      return inverter.getSnapshot();
    },
    async meta() {
      return {
        session: { username: source, role: caps.role, mustChangePassword: false },
        allowControl: cfg.allowControl,
        outputSourcePriority: OUTPUT_SOURCE_PRIORITY,
        chargerSourcePriority: CHARGER_SOURCE_PRIORITY,
        maxChargingCurrent: ALLOWED_MAX_CHARGE_CURRENT,
        maxAcChargingCurrent: ALLOWED_MAX_AC_CHARGE_CURRENT,
      };
    },
    async baseline() {
      return inverter.getBaseline();
    },
    async control(type: ControlType, value: number) {
      return inverter.control(type, value, { source });
    },
    async previewControl(type: ControlType, value: number) {
      return inverter.previewControl(type, value);
    },
    async setLock(locked: boolean) {
      return inverter.setLock(locked);
    },
    async recaptureBaseline() {
      return inverter.recaptureBaseline();
    },
    async raw(command: string) {
      return inverter.rawQuery(command, { source });
    },
    stats: statsGateway,
    onSnapshot(cb: (s: Snapshot) => void) {
      inverter.on("snapshot", cb);
      return () => {
        inverter.off("snapshot", cb);
      };
    },
    capabilities() {
      return caps;
    },
    close() {
      /* локальный шлюз ничем не владеет */
    },
  };
}
