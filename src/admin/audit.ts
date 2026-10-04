/**
 * 审计检索（M2.53）。
 *
 * 表里一直有数据（玩家的每次指令、GM 的每一次改动都写进去），但后台从来没有
 * 办法按条件翻它 —— 也没人记得还有一张归档表，所以翻旧记录会以为「查不到」。
 *
 * 所以这里**两张表一起查**：audit_logs（热）+ audit_logs_archive（归档），
 * 每条结果标出它来自哪张表。
 */
import type { Db } from '../infra/db/sqlite.ts';

export interface AuditHit {
  id: number;
  userId: string;
  command: string;
  input: string;
  output: string;
  createdAt: number;
  /** true = 来自归档表 */
  archived: boolean;
}

export interface AuditQuery {
  /** 在 input / output 里找 */
  text?: string;
  command?: string;
  userId?: string;
  from?: number;
  to?: number;
  limit?: number;
}

export interface AuditResult {
  hits: AuditHit[];
  hot: number;
  archived: number;
  total: number;
  /** 结果被 limit 截断了（总数比拿回来的多） */
  truncated: boolean;
  /** 实际生效的过滤条件，回显给人看 —— 免得以为筛过了其实没筛 */
  applied: string[];
}

const COLUMNS = 'id, user_id, command, input, output, created_at';

export function searchAudit(db: Db, q: AuditQuery): AuditResult {
  const where: string[] = [];
  const params: Array<string | number> = [];
  const applied: string[] = [];

  if (q.userId !== undefined && q.userId.trim() !== '') {
    where.push('user_id LIKE ?');
    params.push('%' + q.userId.trim() + '%');
    applied.push('玩家 ' + q.userId.trim());
  }
  if (q.command !== undefined && q.command.trim() !== '') {
    where.push('command LIKE ?');
    params.push('%' + q.command.trim() + '%');
    applied.push('指令 ' + q.command.trim());
  }
  if (q.text !== undefined && q.text.trim() !== '') {
    where.push("(COALESCE(input, '') LIKE ? OR COALESCE(output, '') LIKE ?)");
    params.push('%' + q.text.trim() + '%', '%' + q.text.trim() + '%');
    applied.push('内容含 ' + q.text.trim());
  }
  if (q.from !== undefined) { where.push('created_at >= ?'); params.push(q.from); applied.push('起始时间'); }
  if (q.to !== undefined) { where.push('created_at <= ?'); params.push(q.to); applied.push('截止时间'); }

  const clause = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';
  const limit = Math.min(Math.max(q.limit ?? 100, 1), 500);

  const count = (table: string): number =>
    (db.prepare('SELECT COUNT(*) AS n FROM ' + table + ' ' + clause).get(...params) as { n: number }).n;
  const hot = count('audit_logs');
  const archived = count('audit_logs_archive');

  const rows = db
    .prepare(
      'SELECT ' + COLUMNS + ', 0 AS archived FROM audit_logs ' + clause +
      ' UNION ALL SELECT ' + COLUMNS + ', 1 AS archived FROM audit_logs_archive ' + clause +
      ' ORDER BY created_at DESC LIMIT ?',
    )
    .all(...params, ...params, limit) as Array<Record<string, unknown>>;

  return {
    hits: rows.map((r) => ({
      id: Number(r['id']),
      userId: String(r['user_id']),
      command: String(r['command']),
      input: r['input'] === null || r['input'] === undefined ? '' : String(r['input']),
      output: r['output'] === null || r['output'] === undefined ? '' : String(r['output']),
      createdAt: Number(r['created_at']),
      archived: Number(r['archived']) === 1,
    })),
    hot,
    archived,
    total: hot + archived,
    truncated: hot + archived > limit,
    applied,
  };
}
