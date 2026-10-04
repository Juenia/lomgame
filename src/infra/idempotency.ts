import type { Db } from './db/sqlite.ts';

/**
 * 幂等键（S1 §7）：QQ 会把同一条消息重推，重复推送必须只处理一次。
 * 用 message_id 做主键 + INSERT OR IGNORE，天然并发安全。
 */
export class IdempotencyStore {
  #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /** 返回 true 表示首次处理，false 表示重复推送 */
  tryMark(messageId: string, userId: string, now: number): boolean {
    const result = this.#db
      .prepare(
        `INSERT OR IGNORE INTO idempotency_keys (message_id, user_id, created_at)
         VALUES (?, ?, ?)`,
      )
      .run(messageId, userId, now);
    return Number(result.changes) > 0;
  }

  /** 只读判断，不写入 */
  seen(messageId: string): boolean {
    const row = this.#db
      .prepare('SELECT 1 AS ok FROM idempotency_keys WHERE message_id = ?')
      .get(messageId);
    return Boolean(row);
  }

  count(): number {
    const row = this.#db.prepare('SELECT COUNT(*) AS n FROM idempotency_keys').get() as {
      n: number;
    };
    return row.n;
  }

  cleanup(beforeTs: number): number {
    const result = this.#db
      .prepare('DELETE FROM idempotency_keys WHERE created_at < ?')
      .run(beforeTs);
    return Number(result.changes);
  }
}
