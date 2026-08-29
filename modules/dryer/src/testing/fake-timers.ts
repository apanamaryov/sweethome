import type { Timers } from "../timers";

interface Pending { at: number; cb: () => void; every: number | null; id: number }

/** Детерминированные таймеры: время двигается только через advance(). */
export class FakeTimers implements Timers {
  now = 0;
  private seq = 0;
  private pending: Pending[] = [];

  setTimeout(cb: () => void, ms: number): unknown {
    const p = { at: this.now + ms, cb, every: null, id: ++this.seq };
    this.pending.push(p);
    return p.id;
  }
  clearTimeout(h: unknown): void {
    this.pending = this.pending.filter((p) => p.id !== h);
  }
  setInterval(cb: () => void, ms: number): unknown {
    const p = { at: this.now + ms, cb, every: ms, id: ++this.seq };
    this.pending.push(p);
    return p.id;
  }
  clearInterval(h: unknown): void {
    this.clearTimeout(h);
  }

  /** Продвигает время, выполняя всё, что созрело, в порядке срабатывания. */
  async advance(ms: number): Promise<void> {
    const target = this.now + ms;
    for (;;) {
      const due = this.pending.filter((p) => p.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.now = due.at;
      if (due.every === null) this.pending = this.pending.filter((p) => p !== due);
      else due.at += due.every;
      due.cb();
      await Promise.resolve(); // дать промисам, ждущим таймер, продвинуться
    }
    this.now = target;
  }
}
