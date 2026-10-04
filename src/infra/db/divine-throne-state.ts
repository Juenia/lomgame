/**
 * 神座的**运行时状态**仓储（M2.169）—— 见 migrations/0050。
 *
 * 表里只放「与内容不同的部分」：没被阴谋碰过的位置不在这张表里，
 * 读取时由 `mergeThroneState` 用内容兜底。
 */
import type { DatabaseSync } from 'node:sqlite';
import type { SeatKind, ThroneState } from '../../domain/world/divine-throne.ts';
import type { ThroneStateRow } from '../../domain/world/divine-throne-state.ts';

function rowOf(row: Record<string, unknown>): ThroneStateRow {
  return {
    pathway: String(row['pathway']),
    seat: String(row['seat'] ?? ''),
    seatKind: String(row['seat_kind'] ?? ''),
    state: String(row['state']) as ThroneState,
    since: Number(row['since'] ?? 0),
    changedBy: String(row['changed_by'] ?? ''),
    fallNote: String(row['fall_note'] ?? ''),
  };
}

const COLS = 'pathway, seat, seat_kind, state, since, changed_by, fall_note';

export class DivineThroneStateRepo {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  all(): ThroneStateRow[] {
    const rows = this.#db.prepare('SELECT ' + COLS + ' FROM divine_throne_state').all() as Array<Record<string, unknown>>;
    return rows.map(rowOf);
  }

  of(pathway: string): ThroneStateRow | null {
    const row = this.#db
      .prepare('SELECT ' + COLS + ' FROM divine_throne_state WHERE pathway = ?')
      .get(pathway) as Record<string, unknown> | undefined;
    return row === undefined ? null : rowOf(row);
  }

  /** 一般写法（seat / seatKind 不给就沿用内容里那一位的名字） */
  setState(input: {
    pathway: string;
    state: ThroneState;
    seat?: string;
    seatKind?: SeatKind;
    at: number;
    by: string;
    note: string;
  }): ThroneStateRow {
    const current = this.of(input.pathway);
    const seat = input.seat ?? current?.seat ?? '';
    const seatKind = input.seatKind ?? (current?.seatKind as SeatKind | undefined) ?? '';
    this.#db
      .prepare(
        'INSERT INTO divine_throne_state (pathway, seat, seat_kind, state, since, changed_by, fall_note) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(pathway) DO UPDATE SET seat = excluded.seat, ' +
          'seat_kind = excluded.seat_kind, state = excluded.state, since = excluded.since, ' +
          'changed_by = excluded.changed_by, fall_note = excluded.fall_note',
      )
      .run(input.pathway, seat, seatKind, input.state, input.at, input.by, input.note);
    return this.of(input.pathway)!;
  }

  /**
   * **某位神陨落** —— 位置空出来，但 `seat` **不清空**。
   *
   * 原作里战神那一档的记载是「已陨落……**疑似留有复活后手**」：
   * 那句话说得出，正是因为「上一任是谁」还记着。
   */
  recordFall(input: { pathway: string; seat: string; at: number; by: string; note: string }): ThroneStateRow {
    return this.setState({ ...input, state: 'vacant' });
  }

  /** **有人坐上了那个位置**（阴谋的终点，也可能是玩家） */
  recordUsurp(input: {
    pathway: string;
    seat: string;
    seatKind: SeatKind;
    at: number;
    by: string;
    note: string;
  }): ThroneStateRow {
    return this.setState({ ...input, state: 'occupied' });
  }
}
