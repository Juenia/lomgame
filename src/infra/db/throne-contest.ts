/**
 * 神位争夺的仓储（M2.170）—— 表见 migrations/0056。
 *
 * `pathway` 是主键：一条途径同时只能有一场争夺（序列 0 是唯一的）。
 */
import type { DatabaseSync } from 'node:sqlite';
import type { ContestStatus, ThroneContest } from '../../domain/world/throne-contest.ts';

function rowOf(row: Record<string, unknown>): ThroneContest {
  let rivals: string[] = [];
  try {
    const parsed = JSON.parse(String(row['rivals_json'] ?? '[]'));
    if (Array.isArray(parsed)) rivals = parsed.map(String);
  } catch {
    // 坏数据当作「没人对撞」—— 于是它会按正常流程落地，而不是永远卡住
    rivals = [];
  }
  return {
    pathway: String(row['pathway']),
    status: String(row['status']) as ContestStatus,
    claimantId: String(row['claimant_id'] ?? ''),
    rivals,
    extensions: Number(row['extensions'] ?? 0),
    startedAt: Number(row['started_at'] ?? 0),
    endsAt: Number(row['ends_at'] ?? 0),
    brokenBy: String(row['broken_by'] ?? ''),
    note: String(row['note'] ?? ''),
  };
}

const COLS = 'pathway, status, claimant_id, rivals_json, extensions, started_at, ends_at, broken_by, note';

export class ThroneContestRepo {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  all(): ThroneContest[] {
    const rows = this.#db.prepare('SELECT ' + COLS + ' FROM throne_contests').all() as Array<Record<string, unknown>>;
    return rows.map(rowOf);
  }

  /** 正在进行的那些（有人已经在上面了） */
  open(): ThroneContest[] {
    const rows = this.#db
      .prepare("SELECT " + COLS + " FROM throne_contests WHERE status = 'rite'")
      .all() as Array<Record<string, unknown>>;
    return rows.map(rowOf);
  }

  of(pathway: string): ThroneContest | null {
    const row = this.#db.prepare('SELECT ' + COLS + ' FROM throne_contests WHERE pathway = ?').get(pathway) as
      | Record<string, unknown>
      | undefined;
    return row === undefined ? null : rowOf(row);
  }

  /** 他是不是已经在某条途径上坐着（一个人同时只能争一个位置） */
  byClaimant(characterId: string): ThroneContest | null {
    return this.open().find((contest) => contest.claimantId === characterId) ?? null;
  }

  /** 第一个上去的人（开一场仪式） */
  begin(input: { pathway: string; claimantId: string; startedAt: number; endsAt: number }): void {
    this.#db
      .prepare(
        'INSERT INTO throne_contests (pathway, status, claimant_id, rivals_json, extensions, started_at, ends_at, broken_by, note) ' +
          "VALUES (?, 'rite', ?, '[]', 0, ?, ?, '', '')" +
          ' ON CONFLICT(pathway) DO UPDATE SET status = excluded.status, claimant_id = excluded.claimant_id, ' +
          "rivals_json = '[]', extensions = 0, " +
          'started_at = excluded.started_at, ends_at = excluded.ends_at, broken_by = \'\', note = \'\'',
      )
      .run(input.pathway, input.claimantId, input.startedAt, input.endsAt);
  }

  /**
   * **后来者加入对撞**（他也上来了 —— 不是打断，是争）。
   *
   * ⚠️ 仪式时间表**重算**（人越多越久），而 `extensions` 归零：
   * 新来的那个还没拖过，凭什么替他记账。
   */
  joinClash(input: { pathway: string; rivalId: string; endsAt: number }): void {
    const contest = this.of(input.pathway);
    if (contest === null) return;
    const rivals = contest.rivals.includes(input.rivalId)
      ? contest.rivals
      : [...contest.rivals, input.rivalId];
    this.#db
      .prepare('UPDATE throne_contests SET rivals_json = ?, ends_at = ?, extensions = 0 WHERE pathway = ?')
      .run(JSON.stringify(rivals), input.endsAt, input.pathway);
  }

  /** 对撞拖期（到期了但还有人争 —— 这一局不算数，时间表往后拖） */
  extend(input: { pathway: string; endsAt: number; extensions: number }): void {
    this.#db
      .prepare('UPDATE throne_contests SET ends_at = ?, extensions = ? WHERE pathway = ?')
      .run(input.endsAt, input.extensions, input.pathway);
  }

  /** 上位成功 */
  settle(pathway: string, note: string): void {
    this.#db.prepare("UPDATE throne_contests SET status = 'settled', note = ? WHERE pathway = ?").run(note, pathway);
  }

  /** 仪式断了（被打断 / 他死了 / 自己放弃）—— 位置继续空着，但这件事被记下来 */
  lapse(input: { pathway: string; brokenBy: string; note: string }): void {
    this.#db
      .prepare("UPDATE throne_contests SET status = 'lapsed', broken_by = ?, note = ? WHERE pathway = ?")
      .run(input.brokenBy, input.note, input.pathway);
  }
}
