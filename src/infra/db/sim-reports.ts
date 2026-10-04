import type { Db } from './sqlite.ts';

export interface SimReportRecord {
  id: string;
  createdAt: number;
  configJson: string;
  summaryJson: string;
  note?: string | null;
}

export interface SimReportRow {
  id: string;
  createdAt: number;
  /** 解析失败时是 null（旧记录格式变了也不该让面板整个崩掉） */
  config: unknown;
  summary: unknown;
  note: string;
}

/** sim_reports：模拟器跑出来的结论要能追溯（表在 0005 迁移里，仓储补在这里） */
export class SimReportRepo {
  #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  insert(record: SimReportRecord): void {
    this.#db
      .prepare(
        'INSERT INTO sim_reports (id, created_at, config_json, summary_json, note) VALUES (?, ?, ?, ?, ?)',
      )
      .run(record.id, record.createdAt, record.configJson, record.summaryJson, record.note ?? null);
  }

  latest(limit = 10): SimReportRow[] {
    const rows = this.#db
      .prepare(
        'SELECT id, created_at, config_json, summary_json, note FROM sim_reports ORDER BY created_at DESC LIMIT ?',
      )
      .all(Math.min(Math.max(limit, 1), 100)) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r['id']),
      createdAt: Number(r['created_at']),
      config: safeParse(r['config_json']),
      summary: safeParse(r['summary_json']),
      note: r['note'] === null || r['note'] === undefined ? '' : String(r['note']),
    }));
  }

  count(): number {
    return (this.#db.prepare('SELECT COUNT(*) AS n FROM sim_reports').get() as { n: number }).n;
  }
}

function safeParse(text: unknown): unknown {
  try {
    return JSON.parse(String(text));
  } catch {
    return null;
  }
}
