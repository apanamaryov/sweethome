import fs from "fs";
import path from "path";
import { Baseline } from "@inverter/shared";

/**
 * Tiny JSON persistence for the captured settings baseline. Kept deliberately
 * simple (single file) — this is an appliance, not a database.
 */
export class Store {
  private file: string;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "baseline.json");
    fs.mkdirSync(dataDir, { recursive: true });
  }

  loadBaseline(): Baseline | null {
    try {
      const txt = fs.readFileSync(this.file, "utf8");
      return JSON.parse(txt) as Baseline;
    } catch {
      return null;
    }
  }

  saveBaseline(b: Baseline): void {
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(b, null, 2), "utf8");
    fs.renameSync(tmp, this.file); // atomic replace
  }

  clearBaseline(): void {
    try {
      fs.unlinkSync(this.file);
    } catch {
      /* ignore */
    }
  }
}
