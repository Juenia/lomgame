/**
 * NPC 处理世界事件（M2.85 世界演化）。
 *
 * `event_id` 是主键：**一件事只会被处理一次** —— 与神位（`godhood_claims.deity_id`）同一思路。
 * 谁先到谁处理，后来的 NPC 不会重复「解决」同一件事。
 */
import type { DatabaseSync } from 'node:sqlite';

export interface EventHandling {
  eventId: string;
  npcId: string;
  note: string;
  merit: number;
  at: number;
}

export class EventHandlingRepo {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  /** 认领并处理（已被别人处理过则返回 false —— 先到先得） */
  claim(input: EventHandling): boolean {
    const result = this.#db
      .prepare('INSERT OR IGNORE INTO world_event_handling (event_id, npc_id, note, merit, at) VALUES (?, ?, ?, ?, ?)')
      .run(input.eventId, input.npcId, input.note, input.merit, input.at);
    return Number(result.changes) > 0;
  }

  of(eventId: string): EventHandling | null {
    const row = this.#db
      .prepare('SELECT event_id, npc_id, note, merit, at FROM world_event_handling WHERE event_id = ?')
      .get(eventId) as Record<string, unknown> | undefined;
    if (row === undefined) return null;
    return {
      eventId: String(row['event_id']),
      npcId: String(row['npc_id']),
      note: String(row['note']),
      merit: Number(row['merit']),
      at: Number(row['at']),
    };
  }

  /** 已经被处理过的事件 id 集合（tick 用来排除已处理的） */
  handledIds(): Set<string> {
    const rows = this.#db.prepare('SELECT event_id FROM world_event_handling').all() as Array<{ event_id: string }>;
    return new Set(rows.map((row) => String(row['event_id'])));
  }

  count(): number {
    const row = this.#db.prepare('SELECT COUNT(*) AS n FROM world_event_handling').get() as { n: number };
    return Number(row.n);
  }
}
