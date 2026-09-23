import fs from "fs";
import path from "path";
import { Baseline } from "@sweethome/inverter-shared";

/**
 * Tiny JSON persistence for the captured settings baseline. Kept deliberately
 * simple (single file) — this is an appliance, not a database.
 */
export class Store {
  private file: string;
  private scheduleFile: string;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "baseline.json");
    this.scheduleFile = path.join(dataDir, "schedule.json");
    fs.mkdirSync(dataDir, { recursive: true });
  }

  /** Включён ли ночной тариф — переживает перезапуск сервиса. */
  loadNightTariff(): boolean {
    try {
      return JSON.parse(fs.readFileSync(this.scheduleFile, "utf8")).nightTariff === true;
    } catch {
      return false;
    }
  }

  saveNightTariff(enabled: boolean): void {
    const tmp = this.scheduleFile + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ nightTariff: enabled }, null, 2), "utf8");
    fs.renameSync(tmp, this.scheduleFile);
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
