/**
 * 神明的**持久化**（M2.168）—— 计划与出手状态两张表（见 migrations/0049）。
 *
 * 在这之前它们是进程内的（`DivinePlans` 的 Map 与 `deps.divineState`），重启就丢。
 * 丢的代价不是报错，而是两件**看起来像设计**的怪事：
 *   · 祂正要走完的计划链从第三步回到第一步 —— 像神在反复做同一件事
 *   · 沉寂期与手段冷却一起清空 —— 重启那一刻众神可能连着出手
 *
 * ⚠️ 判定层只认 `DivinePlanStore` / `DivineStateStore` 两个接口（domain/world/divine-mind.ts），
 * 所以这里**不改变任何判定逻辑** —— 换的只是「记在哪儿」。
 */
import type { DatabaseSync } from 'node:sqlite';
import type { DivineActState, DivinePlanStore, DivineStateStore, GoalPlan } from '../../domain/world/divine-mind.ts';

function planOf(row: Record<string, unknown>): GoalPlan {
  let steps: string[] = [];
  try {
    const parsed = JSON.parse(String(row['steps_json'] ?? '[]'));
    if (Array.isArray(parsed)) steps = parsed.map(String);
  } catch {
    // 坏数据当作「没有步骤」—— 于是这一步之后它会走完并被清掉，而不是永远卡住
    steps = [];
  }
  return {
    goalId: String(row['goal_id']),
    steps,
    step: Number(row['step'] ?? 0),
    startedAt: Number(row['started_at'] ?? 0),
  };
}

export class DivinePlansRepo implements DivinePlanStore {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  get(seat: string): GoalPlan | null {
    const row = this.#db
      .prepare('SELECT goal_id, steps_json, step, started_at FROM divine_plans WHERE seat = ?')
      .get(seat) as Record<string, unknown> | undefined;
    return row === undefined ? null : planOf(row);
  }

  begin(seat: string, goalId: string, steps: string[], at: number): GoalPlan {
    this.#db
      .prepare(
        'INSERT INTO divine_plans (seat, goal_id, steps_json, step, started_at) VALUES (?, ?, ?, 0, ?) ' +
          'ON CONFLICT(seat) DO UPDATE SET goal_id = excluded.goal_id, steps_json = excluded.steps_json, ' +
          'step = 0, started_at = excluded.started_at',
      )
      .run(seat, goalId, JSON.stringify(steps), at);
    return { goalId, steps: [...steps], step: 0, startedAt: at };
  }

  /**
   * 推进一步；**走完就清掉** —— 与内存版（`DivinePlans.advance`）逐字一致。
   *
   * ⚠️ 两处实现的分叉会让「神的计划」在重启前后行为不同，而那种差异只在重启那一刻出现。
   */
  advance(seat: string): GoalPlan | null {
    const plan = this.get(seat);
    if (plan === null) return null;
    const next = plan.step + 1;
    if (next >= plan.steps.length) {
      this.#db.prepare('DELETE FROM divine_plans WHERE seat = ?').run(seat);
    } else {
      this.#db.prepare('UPDATE divine_plans SET step = ? WHERE seat = ?').run(next, seat);
    }
    return { ...plan, step: next };
  }

  /** 在世的计划（`.世界 神明` 与运维报表读它） */
  all(): Array<GoalPlan & { seat: string }> {
    const rows = this.#db.prepare('SELECT seat, goal_id, steps_json, step, started_at FROM divine_plans').all() as Array<
      Record<string, unknown>
    >;
    return rows.map((row) => ({ seat: String(row['seat']), ...planOf(row) }));
  }
}

export class DivineStateRepo implements DivineStateStore {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  get(pathway: string): DivineActState | undefined {
    const row = this.#db
      .prepare('SELECT last_act_at, method_used_json FROM divine_state WHERE pathway = ?')
      .get(pathway) as Record<string, unknown> | undefined;
    if (row === undefined) return undefined;
    let methodUsedAt: Record<string, number> = {};
    try {
      const parsed = JSON.parse(String(row['method_used_json'] ?? '{}')) as Record<string, unknown>;
      for (const [key, value] of Object.entries(parsed ?? {})) methodUsedAt[key] = Number(value);
    } catch {
      methodUsedAt = {};
    }
    return { lastActAt: Number(row['last_act_at'] ?? 0), methodUsedAt };
  }

  set(pathway: string, state: DivineActState): void {
    this.#db
      .prepare(
        'INSERT INTO divine_state (pathway, last_act_at, method_used_json) VALUES (?, ?, ?) ' +
          'ON CONFLICT(pathway) DO UPDATE SET last_act_at = excluded.last_act_at, ' +
          'method_used_json = excluded.method_used_json',
      )
      .run(pathway, state.lastActAt, JSON.stringify(state.methodUsedAt));
  }
}
