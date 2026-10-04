/**
 * 生物 AI（M2.9）—— **纯函数，无 IO**。
 *
 * 生物**不是木桩**。它每回合按当前状态做决策，而且它的行为是**有模式的** ——
 * 玩家会学会「低语者 HP 低于 30% 会逃」「铁血猎犬半血会叫人」。
 * 随机行为只是噪音；**可学习的模式**才是「多回合博弈」的另一半。
 *
 * 决策顺序（顺序本身就是设计）：
 *
 *   evolve     濒死存活 → 蜕壳（序列 -1，永久变强）
 *   berserk    HP < 20% 或长期没进食 → 暴走（伤害 ×2、防御 ×0.5、**不再逃跑**）
 *   play_dead  镜中客 / 命运幻影在 HP < 35% 时装死
 *   call_ally  群居 + HP < 50% → 求援（2—3 回合后增援）
 *   flee       非暴走 + HP < 30% → 尝试脱战
 *   special    物种专属（低语 / 注视 / 撕咬 / 时间凝滞……）
 *   attack     默认
 *
 * 为什么 evolve 排在最前：被逼到墙角时，「蜕壳」是它唯一的出路 ——
 * 先变强，再考虑逃。而暴走一旦触发就**不可逆**（不再逃跑），
 * 这是任务书 §4.3.3 明写的：**暴走的那只不会跑，它会跟你打完。**
 */
import { isDeityOpponent } from '../world/god-challenge.ts';
import { BATTLE } from '../../config/numeric.ts';
import { rollChance } from '../random.ts';
import type { Rng } from '../character/types.ts';
import type { BattleSpeciesView, BattleState, CreatureAction } from './types.ts';

const AI = BATTLE.creatureAi;

export function decideCreatureAction(
  creature: BattleSpeciesView,
  battle: BattleState,
  rng: Rng,
): CreatureAction {
  const ratio = battle.creatureMaxHp > 0 ? battle.creatureHp / battle.creatureMaxHp : 0;

  /* ---- 1. 进化：濒死存活 ---- */
  /*
   * M2.85：**神不蜕壳** —— 他不是虫子。
   *
   * 少了这一条，实测会出现这样的战报：「黑夜女神 蜕了一层壳 —— 它现在是序列 1 了」（HP 上限还 +10）。
   * 生物靠蜕壳在濒死时变强是设计，但一尊神用同一套机制是荒谬的：
   * 他被逼到墙角时不会「进化」，他只会继续打 —— 而这也是「玩家能击败他」这件事的前提。
   */
  if (!isDeityOpponent(battle.creatureId) && !battle.creatureEvolved && ratio <= AI.evolveSurviveRatio) {
    return {
      kind: 'evolve',
      label: '进化',
      note: '它的皮裂开了一道缝，里面的东西比外面大。',
    };
  }

  /* ---- 2. 暴走：HP < 20%，或长期没进食（生物没有 MAD，饥饿是它的等价物） ---- */
  const shouldBerserk = ratio < AI.berserkThreshold || (AI.berserkOnDying && battle.creatureDying);
  if (battle.creatureBerserk) {
    return {
      kind: 'berserk',
      label: '暴走',
      note: '它已经不再躲了。它只想着把你按住。',
    };
  }
  if (shouldBerserk) {
    return {
      kind: 'berserk',
      label: '暴走',
      note: '它忽然不躲了，喉咙里发出一种不像活物的声音。',
    };
  }

  /* ---- 3. 装死（只有点名的那两个物种会） ---- */
  if (
    AI.playDeadSpecies.includes(creature.id) &&
    !battle.creaturePlayingDead &&
    ratio < AI.playDeadThreshold
  ) {
    return {
      kind: 'play_dead',
      label: '装死',
      note: '它倒了下去，一动不动 —— 倒得太整齐了。',
    };
  }

  /* ---- 4. 求援（群居物种，每场一次） ---- */
  if (
    creature.habits.includes('social') &&
    !battle.allyCalled &&
    ratio < AI.callAllyThreshold
  ) {
    return {
      kind: 'call_ally',
      label: '求援',
      note: '它仰头叫了一声。远处有别的东西在回应。',
    };
  }

  /* ---- 5. 逃跑（暴走的那只不会跑） ---- */
  if (ratio < AI.fleeThreshold) {
    return {
      kind: 'flee',
      label: '逃跑',
      note: '它退开了半步，眼睛还在你身上。',
    };
  }

  /* ---- 6. 物种专属 ---- */
  if (creature.special && rollChance(rng, AI.specialChance)) {
    return {
      kind: 'special',
      label: creature.specialName ?? creature.special,
      special: creature.special,
      note: '',
    };
  }

  /* ---- 7. 攻击（默认） ---- */
  return { kind: 'attack', label: '攻击', note: '' };
}

/**
 * 这一回合生物**有没有资格**行动。
 *
 * 两条来源：被放逐（时间凝滞）、被幻觉干扰（愚者序列 8）。
 * 单独一个函数而不是塞进 decideCreatureAction 里：
 * 「它想做什么」与「它做不做得到」是两件事 —— 前者决定文案，
 * 后者决定结算。混在一起的直接后果是「占卜预判看到的是它做不到的事」。
 */
export function creatureCanAct(battle: BattleState): boolean {
  if (battle.creatureStatuses.some((entry) => entry.id === 'banish')) return false;
  return battle.negateCreatureActions <= 0;
}
