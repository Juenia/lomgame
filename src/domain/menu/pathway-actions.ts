/**
 * 途径专属行动（M2.29 任务 2，P9/P10/P11 落地）。
 *
 * ## 这是什么
 *
 * 「占卜家占卜、药师制药、学徒开门」这类**途径专属的场景行动** ——
 * **不是**扮演事件（那是消化魔药的标签判定，见 `play/tags.ts`）。
 *
 * ## 为什么是独立表（P11）
 *
 * 它**不并入** `abilities.yaml`：能力是战斗/被动 effect（G2 口径），专属行动是场景行动（G10 口径）。
 * 「世界兼容度」靠的是**统一触发接口**（本文件的 `pathwayActionFor`）+ **效果进事件流**，
 * 不是「放在同一张表里」。
 *
 * ## 零行为变化地接入
 *
 * 7 条现状（原本写在 `explore-menu.ts` 的私有 `PATHWAY_EXPLORE_ACTION`）搬到这里，
 * 各补 `seq: 9` / `contexts: ['explore']` / `effect: { kind: 'none' }` ——
 * 迁移后由 `test/m2-29-pathway-actions.test.ts` 断言**逐字一致**。
 *
 * ## 解锁语义（与 `locations.yaml` 的 `min_seq` 同一口径）
 *
 *     action.seq >= player.sequence       ⇒ 可用
 *
 * 序列号**数字越小越强**（9 是最低、0 是最高）⇒「解锁序列 9」= 所有人都能用，
 * 「解锁序列 6」= 序列 6 及更高的人能用。一个途径在同一场景有多条可用时，
 * **取 `seq` 最小的那条**（最强的那条）。
 *
 * ## contexts 是**声明式**的（P10）
 *
 * 「都可触发」不等于「所有场景硬编码都能用」：每个行动声明它在哪些场景可用。
 * **占卜在 PVP 里能用，制药在 PVP 里不一定。**
 */
import { NUMERIC } from '../../config/numeric.ts';
import type { PathwayId } from '../character/types.ts';

/**
 * 行动可被触发的场景（P10）。
 *
 * ⚠️ **`pvp` 与 `battle` 是分开的两个值**：
 *   · `battle` —— PVE 遭遇战（`router/commands/battle-hooks.ts`）；
 *   · `pvp`    —— 异步回合的玩家对战（`router/commands/pvp-hooks.ts`）。
 * 它们是两个调用点。合并成一个值会让「只在 PVP 里有意义的行动」（如阅读者的「查阅」——
 * 生物身上没有「我见过这个」的语义）在 PVE 里也被放出去。
 */
export const ACTION_CONTEXTS = ['explore', 'daily', 'pvp', 'battle', 'command'] as const;
export type ActionContext = (typeof ACTION_CONTEXTS)[number];

/**
 * 行动效果的**形状**（统一触发接口的一半）。
 *
 * ⚠️ 这里只**声明**效果，不执行 —— 真正的执行仍归各 handler（铁律 1：判定层不做 IO）。
 * `kind` 的取值域是**封闭**的：开放它等于让每个行动自己发明动词，resolver 永远追不上内容表（K10）。
 */
export type PathwayActionKind = 'none' | 'query' | 'buff' | 'produce' | 'move';

export interface PathwayActionEffect {
  kind: PathwayActionKind;
  /** 各 `kind` 自己的参数；**由使用方解释**，本表不做校验（那是 schema 的事） */
  payload?: Record<string, unknown>;
}

export interface PathwayAction {
  /** 稳定机器名（`<途径>.<动作>`），落 `domain_events` 用 */
  id: string;
  pathway: PathwayId;
  /** **解锁序列**（语义同 `min_seq`：`action.seq >= player.sequence` 才可用） */
  seq: number;
  name: string;
  /** ⚠️ **必须非空** —— G10 的断言之一（P10：声明式，不硬编码） */
  contexts: readonly ActionContext[];
  label: (location: string) => string;
  command: (location: string) => string;
  preview: string;
  /** M2.85：'ap' 档随行动值机制一并下线，只剩 mp */
  needs?: 'mp';
  effect: PathwayActionEffect;
}

/**
 * 全部途径专属行动。
 *
 * **G10 冻结这张表**：`test/m2-29-pathway-actions.test.ts` 断言它的长度与「每条途径在 explore 恰好一条」。
 * 加行动必须同时改那条断言 —— 这是 M2.28 立的 G10（`docs/架构铁律.md` §三·补 的 G 表）。
 */
export const PATHWAY_ACTIONS: readonly PathwayAction[] = [
  /* M2.85 内容填充 P3（补）：door 的 battle 行动 —— 名字取自原作序列 8 的能力文本 */
  { id: 'door.battle', pathway: 'door', seq: 9, name: '戏法大师', contexts: ['battle'],
    label: (location) => `以戏法大师的手法抢先（door）`, command: (location) => `状态`,
    preview: '戏法大师 · 本战下一次出手伤害 ×1.4',
    effect: {"kind":"buff","payload":{"field":"nextAttackMultiplier","value":1.4,"uses":1}} },
  /* M2.85 内容填充 P3（补）：door 的 pvp 行动 —— 名字取自原作序列 9 的能力文本 */
  { id: 'door.pvp', pathway: 'door', seq: 9, name: '学徒', contexts: ['pvp'],
    label: (location) => `用学徒压住对面（door）`, command: (location) => `状态`,
    preview: '学徒 · 下一次交手对方伤害 ×0.6',
    effect: {"kind":"buff","payload":{"field":"enemyDamagePenalty","penalty":0.4,"turns":1,"uses":1}} },
  /* M2.85 内容填充 P3（补）：sun 的 battle 行动 —— 名字取自原作序列 8 的能力文本 */
  { id: 'sun.battle', pathway: 'sun', seq: 9, name: '白昼', contexts: ['battle'],
    label: (location) => `以白昼的手法抢先（sun）`, command: (location) => `状态`,
    preview: '白昼 · 本战下一次出手伤害 ×1.4',
    effect: {"kind":"buff","payload":{"field":"nextAttackMultiplier","value":1.4,"uses":1}} },
  /* M2.85 内容填充 P3（补）：sun 的 pvp 行动 —— 名字取自原作序列 9 的能力文本 */
  { id: 'sun.pvp', pathway: 'sun', seq: 9, name: '歌颂者', contexts: ['pvp'],
    label: (location) => `用歌颂者压住对面（sun）`, command: (location) => `状态`,
    preview: '歌颂者 · 下一次交手对方伤害 ×0.6',
    effect: {"kind":"buff","payload":{"field":"enemyDamagePenalty","penalty":0.4,"turns":1,"uses":1}} },
  /* M2.85 内容填充 P3（补）：corpse_collector 的 battle 行动 —— 名字取自原作序列 8 的能力文本 */
  { id: 'corpse_collector.battle', pathway: 'corpse_collector', seq: 9, name: '死亡之眼', contexts: ['battle'],
    label: (location) => `以死亡之眼的手法抢先（corpse_collector）`, command: (location) => `状态`,
    preview: '死亡之眼 · 本战下一次出手伤害 ×1.4',
    effect: {"kind":"buff","payload":{"field":"nextAttackMultiplier","value":1.4,"uses":1}} },
  /* M2.85 内容填充 P3（补）：corpse_collector 的 pvp 行动 —— 名字取自原作序列 9 的能力文本 */
  { id: 'corpse_collector.pvp', pathway: 'corpse_collector', seq: 9, name: '收尸人', contexts: ['pvp'],
    label: (location) => `用收尸人压住对面（corpse_collector）`, command: (location) => `状态`,
    preview: '收尸人 · 下一次交手对方伤害 ×0.6',
    effect: {"kind":"buff","payload":{"field":"enemyDamagePenalty","penalty":0.4,"turns":1,"uses":1}} },
  /* M2.85 内容填充 P3（补）：error 的 battle 行动 —— 名字取自原作序列 8 的能力文本 */
  { id: 'error.battle', pathway: 'error', seq: 9, name: '魅力', contexts: ['battle'],
    label: (location) => `以魅力的手法抢先（error）`, command: (location) => `状态`,
    preview: '魅力 · 本战下一次出手伤害 ×1.4',
    effect: {"kind":"buff","payload":{"field":"nextAttackMultiplier","value":1.4,"uses":1}} },
  /* M2.85 内容填充 P3（补）：error 的 pvp 行动 —— 名字取自原作序列 9 的能力文本 */
  { id: 'error.pvp', pathway: 'error', seq: 9, name: '偷盗者', contexts: ['pvp'],
    label: (location) => `用偷盗者压住对面（error）`, command: (location) => `状态`,
    preview: '偷盗者 · 下一次交手对方伤害 ×0.6',
    effect: {"kind":"buff","payload":{"field":"enemyDamagePenalty","penalty":0.4,"turns":1,"uses":1}} },
  /* M2.85 内容填充 P3（补）：mystery_pryer 的 battle 行动 —— 名字取自原作序列 8 的能力文本 */
  { id: 'mystery_pryer.battle', pathway: 'mystery_pryer', seq: 9, name: '格斗学者', contexts: ['battle'],
    label: (location) => `以格斗学者的手法抢先（mystery_pryer）`, command: (location) => `状态`,
    preview: '格斗学者 · 本战下一次出手伤害 ×1.4',
    effect: {"kind":"buff","payload":{"field":"nextAttackMultiplier","value":1.4,"uses":1}} },
  /* M2.85 内容填充 P3（补）：mystery_pryer 的 pvp 行动 —— 名字取自原作序列 9 的能力文本 */
  { id: 'mystery_pryer.pvp', pathway: 'mystery_pryer', seq: 9, name: '窥秘之眼', contexts: ['pvp'],
    label: (location) => `用窥秘之眼压住对面（mystery_pryer）`, command: (location) => `状态`,
    preview: '窥秘之眼 · 下一次交手对方伤害 ×0.6',
    effect: {"kind":"buff","payload":{"field":"enemyDamagePenalty","penalty":0.4,"turns":1,"uses":1}} },
  /* M2.85 内容填充 P3（补）：spectator 的 battle 行动 —— 名字取自原作序列 8 的能力文本 */
  { id: 'spectator.battle', pathway: 'spectator', seq: 9, name: '观众', contexts: ['battle'],
    label: (location) => `以观众的手法抢先（spectator）`, command: (location) => `状态`,
    preview: '观众 · 本战下一次出手伤害 ×1.4',
    effect: {"kind":"buff","payload":{"field":"nextAttackMultiplier","value":1.4,"uses":1}} },
  /* M2.85 内容填充 P3（补）：spectator 的 pvp 行动 —— 名字取自原作序列 9 的能力文本 */
  { id: 'spectator.pvp', pathway: 'spectator', seq: 9, name: '演员', contexts: ['pvp'],
    label: (location) => `用演员压住对面（spectator）`, command: (location) => `状态`,
    preview: '演员 · 下一次交手对方伤害 ×0.6',
    effect: {"kind":"buff","payload":{"field":"enemyDamagePenalty","penalty":0.4,"turns":1,"uses":1}} },
  /* M2.85 内容填充 P3（补）：apothecary 的 battle 行动 —— 名字取自原作序列 8 的能力文本 */
  { id: 'apothecary.battle', pathway: 'apothecary', seq: 9, name: '动物感官', contexts: ['battle'],
    label: (location) => `以动物感官的手法抢先（apothecary）`, command: (location) => `状态`,
    preview: '动物感官 · 本战下一次出手伤害 ×1.4',
    effect: {"kind":"buff","payload":{"field":"nextAttackMultiplier","value":1.4,"uses":1}} },
  /* M2.85 内容填充 P3（补）：apothecary 的 pvp 行动 —— 名字取自原作序列 9 的能力文本 */
  { id: 'apothecary.pvp', pathway: 'apothecary', seq: 9, name: '灵视', contexts: ['pvp'],
    label: (location) => `用灵视压住对面（apothecary）`, command: (location) => `状态`,
    preview: '灵视 · 下一次交手对方伤害 ×0.6',
    effect: {"kind":"buff","payload":{"field":"enemyDamagePenalty","penalty":0.4,"turns":1,"uses":1}} },
  /* M2.85 内容填充 P3（补）：arbiter 的 battle 行动 —— 名字取自原作序列 8 的能力文本 */
  { id: 'arbiter.battle', pathway: 'arbiter', seq: 9, name: '治安官', contexts: ['battle'],
    label: (location) => `以治安官的手法抢先（arbiter）`, command: (location) => `状态`,
    preview: '治安官 · 本战下一次出手伤害 ×1.4',
    effect: {"kind":"buff","payload":{"field":"nextAttackMultiplier","value":1.4,"uses":1}} },
  /* M2.85 内容填充 P3（补）：arbiter 的 pvp 行动 —— 名字取自原作序列 9 的能力文本 */
  { id: 'arbiter.pvp', pathway: 'arbiter', seq: 9, name: '仲裁人', contexts: ['pvp'],
    label: (location) => `用仲裁人压住对面（arbiter）`, command: (location) => `状态`,
    preview: '仲裁人 · 下一次交手对方伤害 ×0.6',
    effect: {"kind":"buff","payload":{"field":"enemyDamagePenalty","penalty":0.4,"turns":1,"uses":1}} },
  /* M2.85 内容填充 P3（补）：assassin 的 battle 行动 —— 名字取自原作序列 8 的能力文本 */
  { id: 'assassin.battle', pathway: 'assassin', seq: 9, name: '教唆', contexts: ['battle'],
    label: (location) => `以教唆的手法抢先（assassin）`, command: (location) => `状态`,
    preview: '教唆 · 本战下一次出手伤害 ×1.4',
    effect: {"kind":"buff","payload":{"field":"nextAttackMultiplier","value":1.4,"uses":1}} },
  /* M2.85 内容填充 P3（补）：assassin 的 pvp 行动 —— 名字取自原作序列 9 的能力文本 */
  { id: 'assassin.pvp', pathway: 'assassin', seq: 9, name: '刺客', contexts: ['pvp'],
    label: (location) => `用刺客压住对面（assassin）`, command: (location) => `状态`,
    preview: '刺客 · 下一次交手对方伤害 ×0.6',
    effect: {"kind":"buff","payload":{"field":"enemyDamagePenalty","penalty":0.4,"turns":1,"uses":1}} },
  /* M2.85 内容填充 P3（补）：criminal 的 battle 行动 —— 名字取自原作序列 8 的能力文本 */
  { id: 'criminal.battle', pathway: 'criminal', seq: 9, name: '恶语伤人', contexts: ['battle'],
    label: (location) => `以恶语伤人的手法抢先（criminal）`, command: (location) => `状态`,
    preview: '恶语伤人 · 本战下一次出手伤害 ×1.4',
    effect: {"kind":"buff","payload":{"field":"nextAttackMultiplier","value":1.4,"uses":1}} },
  /* M2.85 内容填充 P3（补）：criminal 的 pvp 行动 —— 名字取自原作序列 9 的能力文本 */
  { id: 'criminal.pvp', pathway: 'criminal', seq: 9, name: '罪犯', contexts: ['pvp'],
    label: (location) => `用罪犯压住对面（criminal）`, command: (location) => `状态`,
    preview: '罪犯 · 下一次交手对方伤害 ×0.6',
    effect: {"kind":"buff","payload":{"field":"enemyDamagePenalty","penalty":0.4,"turns":1,"uses":1}} },
  /* M2.85 内容填充 P3（补）：hunter 的 battle 行动 —— 名字取自原作序列 8 的能力文本 */
  { id: 'hunter.battle', pathway: 'hunter', seq: 9, name: '挑衅', contexts: ['battle'],
    label: (location) => `以挑衅的手法抢先（hunter）`, command: (location) => `状态`,
    preview: '挑衅 · 本战下一次出手伤害 ×1.4',
    effect: {"kind":"buff","payload":{"field":"nextAttackMultiplier","value":1.4,"uses":1}} },
  /* M2.85 内容填充 P3（补）：hunter 的 pvp 行动 —— 名字取自原作序列 9 的能力文本 */
  { id: 'hunter.pvp', pathway: 'hunter', seq: 9, name: '止血药', contexts: ['pvp'],
    label: (location) => `用止血药压住对面（hunter）`, command: (location) => `状态`,
    preview: '止血药 · 下一次交手对方伤害 ×0.6',
    effect: {"kind":"buff","payload":{"field":"enemyDamagePenalty","penalty":0.4,"turns":1,"uses":1}} },
  /* M2.85 内容填充 P3（补）：lawyer 的 battle 行动 —— 名字取自原作序列 8 的能力文本 */
  { id: 'lawyer.battle', pathway: 'lawyer', seq: 9, name: '野蛮人', contexts: ['battle'],
    label: (location) => `以野蛮人的手法抢先（lawyer）`, command: (location) => `状态`,
    preview: '野蛮人 · 本战下一次出手伤害 ×1.4',
    effect: {"kind":"buff","payload":{"field":"nextAttackMultiplier","value":1.4,"uses":1}} },
  /* M2.85 内容填充 P3（补）：lawyer 的 pvp 行动 —— 名字取自原作序列 9 的能力文本 */
  { id: 'lawyer.pvp', pathway: 'lawyer', seq: 9, name: '律师', contexts: ['pvp'],
    label: (location) => `用律师压住对面（lawyer）`, command: (location) => `状态`,
    preview: '律师 · 下一次交手对方伤害 ×0.6',
    effect: {"kind":"buff","payload":{"field":"enemyDamagePenalty","penalty":0.4,"turns":1,"uses":1}} },
  /* M2.85 内容填充 P3（补）：monster 的 battle 行动 —— 名字取自原作序列 8 的能力文本 */
  { id: 'monster.battle', pathway: 'monster', seq: 9, name: '机器', contexts: ['battle'],
    label: (location) => `以机器的手法抢先（monster）`, command: (location) => `状态`,
    preview: '机器 · 本战下一次出手伤害 ×1.4',
    effect: {"kind":"buff","payload":{"field":"nextAttackMultiplier","value":1.4,"uses":1}} },
  /* M2.85 内容填充 P3（补）：monster 的 pvp 行动 —— 名字取自原作序列 9 的能力文本 */
  { id: 'monster.pvp', pathway: 'monster', seq: 9, name: '怪物', contexts: ['pvp'],
    label: (location) => `用怪物压住对面（monster）`, command: (location) => `状态`,
    preview: '怪物 · 下一次交手对方伤害 ×0.6',
    effect: {"kind":"buff","payload":{"field":"enemyDamagePenalty","penalty":0.4,"turns":1,"uses":1}} },
  /* M2.85 内容填充 P3（补）：prisoner 的 battle 行动 —— 名字取自原作序列 8 的能力文本 */
  { id: 'prisoner.battle', pathway: 'prisoner', seq: 9, name: '诅咒', contexts: ['battle'],
    label: (location) => `以诅咒的手法抢先（prisoner）`, command: (location) => `状态`,
    preview: '诅咒 · 本战下一次出手伤害 ×1.4',
    effect: {"kind":"buff","payload":{"field":"nextAttackMultiplier","value":1.4,"uses":1}} },
  /* M2.85 内容填充 P3（补）：prisoner 的 pvp 行动 —— 名字取自原作序列 9 的能力文本 */
  { id: 'prisoner.pvp', pathway: 'prisoner', seq: 9, name: '囚犯', contexts: ['pvp'],
    label: (location) => `用囚犯压住对面（prisoner）`, command: (location) => `状态`,
    preview: '囚犯 · 下一次交手对方伤害 ×0.6',
    effect: {"kind":"buff","payload":{"field":"enemyDamagePenalty","penalty":0.4,"turns":1,"uses":1}} },
  /* M2.85 内容填充 P3（补）：secrets_supplicant 的 battle 行动 —— 名字取自原作序列 8 的能力文本 */
  { id: 'secrets_supplicant.battle', pathway: 'secrets_supplicant', seq: 9, name: '倾听', contexts: ['battle'],
    label: (location) => `以倾听的手法抢先（secrets_supplicant）`, command: (location) => `状态`,
    preview: '倾听 · 本战下一次出手伤害 ×1.4',
    effect: {"kind":"buff","payload":{"field":"nextAttackMultiplier","value":1.4,"uses":1}} },
  /* M2.85 内容填充 P3（补）：secrets_supplicant 的 pvp 行动 —— 名字取自原作序列 9 的能力文本 */
  { id: 'secrets_supplicant.pvp', pathway: 'secrets_supplicant', seq: 9, name: '秘祈人', contexts: ['pvp'],
    label: (location) => `用秘祈人压住对面（secrets_supplicant）`, command: (location) => `状态`,
    preview: '秘祈人 · 下一次交手对方伤害 ×0.6',
    effect: {"kind":"buff","payload":{"field":"enemyDamagePenalty","penalty":0.4,"turns":1,"uses":1}} },
  /* M2.85 内容填充 P3：door 的 daily 行动（补 contexts 覆盖）—— 名字取自原作序列称号，效果字段用的是**现役字段**（判定层已有读取点）
   * 依据：原作序列 9 能力描述关键词 */
  { id: 'door.daily', pathway: 'door', seq: 9, name: '学徒', contexts: ['daily'],
    label: (location) => `以学徒的方式处理${location}（door）`, command: (location) => `今日`,
    preview: '学徒 · 纯读 · 不消耗任何东西',
    effect: {"kind":"query","payload":{"field":"record","scope":"species"}} },
  /* M2.85 内容填充 P3：door 的 command 行动（补 contexts 覆盖）—— 名字取自原作序列称号，效果字段用的是**现役字段**（判定层已有读取点）
   * 依据：原作序列 8 能力描述关键词 */
  { id: 'door.command', pathway: 'door', seq: 9, name: '戏法大师', contexts: ['command'],
    label: (location) => `以学徒的方式处理${location}（door）`, command: (location) => `状态`,
    preview: '戏法大师 · 本地点这一次有额外收获',
    effect: {"kind":"produce","payload":{"field":"lootGrant","source":"visitedToday","uses":1}} },
  /* M2.85 内容填充 P3：sun 的 daily 行动（补 contexts 覆盖）—— 名字取自原作序列称号，效果字段用的是**现役字段**（判定层已有读取点）
   * 依据：原作序列 9 能力描述关键词 */
  { id: 'sun.daily', pathway: 'sun', seq: 9, name: '歌颂者', contexts: ['daily'],
    label: (location) => `以学徒的方式处理${location}（sun）`, command: (location) => `今日`,
    preview: '歌颂者 · 本地点这一次有额外收获',
    effect: {"kind":"buff","payload":{"field":"lootMultiplier","value":1.5,"uses":1}} },
  /* M2.85 内容填充 P3：sun 的 command 行动（补 contexts 覆盖）—— 名字取自原作序列称号，效果字段用的是**现役字段**（判定层已有读取点）
   * 依据：原作序列 8 能力描述关键词 */
  { id: 'sun.command', pathway: 'sun', seq: 9, name: '祈光人', contexts: ['command'],
    label: (location) => `以学徒的方式处理${location}（sun）`, command: (location) => `状态`,
    preview: '祈光人 · 本地点这一次有额外收获',
    effect: {"kind":"produce","payload":{"field":"lootGrant","source":"visitedToday","uses":1}} },
  /* M2.85 内容填充 P3：corpse_collector 的 daily 行动（补 contexts 覆盖）—— 名字取自原作序列称号，效果字段用的是**现役字段**（判定层已有读取点）
   * 依据：原作序列 9 能力描述关键词 */
  { id: 'corpse_collector.daily', pathway: 'corpse_collector', seq: 9, name: '收尸人', contexts: ['daily'],
    label: (location) => `以学徒的方式处理${location}（corpse_collector）`, command: (location) => `今日`,
    preview: '收尸人 · 纯读 · 不消耗任何东西',
    effect: {"kind":"query","payload":{"field":"hostilitySense","scope":"adjacent","depth":1}} },
  /* M2.85 内容填充 P3：corpse_collector 的 command 行动（补 contexts 覆盖）—— 名字取自原作序列称号，效果字段用的是**现役字段**（判定层已有读取点）
   * 依据：原作序列 8 能力描述关键词 */
  { id: 'corpse_collector.command', pathway: 'corpse_collector', seq: 9, name: '掘墓人', contexts: ['command'],
    label: (location) => `以学徒的方式处理${location}（corpse_collector）`, command: (location) => `状态`,
    preview: '掘墓人 · 纯读 · 不消耗任何东西',
    effect: {"kind":"query","payload":{"field":"hostilitySense","scope":"adjacent","depth":1}} },
  /* M2.85 内容填充 P3：error 的 daily 行动（补 contexts 覆盖）—— 名字取自原作序列称号，效果字段用的是**现役字段**（判定层已有读取点）
   * 依据：原作序列 9 能力描述关键词 */
  { id: 'error.daily', pathway: 'error', seq: 9, name: '偷盗者', contexts: ['daily'],
    label: (location) => `以学徒的方式处理${location}（error）`, command: (location) => `今日`,
    preview: '偷盗者 · 纯读 · 不消耗任何东西',
    effect: {"kind":"query","payload":{"field":"hostilitySense","scope":"adjacent","depth":1}} },
  /* M2.85 内容填充 P3：error 的 command 行动（补 contexts 覆盖）—— 名字取自原作序列称号，效果字段用的是**现役字段**（判定层已有读取点）
   * 依据：原作序列 8 能力描述关键词 */
  { id: 'error.command', pathway: 'error', seq: 9, name: '诈骗师', contexts: ['command'],
    label: (location) => `以学徒的方式处理${location}（error）`, command: (location) => `状态`,
    preview: '诈骗师 · 纯读 · 不消耗任何东西',
    effect: {"kind":"query","payload":{"field":"hostilitySense","scope":"adjacent","depth":1}} },
  /* M2.85 内容填充 P3：mystery_pryer 的 daily 行动（补 contexts 覆盖）—— 名字取自原作序列称号，效果字段用的是**现役字段**（判定层已有读取点）
   * 依据：原作序列 9 能力描述关键词 */
  { id: 'mystery_pryer.daily', pathway: 'mystery_pryer', seq: 9, name: '窥秘人', contexts: ['daily'],
    label: (location) => `以学徒的方式处理${location}（mystery_pryer）`, command: (location) => `今日`,
    preview: '窥秘人 · 纯读 · 不消耗任何东西',
    effect: {"kind":"query","payload":{"field":"hostilitySense","scope":"adjacent","depth":1}} },
  /* M2.85 内容填充 P3：mystery_pryer 的 command 行动（补 contexts 覆盖）—— 名字取自原作序列称号，效果字段用的是**现役字段**（判定层已有读取点）
   * 依据：原作序列 8 能力描述关键词 */
  { id: 'mystery_pryer.command', pathway: 'mystery_pryer', seq: 9, name: '格斗学者', contexts: ['command'],
    label: (location) => `以学徒的方式处理${location}（mystery_pryer）`, command: (location) => `状态`,
    preview: '格斗学者 · 本地点这一次有额外收获',
    effect: {"kind":"buff","payload":{"field":"lootMultiplier","value":1.5,"uses":1}} },
  /* M2.85 内容填充 P3：spectator 的 daily 行动（补 contexts 覆盖）—— 名字取自原作序列称号，效果字段用的是**现役字段**（判定层已有读取点）
   * 依据：原作序列 9 能力描述关键词 */
  { id: 'spectator.daily', pathway: 'spectator', seq: 9, name: '观众', contexts: ['daily'],
    label: (location) => `以学徒的方式处理${location}（spectator）`, command: (location) => `今日`,
    preview: '观众 · 纯读 · 不消耗任何东西',
    effect: {"kind":"query","payload":{"field":"hostilitySense","scope":"adjacent","depth":1}} },
  /* M2.85 内容填充 P3：spectator 的 command 行动（补 contexts 覆盖）—— 名字取自原作序列称号，效果字段用的是**现役字段**（判定层已有读取点）
   * 依据：原作序列 8 能力描述关键词 */
  { id: 'spectator.command', pathway: 'spectator', seq: 9, name: '读心者', contexts: ['command'],
    label: (location) => `以学徒的方式处理${location}（spectator）`, command: (location) => `状态`,
    preview: '读心者 · 纯读 · 不消耗任何东西',
    effect: {"kind":"query","payload":{"field":"hostilitySense","scope":"adjacent","depth":1}} },
  /* M2.85 内容填充 P3：apothecary 的 daily 行动（补 contexts 覆盖）—— 名字取自原作序列称号，效果字段用的是**现役字段**（判定层已有读取点）
   * 依据：原作序列 9 能力描述关键词 */
  { id: 'apothecary.daily', pathway: 'apothecary', seq: 9, name: '药师', contexts: ['daily'],
    label: (location) => `以学徒的方式处理${location}（apothecary）`, command: (location) => `今日`,
    preview: '药师 · 本地点这一次有额外收获',
    effect: {"kind":"buff","payload":{"field":"lootMultiplier","value":1.5,"uses":1}} },
  /* M2.85 内容填充 P3：apothecary 的 command 行动（补 contexts 覆盖）—— 名字取自原作序列称号，效果字段用的是**现役字段**（判定层已有读取点）
   * 依据：原作序列 8 能力描述关键词 */
  { id: 'apothecary.command', pathway: 'apothecary', seq: 9, name: '驯兽师', contexts: ['command'],
    label: (location) => `以学徒的方式处理${location}（apothecary）`, command: (location) => `状态`,
    preview: '驯兽师 · 本地点这一次有额外收获',
    effect: {"kind":"buff","payload":{"field":"lootMultiplier","value":1.5,"uses":1}} },
  /* M2.85 内容填充 P3：arbiter 的 daily 行动（补 contexts 覆盖）—— 名字取自原作序列称号，效果字段用的是**现役字段**（判定层已有读取点）
   * 依据：原作序列 9 能力描述关键词 */
  { id: 'arbiter.daily', pathway: 'arbiter', seq: 9, name: '仲裁人', contexts: ['daily'],
    label: (location) => `以学徒的方式处理${location}（arbiter）`, command: (location) => `今日`,
    preview: '仲裁人 · 本地点这一次有额外收获',
    effect: {"kind":"buff","payload":{"field":"exploreDangerMultiplier","multiplier":0.9,"uses":1}} },
  /* M2.85 内容填充 P3：arbiter 的 command 行动（补 contexts 覆盖）—— 名字取自原作序列称号，效果字段用的是**现役字段**（判定层已有读取点）
   * 依据：原作序列 8 能力描述关键词 */
  { id: 'arbiter.command', pathway: 'arbiter', seq: 9, name: '治安官', contexts: ['command'],
    label: (location) => `以学徒的方式处理${location}（arbiter）`, command: (location) => `状态`,
    preview: '治安官 · 纯读 · 不消耗任何东西',
    effect: {"kind":"query","payload":{"field":"hostilitySense","scope":"adjacent","depth":1}} },
  /* M2.85 内容填充 P3：assassin 的 daily 行动（补 contexts 覆盖）—— 名字取自原作序列称号，效果字段用的是**现役字段**（判定层已有读取点）
   * 依据：原作序列 9 能力描述关键词 */
  { id: 'assassin.daily', pathway: 'assassin', seq: 9, name: '刺客', contexts: ['daily'],
    label: (location) => `以学徒的方式处理${location}（assassin）`, command: (location) => `今日`,
    preview: '刺客 · 本地点这一次有额外收获',
    effect: {"kind":"buff","payload":{"field":"lootMultiplier","value":1.5,"uses":1}} },
  /* M2.85 内容填充 P3：assassin 的 command 行动（补 contexts 覆盖）—— 名字取自原作序列称号，效果字段用的是**现役字段**（判定层已有读取点）
   * 依据：原作序列 8 能力描述关键词 */
  { id: 'assassin.command', pathway: 'assassin', seq: 9, name: '教唆者', contexts: ['command'],
    label: (location) => `以学徒的方式处理${location}（assassin）`, command: (location) => `状态`,
    preview: '教唆者 · 纯读 · 不消耗任何东西',
    effect: {"kind":"query","payload":{"field":"hostilitySense","scope":"adjacent","depth":1}} },
  /* M2.85 内容填充 P3：criminal 的 daily 行动（补 contexts 覆盖）—— 名字取自原作序列称号，效果字段用的是**现役字段**（判定层已有读取点）
   * 依据：原作序列 9 能力描述关键词 */
  { id: 'criminal.daily', pathway: 'criminal', seq: 9, name: '罪犯', contexts: ['daily'],
    label: (location) => `以学徒的方式处理${location}（criminal）`, command: (location) => `今日`,
    preview: '罪犯 · 本地点这一次有额外收获',
    effect: {"kind":"buff","payload":{"field":"lootMultiplier","value":1.5,"uses":1}} },
  /* M2.85 内容填充 P3：criminal 的 command 行动（补 contexts 覆盖）—— 名字取自原作序列称号，效果字段用的是**现役字段**（判定层已有读取点）
   * 依据：原作序列 8 能力描述关键词 */
  { id: 'criminal.command', pathway: 'criminal', seq: 9, name: '折翼天使', contexts: ['command'],
    label: (location) => `以学徒的方式处理${location}（criminal）`, command: (location) => `状态`,
    preview: '折翼天使 · 本地点这一次有额外收获',
    effect: {"kind":"produce","payload":{"field":"lootGrant","source":"visitedToday","uses":1}} },
  /* M2.85 内容填充 P3：hunter 的 daily 行动（补 contexts 覆盖）—— 名字取自原作序列称号，效果字段用的是**现役字段**（判定层已有读取点）
   * 依据：原作序列 9 能力描述关键词 */
  { id: 'hunter.daily', pathway: 'hunter', seq: 9, name: '猎人', contexts: ['daily'],
    label: (location) => `以学徒的方式处理${location}（hunter）`, command: (location) => `今日`,
    preview: '猎人 · 纯读 · 不消耗任何东西',
    effect: {"kind":"query","payload":{"field":"hostilitySense","scope":"adjacent","depth":1}} },
  /* M2.85 内容填充 P3：hunter 的 command 行动（补 contexts 覆盖）—— 名字取自原作序列称号，效果字段用的是**现役字段**（判定层已有读取点）
   * 依据：原作序列 8 能力描述关键词 */
  { id: 'hunter.command', pathway: 'hunter', seq: 9, name: '挑衅者', contexts: ['command'],
    label: (location) => `以学徒的方式处理${location}（hunter）`, command: (location) => `状态`,
    preview: '挑衅者 · 纯读 · 不消耗任何东西',
    effect: {"kind":"query","payload":{"field":"hostilitySense","scope":"adjacent","depth":1}} },
  /* M2.85 内容填充 P3：lawyer 的 daily 行动（补 contexts 覆盖）—— 名字取自原作序列称号，效果字段用的是**现役字段**（判定层已有读取点）
   * 依据：原作序列 9 能力描述关键词 */
  { id: 'lawyer.daily', pathway: 'lawyer', seq: 9, name: '律师', contexts: ['daily'],
    label: (location) => `以学徒的方式处理${location}（lawyer）`, command: (location) => `今日`,
    preview: '律师 · 本地点这一次有额外收获',
    effect: {"kind":"buff","payload":{"field":"lootMultiplier","value":1.5,"uses":1}} },
  /* M2.85 内容填充 P3：lawyer 的 command 行动（补 contexts 覆盖）—— 名字取自原作序列称号，效果字段用的是**现役字段**（判定层已有读取点）
   * 依据：原作序列 8 能力描述关键词 */
  { id: 'lawyer.command', pathway: 'lawyer', seq: 9, name: '野蛮人', contexts: ['command'],
    label: (location) => `以学徒的方式处理${location}（lawyer）`, command: (location) => `状态`,
    preview: '野蛮人 · 本地点这一次有额外收获',
    effect: {"kind":"buff","payload":{"field":"lootMultiplier","value":1.5,"uses":1}} },
  /* M2.85 内容填充 P3：monster 的 daily 行动（补 contexts 覆盖）—— 名字取自原作序列称号，效果字段用的是**现役字段**（判定层已有读取点）
   * 依据：原作序列 9 能力描述关键词 */
  { id: 'monster.daily', pathway: 'monster', seq: 9, name: '怪物', contexts: ['daily'],
    label: (location) => `以学徒的方式处理${location}（monster）`, command: (location) => `今日`,
    preview: '怪物 · 纯读 · 不消耗任何东西',
    effect: {"kind":"query","payload":{"field":"hostilitySense","scope":"adjacent","depth":1}} },
  /* M2.85 内容填充 P3：monster 的 command 行动（补 contexts 覆盖）—— 名字取自原作序列称号，效果字段用的是**现役字段**（判定层已有读取点）
   * 依据：原作序列 8 能力描述关键词 */
  { id: 'monster.command', pathway: 'monster', seq: 9, name: '机器', contexts: ['command'],
    label: (location) => `以学徒的方式处理${location}（monster）`, command: (location) => `状态`,
    preview: '机器 · 本地点这一次有额外收获',
    effect: {"kind":"buff","payload":{"field":"lootMultiplier","value":1.5,"uses":1}} },
  /* M2.85 内容填充 P3：prisoner 的 daily 行动（补 contexts 覆盖）—— 名字取自原作序列称号，效果字段用的是**现役字段**（判定层已有读取点）
   * 依据：原作序列 9 能力描述关键词 */
  { id: 'prisoner.daily', pathway: 'prisoner', seq: 9, name: '囚犯', contexts: ['daily'],
    label: (location) => `以学徒的方式处理${location}（prisoner）`, command: (location) => `今日`,
    preview: '囚犯 · 本地点这一次有额外收获',
    effect: {"kind":"buff","payload":{"field":"lootMultiplier","value":1.5,"uses":1}} },
  /* M2.85 内容填充 P3：prisoner 的 command 行动（补 contexts 覆盖）—— 名字取自原作序列称号，效果字段用的是**现役字段**（判定层已有读取点）
   * 依据：原作序列 8 能力描述关键词 */
  { id: 'prisoner.command', pathway: 'prisoner', seq: 9, name: '疯子', contexts: ['command'],
    label: (location) => `以学徒的方式处理${location}（prisoner）`, command: (location) => `状态`,
    preview: '疯子 · 本地点这一次有额外收获',
    effect: {"kind":"buff","payload":{"field":"lootMultiplier","value":1.5,"uses":1}} },
  /* M2.85 内容填充 P3：secrets_supplicant 的 daily 行动（补 contexts 覆盖）—— 名字取自原作序列称号，效果字段用的是**现役字段**（判定层已有读取点）
   * 依据：原作序列 9 能力描述关键词 */
  { id: 'secrets_supplicant.daily', pathway: 'secrets_supplicant', seq: 9, name: '秘祈人', contexts: ['daily'],
    label: (location) => `以学徒的方式处理${location}（secrets_supplicant）`, command: (location) => `今日`,
    preview: '秘祈人 · 纯读 · 不消耗任何东西',
    effect: {"kind":"query","payload":{"field":"hostilitySense","scope":"adjacent","depth":1}} },
  /* M2.85 内容填充 P3：secrets_supplicant 的 command 行动（补 contexts 覆盖）—— 名字取自原作序列称号，效果字段用的是**现役字段**（判定层已有读取点）
   * 依据：原作序列 8 能力描述关键词 */
  { id: 'secrets_supplicant.command', pathway: 'secrets_supplicant', seq: 9, name: '倾听者', contexts: ['command'],
    label: (location) => `以学徒的方式处理${location}（secrets_supplicant）`, command: (location) => `状态`,
    preview: '倾听者 · 本地点这一次有额外收获',
    effect: {"kind":"buff","payload":{"field":"lootMultiplier","value":1.5,"uses":1}} },
  {
    id: 'seer.divine',
    pathway: 'seer',
    seq: 9,
    name: '占卜',
    contexts: ['explore'],
    label: (location) => `占卜一下${location}的底细（愚者专属）`,
    command: (location) => `占卜 我要去${location}，路上会出什么事`,
    preview: `灵性 -${NUMERIC.divination.mpCost}`,
    needs: 'mp',
    effect: { kind: 'none' },
  },
  /* ---- M2.29 批次 A1：序列 6 的行动（第一个「序列递进」的真实条目）----
   *
   * ⚠️ 它的 `contexts` 有**两个**（`daily` / `explore`）——
   *    这是「声明式 ≠ 硬编码所有场景」的第一个真实例子：
   *    无面人可以随时改头换面（daily），也可以在进门之前换一张脸（explore），
   *    但**不能在 PVP 回合里换**（那不是它的语义）。
   */
  {
    id: 'seer.disguise',
    pathway: 'seer',
    seq: 6,
    name: '化身',
    contexts: ['daily', 'explore'],
    label: (location) => `换一张脸再进${location}（无面人）`,
    command: (location) => `状态`,
    preview: '不消耗行动点 · 本地点这一次的敌意降一档',
    effect: { kind: 'buff', payload: { field: 'exploreDangerMultiplier', multiplier: 0.9, uses: 1 } },
  },
  /* M2.29 批次 A1：其余六条序列 6 的行动（与 seer.disguise 同批）。 */
  { id: 'warrior.intimidate', pathway: 'warrior', seq: 6, name: '威慑', contexts: ['explore'],
    label: (location) => `站在那里不动，让它先退一步（守护者）`, command: (location) => `事件 @D@{location}`,
    // M2.85：preview 的「行动点 -1 · 」前缀随行动值一并删除
    preview: '本地点今日事件延后一格',
    effect: { kind: 'buff', payload: { field: 'eventDelay', turns: 1, uses: 1 } } },
  { id: 'sleepless.hearDream', pathway: 'sleepless', seq: 6, name: '听梦', contexts: ['explore', 'daily'],
    label: (location) => `听一会儿，看${location}有没有人在做梦（守夜人）`, command: (location) => `世界 ${location}`,
    preview: '不消耗行动点 · 读到该地点的在场者线索',
    effect: { kind: 'query', payload: { field: 'dreamGap', depth: 2 } } },
  { id: 'sailor.soundDepth', pathway: 'sailor', seq: 6, name: '测深', contexts: ['explore'],
    label: (location) => `听一会儿水声，知道下面有什么（海洋歌者）`, command: (location) => `世界 ${location}`,
    preview: '不消耗行动点 · 本地点这一次探索危险 ×0.8',
    effect: { kind: 'buff', payload: { field: 'exploreDangerMultiplier', multiplier: 0.8, uses: 1 } } },
  { id: 'perfect.disassemble', pathway: 'perfect', seq: 6, name: '拆解', contexts: ['explore'],
    label: (location) => `先把这台机器看穿（机械师）`, command: (location) => `背包`,
    preview: '不消耗行动点 · 读到机关类提示',
    effect: { kind: 'query', payload: { field: 'hostilitySense', scope: 'mechanism' } } },
  { id: 'reader.takenote', pathway: 'reader', seq: 6, name: '速记', contexts: ['explore', 'daily'],
    label: (location) => `把刚看到的原样记下来（解读者）`, command: (location) => `状态`,
    preview: '不消耗行动点 · 本日多记一条',
    effect: { kind: 'buff', payload: { field: 'divinationDailyBonus', value: 1, scope: 'note' } } },
  { id: 'mother.tend', pathway: 'mother', seq: 6, name: '抚育', contexts: ['daily', 'explore'],
    label: (location) => `照料一样还在长的东西（牧者）`, command: (location) => `今日`,
    preview: '不消耗行动点 · 本日恢复一部分生命',
    effect: { kind: 'buff', payload: { field: 'maxHpBonus', value: 10, scope: 'restore', uses: 1 } } },
  /* M2.29 批次 A2：序列 5 的七条行动。 */
  { id: 'seer.puppet', pathway: 'seer', seq: 5, name: '秘偶代行', contexts: ['explore', 'command'],
    label: (location) => `让偶人替你去${location}（秘偶大师）`, command: (location) => `背包`,
    // M2.85：不再有行动点 —— 秘偶代行的价值就是「这一趟偶人替你走」
    preview: '消耗一件道具 · 这一趟让偶人替你去',
    effect: { kind: 'produce', payload: { consume: 1, grant: 'freeExplore' } } },
  { id: 'warrior.readOpening', pathway: 'warrior', seq: 5, name: '破绽', contexts: ['explore', 'pvp'],
    label: (location) => `先看他哪里是空的（武器大师）`, command: (location) => `事件 ${location}`,
    preview: '下一次攻击倍率提高',
    effect: { kind: 'buff', payload: { field: 'nextAttackMultiplier', multiplier: 1.5, uses: 1 } } },
  { id: 'sleepless.enterDream', pathway: 'sleepless', seq: 5, name: '入梦', contexts: ['daily', 'command'],
    label: (location) => `睡着，然后在梦里去${location}（入梦者）`, command: (location) => `今日`,
    preview: '占整晚 · 把该地点记进「去过的地方」（限本城相邻）',
    effect: { kind: 'move', payload: { mode: 'dream', grants: 'visited' } } },
  { id: 'sailor.tailwind', pathway: 'sailor', seq: 5, name: '顺风', contexts: ['command', 'daily'],
    label: (location) => `献上一件东西，换一路顺风（风暴引者）`, command: (location) => `今日`,
    preview: '消耗一件可交易物 · 下一次移动的行动点减半',
    effect: { kind: 'produce', payload: { grant: 'travelApDiscount', value: 0.5, uses: 1 } } },
  { id: 'perfect.retrofit', pathway: 'perfect', seq: 5, name: '改装', contexts: ['command', 'daily'],
    label: (location) => `把手上这件东西改成别的用途（造物者）`, command: (location) => `背包`,
    preview: '消耗一件物品 · 产出它的改制品',
    effect: { kind: 'produce', payload: { variant: true } } },
  { id: 'reader.consult', pathway: 'reader', seq: 5, name: '查阅', contexts: ['command', 'pvp'],
    label: (location) => `从记下的东西里查一个见过的事物（秘典学者）`, command: (location) => `状态`,
    preview: '不消耗行动点 · 从已记录条目里检索',
    effect: { kind: 'query', payload: { field: 'record', target: 'opponentCreatureId' } } },
  { id: 'mother.ripen', pathway: 'mother', seq: 5, name: '催熟', contexts: ['explore', 'command'],
    label: (location) => `让还没到的时候提前到（丰收者）`, command: (location) => `探索 ${location}`,
    preview: '本地点这一次产出翻倍',
    effect: { kind: 'produce', payload: { field: 'lootMultiplier', value: 2, uses: 1 } } },
  {
    id: 'warrior.skirmish',
    pathway: 'warrior',
    seq: 9,
    name: '闯',
    contexts: ['explore'],
    label: (location) => `直接闯进去碰碰运气（战士专属）`,
    command: (location) => `事件 ${location}`,
    preview: '先撞一张事件卡',
    effect: { kind: 'none' },
  },
  {
    id: 'sleepless.readNight',
    pathway: 'sleepless',
    seq: 9,
    name: '看天',
    contexts: ['explore'],
    label: (location) => `先看清今晚的天再进去（不眠者专属）`,
    command: (location) => `世界 ${location}`,
    preview: '不消耗行动点 · 看该地点天气与预告',
    effect: { kind: 'none' },
  },
  {
    id: 'sailor.readWind',
    pathway: 'sailor',
    seq: 9,
    name: '看风',
    contexts: ['explore'],
    label: (location) => `先看看风从哪边来（水手专属）`,
    command: (location) => `世界 ${location}`,
    preview: '不消耗行动点 · 看该地点的天气与预告',
    effect: { kind: 'none' },
  },
  {
    id: 'perfect.tally',
    pathway: 'perfect',
    seq: 9,
    name: '清点',
    contexts: ['explore'],
    label: (location) => `清点一遍随身的东西（完美者专属）`,
    command: (location) => `背包`,
    preview: '不消耗行动点 · 看背包',
    effect: { kind: 'none' },
  },
  {
    id: 'reader.recall',
    pathway: 'reader',
    seq: 9,
    name: '梳理',
    contexts: ['explore'],
    label: (location) => `把已知的东西理一遍（阅读者专属）`,
    command: (location) => `状态`,
    preview: '不消耗行动点 · 看自己现在的状态',
    effect: { kind: 'none' },
  },
  {
    id: 'mother.readDay',
    pathway: 'mother',
    seq: 9,
    name: '看日子',
    contexts: ['explore'],
    label: (location) => `看看今天该做什么（母亲专属）`,
    command: (location) => `今日`,
    preview: '不消耗行动点 · 看今天的安排',
    effect: { kind: 'none' },
  },
  /* ---- M2.39 批次 B：序列 4、3（7 途径）----
   *
   * ⚠️ `contexts` 的选取是**轮换**不是叠加：`pathwayActionFor` 在多条可用时取 `seq` 最小的那条
   *    （见本文件末尾的规则 3）⇒ 新行动会盖住同一 context 里的旧行动。所以每上一级都要
   *    **接过一个旧 context、让出一个**：
   *      序列 6 化身     daily, explore
   *      序列 5 秘偶代行 explore, command   ← 盖住化身的 explore 位
   *      序列 4 改命     daily, explore     ← 秘偶代行退回 command 仍可用
   *      序列 3 织命     daily, command     ← explore 位让给改命，三级各占一角，没有一条被埋掉
   */
  { id: 'seer.rewrite', pathway: 'seer', seq: 4, name: '改命', contexts: ['daily', 'explore'],
    label: (location) => `先看一眼${location}会出什么事，再决定走哪条（改命者）`, command: (location) => `世界 ${location}`,
    preview: '不消耗行动点 · 本地点这一次的探索危险 ×0.8',
    effect: { kind: 'buff', payload: { field: 'exploreDangerMultiplier', multiplier: 0.8, uses: 1 } } },
  { id: 'seer.weave', pathway: 'seer', seq: 3, name: '织命', contexts: ['daily', 'command'],
    label: (location) => `把相邻那几条线也看一眼（织命者）`, command: (location) => `世界 ${location}`,
    preview: '不消耗行动点 · 读到相邻地点有没有东西在等你',
    effect: { kind: 'query', payload: { field: 'hostilitySense', scope: 'adjacent', depth: 1 } } },
  { id: 'warrior.brace', pathway: 'warrior', seq: 4, name: '立阵', contexts: ['battle'],
    label: (location) => `站定，把它下一轮的力道卸掉一半（战阵师）`, command: (location) => `状态`,
    preview: '下一次受到的伤害 ×0.5',
    effect: { kind: 'buff', payload: { field: 'guardDamageMultiplier', multiplier: 0.5, turns: 1, uses: 1 } } },
  { id: 'warrior.commandField', pathway: 'warrior', seq: 3, name: '压阵', contexts: ['battle', 'pvp'],
    label: (location) => `把整片场子压住，让它使不上力（常胜者）`, command: (location) => `状态`,
    preview: '下一次交手对方伤害 ×0.5',
    effect: { kind: 'buff', payload: { field: 'enemyDamagePenalty', penalty: 0.5, turns: 1, uses: 1 } } },
  { id: 'sleepless.weaveDream', pathway: 'sleepless', seq: 4, name: '织梦', contexts: ['daily', 'command'],
    label: (location) => `睡着，把今天走过的地方再走一遍（织梦者）`, command: (location) => `今日`,
    preview: '占整晚 · 从今天去过的一处地点带回一件东西',
    effect: { kind: 'produce', payload: { field: 'lootGrant', source: 'visitedToday', uses: 1 } } },
  { id: 'sleepless.lightLamp', pathway: 'sleepless', seq: 3, name: '点灯', contexts: ['explore', 'daily'],
    label: (location) => `先点一盏灯，再进${location}（执灯人）`, command: (location) => `世界 ${location}`,
    preview: '不消耗行动点 · 本地点今日剩下的探索危险 ×0.7',
    effect: { kind: 'buff', payload: { field: 'exploreDangerMultiplier', multiplier: 0.7, uses: 3 } } },
  { id: 'sailor.ballast', pathway: 'sailor', seq: 4, name: '压舱', contexts: ['explore', 'daily'],
    label: (location) => `把重东西挪到舱底再看${location}（压舱者）`, command: (location) => `休息`,
    preview: '不消耗行动点 · 本日恢复一部分生命',
    effect: { kind: 'buff', payload: { field: 'maxHpBonus', value: 15, scope: 'restore', uses: 1 } } },
  { id: 'sailor.askSea', pathway: 'sailor', seq: 3, name: '问海', contexts: ['explore', 'command'],
    label: (location) => `对着水面问一句${location}的事（怒潮者）`, command: (location) => `世界 ${location}`,
    preview: '不消耗行动点 · 读到本城与相邻一格的敌意线索',
    effect: { kind: 'query', payload: { field: 'hostilitySense', scope: 'sea', radius: 1 } } },
  { id: 'perfect.assemble', pathway: 'perfect', seq: 4, name: '总装', contexts: ['command', 'daily'],
    label: (location) => `把两件东西装成一件（总装者）`, command: (location) => `背包`,
    preview: '消耗两件物品 · 产出一件合装件',
    effect: { kind: 'produce', payload: { consume: 2, grant: 'assembled', qty: 1 } } },
  /*
   * M2.85：perfect.schedule（排程，「消耗一件物品换回本日 1 点行动点」）
   * 随行动值玩法一并下线 —— 它的产出就是行动点，行动点没了这条行动就是空的。
   */
  { id: 'reader.summarize', pathway: 'reader', seq: 4, name: '归纳', contexts: ['command', 'pvp', 'battle'],
    label: (location) => `把见过的同类归成一条（编纂者）`, command: (location) => `状态`,
    preview: '不消耗行动点 · 从已记录条目里按同类外推',
    effect: { kind: 'query', payload: { field: 'record', scope: 'species' } } },
  { id: 'reader.rebut', pathway: 'reader', seq: 3, name: '驳论', contexts: ['pvp', 'battle'],
    label: (location) => `用他知道的东西压住他（通晓者）`, command: (location) => `事件 ${location}`,
    preview: '不消耗行动点 · 下一次交手对方伤害 ×0.7',
    effect: { kind: 'buff', payload: { field: 'enemyDamagePenalty', value: 0.3, uses: 1 } } },
  { id: 'mother.seedKeep', pathway: 'mother', seq: 4, name: '留种', contexts: ['daily', 'command'],
    label: (location) => `把这一季剩下的留成下一季的（孕育者）`, command: (location) => `探索 ${location}`,
    preview: '下次来这里，产出 ×3',
    effect: { kind: 'produce', payload: { field: 'lootMultiplier', value: 3, scope: 'deferred', uses: 1 } } },
  { id: 'mother.shelter', pathway: 'mother', seq: 3, name: '庇护', contexts: ['battle', 'pvp'],
    label: (location) => `让他站着的时候，大地替他挨（生养者）`, command: (location) => `状态`,
    preview: '消耗灵性 · 本战多出一段可用的血',
    needs: 'mp',
    effect: { kind: 'buff', payload: { field: 'maxHpBonus', value: 50, scope: 'battle', uses: 1 } } },
  /* ---- M2.43 批次 C：序列 2 的七条行动 ----
   *
   * ⚠️ contexts 仍然是**轮换**（`pathwayActionFor` 在同场景下取 seq 最小的那条），所以这七条
   *    全部**避开了本途径 seq 3 的 context** —— 上一条行动不会被埋掉，逐条对照：
   *      seer 3=daily,command → 定局取 battle ｜ warrior 3=battle,pvp → 破阵取 command
   *      sleepless 3=explore,daily → 守夜取 command ｜ sailor 3=explore,command → 覆舟取 battle,pvp
   *      perfect 3=daily → 定序取 explore ｜ reader 3=pvp,battle → 预演取 daily
   *      mother 3=battle,pvp → 轮回取 command
   *
   * 字段全部取 `ACTION_FIELD_EFFECTS` 里**已有落点**的那几个（`nextAttackMultiplier` /
   * `exploreDangerMultiplier` / `lootMultiplier` / `maxHpBonus`）或已登记的 `enemyDamagePenalty` ——
   * payload.field 不在那张表里就是一条 error（link-check 的 orphan 判据）。 */
  { id: 'seer.verdict', pathway: 'seer', seq: 2, name: '定局', contexts: ['battle'],
    label: (location) => `先看一眼它这一下要往哪落（定局者）`, command: (location) => `状态`,
    preview: '不消耗行动点 · 本战下一次出手伤害 ×1.5',
    effect: { kind: 'buff', payload: { field: 'nextAttackMultiplier', value: 1.5, uses: 1 } } },
  { id: 'warrior.breakRank', pathway: 'warrior', seq: 2, name: '破阵', contexts: ['command'],
    label: (location) => `把阵线往前推一格（陷阵者）`, command: (location) => `状态`,
    preview: '不消耗行动点 · 下一次出手伤害 ×1.6',
    effect: { kind: 'buff', payload: { field: 'nextAttackMultiplier', value: 1.6, uses: 1 } } },
  { id: 'sleepless.keepVigil', pathway: 'sleepless', seq: 2, name: '守夜', contexts: ['command'],
    label: (location) => `替这一夜守着（守夜人）`, command: (location) => `状态`,
    preview: '不消耗行动点 · 接下来 2 次探索的危险 ×0.7',
    effect: { kind: 'buff', payload: { field: 'exploreDangerMultiplier', value: 0.7, uses: 2 } } },
  { id: 'sailor.capsizeAction', pathway: 'sailor', seq: 2, name: '覆舟', contexts: ['battle', 'pvp'],
    label: (location) => `把脚下这块地掀了（操舵者）`, command: (location) => `状态`,
    preview: '不消耗行动点 · 下一次交手对方伤害 ×0.6',
    effect: { kind: 'buff', payload: { field: 'enemyDamagePenalty', value: 0.4, uses: 1 } } },
  { id: 'perfect.sequencingOrder', pathway: 'perfect', seq: 2, name: '定序', contexts: ['explore'],
    label: (location) => `把今天的顺序重排一遍（永动者）`, command: (location) => `探索 ${location}`,
    preview: '不消耗行动点 · 本地点这一次的产出 ×2',
    effect: { kind: 'produce', payload: { field: 'lootMultiplier', value: 2, uses: 1 } } },
  { id: 'reader.rehearse', pathway: 'reader', seq: 2, name: '预演', contexts: ['daily'],
    label: (location) => `把接下来那一场在脑子里过一遍（著录者）`, command: (location) => `状态`,
    preview: '不消耗行动点 · 本战下一次出手伤害 ×1.6',
    effect: { kind: 'buff', payload: { field: 'nextAttackMultiplier', value: 1.6, uses: 1 } } },
  { id: 'mother.rebirthCycle', pathway: 'mother', seq: 2, name: '轮回', contexts: ['command'],
    label: (location) => `把这一季重新种回去（轮回者）`, command: (location) => `状态`,
    preview: '消耗灵性 · 本战多出一段可用的血（+60）',
    needs: 'mp',
    effect: { kind: 'buff', payload: { field: 'maxHpBonus', value: 60, scope: 'battle', uses: 1 } } },

  /* ---- M2.76：15 条新途径的专属行动（各 1 条，序列 9，explore 场景）----
   *
   * G10 的口径是「每条途径在 explore 恰好一条」+「contexts 必须非空」，
   * 所以新途径各补一条即可，不需要为它们发明新的 effect kind ——
   * `kind` 的取值域是**封闭**的（none/query/buff/produce/move），
   * 开放它等于让每个行动自己发明动词，resolver 永远追不上内容表（K10）。
   */
  {
    id: 'door.survey',
    pathway: 'door',
    seq: 9,
    name: '穿门',
    contexts: ['explore'],
    label: (location) => `抄近路穿过这条街（door专属）`,
    command: (location) => `穿门 我要从这儿过去`,
    preview: '看看这里还有什么',
    effect: { kind: 'none' },
  },
  {
    id: 'sun.survey',
    pathway: 'sun',
    seq: 9,
    name: '净光',
    contexts: ['explore'],
    label: (location) => `照亮这里的阴影（sun专属）`,
    command: (location) => `净光 让我看清这个地方`,
    preview: '看看这里还有什么',
    effect: { kind: 'query' },
  },
  {
    id: 'corpse_collector.survey',
    pathway: 'corpse_collector',
    seq: 9,
    name: '验尸',
    contexts: ['explore'],
    label: (location) => `看一眼这里死过什么人（corpse_collector专属）`,
    command: (location) => `验尸 这里最近出过什么事`,
    preview: '看看这里还有什么',
    effect: { kind: 'query' },
  },
  {
    id: 'error.survey',
    pathway: 'error',
    seq: 9,
    name: '顺手',
    contexts: ['explore'],
    label: (location) => `顺手拿走这里的一件小东西（error专属）`,
    command: (location) => `顺手 我看看这儿有什么能拿的`,
    preview: '看看这里还有什么',
    // ⚠️ 只有带 payload 的 buff/produce 才有落点；新途径这一批统一用 none
    //    （= 显式声明「这个行动不产生数值效果」，M2.38 的检查器认它）。
    effect: { kind: 'none' },
  },
  {
    id: 'mystery_pryer.survey',
    pathway: 'mystery_pryer',
    seq: 9,
    name: '观星',
    contexts: ['explore'],
    label: (location) => `借星象看这里的底细（mystery_pryer专属）`,
    command: (location) => `观星 这个地方对应哪颗星`,
    preview: '看看这里还有什么',
    effect: { kind: 'query' },
  },
  {
    id: 'spectator.survey',
    pathway: 'spectator',
    seq: 9,
    name: '读心',
    contexts: ['explore'],
    label: (location) => `听一听这里的人在想什么（spectator专属）`,
    command: (location) => `读心 这里的人在想什么`,
    preview: '看看这里还有什么',
    effect: { kind: 'query' },
  },
  {
    id: 'apothecary.survey',
    pathway: 'apothecary',
    seq: 9,
    name: '辨药',
    contexts: ['explore'],
    label: (location) => `分辨这里的草木与药剂（apothecary专属）`,
    command: (location) => `辨药 这地方的草药能不能用`,
    preview: '看看这里还有什么',
    effect: { kind: 'query' },
  },
  {
    id: 'arbiter.survey',
    pathway: 'arbiter',
    seq: 9,
    name: '立规',
    contexts: ['explore'],
    label: (location) => `在这里立一条临时的规矩（arbiter专属）`,
    command: (location) => `立规 谁都不许动这里的东西`,
    preview: '看看这里还有什么',
    effect: { kind: 'none' },
  },
  {
    id: 'assassin.survey',
    pathway: 'assassin',
    seq: 9,
    name: '潜踪',
    contexts: ['explore'],
    label: (location) => `贴着阴影走过去（assassin专属）`,
    command: (location) => `潜踪 我不想被任何人看见`,
    preview: '看看这里还有什么',
    effect: { kind: 'none' },
  },
  {
    id: 'criminal.survey',
    pathway: 'criminal',
    seq: 9,
    name: '引诱',
    contexts: ['explore'],
    label: (location) => `把这里的东西引出来（criminal专属）`,
    command: (location) => `引诱 把藏着的东西引出来`,
    preview: '看看这里还有什么',
    effect: { kind: 'none' },
  },
  {
    id: 'hunter.survey',
    pathway: 'hunter',
    seq: 9,
    name: '追踪',
    contexts: ['explore'],
    label: (location) => `顺着痕迹找过去（hunter专属）`,
    command: (location) => `追踪 顺着这些痕迹走`,
    preview: '看看这里还有什么',
    effect: { kind: 'query' },
  },
  {
    id: 'lawyer.survey',
    pathway: 'lawyer',
    seq: 9,
    name: '钻条文',
    contexts: ['explore'],
    label: (location) => `在规矩里找一个口子（lawyer专属）`,
    command: (location) => `钻条文 这里的规矩有没有空子`,
    preview: '看看这里还有什么',
    effect: { kind: 'query' },
  },
  {
    id: 'monster.survey',
    pathway: 'monster',
    seq: 9,
    name: '押一把',
    contexts: ['explore'],
    label: (location) => `把这件事交给运气（monster专属）`,
    command: (location) => `押一把 我赌这一次能成`,
    preview: '看看这里还有什么',
    effect: { kind: 'none' },
  },
  {
    id: 'prisoner.survey',
    pathway: 'prisoner',
    seq: 9,
    name: '挣链',
    contexts: ['explore'],
    label: (location) => `硬挣开挡路的东西（prisoner专属）`,
    command: (location) => `挣链 我要硬闯过去`,
    preview: '看看这里还有什么',
    effect: { kind: 'none' },
  },
  {
    id: 'secrets_supplicant.survey',
    pathway: 'secrets_supplicant',
    seq: 9,
    name: '倾听',
    contexts: ['explore'],
    label: (location) => `安静地听一会儿（secrets_supplicant专属）`,
    command: (location) => `倾听 这里有没有人在说话`,
    preview: '看看这里还有什么',
    effect: { kind: 'query' },
  },
];

/**
 * **统一触发接口**（P11 的核心）：给定途径 / 当前序列 / 场景，返回该用哪一条行动。
 *
 * 纯函数（铁律 1）：不读库、不掷骰、不看时钟。`actions` 可注入是为了让测试能构造
 * 多场景与多序列的**夹具** —— 现有 7 条都只有 `explore`，光靠它们测不出分发逻辑。
 *
 * 规则：
 *   1. 途径、场景都要匹配；
 *   2. `action.seq >= seq`（已解锁）；
 *   3. 多条可用时**取 `seq` 最小的那条**（最强的那条）。
 */
export function pathwayActionFor(
  pathway: PathwayId,
  seq: number,
  context: ActionContext,
  actions: readonly PathwayAction[] = PATHWAY_ACTIONS,
): PathwayAction | null {
  let best: PathwayAction | null = null;
  for (const action of actions) {
    if (action.pathway !== pathway) continue;
    if (!action.contexts.includes(context)) continue;
    if (action.seq < seq) continue;
    if (best === null || action.seq < best.seq) best = action;
  }
  return best;
}

/** 一条途径在某序列下**已解锁**的全部行动（按 seq 升序 = 从强到弱） */
export function unlockedActionsFor(
  pathway: PathwayId,
  seq: number,
  actions: readonly PathwayAction[] = PATHWAY_ACTIONS,
): PathwayAction[] {
  return actions
    .filter((action) => action.pathway === pathway && action.seq >= seq)
    .sort((a, b) => a.seq - b.seq);
}

/** 按 id 取（事件回放与报告用） */
export function actionById(
  id: string,
  actions: readonly PathwayAction[] = PATHWAY_ACTIONS,
): PathwayAction | null {
  return actions.find((action) => action.id === id) ?? null;
}
