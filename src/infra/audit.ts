import type { Db } from './db/sqlite.ts';

export interface AuditEntry {
  userId: string;
  command: string;
  input?: string;
  output?: string;
  createdAt: number;
}

/** 审计日志（S1 §7 / 验收标准「审计日志完整」） */
export class AuditLog {
  #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  write(entry: AuditEntry): void {
    this.#db
      .prepare(
        `INSERT INTO audit_logs (user_id, command, input, output, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(entry.userId, entry.command, entry.input ?? null, entry.output ?? null, entry.createdAt);
  }

  recent(userId: string, limit = 20): AuditEntry[] {
    const rows = this.#db
      .prepare(
        `SELECT user_id, command, input, output, created_at FROM audit_logs
         WHERE user_id = ? ORDER BY id DESC LIMIT ?`,
      )
      .all(userId, limit) as Array<{
      user_id: string;
      command: string;
      input: string | null;
      output: string | null;
      created_at: number;
    }>;
    return rows.map((r) => ({
      userId: r.user_id,
      command: r.command,
      input: r.input ?? undefined,
      output: r.output ?? undefined,
      createdAt: r.created_at,
    }));
  }

  count(): number {
    const row = this.#db.prepare('SELECT COUNT(*) AS n FROM audit_logs').get() as { n: number };
    return row.n;
  }
}
