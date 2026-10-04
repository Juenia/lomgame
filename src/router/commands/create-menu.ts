/**
 * 创建角色的菜单归属键（M2.7.6 补充 §1.1）。
 *
 * 性别选择发生在**玩家还没有角色**的时候 —— 而 pending_menus 是按 character_id 存的。
 * 于是这里给「还没建号的人」一个稳定的伪归属键：同一 QQ 号在同一时间只会有一份待选性别，
 * 而它天然不会和任何真实 characterId 撞（角色 id 是 UUID / 'c-<qq>'，都不带这个前缀）。
 *
 * 为什么不做一张新表：那要多一张表、多一个仓储、多一处过期清理，
 * 而这份状态的寿命只有「玩家看完那句话、回一个数字」这么长。
 */
export const CREATE_MENU_PREFIX = 'create:';

export const MENU_TYPE_CREATE = 'create' as const;

export function createMenuOwner(userId: string): string {
  return `${CREATE_MENU_PREFIX}${userId}`;
}

/** 这个归属键是不是「还没建号的人」 */
export function isCreateOwner(owner: string): boolean {
  return owner.startsWith(CREATE_MENU_PREFIX);
}