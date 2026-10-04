import type { Db } from './sqlite.ts';

/**
 * daily_ticks：每日 tick 的幂等表（表本身在 0001_init.sql 里建好，date 即主键）。
 * claim() 用 INSERT OR IGNORE 抢占当天，重复执行直接返回 false。
 */
export class DailyTickRepo {
  #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /** 返回 true 表示本次抢到了执行权 */
  claim(date: string, now: number): boolean {
    const result = this.#db
      .prepare('INSERT OR IGNORE INTO daily_ticks (date, executed_at) VALUES (?, ?)')
      .run(date, now);
    return Number(result.changes) > 0;
  }

  hasRun(date: string): boolean {
    const row = this.#db.prepare('SELECT 1 AS ok FROM daily_ticks WHERE date = ?').get(date);
    return Boolean(row);
  }

  latest(): { date: string; executedAt: number } | null {
    const row = this.#db
      .prepare('SELECT date, executed_at FROM daily_ticks ORDER BY date DESC LIMIT 1')
      .get() as { date: string; executed_at: number } | undefined;
    return row ? { date: row.date, executedAt: row.executed_at } : null;
  }

  count(): number {
    const row = this.#db.prepare('SELECT COUNT(*) AS n FROM daily_ticks').get() as { n: number };
    return row.n;
  }
}
