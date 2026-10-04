/**
 * **世界伤痕**仓储（M2.169）—— 表见 migrations/0052。
 *
 * 神明级事件在地上留下的东西：某位神陨落的地方、神战打过的痕迹。
 * 读取口径与另外两张运行时表一致：**内容为底、伤痕叠加**。
 */
import type { DatabaseSync } from 'node:sqlite';
// 类型只有一份（domain/world/world-scar.ts）—— 这里不重复定义
import type { WorldScar } from '../../domain/world/world-scar.ts';
export type { WorldScar };

function rowOf(row: Record<string, unknown>): WorldScar {
  return {
    id: String(row['id']),
    kind: String(row['kind']),
    pathway: String(row['pathway']),
    locationId: String(row['location_id']),
    since: Number(row['since'] ?? 0),
    note: String(row['note'] ?? ''),
    dangerBonus: Number(row['danger_bonus'] ?? 0),
    corruption: Number(row['corruption'] ?? 0) === 1,
    lootItem: String(row['loot_item'] ?? ''),
    lootChance: Number(row['loot_chance'] ?? 0),
  };
}

const COLS = 'id, kind, pathway, location_id, since, note, danger_bonus, corruption, loot_item, loot_chance';

export class WorldScarRepo {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  all(): WorldScar[] {
    const rows = this.#db.prepare('SELECT ' + COLS + ' FROM world_scars ORDER BY since DESC').all() as Array<
      Record<string, unknown>
    >;
    return rows.map(rowOf);
  }

  /** 这块地上有什么痕迹（探索与遭遇读它） */
  atLocation(locationId: string): WorldScar[] {
    const rows = this.#db.prepare('SELECT ' + COLS + ' FROM world_scars WHERE location_id = ?').all(locationId) as Array<
      Record<string, unknown>
    >;
    return rows.map(rowOf);
  }

  of(id: string): WorldScar | null {
    const row = this.#db.prepare('SELECT ' + COLS + ' FROM world_scars WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row === undefined ? null : rowOf(row);
  }

  /** 同一处同一种痕迹只留一条（补写会更新它，而不是越积越多） */
  record(scar: WorldScar): void {
    this.#db
      .prepare(
        'INSERT INTO world_scars (id, kind, pathway, location_id, since, note, danger_bonus, corruption, loot_item, loot_chance) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
          'ON CONFLICT(id) DO UPDATE SET since = excluded.since, note = excluded.note, ' +
          'danger_bonus = excluded.danger_bonus, corruption = excluded.corruption, ' +
          'loot_item = excluded.loot_item, loot_chance = excluded.loot_chance',
      )
      .run(
        scar.id, scar.kind, scar.pathway, scar.locationId, scar.since, scar.note,
        scar.dangerBonus, scar.corruption ? 1 : 0, scar.lootItem, scar.lootChance,
      );
  }
}
