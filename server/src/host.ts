import type { HomeModule, ModuleHealth } from "@sweethome/shared/module";

/** Владелец рантайм-состояния модулей: старт/стоп с изоляцией ошибок и сводное здоровье. */
export class ModuleHost {
  private startErrors = new Map<string, string>();

  constructor(readonly modules: HomeModule[]) {}

  async startAll(): Promise<void> {
    for (const m of this.modules) {
      try {
        await m.start();
      } catch (e) {
        const msg = (e as Error).message;
        this.startErrors.set(m.id, msg);
        console.error(`[sweethome] module "${m.id}" failed to start:`, msg);
      }
    }
  }

  async stopAll(): Promise<void> {
    for (const m of this.modules) {
      try {
        await m.stop();
      } catch (e) {
        console.error(`[sweethome] module "${m.id}" failed to stop:`, (e as Error).message);
      }
    }
  }

  health(): { ok: boolean; modules: Record<string, ModuleHealth> } {
    const modules: Record<string, ModuleHealth> = {};
    let ok = true;
    for (const m of this.modules) {
      const err = this.startErrors.get(m.id);
      const h: ModuleHealth = err ? { ok: false, details: { error: err } } : m.health();
      modules[m.id] = h;
      if (!h.ok) ok = false;
    }
    return { ok, modules };
  }
}
