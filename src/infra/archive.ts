/**
 * 审计日志轮转（W5 运维项）：把热表里过期的 audit_logs 搬到归档表。
 * 主表只保留最近 N 天，查询与写入都不会随时间变慢；归档表用于事后审计。
 */
import type { Db } from './db/sqlite.ts';
import { withTransaction } from './db/sqlite.ts';

export interface ArchiveResult {
  moved: number;
  hotRemaining: number;
  archivedTotal: number;
}

export function archiveAuditLogs(db: Db, beforeTs: number, now: number): ArchiveResult {
  const moved = withTransaction(db, () => {
    const insert = db
      .prepare(
        `INSERT OR IGNORE INTO audit_logs_archive
           (id, user_id, command, input, output, created_at, archived_at)
         SELECT id, user_id, command, input, output, created_at, ?
         FROM audit_logs WHERE created_at < ?`,
      )
      .run(now, beforeTs);
    db.prepare('DELETE FROM audit_logs WHERE created_at < ?').run(beforeTs);
    return Number(insert.changes);
  });

  return { moved, ...archiveStats(db) };
}

export function archiveStats(db: Db): { hotRemaining: number; archivedTotal: number } {
  const hot = db.prepare('SELECT COUNT(*) AS n FROM audit_logs').get() as { n: number };
  const archived = db.prepare('SELECT COUNT(*) AS n FROM audit_logs_archive').get() as { n: number };
  return { hotRemaining: hot.n, archivedTotal: archived.n };
}
