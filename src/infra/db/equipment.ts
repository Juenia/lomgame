/**
 * 角色装备（M2.85 RPG 化 B）。
 *
 * 每个槽位只有一行（主键是 character_id + slot）—— 「一个人不可能同时穿两件外套」。
 */
import type { DatabaseSync } from 'node:sqlite';
import type { EquipmentSlot } from '../../domain/item/equipment.ts';

export interface EquippedSlot {
  characterId: string;
  slot: EquipmentSlot;
  equipmentId: string;
  equippedAt: number;
}

export class EquipmentRepo {
  readonly #db: DatabaseSync;
  constructor(db: DatabaseSync) { this.#db = db; }

  /** 他身上穿着的（按槽位） */
  of(characterId: string): EquippedSlot[] {
    const rows = this.#db.prepare('SELECT character_id, slot, equipment_id, equipped_at FROM character_equipment WHERE character_id = ?').all(characterId) as Array<Record<string, unknown>>;
    return rows.map((r) => ({ characterId: String(r['character_id']), slot: String(r['slot']) as EquipmentSlot, equipmentId: String(r['equipment_id']), equippedAt: Number(r['equipped_at']) }));
  }

  /** 某个槽位现在装着什么（空则 null） */
  slotOf(characterId: string, slot: EquipmentSlot): string | null {
    const row = this.#db.prepare('SELECT equipment_id FROM character_equipment WHERE character_id = ? AND slot = ?').get(characterId, slot) as { equipment_id: string } | undefined;
    return row === undefined ? null : String(row.equipment_id);
  }

  /** 装上（同槽位覆盖 —— 换装就是覆盖） */
  equip(characterId: string, slot: EquipmentSlot, equipmentId: string, now: number): void {
    this.#db.prepare('INSERT INTO character_equipment (character_id, slot, equipment_id, equipped_at) VALUES (?, ?, ?, ?) ' +
      'ON CONFLICT(character_id, slot) DO UPDATE SET equipment_id = excluded.equipment_id, equipped_at = excluded.equipped_at')
      .run(characterId, slot, equipmentId, now);
  }

  /** 卸下（返回卸掉的是什么） */
  unequip(characterId: string, slot: EquipmentSlot): string | null {
    const current = this.slotOf(characterId, slot);
    this.#db.prepare('DELETE FROM character_equipment WHERE character_id = ? AND slot = ?').run(characterId, slot);
    return current;
  }

  count(): number {
    const row = this.#db.prepare('SELECT COUNT(*) AS n FROM character_equipment').get() as { n: number };
    return Number(row.n);
  }

  /* ---------------- M2.85 B（重做）：**手里的**与**身上的**分开 ---------------- */

  /** 他手里有哪些非凡物品（含穿着的） */
  ownedOf(characterId: string): string[] {
    const rows = this.#db.prepare('SELECT equipment_id FROM character_equipment_owned WHERE character_id = ? ORDER BY obtained_at DESC').all(characterId) as Array<{ equipment_id: string }>;
    return rows.map((r) => String(r.equipment_id));
  }

  /** 他有没有这件（幂等：重复给只记一次） */
  owns(characterId: string, equipmentId: string): boolean {
    const row = this.#db.prepare('SELECT COUNT(*) AS n FROM character_equipment_owned WHERE character_id = ? AND equipment_id = ?').get(characterId, equipmentId) as { n: number };
    return Number(row.n) > 0;
  }

  /** 获得一件（掉落 / 购买 / 委托报酬都走这里） */
  acquire(characterId: string, equipmentId: string, source: string, now: number): boolean {
    const r = this.#db.prepare('INSERT OR IGNORE INTO character_equipment_owned (character_id, equipment_id, obtained_at, source) VALUES (?, ?, ?, ?)')
      .run(characterId, equipmentId, now, source);
    return Number(r.changes) > 0;
  }

  /** 失去一件（卖掉 / 被取走）；如果正穿着也一起脱下来 */
  lose(characterId: string, equipmentId: string): boolean {
    const rows = this.#db.prepare('SELECT slot FROM character_equipment WHERE character_id = ? AND equipment_id = ?').all(characterId, equipmentId) as Array<{ slot: string }>;
    for (const r of rows) this.unequip(characterId, r.slot as EquipmentSlot);
    const res = this.#db.prepare('DELETE FROM character_equipment_owned WHERE character_id = ? AND equipment_id = ?').run(characterId, equipmentId);
    return Number(res.changes) > 0;
  }

  ownedCount(): number {
    const row = this.#db.prepare('SELECT COUNT(*) AS n FROM character_equipment_owned').get() as { n: number };
    return Number(row.n);
  }
}
