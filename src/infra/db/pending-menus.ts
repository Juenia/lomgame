/**
 * 菜单状态仓储（M2.3）：pending_menus 一张表，每角色一行。
 *
 * 为什么是「一行」而不是「一次菜单一行」：
 *   玩家手里永远只有一份「刚刚看到的选项」。留历史没有意义 ——
 *   过期之后拿旧选项去执行才是真的危险（玩家以为自己选的是新菜单里的第 3 条）。
 *   所以写入就是覆盖（UPSERT），读取时先看 expires_at。
 */
import { NUMERIC } from '../../config/numeric.ts';
import type { Menu, MenuType } from '../../domain/menu/types.ts';
import type { Db } from './sqlite.ts';

export interface PendingMenuRow {
  characterId: string;
  menuType: MenuType;
  menu: Menu;
  createdAt: number;
  expiresAt: number;
}

export class PendingMenuRepo {
  #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /** 落一份菜单（覆盖同角色的旧菜单）；过期时间由 NUMERIC.menu.ttlMs 决定 */
  save(characterId: string, menuType: MenuType, menu: Menu, now: number): PendingMenuRow {
    const expiresAt = now + NUMERIC.menu.ttlMs;
    this.#db
      .prepare(
        `INSERT INTO pending_menus (character_id, menu_type, payload_json, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(character_id) DO UPDATE SET
           menu_type = excluded.menu_type,
           payload_json = excluded.payload_json,
           created_at = excluded.created_at,
           expires_at = excluded.expires_at`,
      )
      .run(characterId, menuType, JSON.stringify(menu), now, expiresAt);
    return { characterId, menuType, menu, createdAt: now, expiresAt };
  }

  /** 原始行（不过期判断）；JSON 坏了当作没有菜单，绝不让一条脏数据把指令打挂 */
  find(characterId: string): PendingMenuRow | null {
    const row = this.#db
      .prepare('SELECT * FROM pending_menus WHERE character_id = ?')
      .get(characterId) as Record<string, unknown> | undefined;
    if (!row) return null;
    try {
      return {
        characterId: String(row.character_id),
        menuType: String(row.menu_type) as MenuType,
        menu: JSON.parse(String(row.payload_json)) as Menu,
        createdAt: Number(row.created_at),
        expiresAt: Number(row.expires_at),
      };
    } catch {
      this.clear(characterId);
      return null;
    }
  }

  /**
   * 仍然有效的菜单。
   * 过期就地删除：读的时候顺手清理，比等定时任务更可靠（进程重启也不会留下脏行）。
   */
  findLive(characterId: string, now: number): PendingMenuRow | null {
    const row = this.find(characterId);
    if (!row) return null;
    if (row.expiresAt <= now) {
      this.clear(characterId);
      return null;
    }
    return row;
  }

  clear(characterId: string): void {
    this.#db.prepare('DELETE FROM pending_menus WHERE character_id = ?').run(characterId);
  }

  /** 清理所有过期行（指令入口懒清扫用）；返回清理条数 */
  clearExpired(now: number): number {
    const result = this.#db.prepare('DELETE FROM pending_menus WHERE expires_at <= ?').run(now);
    return Number(result.changes);
  }

  count(): number {
    const row = this.#db.prepare('SELECT COUNT(*) AS n FROM pending_menus').get() as { n: number };
    return row.n;
  }
}
