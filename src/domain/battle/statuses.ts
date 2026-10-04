/**
 * 战斗状态（M2.9，任务书 §4.3.4）—— **纯函数，无 IO**。
 *
 * 五种状态，各有真实来源（见 types.ts 的 BattleStatusId）。
 * 三条设计纪律：
 *
 *   1. **最多 5 个**（任务书 §4.3.4 明写）。超了不是丢弃新的，而是顶掉**剩余回合最少**的
 *      那个 —— 「刚被打出来的新状态因为列表满了而无效」是最难解释的一种表现。
 *   2. **同状态刷新而不是叠加**。挨两次「低语」不该变成 -40% 命中，
 *      那会让一条链路在长回合里变成必输。
 *   3. **状态的数值一律来自 numeric.battle.statuses**，本文件不写任何常数。
 */
import { BATTLE } from '../../config/numeric.ts';
import type { BattleStatusEffect, BattleStatusId } from './types.ts';

export const STATUS_LABELS: Readonly<Record<BattleStatusId, string>> = {
  bleed: '流血',
  fear: '恐惧',
  poison: '中毒',
  lostControl: '失控',
  banish: '放逐',
};

/** 默认持续回合数（内容侧不给就用它） */
function defaultRounds(id: BattleStatusId): number {
  switch (id) {
    case 'bleed':
      return BATTLE.statuses.bleed.rounds;
    case 'fear':
      return BATTLE.statuses.fear.rounds;
    case 'poison':
      return BATTLE.statuses.poison.rounds;
    case 'lostControl':
      return BATTLE.statuses.lostControl.rounds;
    case 'banish':
      // 见 numeric：banish 只有 skipRounds 一个旋钮（跳过几回合 = 持续几回合）
      return BATTLE.statuses.banish.skipRounds;
    default:
      return 1;
  }
}

export function hasStatus(list: readonly BattleStatusEffect[], id: BattleStatusId): boolean {
  return list.some((entry) => entry.id === id);
}

/**
 * 施加一个状态。返回**新列表**（纯函数，输入不动）。
 *
 *   已有 → 刷新到更长的那个回合数（同状态不叠加）
 *   没有 → 追加；列表满了就顶掉剩余回合最少的那个
 */
export function applyStatus(
  list: readonly BattleStatusEffect[],
  id: BattleStatusId,
  source: string,
  rounds: number = defaultRounds(id),
): BattleStatusEffect[] {
  const existing = list.find((entry) => entry.id === id);
  if (existing) {
    return list.map((entry) =>
      entry.id === id ? { ...entry, rounds: Math.max(entry.rounds, rounds), source } : entry,
    );
  }
  const next = [...list, { id, rounds, source }];
  if (next.length <= BATTLE.maxStatuses) return next;
  // 满了：顶掉剩余回合最少的那个（稳定排序，同长度时顶掉更早加入的）
  let weakest = 0;
  for (let index = 1; index < next.length; index += 1) {
    if (next[index]!.rounds < next[weakest]!.rounds) weakest = index;
  }
  return next.filter((_, index) => index !== weakest);
}

/** 清掉全部负面状态（符咒 / 净化类效果的落点） */
export function cleanseStatuses(list: readonly BattleStatusEffect[]): BattleStatusEffect[] {
  return [];
}

/** 移掉某个状态（梦魇打断暴走时要用） */
export function removeStatus(
  list: readonly BattleStatusEffect[],
  id: BattleStatusId,
): BattleStatusEffect[] {
  return list.filter((entry) => entry.id !== id);
}

/** 命中修正：恐惧 -20%（多个恐惧不叠加，取一次） */
export function hitPenaltyOf(list: readonly BattleStatusEffect[]): number {
  return hasStatus(list, 'fear') ? BATTLE.statuses.fear.hitPenalty : 0;
}

/** 这一边能不能行动（放逐 = 不能） */
export function canActOf(list: readonly BattleStatusEffect[]): boolean {
  return !hasStatus(list, 'banish');
}

/** 每回合的持续伤害 / 消耗（流血 -3 HP、中毒 -2 HP -3 MP） */
export function dotOf(list: readonly BattleStatusEffect[]): {
  hp: number;
  mp: number;
  lines: string[];
} {
  let hp = 0;
  let mp = 0;
  const lines: string[] = [];
  if (hasStatus(list, 'bleed')) {
    hp += BATTLE.statuses.bleed.hpPerRound;
    lines.push(`流血：HP ${BATTLE.statuses.bleed.hpPerRound}。`);
  }
  if (hasStatus(list, 'poison')) {
    hp += BATTLE.statuses.poison.hpPerRound;
    mp += BATTLE.statuses.poison.mpPerRound;
    lines.push(`中毒：HP ${BATTLE.statuses.poison.hpPerRound}、MP ${BATTLE.statuses.poison.mpPerRound}。`);
  }
  return { hp, mp, lines };
}

/**
 * 回合末推进：所有状态 -1 回合，归零的脱落。
 *
 * ⚠️ 这里**不结算 DOT**（那是 dotOf 的事）—— 「掉血」与「状态计时」是两件事，
 * 混在一个函数里会让「这一回合掉的血是状态造成的还是攻击造成的」说不清。
 */
export function advanceStatuses(
  list: readonly BattleStatusEffect[],
): { list: BattleStatusEffect[]; expired: BattleStatusId[] } {
  const expired: BattleStatusId[] = [];
  const next: BattleStatusEffect[] = [];
  for (const entry of list) {
    const rounds = entry.rounds - 1;
    if (rounds <= 0) {
      expired.push(entry.id);
      continue;
    }
    next.push({ ...entry, rounds });
  }
  return { list: next, expired };
}

/** 报告与回执用的一行摘要：「流血(2) · 恐惧(1)」 */
export function describeStatuses(list: readonly BattleStatusEffect[]): string {
  if (list.length === 0) return '健康';
  return list.map((entry) => `${STATUS_LABELS[entry.id]}(${entry.rounds})`).join(' · ');
}
