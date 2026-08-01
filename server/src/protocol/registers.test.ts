import { REGISTER_DOCS, registerDocsMarkdown } from "@sweethome/inverter-shared";
import type { InverterStatus, InverterRatedInfo } from "@sweethome/inverter-shared";
import { STATUS_BLOCKS, ALARM_BLOCKS, SETTINGS_BLOCKS, decodeStatus, decodeSettings } from "./smg";

/**
 * REGISTER_DOCS (shared) — описательная копия того, что декодируют decodeStatus/
 * decodeSettings. Эти тесты держат её в согласии с кодом: описан только тот адрес,
 * который поллер реально читает, и описано каждое декодируемое поле.
 */

/** Все адреса, которые поллер реально читает. */
function readableAddresses(): Set<number> {
  const set = new Set<number>();
  for (const [start, count] of [...STATUS_BLOCKS, ...ALARM_BLOCKS, ...SETTINGS_BLOCKS]) {
    for (let a = start; a < start + count; a++) set.add(a);
  }
  return set;
}

describe("REGISTER_DOCS", () => {
  it("documents only registers the poller actually reads", () => {
    const readable = readableAddresses();
    const orphans = REGISTER_DOCS.filter((d) => !readable.has(d.addr));
    expect(orphans.map((d) => `${d.addr} (${d.key})`)).toEqual([]);
  });

  it("has no duplicate keys and no empty names", () => {
    const keys = REGISTER_DOCS.map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(REGISTER_DOCS.filter((d) => !d.name.trim() || !d.key.trim())).toEqual([]);
  });

  it("covers every decoded status field", () => {
    const decoded = decodeStatus(new Map()) as InverterStatus;
    const documented = new Set(REGISTER_DOCS.map((d) => d.key));
    const missing = Object.keys(decoded).filter((k) => k !== "raw" && !documented.has(k));
    expect(missing).toEqual([]);
  });

  it("covers every decoded settings field", () => {
    const decoded = decodeSettings(new Map()) as InverterRatedInfo;
    const documented = new Set(REGISTER_DOCS.map((d) => d.key));
    const missing = Object.keys(decoded).filter((k) => k !== "raw" && !documented.has(k));
    expect(missing).toEqual([]);
  });

  it("renders a markdown table with a row per register", () => {
    const md = registerDocsMarkdown();
    expect(md).toContain("| Address | Key |");
    expect(md.split("\n").filter((l) => /^\| \d+ \|/.test(l))).toHaveLength(REGISTER_DOCS.length);
    expect(md).toContain("gridVoltage");
  });
});
