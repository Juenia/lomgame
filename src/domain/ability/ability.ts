import { z } from 'zod';
import { PathwayIdSchema } from '../geo/types.ts';
import { NUMERIC } from '../../config/numeric.ts';
import type { PathwayId } from '../character/types.ts';
import type { NumericField } from '../effect/apply.ts';

/**
 * 能力效果：abilities 表里存的就是这份 JSON。
 * 代码只解释字段，不硬编码「愚者序列 8 是什么」。
 */
export const AbilityEffectSchema = z.object({
  /** 生命上限加成（战士序列 8） */
  maxHpBonus: z.number().optional(),
  maxMpBonus: z.number().optional(),
  /**
   * 战斗先攻加成。
   *
   * @deprecated M2.18 起**无读者**。M2.10 的回合序是「**发起者先手**」——
   * 那是**设计**而不是权宜（原话见 docs/M2.10-交付说明.md：
   * 「异步 PVP 里先出招的人先亮牌，这是发起者要付的代价的另一面」），
   * 所以没有可注入的 roll。
   *
   * **保留**的理由：abilities.yaml 的 warrior_8 还在用这个字段，
   * 而 test/w4-edge.test.ts 的用例专门断言「先攻加成等**当前未接入战斗系统**的字段照样能查出来」——
   * 删了会带崩那条用例。将来若真做回合序 roll，这个字段会回来。
   */
  initiativeBonus: z.number().optional(),
  /** 探索危险度倍率，0.8 = 危险触发概率降 20%（不眠者序列 8） */
  exploreDangerMultiplier: z.number().positive().optional(),
  /** 占卜冷却倍率，0.5 = 冷却减半（愚者序列 8） */
  divinationCooldownMultiplier: z.number().positive().optional(),
  /** 占卜每日额外次数（愚者序列 8） */
  divinationDailyBonus: z.number().int().optional(),
  /**
   * M2.12（愚者序列 7「命运碎片」）：占卜时多看到几个「可能的未来」。
   *
   * ⚠️ 它加的是**卜象的条数**，不是准确度 —— 这是「感知向」与「数值向」的分界：
   * 序列 7 的人不是算得更准，是**看见的岔路更多**。
   */
  divinationExtraOmen: z.number().int().optional(),
  /** M2.12（战士序列 7「敌意感知」）：进入一个新地点时，能感到「这里有没有东西在等你」 */
  hostilitySense: z.boolean().optional(),
  /** M2.12（不眠者序列 7「梦隙」）：探索时能看见「同一地点的另一时刻」 */
  dreamGap: z.boolean().optional(),
});

export const AbilityDefSchema = z.object({
  id: z.string().min(1),
  // M2.19：与 geo/types.ts 的 PathwayIdSchema 同一个取值域（加途径时两处一起改）
  // M2.26：加 perfect（蒸汽与机械之神）、reader（知识与智慧之神）
  /*
   * M2.76：改成**复用** `PathwayIdSchema` —— 原状是手抄一份 7 条途径的枚举。
   * 与 `recipe.ts` / `item.ts` 是同一个形状，也是同一轮抓出来的：
   * 三处各抄了一份，落地 15 条新途径时三处一起失效（报「Invalid option」）。
   * 参见 AGENTS.md §3.1「清单只能有一份，且不许手抄」。
   */
  pathway: PathwayIdSchema,
  seq: z.number().int().min(0).max(9),
  name: z.string().min(1),
  effect: AbilityEffectSchema,
});

export type AbilityEffect = z.infer<typeof AbilityEffectSchema>;
export type AbilityDef = z.infer<typeof AbilityDefSchema>;

/**
 * **教会技能**（M2.17，src/data/church-abilities.yaml）。
 *
 * 与 AbilityDef 是**两层**，不是同一张表的两种行：
 *   途径能力 —— 钥匙是 pathway + seq（序列晋升解锁）
 *   教会技能 —— 钥匙是 churchId + rank（教内档位解锁）
 * 所以这里不复用 AbilityDefSchema（那会让 pathway 变成一个允许为空的第三种状态）。
 * 但 effect **是同一份 schema** —— 效果字段只解释一次，两层的数值口径天然一致。
 */
export const ChurchAbilityDefSchema = z.object({
  id: z.string().min(1),
  churchId: z.string().min(1),
  /** 解锁档位索引（0 起，与 churches.yaml 的 ranks 顺序同源） */
  rank: z.number().int().min(0).max(5),
  name: z.string().min(1),
  effect: AbilityEffectSchema,
  description: z.string().min(1),
});
export type ChurchAbilityDef = z.infer<typeof ChurchAbilityDefSchema>;

export function parseChurchAbility(
  raw: unknown,
): { ok: true; ability: ChurchAbilityDef } | { ok: false; issues: string[] } {
  const result = ChurchAbilityDefSchema.safeParse(raw);
  if (result.success) return { ok: true, ability: result.data };
  return {
    ok: false,
    issues: result.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`),
  };
}

/** 没有解锁任何能力时的空效果集 */
export const NO_ABILITY_EFFECTS: AbilityEffect = {};

export function parseAbility(raw: unknown): { ok: true; ability: AbilityDef } | { ok: false; issues: string[] } {
  const result = AbilityDefSchema.safeParse(raw);
  if (result.success) return { ok: true, ability: result.data };
  return {
    ok: false,
    issues: result.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`),
  };
}

/**
 * mergeAbilityEffects 的输入形状：**只要有 effect 就能合并**。
 * 途径能力（AbilityDef）与教会技能（ChurchAbilityDef）都满足它，
 * 将来的第三层能力也只需要满足它。
 */
export type EffectSource = { effect: AbilityEffect };

/**
 * 多个能力叠加：同名效果相加（倍率类相乘），保持「查表」而不是「按途径写死」。
 *
 * ======================== M2.17：**两源合并**（本函数是唯一落点） ========================
 *
 * 从 M2.17 起，喂进来的 defs 可以是**两个来源**：
 *
 *   1. 途径能力 —— abilities.yaml，序列晋升解锁（W4 起）
 *   2. 教会技能 —— church-abilities.yaml，教内档位解锁（M2.17 新增）
 *
 * 所以签名从 `readonly AbilityDef[]` 放宽成 `readonly EffectSource[]`：
 * 这个函数从来只读 def.effect，放宽之后两源都能进，而**旧的调用点一行都不用改**
 * （结构化类型的必然结果）。合并规则**不分来源** —— 同名字段相加、倍率相乘，
 * 于是「途径给的 +5 HP」与「教会给的 +10 HP」自然叠成 +15。
 *
 * ⚠️ 这里是**唯一**的合并入口（铁律 2 的同一手法）：谁想再加第三层能力，
 * 要扩展的是「谁提供 EffectSource」，而不是这个函数。
 */
export function mergeAbilityEffects<T extends EffectSource>(defs: readonly T[]): AbilityEffect {
  const merged: AbilityEffect = {};
  let hpBonus = 0;
  let mpBonus = 0;
  let initiative = 0;
  let dangerMultiplier = 1;
  let divinationCooldown = 1;
  let divinationBonus = 0;
  let extraOmen = 0;

  for (const def of defs) {
    const effect = def.effect;
    hpBonus += effect.maxHpBonus ?? 0;
    mpBonus += effect.maxMpBonus ?? 0;
    initiative += effect.initiativeBonus ?? 0;
    dangerMultiplier *= effect.exploreDangerMultiplier ?? 1;
    divinationCooldown *= effect.divinationCooldownMultiplier ?? 1;
    divinationBonus += effect.divinationDailyBonus ?? 0;
    extraOmen += effect.divinationExtraOmen ?? 0;
  }

  if (hpBonus !== 0) merged.maxHpBonus = hpBonus;
  if (mpBonus !== 0) merged.maxMpBonus = mpBonus;
  if (initiative !== 0) merged.initiativeBonus = initiative;
  if (dangerMultiplier !== 1) merged.exploreDangerMultiplier = dangerMultiplier;
  if (divinationCooldown !== 1) merged.divinationCooldownMultiplier = divinationCooldown;
  if (divinationBonus !== 0) merged.divinationDailyBonus = divinationBonus;
  if (extraOmen !== 0) merged.divinationExtraOmen = extraOmen;
  // 两个布尔是「有就是有」：多个人同时给你这条感知也不会叠加出第二条
  if (defs.some((def) => def.effect.hostilitySense === true)) merged.hostilitySense = true;
  if (defs.some((def) => def.effect.dreamGap === true)) merged.dreamGap = true;
  return merged;
}

export type StatCaps = Partial<Record<NumericField, readonly [number, number]>>;

/** 能力 → apply() 的上下限覆盖（目前只有生命/灵性上限） */
export function capsFromAbilityEffects(effects: AbilityEffect): StatCaps {
  const caps: StatCaps = {};
  const hpMax = 100 + (effects.maxHpBonus ?? 0);
  const mpMax = 100 + (effects.maxMpBonus ?? 0);
  if (hpMax !== 100) caps.hp = [0, hpMax];
  if (mpMax !== 100) caps.mp = [0, mpMax];
  return caps;
}

/**
 * 教会技能的解锁（M2.17）—— **算出来，不落库、不加列**。
 *
 * 与 M2.16 的 rank 同一条原则：解锁条件是档位的函数（rank <= def.rank），
 * 落一张 unlocked_abilities 表只会引入「等级涨了、表没同步」这类问题，
 * 而它带来的查询便利在这里没有任何消费方。
 *
 * 调用方拿到的 rank 来自 `domain/church/membership.ts` 的 `currentRank(state, church)` ——
 * 那两个纯函数合起来就是任务书要的 `unlockedAbilities(state, church)`：
 * 一个算「在第几档」，一个算「这一档有哪些技能」。分开的理由是**依赖方向**：
 * ability.ts 不认识教会（它只认 churchId 这个字符串），所以它不需要导入 church 领域。
 *
 * `NUMERIC.church.abilities.enabled === false` 时返回空数组 —— 跑对照批时用它整层关掉。
 */
export function unlockedChurchAbilities(
  rank: number,
  churchId: string | null | undefined,
  defs: readonly ChurchAbilityDef[],
): ChurchAbilityDef[] {
  if (!NUMERIC.church.abilities.enabled) return [];
  if (!churchId) return [];
  return defs.filter((def) => def.churchId === churchId && def.rank <= rank);
}

/** 解锁标记：与魔药 W3 的 naming 保持一致 */
export function abilityFlag(pathway: PathwayId, seq: number): string {
  return `ability_${pathway}_${seq}`;
}
