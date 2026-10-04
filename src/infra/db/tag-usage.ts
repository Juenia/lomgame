import type { Db } from './sqlite.ts';

/** daily_tag_usage：扮演标签的每日用量，防复读刷分的唯一数据来源 */
export class TagUsageRepo {
  #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  usageOf(characterId: string, date: string): Map<string, number> {
    const rows = this.#db
      .prepare('SELECT tag, count FROM daily_tag_usage WHERE character_id = ? AND date = ?')
      .all(characterId, date) as Array<{ tag: string; count: number }>;
    return new Map(rows.map((row) => [row.tag, row.count]));
  }

  countOf(characterId: string, date: string, tag: string): number {
    const row = this.#db
      .prepare('SELECT count FROM daily_tag_usage WHERE character_id = ? AND date = ? AND tag = ?')
      .get(characterId, date, tag) as { count: number } | undefined;
    return row?.count ?? 0;
  }

  distinctCount(characterId: string, date: string): number {
    const row = this.#db
      .prepare('SELECT COUNT(*) AS n FROM daily_tag_usage WHERE character_id = ? AND date = ?')
      .get(characterId, date) as { n: number };
    return row.n;
  }

  /** 一次扮演命中的多个标签一起 +1 */
  record(characterId: string, date: string, tags: readonly string[]): void {
    if (tags.length === 0) return;
    const stmt = this.#db.prepare(
      `INSERT INTO daily_tag_usage (character_id, date, tag, count) VALUES (?, ?, ?, 1)
       ON CONFLICT(character_id, date, tag) DO UPDATE SET count = count + 1`,
    );
    for (const tag of tags) stmt.run(characterId, date, tag);
  }
}
