/**
 * 教会命运的仓储（M2.169）—— 表见 migrations/0053。
 *
 * 只有被神明级事件碰过的教会才在这张表里（内容层的教会照常）。
 */
import type { DatabaseSync } from 'node:sqlite';
import type { ChurchFate, ChurchState } from '../../domain/world/church-fate.ts';

function rowOf(row: Record<string, unknown>): ChurchState {
  return {
    churchId: String(row['church_id']),
    fate: String(row['fate']) as ChurchFate,
    controlledBy: String(row['controlled_by'] ?? ''),
    since: Number(row['since'] ?? 0),
    by: String(row['by'] ?? ''),
    note: String(row['note'] ?? ''),
  };
}

const COLS = 'church_id, fate, controlled_by, since, by, note';

export class ChurchStateRepo {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  all(): ChurchState[] {
    const rows = this.#db.prepare('SELECT ' + COLS + ' FROM church_states').all() as Array<Record<string, unknown>>;
    return rows.map(rowOf);
  }

  of(churchId: string): ChurchState | null {
    const row = this.#db.prepare('SELECT ' + COLS + ' FROM church_states WHERE church_id = ?').get(churchId) as
      | Record<string, unknown>
      | undefined;
    return row === undefined ? null : rowOf(row);
  }

  /** 没记录 = 如常（与另外几张运行时表同一条口径：内容为底） */
  fateOf(churchId: string): ChurchFate {
    return this.of(churchId)?.fate ?? 'intact';
  }

  set(state: ChurchState): void {
    this.#db
      .prepare(
        'INSERT INTO church_states (church_id, fate, controlled_by, since, by, note) VALUES (?, ?, ?, ?, ?, ?) ' +
          'ON CONFLICT(church_id) DO UPDATE SET fate = excluded.fate, controlled_by = excluded.controlled_by, ' +
          'since = excluded.since, by = excluded.by, note = excluded.note',
      )
      .run(state.churchId, state.fate, state.controlledBy, state.since, state.by, state.note);
  }
}
