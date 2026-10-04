/**
 * **神明的阴谋**（M2.169）—— 纯函数，无 IO。
 *
 * 用户口径：「神明的阴谋应该是世界级规模的，不要小打小闹，
 * 例如邪神是针对正神实施的阴谋，目的是为了（扳倒）正神。」
 *
 * ## 它和 NPC 的阴谋差在哪（这是这一层的全部意义）
 *
 * ```
 *                  对象          规模        后果
 * npc-scheme       一个人         街面        抢东西 / 栽赃 / 让玩家吃亏
 * divine-scheme    **一位神**     世界格局    神座易主 · 教会易主 · 地上多出遗迹
 * ```
 *
 * ## 五个阶段（原作先例：黑夜女神与大地母神联手暗算战神）
 *
 * ```
 * ally        结盟     找同谋。单打独斗的代价高得多 —— 原作里那次是两个打一个
 * infiltrate  渗透     在目标的教会里安插 / 腐化（接 M2.164 的低语与 M2.167 的堕落者）
 * weaken      削弱     吃掉目标的资源（教会 / 天使 / 封印物）
 * war         神战     正面对抗：世界级事件、地上出现遗迹、双方都掉血
 * fall        陨落     目标倒下 ⇒ 神座空出来 ⇒ **吞并祂的教会**
 * ```
 *
 * ⚠️ 阶段**累积**、不能跳：一位神没法在毫无铺垫的情况下把另一位从座位上拉下来。
 *
 * ## 三条纪律
 *
 *   ① **默认结局是失败或半成** —— 成了才是新闻（用户要稀有性，这里也是）
 *   ② **有一个「对手」** —— 每一步都可能被察觉，察觉之后对方能反击
 *   ③ **旧日杀不死**（原作明写）—— 对那一位的终点只能是 `sealed`，不是 `vacant`
 */
import type { Rng } from '../character/types.ts';

export const SCHEME_GOALS = ['usurp', 'fall', 'weaken', 'corrupt'] as const;
export type SchemeGoal = (typeof SCHEME_GOALS)[number];

export const SCHEME_GOAL_LABELS: Readonly<Record<SchemeGoal, string>> = {
  usurp: '取而代之',
  fall: '让祂陨落',
  weaken: '削弱祂',
  corrupt: '腐化祂的教会',
};

export const SCHEME_STAGES = ['ally', 'infiltrate', 'weaken', 'war', 'fall'] as const;
export type SchemeStage = (typeof SCHEME_STAGES)[number];

export const SCHEME_STAGE_LABELS: Readonly<Record<SchemeStage, string>> = {
  ally: '结盟',
  infiltrate: '渗透',
  weaken: '削弱',
  war: '神战',
  fall: '陨落',
};

/**
 * **每个阶段要熬多久**（天）。
 *
 * 【原作】那场神战不是一夜之间的事：结盟与渗透是经年的，战争本身也打了很久。
 * 【设计】数值是我定的，但量级照着原作给：一条完整的链以**年**计，
 * 而玩家在这个世界里跑几个月就能看到它的中段 —— 于是「神在谋划什么」是可感知的。
 */
export const SCHEME_STAGE_DAYS: Readonly<Record<SchemeStage, number>> = {
  ally: 60,
  infiltrate: 90,
  weaken: 120,
  war: 90,
  fall: 30,
};

/**
 * **世界大门**：每小时 0.2% —— 约二十天里有一位存在决定动手。
 *
 * 【设计】数值是项目设计，量级照着原作：一场神战以**年**计，
 * 但「有人开始谋划」这件事本身也不该一小时发生一次。
 * 从发起到结算，一条完整的链是 60+90+120+90+30 = **390 天**（一年出头）。
 */
export const DIVINE_SCHEME_URGE_PER_HOUR = 0.002;

/** 这条边能不能成为阴谋的依据（关系网给的三条路） */
export const SCHEME_EDGE_KINDS = ['ally', 'rival', 'covet'] as const;
export type SchemeEdgeKind = (typeof SCHEME_EDGE_KINDS)[number];

export const SCHEME_EDGE_LABELS: Readonly<Record<SchemeEdgeKind, string>> = {
  ally: '盟友',
  rival: '水火不容',
  covet: '觊觎其位',
};

/**
 * **谁能对谁下手**。
 *
 * 三条依据（都来自关系网，不是随机挑的）：
 *   · `covet` 觊觎其位 —— 邪神对正神的那一条（用户点名的那一种）
 *   · `rival` 水火不容 —— 原作里就写着「黑夜女神教会与战神教会水火不容」
 *   · 没有关系 ⇒ **不下手**（世界级阴谋不该随机发生在一个毫无缘由的目标身上）
 */
export function canSchemeAgainst(input: {
  schemer: string;
  target: string;
  edges: readonly { a: string; b: string; kind: string }[];
}): SchemeEdgeKind | null {
  for (const edge of input.edges) {
    /*
     * ⚠️ **`covet` 是有向的，`rival` 是无向的** —— 这一条写错过一次：
     *
     * 「原初魔女觊觎月亮的位置」不等于「月亮觊觎原初魔女」。
     * 第一版按无向匹配，于是堕落母神立刻反过来去夺原初魔女的位 ——
     * 语义上说不通，而且**不报错**（它看起来只是「又一场阴谋」）。
     *
     * 边的写法方向就是觊觎方向（`a` 觊觎 `b`）—— 数据表的表头里也写着这句话。
     */
    if (edge.kind === 'covet') {
      if (edge.a === input.schemer && edge.b === input.target) return 'covet';
      continue;
    }
    const pair = (edge.a === input.schemer && edge.b === input.target) ||
      (edge.a === input.target && edge.b === input.schemer);
    if (!pair) continue;
    // 盟友不会算计盟友 —— 那一条边是给「联手」用的，不是给「下手」用的
    if (edge.kind === 'rival') return 'rival';
  }
  return null;
}

/** 阴谋的进度快照（与库里那一行同形） */
export interface DivineSchemeState {
  id: string;
  schemer: string;
  target: string;
  goal: SchemeGoal;
  stage: SchemeStage;
  progress: number;
  exposed: number;
  allies: readonly string[];
  startedAt: number;
  dueAt: number;
  outcome: string;
}

const DAY_MS = 86_400_000;

/**
 * **这一步推不推得动**：到了 due 就进下一阶段。
 *
 * 返回 null = 还没到时候（世界级阴谋大部分时间都在「还没到时候」）。
 */
export function nextStageAt(stage: SchemeStage, at: number): number {
  return at + SCHEME_STAGE_DAYS[stage] * DAY_MS;
}

/** 下一阶段（`fall` 之后没有下一阶段 —— 那一步是结算，不是过渡） */
export function stageAfter(stage: SchemeStage): SchemeStage | null {
  const index = SCHEME_STAGES.indexOf(stage);
  return index < 0 || index >= SCHEME_STAGES.length - 1 ? null : SCHEME_STAGES[index + 1]!;
}

/**
 * **暴露度怎么涨**：每一步都涨一点，急着推进涨得更多。
 *
 * 【设计】它是「对手有没有察觉」的唯一来源 —— 少了它，阴谋就是一条必然成功的流水线，
 * 而用户要的恰恰是「有对手」。
 */
export function exposureGain(input: { stage: SchemeStage; allies: number }): number {
  // 同谋越多越藏不住：两个打一个虽然稳，但动静也大（原作里那场神战打了很多年）
  const base = 8;
  const allyPenalty = Math.max(0, input.allies) * 4;
  const stageWeight = input.stage === 'war' ? 3 : input.stage === 'weaken' ? 2 : 1;
  return base * stageWeight + allyPenalty;
}

/**
 * **目标（或其盟友）有没有察觉**。
 *
 * 察觉之后这一局不会立刻结束 —— 它会**被反击**：
 * 目标可以抢先动手、可以拉盟友、可以向自己的教会征召（于是玩家有机会被卷进来）。
 */
export function detected(input: { exposed: number; rng: Rng }): boolean {
  return input.rng.next() < Math.min(0.9, input.exposed / 100);
}

/**
 * **结算：这一局成没成**。
 *
 * 三条都影响结果，而且都是可解释的：
 *   · 暴露度越高越容易失败（对手有准备）
 *   · 同谋越多越容易成（原作那次是两个打一个）
 *   · 目标如果是**旧日**，最好的结果也只是「封印」——原作明写「无法真正杀死祂」
 */
export interface SchemeOutcome {
  /** done = 成了；foiled = 被反击打断；half = 半成（目标受损但没倒下） */
  result: 'done' | 'foiled' | 'half';
  note: string;
}

export function resolveScheme(input: {
  scheme: DivineSchemeState;
  /** 目标是不是「杀不死」的那一档（旧日 / 支柱 / 外神） */
  targetUnkillable: boolean;
  rng: Rng;
}): SchemeOutcome {
  const scheme = input.scheme;
  const allies = scheme.allies.length;
  // 成功率：底 0.35 + 同谋 0.15/位 - 暴露 0.4×（暴露/100）
  const chance = Math.max(0.05, Math.min(0.95, 0.35 + allies * 0.15 - 0.4 * (scheme.exposed / 100)));
  const roll = input.rng.next();
  if (roll > chance) {
    return { result: 'foiled', note: '被察觉之后，对面先动的手。' };
  }
  if (input.targetUnkillable) {
    return { result: 'half', note: '祂杀不死 —— 只能被封住。' };
  }
  return { result: 'done', note: '' };
}

/** 阴谋破了之后那一位的去向（玩家读到的那一句） */
export function schemeEndLine(input: {
  schemerName: string;
  targetName: string;
  goal: SchemeGoal;
  outcome: SchemeOutcome;
}): string {
  const what = SCHEME_GOAL_LABELS[input.goal];
  if (input.outcome.result === 'foiled') {
    return input.schemerName + '对' + input.targetName + '的图谋' + '（' + what + '）被人先一步掀了桌子。';
  }
  if (input.outcome.result === 'half') {
    return input.targetName + '没有倒下 —— ' + input.outcome.note;
  }
  return input.targetName + '倒下了。' + input.schemerName + '做成了祂想做的事（' + what + '）。';
}

