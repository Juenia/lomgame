/**
 * id 生成（W7 新增的测试设施）
 *
 * 问题：服务端所有判定的 seed 都是 `seedFrom([messageId, characterId, now, ...])` 派生的，
 * 而角色 id 是 `randomUUID()` —— 于是同一批虚拟玩家、同一个 seed 跑两遍，
 * 抽卡 / 掉落 / 消化判定 / 晋升成败全都不一样，"同 seed 同输出"根本不成立。
 *
 * 解法：给测试留一个开关 `DETERMINISTIC_IDS=1`（与 ALLOW_CLOCK_CONTROL、TIME_TRAVEL_DAYS 同类）：
 *   - 打开时：id 由入参派生 → 完全可复现；
 *   - 关闭时（**生产默认**）：仍然是随机 UUID / 随机短号，行为与 W1—W6 完全一致。
 */
import { createHash, randomUUID } from 'node:crypto';

let deterministicIds = false;

export function enableDeterministicIds(value: boolean): void {
  deterministicIds = value;
}

export function isDeterministicIds(): boolean {
  return deterministicIds;
}

/** 角色 id：确定性模式下用 QQ 号派生（唯一性由 characters.user_id 的唯一约束保证） */
export function newCharacterId(userId: string): string {
  if (!deterministicIds) return randomUUID();
  return `c-${userId}`;
}

/**
 * M2.7：行程号。同一个角色在确定性模式下用 角色 id + 出发时刻 派生 ——
 * 一个人不可能在同一毫秒开始两段行程，所以它天然唯一（数据库另有主键约束兜底）。
 */
export function newTravelId(characterId: string, startedAt: number): string {
  if (!deterministicIds) return randomUUID();
  return `t-${createHash('sha1').update(`${characterId}:${startedAt}`).digest('hex').slice(0, 12)}`;
}

/* M2.7.6 的 newOfferId（引导邀约号）随 M2.85 的引导玩法一并删除。 */

/**
 * M2.8：遭遇号。
 *
 * 一个角色在同一毫秒只会掷出一次遭遇（一条探索指令一次），
 * 所以 角色 + 时刻 天然唯一 —— 与 newTravelId 同一个论证。
 */
export function newSightingId(characterId: string, at: number): string {
  if (!deterministicIds) return randomUUID();
  return `s-${createHash('sha1').update(`${characterId}:${at}`).digest('hex').slice(0, 12)}`;
}

/**
 * M2.9：战斗号。
 *
 * 一个角色在同一毫秒只会开一场战斗（开着的那场没打完之前不再开新的），
 * 所以 角色 + 时刻 天然唯一 —— 与 newTravelId / newSightingId 同一个论证。
 */
export function newBattleId(characterId: string, startedAt: number): string {
  if (!deterministicIds) return randomUUID();
  return `b-${createHash('sha1').update(`${characterId}:${startedAt}`).digest('hex').slice(0, 12)}`;
}

/** M2.7.6：配方线索号（一个角色同一时刻至多一条未用线索） */
export function newClueId(characterId: string, foundAt: number): string {
  if (!deterministicIds) return randomUUID();
  return `k-${createHash('sha1').update(`${characterId}:${foundAt}`).digest('hex').slice(0, 12)}`;
}

/** 6 位短号（交易单号 / 队伍号）：确定性模式下按入参哈希 */
export function newShortId(seedInput: string): string {
  if (!deterministicIds) return randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase();
  return createHash('sha1').update(seedInput).digest('hex').slice(0, 6).toUpperCase();
}
