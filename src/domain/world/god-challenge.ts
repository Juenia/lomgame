/**
 * 挑战神（M2.85 世界演化第四层）—— 用户拍板：「**神明并非是不可战胜的**，倘若玩家可以击败序列 0，
 * 则能晋升成为新的序列 0；玩家同理。」
 *
 * ## 怎么把「神」接进现有的战斗
 *
 * 战斗系统原本只有两种对手：**生物**（`isPvp = false`）与**玩家**（`isPvp = true`）。
 * 而 `BattleState` 的注释里早就写着「M2.10 只需要把 opponent 从『生物实例』换成『另一个玩家的角色卡』」
 * —— 也就是说它的字段本来就是按「一个能打的东西」设计的，不是按生物设计的。
 *
 * 于是这里**不新增第三种战斗类型**，而是把神**装扮成一只生物**交给战斗系统：
 *
 *   creature.id = `deity:` + 神明 id      ← 这个前缀就是「他不是生物」的标记
 *   species.name = 神的名号                 ← 战报里显示的就是他
 *   sequence = 0、HP / 伤害按序列 0 的曲线  ← 他是凡人能遇到的最强对手
 *
 * 好处是**战斗的全部逻辑（回合、状态、逃跑、超时）一行都不用改**，而代价只是：
 * 胜利结算时要**先看一眼 id 前缀**，是神就走「登神」而不是「掉落」。
 *
 * ## 资格
 *
 * 只有**站在序列 1** 的人谈得上挑战神（`CONTENT_MAX_SEQUENCE` 正好是 1 —— 本版玩家能到的最高处）。
 * 序列更低的人连神的门都找不到，这与「资格闸」是同一套思路。
 */
import { NUMERIC } from '../../config/numeric.ts';
import { CONTENT_MAX_SEQUENCE } from '../../config/content-scope.ts';
import type { Creature, CreatureSpecies } from '../creature/types.ts';
import type { Deity } from './pantheon.ts';

/** 神作为对手时的 id 前缀 —— **胜利结算靠它分辨**「这是生物还是神」 */
export const DEITY_PREFIX = 'deity:';

export function isDeityOpponent(id: string): boolean {
  return id.startsWith(DEITY_PREFIX);
}

export function deityIdOf(opponentId: string): string {
  return opponentId.slice(DEITY_PREFIX.length);
}

/** 神的战斗数值（序列 0：HP 300 / 伤害 34—55 / 命中 0.62，沿用本项目 seq→hp 曲线的最深一档） */
export function godBattleStats(): { hp: number; damage: [number, number]; hit: number } {
  return { hp: 300, damage: [34, 55], hit: 0.62 };
}

/**
 * 这个人够不够格挑战神。
 *
 * ⚠️ 这是**第一道闸**（与 NPC 的资格闸同一套思路）：序列必须已经到 `CONTENT_MAX_SEQUENCE`（1）。
 * 序列 2 的人来挑战，回答不是「你输了」，而是「你连站在他面前都做不到」——
 * 免得玩家以为这只是概率问题，反复来刷。
 */
export function canChallengeGod(sequence: number): { ok: boolean; reason?: string } {
  if (sequence > CONTENT_MAX_SEQUENCE) {
    return {
      ok: false,
      reason: `你的序列是 ${sequence}，还差得远 —— 想站到神的对面，至少要先走到序列 ${CONTENT_MAX_SEQUENCE}。`,
    };
  }
  return { ok: true };
}

/** 神「装扮成」一只生物，交给现成的战斗系统 */
export function deityAsOpponent(
  deity: Deity,
  locationId: string,
  now: number,
): { creature: Creature; species: CreatureSpecies } {
  const stats = godBattleStats();
  const id = DEITY_PREFIX + deity.id;
  const creature: Creature = {
    id,
    speciesId: id,
    locationId,
    sequence: 0,
    hp: stats.hp,
    maxHp: stats.hp,
    status: 'healthy',
    ageHours: 0,
    feedCount: 0,
    lastFedAt: null,
    spawnedAt: now,
    migratedFrom: null,
  };
  const species: CreatureSpecies = {
    id,
    bestiaryId: null,
    name: deity.name,
    baseSequence: 0,
    habitat: [locationId],
    pathwayAffinity: [...deity.pathways],
    drops: [],
    behaviors: [],
    habits: [],
    tickRate: 'daily',
    baseHp: stats.hp,
    flavor: `${deity.name}就站在那里。`,
    perception: {
      blur: '前面那片空气不对，像有什么东西一直在看着这边。',
      silhouette: '一个看不出年岁的身影站着，周围的雾不敢靠近。',
      full: `${deity.name} —— 这不是生物，是一尊神。`,
      advantage: '他没有破绽，只有「你现在能站到他面前」这件事本身是你的凭仗。',
      essence: '杀了他，神位就是空的。',
    },
    battle: {
      damage: stats.damage,
      hit: stats.hit,
      special: 'gaze',
      specialName: '注视',
      fleeChance: 0.05,
    },
  };
  return { creature, species };
}

/** 挑战的冷却（毫秒）—— 神不该被同一个人反复骚扰 */
export function challengeCooldownMs(): number {
  return (NUMERIC as unknown as { npc?: { godChallengeCooldownDays?: number } }).npc?.godChallengeCooldownDays
    ? (NUMERIC as unknown as { npc: { godChallengeCooldownDays: number } }).npc.godChallengeCooldownDays * 86_400_000
    : 7 * 86_400_000;
}
