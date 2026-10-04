import type { Db } from './sqlite.ts';
import { daysBetween } from '../date.ts';

/**
 * event_triggers：**每日上限**（`daily_limit`）+ cooldown_days 冷却。
 *
 * ## M2.69：一行记录说的是「触发过几次」，不是「触发过没有」
 *
 * 在此之前这张表的语义是**布尔**的：`(角色, 卡, 日期)` 有行 = 今天出过了。
 * 而卡片顶层的 `daily_limit`（65 张全写）运行期从来没被读过 ——
 * 于是写 2 的卡（daily_012 / daily_016）实际只能出一次，
 * 而写 0 的卡（本版没有，但它是合法的）没有任何办法表达「今天别出我」。
 *
 * 加一列 `count` 之后语义变成「今天出过几次」，判定在
 * `domain/event/engine.ts` 的 `eligible()` 里（`used >= card.daily_limit`）。
 * 老库里的行默认 count = 1，与加这一列之前逐位相同。
 */
export class EventTriggerRepo {
  #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /**
   * 今天每张卡触发过几次（卡 id → 次数）。
   *
   * ⚠️ 返回的是**次数**而不是集合：集合表达不了「这张卡今天还能再出一次」。
   * 调用方（`eligibleCardIds` / `.事件` / `.扮演` / 跑批）把它原样交给
   * `EventEngine.eligible`，由那一处统一比 `daily_limit`（K22：判据只有一处）。
   */
  countsOn(characterId: string, date: string): Map<string, number> {
    const rows = this.#db
      .prepare('SELECT event_id, count FROM event_triggers WHERE character_id = ? AND date = ?')
      .all(characterId, date) as Array<{ event_id: string; count: number }>;
    return new Map(rows.map((row) => [row.event_id, Number(row.count ?? 1)]));
  }

  /** 今天这张卡出过几次（单张查询；报告与调试用） */
  countOf(characterId: string, eventId: string, date: string): number {
    const row = this.#db
      .prepare('SELECT count FROM event_triggers WHERE character_id = ? AND event_id = ? AND date = ?')
      .get(characterId, eventId, date) as { count: number } | undefined;
    return row === undefined ? 0 : Number(row.count ?? 1);
  }

  /**
   * 记一次触发：**次数 +1**（不是「插一行然后忽略重复」）。
   *
   * UPSERT 而不是「先查后写」—— 与 zone_state / power_state 的写法同一个理由：
   * 世界 tick 与惰性推进可能并发，先查后写会丢更新。
   */
  mark(characterId: string, eventId: string, date: string): void {
    this.#db
      .prepare(
        `INSERT INTO event_triggers (character_id, event_id, date, count) VALUES (?, ?, ?, 1)
         ON CONFLICT(character_id, event_id, date) DO UPDATE SET count = count + 1`,
      )
      .run(characterId, eventId, date);
  }

  /** 最近一次触发的日期（ISO date key），从未触发返回 null */
  lastDate(characterId: string, eventId: string): string | null {
    const row = this.#db
      .prepare(
        'SELECT MAX(date) AS last FROM event_triggers WHERE character_id = ? AND event_id = ?',
      )
      .get(characterId, eventId) as { last: string | null } | undefined;
    return row?.last ?? null;
  }

  /** 距上次触发不足 cooldownDays 天 → 仍在冷却 */
  inCooldown(characterId: string, eventId: string, date: string, cooldownDays: number): boolean {
    if (cooldownDays <= 0) return false;
    const last = this.lastDate(characterId, eventId);
    if (!last) return false;
    return daysBetween(last, date) < cooldownDays;
  }

  /** 清理保留期外的事件触发记录（每日 tick 调用），返回删除行数 */
  pruneBefore(date: string): number {
    const result = this.#db.prepare('DELETE FROM event_triggers WHERE date < ?').run(date);
    return Number(result.changes);
  }

  /** 今天一共触发过几张卡（报告用；**按不同卡计**，不是次数和） */
  countOn(characterId: string, date: string): number {
    const row = this.#db
      .prepare('SELECT COUNT(*) AS n FROM event_triggers WHERE character_id = ? AND date = ?')
      .get(characterId, date) as { n: number };
    return row.n;
  }
}
