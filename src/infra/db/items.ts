import type { Db } from './sqlite.ts';
import type { ItemDef } from '../../domain/item/item.ts';
import { ItemDefSchema } from '../../domain/item/item.ts';

/** items：物品元数据，启动时从 src/data/items.yaml 播种 */
export class ItemRepo {
  #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  seed(defs: readonly ItemDef[]): number {
    /*
     * M2.13：多写四列（type / side_effect_json / seal_level / rarity，见 0021 迁移）。
     * ⚠️ `battle` 仍然**不落库** —— M2.9 起它就没进过表（判定层要用时由命令层
     * 从 YAML 读的那一份喂进去），这一轮不动它：把它落库会变成第三份真相。
     */
    const stmt = this.#db.prepare(
      `INSERT INTO items (id, name, kind, bindable, tradeable, pathway, seq, effect_json, note, type, side_effect_json, seal_level, rarity)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name, kind = excluded.kind, bindable = excluded.bindable,
         tradeable = excluded.tradeable,
         pathway = excluded.pathway, seq = excluded.seq,
         effect_json = excluded.effect_json, note = excluded.note,
         type = excluded.type, side_effect_json = excluded.side_effect_json,
         seal_level = excluded.seal_level, rarity = excluded.rarity`,
    );
    let count = 0;
    for (const item of defs) {
      stmt.run(
        item.id,
        item.name,
        item.kind,
        item.bindable ? 1 : 0,
        item.tradeable ? 1 : 0,
        item.pathway ?? null,
        item.seq ?? null,
        JSON.stringify(item.effect ?? {}),
        item.note ?? null,
        item.type,
        item.sideEffect ? JSON.stringify(item.sideEffect) : null,
        item.sealLevel ?? null,
        item.rarity,
      );
      count += 1;
    }
    return count;
  }

  get(itemId: string): ItemDef | null {
    const row = this.#db.prepare('SELECT * FROM items WHERE id = ?').get(itemId) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    /*
     * M2.13：四处新增（type / sideEffect / sealLevel / rarity，见 0021 迁移）。
     *
     * ⚠️ 旧库（没跑过 0021）里这四列不存在，`row.type` 会是 undefined ——
     * 而 schema 里 `type` 有默认值 `material`、`rarity` 有默认值 1，
     * 所以「读不到」与「本来就是普通物」在这里**收敛到同一个结果**，
     * 不需要为旧库写一条分支。这也是把默认值选成 material / 1 的理由之一。
     */
    const parsed = ItemDefSchema.safeParse({
      id: row.id,
      name: row.name,
      kind: row.kind,
      bindable: Number(row.bindable) === 1,
      tradeable: Number(row.tradeable ?? 1) === 1,
      pathway: row.pathway ?? undefined,
      seq: row.seq ?? undefined,
      effect: JSON.parse(String(row.effect_json ?? '{}')) as Record<string, number>,
      note: row.note ?? undefined,
      type: row.type ?? undefined,
      sideEffect: row.side_effect_json
        ? (JSON.parse(String(row.side_effect_json)) as Record<string, number>)
        : undefined,
      sealLevel: row.seal_level === null || row.seal_level === undefined ? undefined : Number(row.seal_level),
      rarity: row.rarity === null || row.rarity === undefined ? undefined : Number(row.rarity),
    });
    return parsed.success ? parsed.data : null;
  }

  nameOf(itemId: string): string {
    return this.get(itemId)?.name ?? itemId;
  }

  all(): ItemDef[] {
    const rows = this.#db.prepare('SELECT * FROM items ORDER BY id ASC').all() as Array<Record<string, unknown>>;
    return rows.map((row) => this.get(String(row.id))).filter((item): item is ItemDef => item !== null);
  }

  findByNameOrName(query: string): ItemDef | null {
    const byId = this.get(query);
    if (byId) return byId;
    const row = this.#db.prepare('SELECT id FROM items WHERE name = ?').get(query) as
      | { id: string }
      | undefined;
    return row ? this.get(row.id) : null;
  }

  count(): number {
    const row = this.#db.prepare('SELECT COUNT(*) AS n FROM items').get() as { n: number };
    return row.n;
  }
}
