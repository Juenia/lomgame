/**
 * M2.13：**封印物的判定层**（纯函数，无 IO）。
 *
 * ## 这一层回答两个问题
 *
 *   1. **探索时掉不掉**（`rollExtraordinaryDrop`）—— 按地点的序列门槛分三档；
 *   2. **用一件会怎样**（`resolveExtraordinaryUse`）—— 效果 + 代价 + 接下来做什么。
 *
 * ## 四条纪律（与 `domain/wanted/assault.ts` 同一套）
 *
 *   1. **判定层不做 IO、不认识 SQL、不认识指令。** 目标视图由命令层查好喂进来；
 *      回执文案由命令层渲染（这里只给 `action` 与 `sealWarning`）。
 *   2. **数值全部只读 `NUMERIC.extraordinary`**，本文件不写任何常数。
 *   3. **不掷不该掷的骰。** 掉落判定用**独立随机源**（由探索 seed 派生），
 *      绝不插进 `resolveExplore` 的随机序列里 —— 那会让全部地点的分布整体漂移。
 *   4. **代价照付。** 命运骰子借的是一次运气，不是一次成功；
 *      封印之刃借的是一次近身的机会，不是一次命中。
 *      「用了没中、代价照扣」不是惩罚，是这两件东西**不是必胜按钮**的落点。
 */
import { NUMERIC } from '../../config/numeric.ts';
import type { CharacterState, Rng } from '../character/types.ts';
import type { EffectDelta } from '../effect/apply.ts';
import type { ItemDef } from '../item/item.ts';
import type {
  CalamityDrop,
  DropTier,
  ExtraordinaryDrop,
  ExtraordinaryTarget,
  ExtraordinaryAction,
  UseResult,
} from './types.ts';

const CFG = NUMERIC.extraordinary;
/** M2.14：灾厄的三个影响系数。引用而非快照 —— applyNumericOverrides 改的是对象内部 */
const CALAMITY = NUMERIC.calamity;

/* ------------------------------------------------------------------ *
 * 一、探索掉落
 * ------------------------------------------------------------------ */

/** 地点门槛 → 档位（内容表里 min_seq 只有 9 / 8 / 7 三档，更低的门槛按最高档算） */
export function dropTierOf(minSeq: number): DropTier {
  if (minSeq <= 7) return 'seq7';
  if (minSeq === 8) return 'seq8';
  return 'seq9';
}

/** 这一档的三类掉落率 */
export function dropRatesFor(minSeq: number): { wonder: number; sealed: number; charm: number } {
  const tier = dropTierOf(minSeq);
  return {
    wonder: CFG.dropRates.wonder[tier],
    sealed: CFG.dropRates.sealed[tier],
    charm: CFG.dropRates.charm[tier],
  };
}

/**
 * 掷一次封印物掉落。**三类各掷一次**（互不排斥：一次探索理论上可以同时掉一张符咒与一件封印物，
 * 只是概率是 1% × 0.1% 这个量级）。
 *
 * 顺序固定为 wonder → sealed → charm，所以「同 seed 同结果」这条不变量成立。
 *
 * @returns 命中的那一类；一次都没命中时返回 null
 */
export function rollExtraordinaryDrop(input: {
  minSeq: number;
  rng: Rng;
  /**
   * M2.14：灾厄期把**探索**掉落压下去（0 / 不传 = 无灾厄，既有行为逐位不变）。
   *
   * 传进来的是 `calamityFactorAt(worldSeed, now)` 现场算出的**连续强度** 0—1，
   * 不是等级 —— 判定层不认识「灾厄」这个概念，它只看到一个乘数
   * （与 `world.dropMultiplier` 同一手法）。
   */
  calamityFactor?: number;
  /** 内容侧的名字 → 实际物品（命令层给；不给就只回报类型，不回报 id） */
  pickItemId?: (kind: ExtraordinaryDrop['kind']) => string | null;
}): ExtraordinaryDrop | null {
  const rates = dropRatesFor(input.minSeq);
  const tier = dropTierOf(input.minSeq);
  /*
   * 灾厄压的是**概率**，不是随机数的消耗：三类仍然各掷一次、顺序不变
   * （wonder → sealed → charm），所以「同 seed 同结果」这条不变量不受影响。
   * 返回的 chance 是**压过之后**的值 —— 报告要能解释「为什么这次概率低」。
   */
  const factor = Math.max(0, Math.min(1, input.calamityFactor ?? 0));
  const penalty = 1 - factor * CALAMITY.effects.exploreDropPenalty;
  for (const kind of ['wonder', 'sealed', 'charm'] as const) {
    const chance = rates[kind] * penalty;
    if (chance <= 0) continue;
    const roll = input.rng.next();
    if (roll < chance) return { kind, tier, roll, chance };
  }
  return null;
}

/**
 * M2.14：**灾厄产出的封印物**（封印物的第二条来源）。
 *
 * 和 `rollExtraordinaryDrop` 是两套东西，不要合并：
 *
 * | | 探索掉落 | 灾厄产出 |
 * |---|---|---|
 * | 分档维度 | 地点的**序列门槛**（`min_seq`） | **触发点**（每次探索 / 战斗胜利） |
 * | 表的出处 | `NUMERIC.extraordinary.dropRates` | `NUMERIC.drop.calamity` |
 * | 物品绑定 | unbound（要能交易） | unbound（同上） |
 *
 * 顺序同样固定（wonder → sealed → charm），「同 seed 同结果」成立。
 * 非灾厄期调用方**不该调它**（先判 factor > 0 再掷，铁律 6）——
 * 真调了也会返回 null，但那时候 seedFrom 已经构造过了。
 */
export function rollCalamityDrop(input: { segment: 'explore' | 'battle'; rng: Rng }): CalamityDrop | null {
  const rates = NUMERIC.drop.calamity[input.segment];
  if (!rates) return null;
  for (const kind of ['wonder', 'sealed', 'charm'] as const) {
    const chance = rates[kind];
    if (chance <= 0) continue;
    const roll = input.rng.next();
    if (roll < chance) return { kind, roll, chance };
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * 二、使用
 * ------------------------------------------------------------------ */

/** `sealed_fate_dice` → `fate_dice`（报告与回执里用短名，读起来更像东西的名字） */
export function shortNameOf(itemId: string): string {
  for (const prefix of ['wonder_', 'sealed_', 'charm_']) {
    if (itemId.startsWith(prefix)) return itemId.slice(prefix.length);
  }
  return itemId;
}

/** 这一件是不是封印物（主动使用的那一类） */
export function isSealed(item: ItemDef | null): boolean {
  return item?.type === 'sealed';
}

/** 这一件是不是神奇的被动物品 */
export function isWonder(item: ItemDef | null): boolean {
  return item?.type === 'wonder';
}

/**
 * **使用一件封印物 / 符咒的完整判定。**
 *
 * 接口形状按任务书 §5.2：`resolveExtraordinaryUse(state, item, target, rng) → UseResult`。
 *
 * ⚠️ `rng` 这一轮**不掷任何骰**：12 件封印物的效果全部是确定性的
 * （无视拦截 / 重抽 / 伤害翻倍 / 看信息 / 回 AP / 减 COR / 隐身 / 传送）。
 * 参数留在签名里有两个理由：接口形状按任务书；下一轮要加「使用失败」时有地方掷。
 * 现在把它显式 `void` 掉，而不是从签名里删掉 —— 删了之后加回来会是一次静默的破坏性改动。
 */
export function resolveExtraordinaryUse(
  state: CharacterState,
  item: ItemDef,
  target: ExtraordinaryTarget | null,
  rng: Rng,
): UseResult {
  void rng;
  void state;
  const effect = item.effect ?? {};
  const side = item.sideEffect ?? {};

  /*
   * 代价先算。**它在任何分支上都会被返回**（包括「这件东西用不了」的失败分支）——
   * 唯一的例外是「根本没有这件物品」，那一种根本走不到这里（命令层会先拦）。
   */
  const deltas: EffectDelta[] = [];
  if (typeof side.mad === 'number' && side.mad !== 0) deltas.push({ type: 'mad', value: side.mad });
  if (typeof side.cor === 'number' && side.cor !== 0) deltas.push({ type: 'cor', value: side.cor });

  const sealWarning =
    typeof item.sealLevel === 'number' && item.sealLevel >= CFG.sealWarnLevel
      ? '【' + item.name + ' · 封印等级 ' + item.sealLevel + '】'
      : null;

  /* ---- 符咒（一次性，效果写在 effect 里） ---- */
  if (item.type === 'charm') {
    if (effect.cor !== undefined && !deltas.some((d) => d.type === 'cor')) {
      deltas.push({ type: 'cor', value: effect.cor });
    }
    if (effect.hideWantedHours !== undefined) {
      return {
        ok: true,
        deltas,
        action: { kind: 'hide_wanted', hours: effect.hideWantedHours },
        roll: null,
        sealWarning,
      };
    }
    if (effect.teleportToMarked === true) {
      return { ok: true, deltas, action: { kind: 'teleport', toMarked: true }, roll: null, sealWarning };
    }
    // 剩下的是纯数值符咒（驱邪符：COR -20）—— 只有 deltas，没有动作
    return { ok: true, deltas, action: null, roll: null, sealWarning };
  }

  /* ---- 神奇物品：被动。主动使用它不会额外发生什么，但仍然要如实说清楚 ---- */
  if (item.type === 'wonder') {
    return {
      ok: false,
      reason: item.name + '不用主动使用 —— 带在身上就一直在起作用。',
      // ⚠️ 失败时**不返回副作用**：被动物品没被「用掉」，自然也不该付代价
      deltas: [],
      action: { kind: 'passive' },
      roll: null,
      sealWarning: null,
    };
  }

  /* ---- 封印物：五件，各一支 action ---- */

  if (effect.ignoreSequenceGap === true) {
    /*
     * 封印之刃。**这一轮的核心之一。**
     *
     * 它做两件事，缺一不可：
     *   1. 跳过 `diff >= blockThreshold` 的那道拦截（M2.6.1）；
     *   2. 用一个 +1.0 的命中修正把命中率抬到 1.0 —— 因为被拦的那一档
     *      `hitChanceOf` 返回的是 0，光「跳过拦截」得到的仍然是「一次也打不中」。
     * 任务书 §5.4 把这两件事写成了一句「（`hitModifier` 传 `+1.0`）」。
     */
    return {
      ok: true,
      deltas,
      action: {
        kind: 'attack',
        ignoreSequenceGap: true,
        hitModifier: typeof effect.hitModifier === 'number' ? effect.hitModifier : 1,
      },
      roll: null,
      sealWarning,
    };
  }

  if (effect.damageMultiplier !== undefined) {
    const multiplier = effect.damageMultiplier;
    if (!(multiplier > 1)) {
      return {
        ok: false,
        reason: item.name + '上的伤害倍率配置有问题（' + multiplier + '）。',
        deltas: [],
        action: null,
        roll: null,
        sealWarning: null,
      };
    }
    return { ok: true, deltas, action: { kind: 'power_attack', damageMultiplier: multiplier }, roll: null, sealWarning };
  }

  if (effect.reroll === true) {
    return { ok: true, deltas, action: { kind: 'reroll' }, roll: null, sealWarning };
  }

  if (Array.isArray(effect.reveal)) {
    return {
      ok: true,
      deltas,
      action: { kind: 'reveal', fields: effect.reveal },
      roll: null,
      sealWarning,
    };
  }

  /*
   * 时间沙漏（M2.85）：原「重置每日行动点 + 之后几天恢复减半」的效果随行动值移除，
   * 这一条分支一并下线 —— 该物品现在会落到下面的「没有写得出效果」那句。
   */

  return {
    ok: false,
    reason: item.name + '上没有写得出效果 —— 它现在只是一件摆设。',
    deltas: [],
    action: null,
    roll: null,
    sealWarning: null,
  };
}

/* ------------------------------------------------------------------ *
 * 三、命运骰子的重抽
 * ------------------------------------------------------------------ */

/** 一次判定的「好坏」排序：命中 > 没命中 > 被拦。重抽取更好的那次 */
export function betterOf<T extends { blocked: boolean; hit?: boolean }>(a: T, b: T): T {
  const score = (r: T): number => (r.blocked ? 0 : r.hit ? 2 : 1);
  return score(b) > score(a) ? b : a;
}

/**
 * 重抽是否值得做（**判定层给命令层的判据，不是命令层的 if**）。
 *
 * 规则：**只看「这次判定有没有第二次机会」**。
 * 已经被序列差拦住的那种（`blockedBy === 'sequence_gap'`）**重抽也不会有用** ——
 * 拦截是确定性的、不掷骰，重掷一百次还是拦。
 * 命令层据此决定「要不要为它花掉一件命运骰子」，而不是自己判断序列差。
 */
export function rerollHelps(result: { blocked: boolean; blockedBy?: string }): boolean {
  if (!result.blocked) return true;
  return result.blockedBy !== 'sequence_gap';
}

export type { ExtraordinaryAction };
