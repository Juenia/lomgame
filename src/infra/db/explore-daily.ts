import type { Db } from './sqlite.ts';

/** explore_daily：同一地点每日探索次数 */
export class ExploreDailyRepo {
  #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  countOf(characterId: string, date: string, locationId: string): number {
    const row = this.#db
      .prepare('SELECT count FROM explore_daily WHERE character_id = ? AND date = ? AND location_id = ?')
      .get(characterId, date, locationId) as { count: number } | undefined;
    return row?.count ?? 0;
  }

  increment(characterId: string, date: string, locationId: string): number {
    this.#db
      .prepare(
        `INSERT INTO explore_daily (character_id, date, location_id, count) VALUES (?, ?, ?, 1)
         ON CONFLICT(character_id, date, location_id) DO UPDATE SET count = count + 1`,
      )
      .run(characterId, date, locationId);
    return this.countOf(characterId, date, locationId);
  }

  todayOf(characterId: string, date: string): Map<string, number> {
    const rows = this.#db
      .prepare('SELECT location_id, count FROM explore_daily WHERE character_id = ? AND date = ?')
      .all(characterId, date) as Array<{ location_id: string; count: number }>;
    return new Map(rows.map((row) => [row.location_id, row.count]));
  }
}
