import type { Db } from './sqlite.ts';

/** daily_counters：休息/净化/占卜这类「每日 N 次」的业务限制（与令牌桶频控是两件事） */
export class DailyCounterRepo {
  #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  countOf(characterId: string, date: string, key: string): number {
    const row = this.#db
      .prepare('SELECT count FROM daily_counters WHERE character_id = ? AND date = ? AND key = ?')
      .get(characterId, date, key) as { count: number } | undefined;
    return row?.count ?? 0;
  }

  increment(characterId: string, date: string, key: string): number {
    this.#db
      .prepare(
        `INSERT INTO daily_counters (character_id, date, key, count) VALUES (?, ?, ?, 1)
         ON CONFLICT(character_id, date, key) DO UPDATE SET count = count + 1`,
      )
      .run(characterId, date, key);
    return this.countOf(characterId, date, key);
  }

  remaining(characterId: string, date: string, key: string, limit: number): number {
    return Math.max(0, limit - this.countOf(characterId, date, key));
  }

  todayOf(characterId: string, date: string): Map<string, number> {
    const rows = this.#db
      .prepare('SELECT key, count FROM daily_counters WHERE character_id = ? AND date = ?')
      .all(characterId, date) as Array<{ key: string; count: number }>;
    return new Map(rows.map((row) => [row.key, row.count]));
  }
}
