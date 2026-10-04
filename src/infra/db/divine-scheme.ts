/**
 * 神明阴谋的仓储（M2.169）—— 表见 migrations/0051_m2_169_divine_schemes.sql。
 *
 * 与 `npc_schemes` 是两件事：那一个是「一个人算计另一个人」，
 * 这一个是「一位神算计另一位神」—— 它动的是**神座**。
 */
import type { DatabaseSync } from 'node:sqlite';
import type { DivineSchemeState, SchemeGoal, SchemeStage } from '../../domain/world/divine-scheme.ts';

function rowOf(row: Record<string, unknown>): DivineSchemeState {
  let allies: string[] = [];
  try {
    const parsed = JSON.parse(String(row['allies_json'] ?? '[]'));
    if (Array.isArray(parsed)) allies = parsed.map(String);
  } catch {
    allies = [];
  }
  return {
    id: String(row['id']),
    schemer: String(row['schemer']),
    target: String(row['target']),
    goal: String(row['goal']) as SchemeGoal,
    stage: String(row['stage']) as SchemeStage,
    progress: Number(row['progress'] ?? 0),
    exposed: Number(row['exposed'] ?? 0),
    allies,
    startedAt: Number(row['started_at'] ?? 0),
    dueAt: Number(row['due_at'] ?? 0),
    outcome: String(row['outcome'] ?? ''),
  };
}

const COLS = 'id, schemer, target, goal, stage, progress, exposed, allies_json, started_at, due_at, outcome';

export class DivineSchemeRepo {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  /** 进行中的那些（结局为空） */
  open(): DivineSchemeState[] {
    const rows = this.#db
      .prepare('SELECT ' + COLS + ' FROM divine_schemes WHERE outcome = \'\' ORDER BY due_at ASC')
      .all() as Array<Record<string, unknown>>;
    return rows.map(rowOf);
  }

  /** 全部（含已了结的 —— `.世界 神明` 要能把旧账翻出来） */
  all(): DivineSchemeState[] {
    const rows = this.#db.prepare('SELECT ' + COLS + ' FROM divine_schemes ORDER BY started_at DESC').all() as Array<
      Record<string, unknown>
    >;
    return rows.map(rowOf);
  }

  of(id: string): DivineSchemeState | null {
    const row = this.#db.prepare('SELECT ' + COLS + ' FROM divine_schemes WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row === undefined ? null : rowOf(row);
  }

  /** 这条途径有没有正在进行的阴谋（一位神不会同时开两局对着同一个人） */
  openBySchemer(schemer: string): DivineSchemeState | null {
    return this.open().find((scheme) => scheme.schemer === schemer) ?? null;
  }

  create(scheme: DivineSchemeState): void {
    this.#db
      .prepare(
        'INSERT INTO divine_schemes (id, schemer, target, goal, stage, progress, exposed, allies_json, started_at, due_at, outcome) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        scheme.id, scheme.schemer, scheme.target, scheme.goal, scheme.stage,
        scheme.progress, scheme.exposed, JSON.stringify(scheme.allies),
        scheme.startedAt, scheme.dueAt, scheme.outcome,
      );
  }

  /** 推进一步（阶段 / 到期时刻 / 暴露度一起更新） */
  advance(input: { id: string; stage: SchemeStage; progress: number; exposed: number; dueAt: number }): void {
    this.#db
      .prepare('UPDATE divine_schemes SET stage = ?, progress = ?, exposed = ?, due_at = ? WHERE id = ?')
      .run(input.stage, input.progress, input.exposed, input.dueAt, input.id);
  }

  /** 了结（done / foiled / half）—— 留痕，不删 */
  close(input: { id: string; outcome: string; at: number }): void {
    this.#db
      .prepare('UPDATE divine_schemes SET outcome = ?, closed_at = ? WHERE id = ?')
      .run(input.outcome, input.at, input.id);
  }
}
