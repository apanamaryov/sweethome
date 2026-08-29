/** Таймеры инъектируются: в тестах их крутят руками (см. testing/fake-timers.ts). */
export interface Timers {
  setTimeout(cb: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
  setInterval(cb: () => void, ms: number): unknown;
  clearInterval(h: unknown): void;
}

export const realTimers: Timers = {
  setTimeout: (cb, ms) => setTimeout(cb, ms),
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
  setInterval: (cb, ms) => setInterval(cb, ms),
  clearInterval: (h) => clearInterval(h as NodeJS.Timeout),
};
