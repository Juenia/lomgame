import type { Db } from './sqlite.ts';

export interface FeedbackRow {
  id: number;
  userId: string;
  characterId: string | null;
  content: string;
  category: string;
  status: string;
  createdAt: number;
  handledAt: number | null;
}

/** feedback：封测期玩家反馈（.反馈 指令写入，运营在复盘时分类） */
export class FeedbackRepo {
  #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  add(input: { userId: string; characterId?: string | null; content: string; createdAt: number }): number {
    const result = this.#db
      .prepare(
        `INSERT INTO feedback (user_id, character_id, content, created_at) VALUES (?, ?, ?, ?)`,
      )
      .run(input.userId, input.characterId ?? null, input.content, input.createdAt);
    return Number(result.lastInsertRowid);
  }

  getById(id: number): FeedbackRow | null {
    const row = this.#db.prepare('SELECT * FROM feedback WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? toRow(row) : null;
  }

  count(): number {
    const row = this.#db.prepare('SELECT COUNT(*) AS n FROM feedback').get() as { n: number };
    return row.n;
  }

  /** 投诉类反馈数（投诉率 = 投诉数 / 活跃用户数） */
  countByCategory(category: string): number {
    const row = this.#db
      .prepare('SELECT COUNT(*) AS n FROM feedback WHERE category = ?')
      .get(category) as { n: number };
    return row.n;
  }

  recent(limit = 20): FeedbackRow[] {
    const rows = this.#db
      .prepare('SELECT * FROM feedback ORDER BY created_at DESC LIMIT ?')
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map(toRow);
  }

  setCategory(id: number, category: string): void {
    this.#db.prepare('UPDATE feedback SET category = ? WHERE id = ?').run(category, id);
  }

  markHandled(id: number, now: number, status = 'triaged'): void {
    this.#db.prepare('UPDATE feedback SET status = ?, handled_at = ? WHERE id = ?').run(status, now, id);
  }
}

function toRow(row: Record<string, unknown>): FeedbackRow {
  return {
    id: Number(row.id),
    userId: String(row.user_id),
    characterId: row.character_id === null ? null : String(row.character_id),
    content: String(row.content),
    category: String(row.category),
    status: String(row.status),
    createdAt: Number(row.created_at),
    handledAt: row.handled_at === null || row.handled_at === undefined ? null : Number(row.handled_at),
  };
}
