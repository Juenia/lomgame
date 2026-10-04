import type { Db } from './sqlite.ts';
import type { BindType } from '../../domain/item/bind.ts';
import type { MaterialNeed } from '../../domain/potion/recipe.ts';
import { planRemoval, planRemovalMany } from '../../domain/item/inventory-rules.ts';

export interface InventorySlot {
  itemId: string;
  bindType: BindType;
  quantity: number;
}

/**
 * inventory：绑定/非绑定分开堆叠。
 * 扣减一律「先扣非绑定，再扣绑定」；不足则整体失败，绝不做部分扣减。
 */
export class InventoryRepo {
  #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  list(characterId: string): InventorySlot[] {
    const rows = this.#db
      .prepare(
        `SELECT item_id, bind_type, quantity FROM inventory
         WHERE character_id = ? AND quantity > 0
         ORDER BY item_id ASC, bind_type ASC`,
      )
      .all(characterId) as Array<{ item_id: string; bind_type: string; quantity: number }>;
    return rows.map((row) => ({
      itemId: row.item_id,
      bindType: row.bind_type as BindType,
      quantity: row.quantity,
    }));
  }

  count(characterId: string, itemId: string): number {
    const row = this.#db
      .prepare('SELECT COALESCE(SUM(quantity), 0) AS n FROM inventory WHERE character_id = ? AND item_id = ?')
      .get(characterId, itemId) as { n: number };
    return row.n;
  }

  countByBind(characterId: string, itemId: string, bindType: BindType): number {
    const row = this.#db
      .prepare('SELECT COALESCE(quantity, 0) AS n FROM inventory WHERE character_id = ? AND item_id = ? AND bind_type = ?')
      .get(characterId, itemId, bindType) as { n: number } | undefined;
    return row?.n ?? 0;
  }

  add(characterId: string, itemId: string, quantity: number, bindType: BindType, now: number): void {
    if (quantity <= 0) return;
    this.#db
      .prepare(
        `INSERT INTO inventory (character_id, item_id, bind_type, quantity, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(character_id, item_id, bind_type) DO UPDATE SET
           quantity = quantity + excluded.quantity, updated_at = excluded.updated_at`,
      )
      .run(characterId, itemId, bindType, quantity, now);
  }

  addMany(
    characterId: string,
    drops: ReadonlyArray<{ itemId: string; quantity: number; bindType: BindType }>,
    now: number,
  ): void {
    for (const drop of drops) this.add(characterId, drop.itemId, drop.quantity, drop.bindType, now);
  }

  /**
   * 单种物品扣减（不区分绑定），不足返回 false 且不改动任何一行。
   * 扣减顺序（先非绑定后绑定）由 domain/item/inventory-rules.ts 的纯函数决定，
   * 模拟器用的是同一份规则。
   */
  tryRemove(characterId: string, itemId: string, quantity: number, now: number): boolean {
    if (quantity <= 0) return true;
    const plan = planRemoval(this.list(characterId), itemId, quantity);
    if (!plan.ok) return false;
    for (const deduction of plan.deductions) {
      this.#write(characterId, itemId, deduction.bindType, -deduction.quantity, now);
    }
    return true;
  }

  /** 多种材料全有或全无（魔药调制用） */
  tryRemoveMany(characterId: string, needs: readonly MaterialNeed[], now: number): boolean {
    const plan = planRemovalMany(this.list(characterId), needs);
    if (!plan.ok) return false;
    for (const entry of plan.perItem) {
      for (const deduction of entry.deductions) {
        this.#write(characterId, entry.itemId, deduction.bindType, -deduction.quantity, now);
      }
    }
    return true;
  }

  /** 交易冻结：先从卖家可用栏位移出，取消/超时时再 add 回来 */
  freeze(characterId: string, itemId: string, quantity: number, now: number): boolean {
    return this.tryRemove(characterId, itemId, quantity, now);
  }

  paginate(
    characterId: string,
    page: number,
    pageSize: number,
    options: { exclude?: readonly string[] } = {},
  ): { slots: InventorySlot[]; total: number; page: number; pages: number } {
    const excluded = new Set(options.exclude ?? []);
    const all = this.list(characterId).filter((slot) => !excluded.has(slot.itemId));
    const pages = Math.max(1, Math.ceil(all.length / pageSize));
    const current = Math.min(Math.max(1, page), pages);
    const start = (current - 1) * pageSize;
    return {
      slots: all.slice(start, start + pageSize),
      total: all.length,
      page: current,
      pages,
    };
  }

  #write(characterId: string, itemId: string, bindType: BindType, delta: number, now: number): void {
    this.#db
      .prepare(
        `UPDATE inventory SET quantity = quantity + ?, updated_at = ?
         WHERE character_id = ? AND item_id = ? AND bind_type = ?`,
      )
      .run(delta, now, characterId, itemId, bindType);
  }
}
