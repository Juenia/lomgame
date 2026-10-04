/**
 * **NPC 的死亡与复活**（M2.164）—— 纯函数，无 IO。
 *
 * ## 用户拍板的两条
 *
 *   「NPC 死亡是**真的死亡**（永久，不刷新）」
 *   「**神明可以复活**（邪神也可以）—— 与 divine-thrones 的 resources/goals 接上」
 *
 * ## 「永久」是什么意思
 *
 * 生物生态会自己补回来（那是生态）—— 人**不补**。一个人死了，
 * 他就不再晋升、不再移动、不再出现在街上、不再算计谁；
 * npc_life 里那一条会一直躺在那儿，除非有神把他找回来。
 *
 * ## 两条口径，写在这里免得两头对不上
 *
 *  ① **资源是门槛，不是账本**。与 divine-decide.ts 的 availableMethods 完全一致：
 *     神的 resources 是静态内容（YAML），判定只问「够不够」，不扣减。
 *     要改成真扣减就得先把神座状态落库 —— 那是另一件事，不能半做。
 *  ② **没有记录 = 活着**。npc_life 只记「明确死过的人」（见 db/npc-life.ts）。
 *
 * ## 为什么死亡档位是显式表，而不是一条公式
 *
 * seq <= 6 ? 0.1 : 0.2 这种闭区间分支，会把**任何没预料到的档**静默吞进某一支
 * （AGENTS §3.3）。这里的 TIER_BY_SEQUENCE 是**显式表 + 缺失键报错**：
 * 序列 0—9 每一档都写着，越界立刻抛。
 */
import type { DivineResources } from './divine-throne.ts';
import type { Temperament } from './npc-relation.ts';

/** 怎么死的。文案与判据都读它 —— 中文名在这里，不许在别处再写一份 */
export const DEATH_KINDS = ['murder', 'scheme', 'calamity', 'creature', 'age'] as const;
export type DeathKind = (typeof DEATH_KINDS)[number];

export const DEATH_KIND_LABELS: Readonly<Record<DeathKind, string>> = {
  murder: '被人杀死',
  scheme: '死在别人的局里',
  calamity: '死于灾厄',
  creature: '死于怪物',
  age: '寿终',
};

/** 死亡档位（按序列粗分六档 —— 判定与复活门槛都读它） */
export const DEATH_TIERS = ['mortal', 'low', 'mid', 'high', 'angel', 'god'] as const;
export type DeathTier = (typeof DEATH_TIERS)[number];

export const DEATH_TIER_LABELS: Readonly<Record<DeathTier, string>> = {
  mortal: '凡人',
  low: '低序列',
  mid: '中序列',
  high: '高序列',
  angel: '天使',
  god: '神',
};

/** 序列 → 档位。**每一档都写着**：漏一档会在运行时抛，而不是静默归到某一支 */
const TIER_BY_SEQUENCE: Readonly<Record<number, DeathTier>> = {
  0: 'god',
  1: 'angel',
  2: 'angel',
  3: 'high',
  4: 'high',
  5: 'mid',
  6: 'mid',
  7: 'low',
  8: 'low',
  9: 'mortal',
};

export function deathTierOf(sequence: number): DeathTier {
  const tier = TIER_BY_SEQUENCE[sequence];
  if (tier === undefined) throw new Error('序列 ' + sequence + ' 没有对应的死亡档位 —— 去补 TIER_BY_SEQUENCE');
  return tier;
}

/**
 * **这一次会不会死**（掷中即死，不可逆）。
 *
 * 数值口径：凡人死于阴谋是**四分之一**（街面上的算计真的会死人），
 * 而序列 1 的天使被同样的算计弄死只有 **1.5%**；
 * 序列 0 是 **0** —— 一次阴谋杀不死坐在神位上的存在（要动祂得走神战那条线）。
 */
const DEATH_CHANCE: Readonly<Record<DeathTier, Readonly<Record<DeathKind, number>>>> = {
  mortal: { murder: 0.5, scheme: 0.25, calamity: 0.6, creature: 0.5, age: 0.05 },
  low: { murder: 0.35, scheme: 0.15, calamity: 0.35, creature: 0.3, age: 0.02 },
  mid: { murder: 0.2, scheme: 0.08, calamity: 0.2, creature: 0.18, age: 0.01 },
  high: { murder: 0.1, scheme: 0.04, calamity: 0.1, creature: 0.1, age: 0 },
  angel: { murder: 0.03, scheme: 0.015, calamity: 0.04, creature: 0.04, age: 0 },
  god: { murder: 0, scheme: 0, calamity: 0, creature: 0, age: 0 },
};

export function deathChanceOf(sequence: number, kind: DeathKind): number {
  return DEATH_CHANCE[deathTierOf(sequence)][kind];
}

/**
 * 杀一个人的**功绩**（按目标序列算：弄死一个序列 1 的人，胜过弄死十个凡人）。
 *
 * 它与 meritOfHunt（猎杀生物）同一个用途：成神门槛读功绩总分（见 npc-advance.ts）。
 * 少了这一条，杀人就没有回报 —— 那么高序列之间**不会有阴谋**，
 * 而这个世界的塔尖恰恰是靠这个转起来的。
 */
export function meritOfKill(sequence: number): number {
  return Math.max(0, 10 - sequence) * 2;
}

/**
 * **复活的门槛**（资源只判够不够，不扣 —— 见文件头第 ① 条）。
 *
 * 越强的人越难被找回来：天使与神那一档的「回来」在原作里需要极特定的条件
 * （身份、锚点、唯一性），不是有资源就行。
 */
export const REVIVE_NEEDS: Readonly<Record<DeathTier, { intel: number; wealth: number }>> = {
  mortal: { intel: 0, wealth: 0 },
  low: { intel: 1, wealth: 1 },
  mid: { intel: 2, wealth: 2 },
  high: { intel: 3, wealth: 3 },
  angel: { intel: 4, wealth: 4 },
  god: { intel: 5, wealth: 5 },
};

/** 找回来的概率（过了门槛之后还要掷这一下）—— 神不是有求必应的 */
export const REVIVE_ODDS: Readonly<Record<DeathTier, number>> = {
  mortal: 0.5,
  low: 0.35,
  mid: 0.2,
  high: 0.1,
  angel: 0.03,
  god: 0.01,
};

/**
 * **世界级大门**：每小时 0.2% —— 约二十天里有一次「有人被找了回来」。
 *
 * 与 divineStance 的稀有性同一个手法：先过一道极小的门，再谈关系与门槛。
 * 少了它，神就会变成一台复活机器（每个死者每天都被掷一次）。
 */
export const RESURRECTION_URGE_PER_HOUR = 0.002;

/** 最短的「不打扰」时间：死满一天之后才谈得上被找回来（刚死就复活太廉价） */
export const REVIVE_AFTER_HOURS = 24;

/**
 * 这位神**够不够格**把他找回来。
 *
 * 返回 { ok, reason } 而不是布尔：世界 tick 会把 reason 写进日志，
 * 「为什么祂没出手」必须答得上来（与 divineStance 的 reasons 同一口径）。
 */
export function canRevive(input: {
  sequence: number;
  resources: DivineResources;
  hoursSinceDeath: number;
}): { ok: boolean; reason: string } {
  const tier = deathTierOf(input.sequence);
  if (input.hoursSinceDeath < REVIVE_AFTER_HOURS) {
    return { ok: false, reason: '死去还不到 ' + REVIVE_AFTER_HOURS + ' 小时（' + Math.round(input.hoursSinceDeath) + '）' };
  }
  const need = REVIVE_NEEDS[tier];
  if (input.resources.intel < need.intel) {
    return { ok: false, reason: '情报不够（' + input.resources.intel + '/' + need.intel + '）' };
  }
  if (input.resources.wealth < need.wealth) {
    return { ok: false, reason: '财力不够（' + input.resources.wealth + '/' + need.wealth + '）' };
  }
  return { ok: true, reason: DEATH_TIER_LABELS[tier] + '档：情报 ' + need.intel + ' · 财力 ' + need.wealth };
}

/**
 * **祂为什么要为这个人开门**：死者得跟祂有关系。三条路，缺一不可的理由在下面。
 *
 *   ① 同一个教会（`npc-cast.yaml` 的 church 与神座的 resources.churches **同源**：
 *      都是 churches.yaml 的 id）
 *   ② 同一条途径（都走这条途径的人，是一条线上的）
 *   ③ **生前被他蛊惑过**（`npc_life.tempter` 等于祂的途径）——
 *      这一条是邪神那一档的主要入口：祂碰过的人，死了由祂收回来
 *
 * ⚠️ **故意没有「同一势力」这一路**：NPC 的 `faction` 指 `factions.yaml`，
 * 而神座的 `resources.factions` 指 `powers.yaml` —— **两张不同的表**。
 * 写上去看起来更完整，实际永远匹配不上，而且不报错。
 * 宁可少一路，也不要一路假的（AGENTS：抓不住故障的判据是装饰）。
 *
 * 没有这几条的话，神会随机去复活街上任何一个陌生人 —— 那不是神，那是刷新机制。
 */
export function boundToSeat(input: {
  npcChurch: string;
  npcPathway: string;
  /** 他生前被谁蛊惑过（`npc_life.tempter`）；空 = 没被碰过 */
  npcTempter?: string;
  throneChurches: readonly string[];
  thronePathway: string;
}): boolean {
  if (input.npcChurch !== '' && input.throneChurches.includes(input.npcChurch)) return true;
  if (input.npcPathway !== '' && input.npcPathway === input.thronePathway) return true;
  if (input.npcTempter !== undefined && input.npcTempter !== '' && input.npcTempter === input.thronePathway) return true;
  return false;
}

/**
 * **邪神那一档**（隐秘存在 / 外神）。
 *
 * 用户拍板「邪神也可以复活」—— 但祂们找回来的人**不再是原来那个人**：
 * 堕落度会跟着回来（CORRUPTION_ON_DARK_REVIVE）。这正是「邪神蛊惑 NPC 堕落」
 * 那一项机制的入口之一，所以两条要一起读。
 */
export function isDarkSeat(seatKind: string): boolean {
  return seatKind === 'hidden' || seatKind === 'outsider';
}

/** 邪神复活时带回来的堕落度 */
export const CORRUPTION_ON_DARK_REVIVE = 45;

/*
 * ═══════ 用户追问：**回来的还是他吗？还是人吗？** ═══════
 *
 * 第一版把复活写成了「原样回来 + 一个堕落度数字」—— 那等于读档：
 * 记忆、关系、性情全在，死亡就白死了。所以复活要有**形态**。
 *
 *   same    还是他 —— 只可能发生在第一次、且拉他回来的是正神那一档
 *   changed 是他，但缺了一块 —— 第二次起必然；好感被削、性情可能翻过来
 *   vessel  壳回来了、人没回来 —— 天使与神那一档被强行拉回：名字还在，记忆清零
 *   thrall  **不是人** —— 邪神那一档：祂的东西，只认祂，不认你
 */
export const RETURN_FORMS = ['same', 'changed', 'vessel', 'thrall'] as const;
export type ReturnForm = (typeof RETURN_FORMS)[number];

export const RETURN_FORM_LABELS: Readonly<Record<ReturnForm, string>> = {
  same: '还是他',
  changed: '缺了一块',
  vessel: '换了个壳',
  thrall: '不是人',
};

/**
 * **回来的是谁** —— 由「哪位神 + 第几次 + 他的序列」决定，与掷骰无关的部分先定死。
 *
 * 三条硬规矩（都不掷骰，所以可解释、可断言）：
 *   ① 邪神拉回来的一律是 thrall —— **没有第二种可能**（用户那一问的答案）
 *   ② 天使与神那一档被拉回，回来的多半是 vessel（强行把一个高序列者拉回来，
 *      代价就是「壳回来了，人没回来」）
 *   ③ 第二次起必然是 changed（第一次已经用掉了「原样」的那一次机会）
 *
 * 只有「第一次 + 正神」才掷那一下 50%：一半原样，一半缺一块。
 */
export function returnFormOf(input: {
  dark: boolean;
  /** 他已经被找回来过几次（**这一次之前**的次数，来自 npc_life.revivals） */
  revivals: number;
  sequence: number;
  /** 0—1 的掷值 */
  roll: number;
}): ReturnForm {
  if (input.dark) return 'thrall';
  const tier = deathTierOf(input.sequence);
  if (tier === 'god' || tier === 'angel') return 'vessel';
  if (input.revivals >= 1) return 'changed';
  return input.roll < 0.5 ? 'same' : 'changed';
}

/**
 * 他**还算不算人**。
 *
 * `thrall` 不算 —— 他是那位存在伸出来的一只手，不是一个人。
 * `vessel` **算**：走回来的那具身体里确实是个活着的人，只是不是原来那个。
 * 这个区分是有用的：「不算人」的东西不该被当作普通人对待（不能托付、不能被算计、
 * 也不该出现在「街上站着谁」的那份寻常名单里而不加说明）。
 */
export function humanOf(form: ReturnForm): boolean {
  return form !== 'thrall';
}

/**
 * **回来之后他还认得你多少**（对玩家的好感怎么变）。
 *
 *   same    照旧
 *   changed 减半（缺了一块：他还记得你，但不记得那件事）
 *   vessel  归零（这个人从来没认识过你）
 *   thrall  转负 —— 他认的是祂，而你站在祂的对面
 */
export function affinityAfterReturn(before: number, form: ReturnForm): number {
  if (form === 'same') return before;
  if (form === 'changed') return Math.round(before * 0.5);
  if (form === 'vessel') return 0;
  return Math.min(-30, -Math.abs(before));
}

/** 回来之后性情算不算黑暗向（changed / vessel / thrall 一律算 —— 他会替把他拉回来的那位做事） */
export function darkAfterReturn(form: ReturnForm): boolean {
  return form !== 'same';
}

/** 堕落度的三档（判定与文案都读它，免得两处各写一套阈值） */
export const CORRUPTION_TIERS = ['touched', 'swaying', 'fallen'] as const;
export type CorruptionTier = (typeof CORRUPTION_TIERS)[number];

export const CORRUPTION_TIER_LABELS: Readonly<Record<CorruptionTier, string>> = {
  touched: '被碰过',
  swaying: '动摇',
  fallen: '堕落',
};

/** 阈值：0—29 被碰过 / 30—69 动摇 / 70—100 堕落 */
export function corruptionTierOf(value: number): CorruptionTier {
  if (value >= 70) return 'fallen';
  if (value >= 30) return 'swaying';
  return 'touched';
}

/**
 * **动摇之后，他就开始替祂办事了**。
 *
 * 这是「蛊惑」与「阴谋」之间那条真正的线：`swaying` 及以上的人性情按黑暗向算，
 * 于是 `willScheme` 放行，他会成为祂伸出来的一只手（去算计玩家或同行）。
 * 少了这一条，堕落度就只是一个显示用的数字 —— 而用户不喜欢「显示个文本但没机制」。
 */
export function corruptedEnoughToServe(value: number): boolean {
  return corruptionTierOf(value) !== 'touched';
}

/*
 * ═══════ 邪神的低语（「邪神蛊惑 NPC 堕落」）═══════
 *
 * 与「复活成 thrall」是两条不同的路：
 *   复活成 thrall  死了之后被收走 —— 一次性，彻底
 *   低语           活着的时候被一点点说动 —— 慢慢来的，而且**可以被看见**
 */

/** 世界级大门：每小时 0.4% —— 低语比复活频繁得多（那是祂的日常） */
export const WHISPER_URGE_PER_HOUR = 0.004;

/** 一次低语推多少堕落度（不是一次到底 —— 蛊惑是慢慢来的） */
export const CORRUPTION_PER_WHISPER = 18;

/** 他的序列会不会挡住这一句：越强越难被说动（显式表，缺失键抛） */
const WHISPER_BY_TIER: Readonly<Record<DeathTier, number>> = {
  mortal: 1,
  low: 0.8,
  mid: 0.5,
  high: 0.3,
  angel: 0.2,
  god: 0,
};

/**
 * **他会不会被说动**。三件事决定，全都能从数据里查到（所以可解释）：
 *
 *   ① 性情：黑暗向的人本来就站在那一边（0.5）> 中立（0.3）> 善意（0.15）
 *   ② 序列：凡人 ×1，天使 ×0.2，神 ×0（神不会被低语说动）
 *   ③ **已经被碰过的人更容易**（+ 已有的堕落度 / 200）—— 这就是「一点点滑下去」
 */
export function whisperChance(input: {
  temperament: Temperament;
  sequence: number;
  corrupted: number;
}): number {
  const base = input.temperament === 'dark' ? 0.5 : input.temperament === 'neutral' ? 0.3 : 0.15;
  const byTier = WHISPER_BY_TIER[deathTierOf(input.sequence)];
  const slide = Math.max(0, Math.min(0.3, input.corrupted / 200));
  return Math.max(0, Math.min(0.95, base * byTier + slide));
}

/** 玩家读到的那一句（死亡）。killerName 为空 = 天灾 */
export function deathLineOf(name: string, kind: DeathKind, killerName: string): string {
  const how = DEATH_KIND_LABELS[kind];
  if (killerName === '') return name + '死了 —— ' + how + '。';
  return name + '死了 —— ' + killerName + '的手笔（' + how + '）。';
}

/**
 * 玩家读到的那一句（复活）。
 *
 * `seat` 为空串 = **匿名播报**（谁动的手进日志与图鉴，不进公开播报）——
 * 与神明行动那一条完全一致：玩家该读到「有人回来了」，而不是「黑夜女神复活了某某」。
 *
 * 四种形态四种说法：这一句是玩家判断「回来的到底是不是他」的唯一线索 ——
 * 全都写成「某某回来了」就等于把形态这件事藏起来了。
 */
const RETURN_LINES: Readonly<Record<ReturnForm, (name: string) => string>> = {
  same: (name) => name + '回来了 —— 还是他。',
  changed: (name) => name + '回来了 —— 但他缺了一块，像是忘了什么。',
  vessel: (name) => name + '回来了 —— 走回来的那具身体，未必是他。',
  thrall: (name) => name + '回来了 —— 那已经不是人了。',
};

export function reviveLineOf(name: string, form: ReturnForm, seat: string): string {
  const who = seat === '' ? '' : '（' + seat + '）';
  return RETURN_LINES[form](name) + who;
}
