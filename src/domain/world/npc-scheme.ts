/**
 * NPC 的阴谋（M2.85 RPG 化）—— **纯函数，无 IO**。
 *
 * ## 用户三次拍板，第三次是这次重做的原因
 *
 * > ① 「对立高序列者会算计玩家或者 NPC，可以布局做出一些阴谋」
 * > ② 「太儿戏了，阿蒙那种半神算计偷你一点东西吗？」
 * > ③ 「**阴谋不应该过于单调，现在就我提出来的两种和你的小偷行为**」
 *
 * 第 ③ 条指出的是**结构问题**：之前按「手段名」分类（偷/咒/栽赃），
 * 于是十几种手段其实是同一件事的十几种说法 —— **全是「损害你」**。
 *
 * ## 正确的结构：先问「他的目的是什么」（nature），再问「他下到哪一层」（tier）
 *
 *   harm       损害 —— 让你损失
 *   use        操纵 —— 让你替他做事
 *   deceive    误导 —— 让你相信假的事
 *   infiltrate 渗透 —— 进入你的圈子
 *   subvert    颠覆 —— 动摇你的根基
 *   harvest    收割 —— 把你当资源
 *
 * 六种性质 × 三个层级（petty/serious/grand）= **三十多种手段**，
 * 而**效果按性质收敛成六种机制** —— 手段可以很多，机制不能失控。
 *
 * ## 目标也可以是 NPC
 *
 * 用户第 ① 条就说了「算计玩家**或者 NPC**」。所以 `targetKind` 是这一层的一等公民：
 * 阴谋的目标可以是玩家，也可以是另一个 NPC（高序列者之间也在互相下棋）。
 */

export type SchemeStage = 'lurk' | 'omen' | 'strike';

export const SCHEME_STAGE_LABELS: Record<SchemeStage, string> = {
  lurk: '布局',
  omen: '端倪',
  strike: '发动',
};

/* ---------------- 层级：谁在下棋 ---------------- */

export type SchemeTier = 'petty' | 'serious' | 'grand';

export const SCHEME_TIER_LABELS: Record<SchemeTier, string> = {
  petty: '街面上的算计',
  serious: '认真对付你',
  grand: '棋局',
};

/** 这个人能下到哪一层（序列越低，棋越大） */
export function schemeTierOf(sequence: number): SchemeTier {
  if (sequence <= 4) return 'grand';
  if (sequence <= 7) return 'serious';
  return 'petty';
}

/* ---------------- 性质：他图什么 ---------------- */

export const SCHEME_NATURES = ['harm', 'use', 'deceive', 'infiltrate', 'subvert', 'harvest'] as const;
export type SchemeNature = (typeof SCHEME_NATURES)[number];

export const SCHEME_NATURE_LABELS: Record<SchemeNature, string> = {
  harm: '损害',
  use: '操纵',
  deceive: '误导',
  infiltrate: '渗透',
  subvert: '颠覆',
  harvest: '收割',
};

/**
 * **手段目录**：nature → tier → 手段。
 *
 * 三十多个手段，每一种都是原著里这类人真会做的事；
 * 而它们的**效果**收敛到六种（见 effectOfNature）—— 手段是叙事，效果是机制。
 */
export const SCHEME_CATALOG: Record<SchemeNature, Record<SchemeTier, readonly string[]>> = {
  harm: {
    petty: ['pilfer', 'gossip', 'trip'],
    serious: ['curse', 'frame', 'break_wares'],
    grand: ['borrow_blade', 'dismantle'],
  },
  use: {
    petty: ['errand'],
    serious: ['lure', 'bait'],
    grand: ['use', 'puppet'],
  },
  deceive: {
    petty: ['rumor'],
    serious: ['false_lead', 'disguise'],
    grand: ['false_ally', 'rewrite_memory'],
  },
  infiltrate: {
    petty: ['watch'],
    serious: ['plant_spy', 'befriend'],
    grand: ['replace', 'turn_your_people'],
  },
  subvert: {
    petty: ['vandal'],
    serious: ['expose'],
    grand: ['sabotage_ritual', 'rewrite'],
  },
  harvest: {
    petty: ['tax'],
    serious: ['drain'],
    grand: ['plant', 'devour'],
  },
};

/** 所有手段（扁平） */
export const ALL_SCHEME_KINDS: readonly string[] = Object.values(SCHEME_CATALOG)
  .flatMap((byTier) => Object.values(byTier))
  .flat();

export type SchemeKind = string;

export const SCHEME_KIND_LABELS: Record<string, string> = {
  // 损害
  pilfer: '顺走你的东西', gossip: '传你的闲话', trip: '给你下绊子',
  curse: '下咒', frame: '栽赃', break_wares: '砸你的营生',
  borrow_blade: '借刀', dismantle: '拆你的根基',
  // 操纵
  errand: '使唤你', lure: '设饵', bait: '引你上钩',
  use: '利用你', puppet: '把你当提线木偶',
  // 误导
  rumor: '放假消息', false_lead: '给你一条假线索', disguise: '冒充别人',
  false_ally: '扮成你的盟友', rewrite_memory: '改你的记忆',
  // 渗透
  watch: '盯着你', plant_spy: '在你身边安插人', befriend: '接近你身边的人',
  replace: '顶替你的位置', turn_your_people: '策反你的人',
  // 颠覆
  vandal: '毁你的东西', expose: '揭穿你的秘密',
  sabotage_ritual: '破坏你的仪式', rewrite: '篡改你的记录',
  // 收割
  tax: '收你的份子', drain: '抽取你的力量',
  plant: '埋线', devour: '吞掉你的一部分',
};

/** 某层某性质下能用的手段 */
export function kindsFor(tier: SchemeTier, nature: SchemeNature): readonly string[] {
  return SCHEME_CATALOG[nature][tier];
}

/** 兼容旧签名（不传性质时：把该层所有手段摊平） */
export function kindsForTier(tier: SchemeTier): readonly string[] {
  return SCHEME_NATURES.flatMap((n) => SCHEME_CATALOG[n][tier]);
}

/**
 * **阴谋连锁**：哪些手段要先有铺垫。
 *
 * 用户提的「布局做出一些阴谋」—— 真正的棋局是**分步**的：
 * 先在你身边安插人，才谈得上顶替你；先扮成你的盟友，才谈得上利用你。
 * 一上来就「顶替」的不是棋手，是作弊。
 *
 * 判定：同一个人对同一个目标**完成过**前置手段（`npc_schemes` 里有已发动的记录），才允许下这一步。
 * ⚠️ 这张表只约束 **grand 层**（棋局级）—— 街面上的算计不需要铺垫。
 */
export const KIND_REQUIRES: Record<string, string> = {
  replace: 'plant_spy',            // 先在你身边安插人
  turn_your_people: 'befriend',    // 先接近你身边的人
  use: 'false_ally',               // 先扮成你的盟友
  devour: 'drain',                 // 先抽取，再吞掉
  rewrite: 'watch',                // 先盯梢，才知道要改哪一条
  borrow_blade: 'frame',           // 先栽赃，别人才信他替你得罪了人
  puppet: 'use',                   // 先利用过一次，才提得动线
  dismantle: 'expose',             // 先揭穿，才拆得动根基
  false_ally: 'disguise',          // 先冒充过别人，扮盟友才像
};

/** 这一步需要什么铺垫（没有则返回 null） */
export function requiresFor(kind: string): string | null {
  return KIND_REQUIRES[kind] ?? null;
}

/**
 * 这个手段现在能不能用。
 *
 * `doneKinds` 是「他对同一个目标**已经发动过**的手段集合」。
 */
export function canUseKind(kind: string, doneKinds: ReadonlySet<string>): boolean {
  const need = requiresFor(kind);
  if (need === null) return true;
  return doneKinds.has(need);
}

/** 这个手段属于哪种性质 */
export function natureOfKind(kind: string): SchemeNature {
  for (const nature of SCHEME_NATURES) {
    for (const tier of ['petty', 'serious', 'grand'] as const) {
      if (SCHEME_CATALOG[nature][tier].includes(kind)) return nature;
    }
  }
  return 'harm';
}

/**
 * **效果按性质收敛成六种** —— 这是「手段可以多，机制不能失控」的落点。
 *
 * 命令层按 nature 落后果，而不是按 kind 写三十个分支。
 */
export function effectOfNature(nature: SchemeNature): {
  /** 主要打在哪一项上 */
  target: 'item' | 'hp' | 'dig' | 'dp' | 'church' | 'wanted' | 'none';
  /** 世界事件里的抬头 */
  headline: string;
} {
  switch (nature) {
    case 'harm': return { target: 'hp', headline: '有人冲着你来' };
    case 'use': return { target: 'dp', headline: '有人借了你的手' };
    case 'deceive': return { target: 'dp', headline: '你信了一件不该信的事' };
    case 'infiltrate': return { target: 'church', headline: '你身边的人不太对' };
    case 'subvert': return { target: 'dig', headline: '你的根基被动过' };
    case 'harvest': return { target: 'item', headline: '有人从你身上拿走了什么' };
  }
}

/* ---------------- 时间：按层级 ---------------- */

export const SCHEME_DAYS_BY_TIER: Record<SchemeTier, { lurk: number; omen: number }> = {
  petty: { lurk: 7, omen: 3 },
  serious: { lurk: 14, omen: 7 },
  grand: { lurk: 90, omen: 30 },
};

export const SCHEME_DAYS: Record<SchemeStage, number> = { lurk: 14, omen: 7, strike: 0 };

export function schemeIdOf(npcId: string, targetId: string, kind: string): string {
  return `scheme-${npcId}-${targetId}-${kind}`;
}

/** 现在该推进到哪一阶段 */
export function stageAt(stage: SchemeStage, startedAt: number, now: number, tier: SchemeTier = 'serious'): SchemeStage {
  const days = SCHEME_DAYS_BY_TIER[tier];
  const elapsed = (now - startedAt) / 86_400_000;
  if (elapsed >= days.lurk + days.omen) return 'strike';
  if (elapsed >= days.lurk) return 'omen';
  return stage;
}

/* ---------------- 端倪与发动（按性质写，覆盖全部手段） ---------------- */

const OMEN_BY_NATURE: Record<SchemeNature, string> = {
  harm: '有些东西的位置不对 —— 你说不上来是哪儿，但你知道它原来不是这样。',
  use: '你回想这几天的安排，有一件事想不起是自己什么时候决定的 —— 但你确实去做了。',
  deceive: '有一件事你记得很清楚。太清楚了 —— 清楚到你想不起是谁告诉你的。',
  infiltrate: '有人对你太热情了。热情得像是排练过。',
  subvert: '你翻自己的记录，少了一件事。你确定你做过，但记录上没有。',
  harvest: '你最近总觉得累。不是没睡好那种累。',
};

const STRIKE_BY_NATURE: Record<SchemeNature, string> = {
  harm: '那一下落下来了。你甚至没看清是从哪个方向来的。',
  use: '你替他把那件事做完了。做完之后你才看明白：需要那件事发生的从来不是你。',
  deceive: '你照着那条线索走到底，才发现整条线索都是给人准备的 —— 包括你。',
  infiltrate: '你身边的人开始按别人的意思做事了。而他们看起来还是他们。',
  subvert: '你赖以立足的那件事不成立了 —— 而这不是意外。',
  harvest: '你身上少的那部分，不是丢的，是**被取走的**。',
};

export function omenTextOf(kind: string): string {
  return OMEN_BY_NATURE[natureOfKind(kind)];
}

export function strikeTextOf(kind: string): string {
  return STRIKE_BY_NATURE[natureOfKind(kind)];
}

/**
 * 玩家在端倪阶段查证之后能不能反制。
 *
 * ⚠️ 面对 grand（序列 ≤4）的布局，反制**注定很难** —— 这正是压迫感的来源。
 * 但绝不设为 0：原著里克莱恩就是靠准备与智慧一次次活下来的。
 */
export function foilChance(playerSequence: number, npcSequence: number): number {
  const gap = playerSequence - npcSequence;
  if (gap <= -2) return 0.85;
  if (gap === -1) return 0.7;
  if (gap === 0) return 0.5;
  if (gap === 1) return 0.3;
  if (gap === 2) return 0.15;
  if (gap === 3) return 0.08;
  return 0.03;
}
