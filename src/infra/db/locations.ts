import type { Db } from './sqlite.ts';
import { LocationDefSchema, type LocationDef } from '../../domain/explore/location.ts';

/** locations：地点与掉落表，启动时从 src/data/locations.yaml 播种 */
export class LocationRepo {
  #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  seed(defs: readonly LocationDef[]): number {
    const stmt = this.#db.prepare(
      `INSERT INTO locations (id, name, min_seq, max_seq, danger, loot_json, events_json, adjacent_json, corruption_source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name, min_seq = excluded.min_seq, max_seq = excluded.max_seq,
         danger = excluded.danger, loot_json = excluded.loot_json, events_json = excluded.events_json,
         adjacent_json = excluded.adjacent_json, corruption_source = excluded.corruption_source`,
    );
    let count = 0;
    for (const location of defs) {
      stmt.run(
        location.id,
        location.name,
        location.min_seq,
        location.max_seq,
        location.danger,
        JSON.stringify(location.loot),
        JSON.stringify(location.events),
        // M2.2：相邻地点（天气扩散图）
        JSON.stringify(location.adjacent ?? []),
        // M2.167：堕落源（判定读它 —— 异变概率 ×3）
        location.corruption_source ? 1 : 0,
      );
      count += 1;
    }
    return count;
  }

  get(id: string): LocationDef | null {
    const row = this.#db.prepare('SELECT * FROM locations WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.#toDef(row) : null;
  }

  findByNameOrId(text: string): LocationDef | null {
    const byId = this.get(text);
    if (byId) return byId;
    const row = this.#db.prepare('SELECT * FROM locations WHERE name = ?').get(text) as
      | Record<string, unknown>
      | undefined;
    return row ? this.#toDef(row) : null;
  }

  all(): LocationDef[] {
    const rows = this.#db.prepare('SELECT * FROM locations ORDER BY min_seq DESC, id ASC').all() as Array<
      Record<string, unknown>
    >;
    return rows.map((row) => this.#toDef(row));
  }

  count(): number {
    const row = this.#db.prepare('SELECT COUNT(*) AS n FROM locations').get() as { n: number };
    return row.n;
  }

  #toDef(row: Record<string, unknown>): LocationDef {
    const parsed = LocationDefSchema.safeParse({
      id: row.id,
      name: row.name,
      min_seq: row.min_seq,
      max_seq: row.max_seq,
      danger: row.danger,
      loot: JSON.parse(String(row.loot_json ?? '[]')),
      events: JSON.parse(String(row.events_json ?? '[]')),
      adjacent: JSON.parse(String(row.adjacent_json ?? '[]')),
      // M2.167：老库这一列不存在时是 undefined —— schema 的 default(false) 接住它
      corruption_source: Number(row.corruption_source ?? 0) === 1,
    });
    if (!parsed.success) throw new Error(`地点数据损坏：${String(row.id)}`);
    return parsed.data;
  }
}
