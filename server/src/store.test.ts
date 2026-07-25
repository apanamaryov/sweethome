/**
 * Unit tests for Store (server/src/store.ts) — baseline JSON persistence.
 *
 * How store.ts actually works (read from source, not assumed):
 *   - Store's constructor joins dataDir + "baseline.json" into `this.file`
 *     and calls fs.mkdirSync(dataDir, { recursive: true }) eagerly.
 *   - loadBaseline() reads `this.file` as utf8 and JSON.parse()s it; ANY
 *     failure (missing file, bad JSON) is swallowed by a try/catch that
 *     returns null — there is no distinction between "not found" and
 *     "corrupt".
 *   - saveBaseline(b) writes pretty-printed JSON (2-space indent) to
 *     `this.file + ".tmp"` via writeFileSync, then fs.renameSync()s the tmp
 *     file over the real one (atomic replace) — it never writes the real
 *     file path directly.
 *   - clearBaseline() unlinkSync()s `this.file`, swallowing any error.
 *
 * fs is fully mocked (factory below) so none of this ever touches the real
 * filesystem — no temp dir needed.
 */

jest.mock("fs", () => ({
  mkdirSync: jest.fn(),
  readFileSync: jest.fn(),
  writeFileSync: jest.fn(),
  renameSync: jest.fn(),
  unlinkSync: jest.fn(),
}));

import fs from "fs";
import path from "path";
import { Baseline } from "@inverter/shared";
import { Store } from "./store";

const mkdirSync = fs.mkdirSync as jest.Mock;
const readFileSync = fs.readFileSync as jest.Mock;
const writeFileSync = fs.writeFileSync as jest.Mock;
const renameSync = fs.renameSync as jest.Mock;
const unlinkSync = fs.unlinkSync as jest.Mock;

const DATA_DIR = "/fake/data";
const BASELINE_FILE = path.join(DATA_DIR, "baseline.json");

const sampleBaseline: Baseline = {
  deviceId: "sk5500p48l-0001",
  capturedAt: 1_753_200_000_000,
  info: null,
  flags: null,
};

beforeEach(() => {
  mkdirSync.mockReset();
  readFileSync.mockReset();
  writeFileSync.mockReset();
  renameSync.mockReset();
  unlinkSync.mockReset();
});

describe("Store constructor", () => {
  it("ensures the data directory exists via a recursive mkdir", () => {
    new Store(DATA_DIR);

    expect(mkdirSync).toHaveBeenCalledWith(DATA_DIR, { recursive: true });
  });
});

describe("Store.loadBaseline", () => {
  it("returns the parsed baseline when the file exists and holds valid JSON", () => {
    readFileSync.mockReturnValue(JSON.stringify(sampleBaseline));

    const store = new Store(DATA_DIR);
    const result = store.loadBaseline();

    expect(readFileSync).toHaveBeenCalledWith(BASELINE_FILE, "utf8");
    expect(result).toEqual(sampleBaseline);
  });

  it("returns null when the file does not exist (readFileSync throws ENOENT)", () => {
    readFileSync.mockImplementation(() => {
      const err = new Error("no such file or directory") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    });

    const store = new Store(DATA_DIR);

    expect(store.loadBaseline()).toBeNull();
  });

  it("returns null (not a throw) when the file contains invalid JSON", () => {
    readFileSync.mockReturnValue("{ not valid json");

    const store = new Store(DATA_DIR);

    expect(store.loadBaseline()).toBeNull();
  });
});

describe("Store.saveBaseline", () => {
  it("writes pretty-printed JSON to a .tmp file, then atomically renames it into place", () => {
    const store = new Store(DATA_DIR);

    store.saveBaseline(sampleBaseline);

    const tmpFile = BASELINE_FILE + ".tmp";
    expect(writeFileSync).toHaveBeenCalledWith(tmpFile, JSON.stringify(sampleBaseline, null, 2), "utf8");
    expect(renameSync).toHaveBeenCalledWith(tmpFile, BASELINE_FILE);
  });

  it("writes before renaming (tmp-then-rename ordering, so a crash mid-write can't corrupt the real file)", () => {
    const store = new Store(DATA_DIR);

    store.saveBaseline(sampleBaseline);

    const writeOrder = writeFileSync.mock.invocationCallOrder[0];
    const renameOrder = renameSync.mock.invocationCallOrder[0];
    expect(writeOrder).toBeLessThan(renameOrder);
  });
});

describe("Store.clearBaseline", () => {
  it("unlinks the baseline file", () => {
    const store = new Store(DATA_DIR);

    store.clearBaseline();

    expect(unlinkSync).toHaveBeenCalledWith(BASELINE_FILE);
  });

  it("swallows the error when the file is already gone", () => {
    unlinkSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    const store = new Store(DATA_DIR);

    expect(() => store.clearBaseline()).not.toThrow();
  });
});
