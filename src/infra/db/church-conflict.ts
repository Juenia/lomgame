/**
 * 势力争夺的增量表（M2.18 任务 B）：church_territory_contest。
 *
 * 只做三件事：记一条增量、读全部、读某地点的。
 * **归属的计算不在这里** —— 那是 domain/church/conflict.ts 的纯函数。
 */
import type { ContestRow } from '../../domain/church/conflict.ts';
import type { Db } from './sqlite.ts';

interface ContestDbRow {
  location_id: string;
  winner_church_id: string;
  delta: number;
}

export class ChurchConflictRepo {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /** 记一条增量（一次 PVP 胜利 +1 / 每日衰减 -1） */
  record(input: { locationId: string; winnerChurchId: string; delta: number; now: number }): void {
    this.#db
      .prepare(
        'INSERT INTO church_territory_contest (location_id, winner_church_id, delta, created_at) VALUES (?, ?, ?, ?)',
      )
      .run(input.locationId, input.winnerChurchId, input.delta, input.now);
  }

  /** 全部增量（归属计算与报告都读它） */
  all(): ContestRow[] {
    const rows = this.#db
      .prepare('SELECT location_id, winner_church_id, delta FROM church_territory_contest')
      .all() as unknown as ContestDbRow[];
    return rows.map((row) => ({
      locationId: row.location_id,
      winnerChurchId: row.winner_church_id,
      delta: Number(row.delta),
    }));
  }

  /** 某地点的增量 */
  ofLocation(locationId: string): ContestRow[] {
    const rows = this.#db
      .prepare(
        'SELECT location_id, winner_church_id, delta FROM church_territory_contest WHERE location_id = ?',
      )
      .all(locationId) as unknown as ContestDbRow[];
    return rows.map((row) => ({
      locationId: row.location_id,
      winnerChurchId: row.winner_church_id,
      delta: Number(row.delta),
    }));
  }

  /** 行数（验收与报告用） */
  count(): number {
    const row = this.#db
      .prepare('SELECT COUNT(*) AS n FROM church_territory_contest')
      .get() as unknown as { n: number };
    return Number(row.n);
  }
}
