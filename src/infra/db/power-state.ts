/**
 * 文明势力的运行时状态与关系（M2.59）。
 *
 * 与 powers.yaml 的分工和 M2.58 的 zone_state 完全一致：
 *   powers.yaml      —— 内容。势力是什么，静态。
 *   power_state      —— 世界状态。警觉会涨会落。
 *   power_relations  —— 势力之间的关系，可被运行时改写。
 */
import type { Db } from './sqlite.ts';
import { INFLUENCE_NEUTRAL, type PowerRelationKind, type PowerState } from '../../domain/world/power.ts';

export interface PowerRelation {
  fromPowerId: string;
  toPowerId: string;
  kind: PowerRelationKind;
  weight: number;
}

export class PowerStateRepo {
  #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /** 全部势力的状态（最多十几家，一次读全比按需查更省事） */
  all(): Map<string, PowerState> {
    const rows = this.#db.prepare('SELECT * FROM power_state').all() as Array<Record<string, unknown>>;
    const out = new Map<string, PowerState>();
    for (const row of rows) {
      const powerId = String(row['power_id']);
      out.set(powerId, {
        powerId,
        alert: clamp01(Number(row['alert'] ?? 0)),
        influence: clamp01(Number(row['influence'] ?? 0.5)),
        reactionCount: Number(row['reaction_count'] ?? 0),
        lastReactionAt: row['last_reaction_at'] === null ? null : Number(row['last_reaction_at']),
      });
    }
    return out;
  }

  /** 只读警觉 —— 反应引擎只要这一个 */
  alertByPower(): Map<string, number> {
    const out = new Map<string, number>();
    for (const [powerId, state] of this.all()) out.set(powerId, state.alert);
    return out;
  }

  /**
   * 记一次反应：警觉 +delta（clamp 到 1），计数 +1。
   *
   * UPSERT 而不是「先查后写」—— 与 zone_state 的 recordSighting 同一个理由：
   * 世界 tick 与惰性推进可能并发，先查后写会丢更新。
   */
  recordReaction(powerId: string, at: number, alertDelta: number): void {
    this.#db
      .prepare(
        `INSERT INTO power_state (power_id, alert, influence, reaction_count, last_reaction_at, updated_at)
         VALUES (?, ?, 0.5, 1, ?, ?)
         ON CONFLICT(power_id) DO UPDATE SET
           alert = MIN(1.0, power_state.alert + ?),
           reaction_count = power_state.reaction_count + 1,
           last_reaction_at = ?,
           updated_at = ?`,
      )
      .run(powerId, clamp01(alertDelta), at, at, clamp01(alertDelta), at, at);
  }

  /**
   * M2.67：**加减影响力**（clamp 到 0—1）。
   *
   * 在这之前 `influence` 是个**死列**：两张 UPSERT 都把它写成字面量 0.5，
   * 没有任何地方改过它、也没有任何判定读过它（M2.59 §5.2 登记为「只落数据」）。
   * 现在它由 `influenceDeltaOf` 推动（属地内涨、属地外落）。
   */
  addInfluence(powerId: string, delta: number, at: number): void {
    this.#db
      .prepare(
        `INSERT INTO power_state (power_id, alert, influence, reaction_count, last_reaction_at, updated_at)
         VALUES (?, 0, ?, 0, NULL, ?)
         ON CONFLICT(power_id) DO UPDATE SET
           influence = MAX(0.0, MIN(1.0, power_state.influence + ?)),
           updated_at = ?`,
      )
      .run(powerId, clamp01(INFLUENCE_NEUTRAL + delta), at, delta, at);
  }

  /** 把影响力设成某个值（衰减用） */
  setInfluence(powerId: string, influence: number, at: number): void {
    this.#db
      .prepare(
        `INSERT INTO power_state (power_id, alert, influence, reaction_count, last_reaction_at, updated_at)
         VALUES (?, 0, ?, 0, NULL, ?)
         ON CONFLICT(power_id) DO UPDATE SET influence = ?, updated_at = ?`,
      )
      .run(powerId, clamp01(influence), at, clamp01(influence), at);
  }

  /** 把警觉设成某个值（衰减用） */
  setAlert(powerId: string, alert: number, at: number): void {
    this.#db
      .prepare(
        `INSERT INTO power_state (power_id, alert, influence, reaction_count, last_reaction_at, updated_at)
         VALUES (?, ?, 0.5, 0, NULL, ?)
         ON CONFLICT(power_id) DO UPDATE SET alert = ?, updated_at = ?`,
      )
      .run(powerId, clamp01(alert), at, clamp01(alert), at);
  }

  count(): number {
    const row = this.#db.prepare('SELECT COUNT(*) AS n FROM power_state').get() as { n: number };
    return row.n;
  }
}

export class PowerRelationRepo {
  #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  all(): PowerRelation[] {
    const rows = this.#db.prepare('SELECT * FROM power_relations').all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      fromPowerId: String(row['from_power_id']),
      toPowerId: String(row['to_power_id']),
      kind: String(row['kind']) as PowerRelationKind,
      weight: Number(row['weight'] ?? 0.5),
    }));
  }

  /**
   * 把一条关系写进运行时（覆盖 powers.yaml 的默认值）。
   *
   * 本版**没有代码会调用它** —— 它在这里是为了让「势力之间的关系会变」
   * 这件事有一个已经建好的落点。真正会调它的是「玩家挑动两派对立」那类玩法，
   * 而那需要先有玩家侧的交互设计。
   */
  upsert(fromPowerId: string, toPowerId: string, kind: PowerRelationKind, weight: number, at: number): void {
    this.#db
      .prepare(
        `INSERT INTO power_relations (from_power_id, to_power_id, kind, weight, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(from_power_id, to_power_id, kind) DO UPDATE SET weight = ?, updated_at = ?`,
      )
      .run(fromPowerId, toPowerId, kind, weight, at, weight, at);
  }

  count(): number {
    const row = this.#db.prepare('SELECT COUNT(*) AS n FROM power_relations').get() as { n: number };
    return row.n;
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
