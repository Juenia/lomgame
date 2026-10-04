/**
 * M2.38 任务 1（**P0**）：**途径行动的 `effect` 读取点**。
 *
 * ## 为什么是 P0
 *
 * M2.29 交付的每个节点是**四件套**：能力 + 战斗技能 + 途径行动 + 配方。
 * 前三件都有读取点，**只有行动没有** ——
 * `pathwayActionFor` 全仓只有一个调用点（`explore-menu.ts:74`），而它只取
 * `label` / `command` / `preview`（**给玩家看的文案**），`effect` **一个字节都没读过**。
 *
 * ## 本模块做什么
 *
 * 把 `effect` 解释成**可执行的结果**（`ActionOutcome`），四类落点：
 *
 * | 落点 | 谁执行 | 例子 |
 * | --- | --- | --- |
 * | `delta` | 走唯一数值入口 `apply()` | `maxHpBonus: 10` ⇒ `{ type: 'hp', value: 10 }` |
 * | `mark` | 写 `flags`，由**判定层**在作用域内消费 | `exploreDangerMultiplier: 0.9` ⇒ 本次探索危险 ×0.9 |
 * | `item` | 命令层按 `planActionItems` 的清单搬物品 | `variant` ⇒ 淬火匕首 ⇒ 淬火匕首#retrofit |
 * | `text` | 回执（query 类真的读字段） | `hostilitySense` ⇒ 有没有敌意 |
 *
 * ## ★ M2.65：**「有落点」不再等于「有一个 to」**
 *
 * M2.38 的判据只问「这个 field 在不在表里」，于是 `nextAttack` 这类
 * **写了标记却没有任何人读**的字段，在审计里和「已经生效」长得一模一样
 *（K19 的老形状：判据只认一件事，另一件事就被当成不存在）。
 * 实测：M2.38～M2.64 期间 `loot` / `nextAttack` / `eventDelay` / `divinationDaily`
 * **四个标记一个消费者都没有**。
 *
 * ⇒ 现在 `mark` 落点**必须**在 `ACTION_MARK_READERS` 里有一条读它的函数
 *（表就是消费者名册），`item` 落点**必须**在 `ACTION_ITEM_PLANNERS` 里有一条分支。
 * 没有 ⇒ `link-check` 报 error，不再是「诚实记账」那一档。
 *
 * ## 纯函数（铁律 1）
 *
 * 本模块不读库、不看时钟、不掷骰：`abilityEffects` 与 `now` 都由调用方注入。
 */
import type { AbilityEffect } from '../ability/ability.ts';
import type { CharacterState } from '../character/types.ts';
import type { EffectDelta, NumericField } from '../effect/apply.ts';
import type { PathwayAction } from './pathway-actions.ts';
import { ACTION_ITEM_PLANNERS, type ActionItemEffect } from './pathway-action-items.ts';

/**
 * 标记的三种量纲。**它是标记自己带的属性**，不是每条 payload 各写一遍 ——
 * 于是「`eventDelay` 读的是 turns」这件事在全仓只有一处说法。
 */
export type MarkUnit = 'multiplier' | 'turns' | 'value';

/**
 * 标记的**作用域**。
 *
 *   location —— `action:<标记>:<地点>:<日期>`（「本地点这一次」）
 *   day      —— `action:<标记>::<日期>`（「本日」；与脚下站在哪无关）
 *
 * ⚠️ 两者都**自带过期**：日期换了一天，键本身就对不上了。
 * 这是刻意的第二道保险 —— 一个没人清理的标记，读起来和「一直生效」一模一样（K19）。
 */
export type MarkScope = 'location' | 'day';

export type ActionMarkId =
  | 'exploreDanger' | 'loot' | 'nextAttack' | 'eventDelay'
  | 'divinationDaily' | 'freeExplore' | 'travelDiscount' | 'lootGrant'
  | 'guardDamage' | 'enemyDamage';

export interface ActionMarkSpec {
  scope: MarkScope;
  unit: MarkUnit;
  /** 读不到时的中性值（1 = 不改变任何东西；0 = 没有这件事） */
  neutral: number;
  /** 人读的名字（回执与报告都用它） */
  label: string;
}

/**
 * 标记名册：**标记的全部属性**（作用域 / 量纲 / 中性值 / 中文名）。
 *
 * ⚠️ 加一个标记 = 在这里加一行 + 在 `ACTION_MARK_READERS` 里加一条读取函数。
 * 少了后者，`link-check` 的行动表检查会报 error —— 见文件头 M2.65 那一段。
 */
export const ACTION_MARKS: Readonly<Record<ActionMarkId, ActionMarkSpec>> = {
  exploreDanger: { scope: 'location', unit: 'multiplier', neutral: 1, label: '探索危险' },
  loot: { scope: 'location', unit: 'multiplier', neutral: 1, label: '产出' },
  nextAttack: { scope: 'location', unit: 'multiplier', neutral: 1, label: '下一次出手' },
  eventDelay: { scope: 'location', unit: 'turns', neutral: 0, label: '事件延后' },
  divinationDaily: { scope: 'day', unit: 'value', neutral: 0, label: '今日占卜次数' },
  freeExplore: { scope: 'location', unit: 'value', neutral: 0, label: '免行动点探索' },
  travelDiscount: { scope: 'day', unit: 'multiplier', neutral: 1, label: '移动行动点折扣' },
  lootGrant: { scope: 'day', unit: 'value', neutral: 0, label: '补一件收获' },
  guardDamage: { scope: 'location', unit: 'multiplier', neutral: 1, label: '受到的伤害' },
  enemyDamage: { scope: 'location', unit: 'value', neutral: 0, label: '对方伤害削减' },
};

/**
 * `payload.field` → 它**实际做什么**（唯一出处，K22）。
 *
 * 字段名与 `AbilityEffect`（`domain/ability/ability.ts`）**对齐** —— 那边是**被动**能力
 * （晋升就给、一直在），这边是**主动**用一次；名字相同、时机不同。
 *
 * `to` 的四种取值对应四类落点（见文件头）。**`pending` 是诚实的记账**：
 * 它表示「这个 field 我们认，但还没有机制」—— 用的时候回执会说出来。
 * M2.65 起**现有 42 条行动一条 pending 都没有了**，但这一档保留：
 * 它是新内容落地时的合法中间态，而且必须看得见。
 */
export type FieldEffect =
  | { to: 'delta'; delta: NumericField }
  | { to: 'mark'; mark: ActionMarkId }
  | { to: 'item'; effect: ActionItemEffect }
  | { to: 'pending'; note: string };

export const ACTION_FIELD_EFFECTS: Readonly<Record<string, FieldEffect>> = {
  /* ---- 走数值入口（真的改 state） ---- */
  maxHpBonus: { to: 'delta', delta: 'hp' },
  maxMpBonus: { to: 'delta', delta: 'mp' },
  /*
   * M2.65 的 extraAp（perfect.schedule 排程：「消耗一件物品换回本日 1 点行动点」）
   * 随 M2.85 的行动值移除一并下线 —— 该行动当前没有数值效果（登记在交付说明）。
   */

  /* ---- 走标记（由判定层在作用域内消费，读完即删） ---- */
  exploreDangerMultiplier: { to: 'mark', mark: 'exploreDanger' },
  lootMultiplier: { to: 'mark', mark: 'loot' },
  nextAttackMultiplier: { to: 'mark', mark: 'nextAttack' },
  eventDelay: { to: 'mark', mark: 'eventDelay' },
  divinationDailyBonus: { to: 'mark', mark: 'divinationDaily' },
  /* M2.65：这一批原先全是 pending，现在各有各的下家 */
  freeExplore: { to: 'mark', mark: 'freeExplore' },
  travelApDiscount: { to: 'mark', mark: 'travelDiscount' },
  lootGrant: { to: 'mark', mark: 'lootGrant' },
  guardDamageMultiplier: { to: 'mark', mark: 'guardDamage' },
  enemyDamagePenalty: { to: 'mark', mark: 'enemyDamage' },

  /* ---- 走物品（命令层按 planActionItems 的清单搬东西） ---- */
  variant: { to: 'item', effect: 'variant' },
  assembled: { to: 'item', effect: 'assemble' },
};

/** `kind: 'query'` 的字段 → 人读的名字（也是**唯一出处**） */
export const ACTION_QUERY_FIELDS: Readonly<Record<string, string>> = {
  hostilitySense: '敌意感知',
  dreamGap: '梦境间隙',
  record: '记下的条目',
};

export type ActionOutcome =
  | { kind: 'none'; text: string; deltas: EffectDelta[]; marks: ActionMark[] }
  | { kind: 'query'; text: string; deltas: EffectDelta[]; marks: ActionMark[] }
  | { kind: 'buff'; text: string; deltas: EffectDelta[]; marks: ActionMark[] }
  | { kind: 'produce'; text: string; deltas: EffectDelta[]; marks: ActionMark[] }
  | { kind: 'move'; text: string; deltas: EffectDelta[]; marks: ActionMark[] };

/** 一条要写的标记：**按行动 + 地点**限定作用域，并带上过期日 */
export interface ActionMark {
  flag: string;
  value: string;
  /** 标记名（回执 / 报告 / 清理都用它，调用方不必去解析键） */
  mark: ActionMarkId;
}

/**
 * 标记键：`action:<标记>:<地点>:<日期>`（地点作用域）
 * 或       `action:<标记>::<日期>`（当日作用域）。
 *
 * ⚠️ **带 `locationId` 与 `day` 是有意的**：
 *   · 地点 —— 「本地点这一次」是 payload 的原文口径（`exploreDangerMultiplier` 的 `uses: 1`）；
 *   · 日期 —— 标记必须**自己过期**，否则它会变成一个永久的隐藏加成（K19 的形状：
 *     一个没人清理的标记，读起来和「一直生效」一模一样）。
 *
 * 消费方用完即删；跨天之后键本身就对不上了，是第二道保险。
 */
export function actionMarkFlag(
  mark: ActionMarkId,
  locationId: string,
  day: string,
  scope: MarkScope = ACTION_MARKS[mark].scope,
): string {
  return scope === 'day'
    ? 'action:' + mark + '::' + day
    : 'action:' + mark + ':' + locationId + ':' + day;
}

export interface ActionResolveInput {
  action: PathwayAction;
  character: CharacterState;
  locationId: string;
  /** 当天的日界串（`today()` 的口径），用来拼标记键 */
  day: string;
  /** 能力效果（query 类要读它）；由调用方算好注入，保持本函数纯 */
  abilityEffects?: AbilityEffect;
}

function numberOf(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * **payload 里那个数**：`value` → `multiplier` → `penalty` → `turns`，取第一个能读成数的。
 *
 * ⚠️ 为什么要认四种键名：M2.29～M2.43 的内容表把同一个意思写成了四种样子
 *（`lootMultiplier` 用 `value`、`guardDamageMultiplier` 用 `multiplier`、
 * `enemyDamagePenalty` 用 `penalty` 或 `value`、`eventDelay` 用 `turns`）。
 * 只认一种的话，另一种**静默退回默认值 1** —— 「配置里写了 0.4、跑起来是 0.5」正是 K10。
 * 读不到任何一个是**内容事故**，但本函数只能给中性值；把它抓出来的是
 * `test/m2-65-action-consumers.test.ts` 的「每条 buff/produce 行动的 payload 都读得到一个数」。
 */
/**
 * **payload → 它在 ACTION_FIELD_EFFECTS 里的键**（唯一出处，K22）。
 *
 * `produce` 类有三种写法（M2.29～M2.43 陆续加的，全部要认）：
 *   `field: 'lootMultiplier'` / `grant: 'freeExplore'` / `variant: true`。
 *
 * ⚠️ 这个函数是 M2.65 补上的 —— 在此之前**解析器只看 field、审计却认三种**，
 * 于是 `seer.puppet` / `sailor.tailwind` / `perfect.retrofit` /
 * `perfect.assemble` 这四条在审计里是「有落点」，
 * 跑起来却是「⚠️ 这条行动的效果不在表里」（K4 的老形状：判据与执行各认一种写法）。
 * 端到端用例当场抓到了它 —— 见 `test/m2-65-action-consumers.test.ts`。
 */
export function actionEffectKeyOf(payload: Readonly<Record<string, unknown>>): string {
  const field = typeof payload.field === 'string' ? payload.field : '';
  if (field !== '') return field;
  const grant = typeof payload.grant === 'string' ? payload.grant : '';
  if (grant !== '') return grant;
  return payload.variant === true ? 'variant' : '';
}

export function markValueOf(payload: Readonly<Record<string, unknown>>, fallback = 1): number {
  for (const key of ['value', 'multiplier', 'penalty', 'turns']) {
    const n = Number(payload[key]);
    if (payload[key] !== undefined && Number.isFinite(n)) return n;
  }
  return fallback;
}

/**
 * 把一条行动的 `effect` 解释成**可执行的结果**。
 *
 * 它是 `payload` 的**唯一读取点** —— 改 `payload`，这里返回的东西就变，
 * 调用方（`.行动` 指令）的行为随之改变。
 */
export function resolvePathwayAction(input: ActionResolveInput): ActionOutcome {
  const { action, locationId, day } = input;
  const payload = (action.effect.payload ?? {}) as Readonly<Record<string, unknown>>;
  // field / grant / variant 三种写法都认 —— 与审计走同一个函数（K22）
  const field = actionEffectKeyOf(payload);

  if (action.effect.kind === 'none') {
    return { kind: 'none', text: action.preview, deltas: [], marks: [] };
  }

  if (action.effect.kind === 'query') {
    const label = ACTION_QUERY_FIELDS[field] ?? field;
    const effects = input.abilityEffects ?? {};
    const flag = effects[field as keyof AbilityEffect];
    const text = flag === true
      ? '你' + label + '到了：' + action.preview
      : '你试着' + label + '，但这一层还没长在你身上（需要对应的能力）。';
    return { kind: 'query', text, deltas: [], marks: [] };
  }

  if (action.effect.kind === 'buff' || action.effect.kind === 'produce') {
    const spec = ACTION_FIELD_EFFECTS[field];
    if (!spec) {
      return {
        kind: action.effect.kind,
        text: '⚠️ 这条行动的效果（' + (field || '(没有 field)') + '）**不在 ACTION_FIELD_EFFECTS 里** —— 没有任何读取点。',
        deltas: [],
        marks: [],
      };
    }
    if (spec.to === 'pending') {
      return { kind: action.effect.kind, text: '⚠️ 这条行动的效果**已登记但尚未实现**：' + spec.note, deltas: [], marks: [] };
    }
    if (spec.to === 'delta') {
      const value = numberOf(payload.value ?? payload.multiplier, 0);
      return {
        kind: action.effect.kind,
        text: action.preview,
        deltas: value === 0 ? [] : [{ type: spec.delta, value }],
        marks: [],
      };
    }
    /*
     * `to: 'item'`：物品怎么搬**由 planActionItems 说了算**（那里读 consume / variant / from），
     * 这里只负责「这次行动确实落在物品上」这件事。文本由命令层补 ——
     * 解析器不知道背包里有什么，硬编一句「你把它改装了」会在没有物品时也说出口。
     */
    if (spec.to === 'item') {
      return { kind: action.effect.kind, text: action.preview, deltas: [], marks: [] };
    }
    const meta = ACTION_MARKS[spec.mark];
    const value = markValueOf(payload, meta.neutral);
    return {
      kind: action.effect.kind,
      text: action.preview,
      deltas: [],
      marks: [{ flag: actionMarkFlag(spec.mark, locationId, day), value: String(value), mark: spec.mark }],
    };
  }

  // kind: 'move'
  const mode = typeof payload.mode === 'string' ? payload.mode : 'unknown';
  return {
    kind: 'move',
    text: '⚠️ 「' + mode + '」移动**已登记但尚未实现**（需要移动结算读它，批次 B）。',
    deltas: [],
    marks: [],
  };
}

/** 从标记值里读一个倍率（读不到就返回 1）—— 消费方用它，别自己解析字符串 */
export function multiplierOfMark(value: string | null): number {
  if (value === null) return 1;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/** 从标记值里读一个正整数（读不到就返回 0）：`turns` / `value` 类的量纲用它 */
export function countOfMark(value: string | null): number {
  if (value === null) return 0;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/* ------------------------------------------------------------------ *
 * 标记的**读取点名册**（M2.65）：每一个标记都必须有一条真读它的函数
 * ------------------------------------------------------------------ */

/** 读一个 flag 的值（由调用方注入 `deps.flags.value` 的绑定），返回中性量纲的数 */
export type MarkReader = (
  readFlag: (flag: string) => string | null,
  locationId: string,
  day: string,
) => number;

function rawMark(
  readFlag: (flag: string) => string | null,
  mark: ActionMarkId,
  locationId: string,
  day: string,
): string | null {
  return readFlag(actionMarkFlag(mark, locationId, day));
}

/**
 * 标记 → 读取函数（**唯一出处**，K22）。
 *
 * ⚠️ 它同时是 `link-check` 的判据：`ACTION_FIELD_EFFECTS` 里 `to: 'mark'` 的
 * `mark` 不在这张表里 ⇒ 报 error。「写了标记没人读」从此不是一种状态。
 */
export const ACTION_MARK_READERS: Readonly<Record<ActionMarkId, MarkReader>> = {
  exploreDanger: (r, l, d) => multiplierOfMark(rawMark(r, 'exploreDanger', l, d)),
  loot: (r, l, d) => multiplierOfMark(rawMark(r, 'loot', l, d)),
  nextAttack: (r, l, d) => multiplierOfMark(rawMark(r, 'nextAttack', l, d)),
  eventDelay: (r, l, d) => countOfMark(rawMark(r, 'eventDelay', l, d)),
  divinationDaily: (r, l, d) => countOfMark(rawMark(r, 'divinationDaily', l, d)),
  freeExplore: (r, l, d) => (rawMark(r, 'freeExplore', l, d) === null ? 0 : 1),
  travelDiscount: (r, l, d) => multiplierOfMark(rawMark(r, 'travelDiscount', l, d)),
  lootGrant: (r, l, d) => (rawMark(r, 'lootGrant', l, d) === null ? 0 : 1),
  guardDamage: (r, l, d) => multiplierOfMark(rawMark(r, 'guardDamage', l, d)),
  // 削减量：0 = 不削（1 - 0 就是原样）。上限 1 是「最多削到零伤害」，不是「倒过来加血」
  enemyDamage: (r, l, d) => {
    const raw = rawMark(r, 'enemyDamage', l, d);
    if (raw === null) return 0;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.min(1, n) : 0;
  },
};

/** 读一个标记（消费方统一走这里，谁都不手拼键名） */
export function readActionMark(
  readFlag: (flag: string) => string | null,
  mark: ActionMarkId,
  locationId: string,
  day: string,
): number {
  return ACTION_MARK_READERS[mark](readFlag, locationId, day);
}

/**
 * **探索危险倍率**的标记读取 —— 生产者（`resolvePathwayAction`）
 * 与消费者（`router/commands/explore.ts`）都走这里。
 */
export function exploreDangerMarkMultiplier(
  readFlag: (flag: string) => string | null,
  locationId: string,
  day: string,
): number {
  return readActionMark(readFlag, 'exploreDanger', locationId, day);
}

/** 本地点这一次的**产出倍率**（`mother.seedKeep` / `perfect.sequencingOrder`） */
export function lootMarkMultiplier(
  readFlag: (flag: string) => string | null,
  locationId: string,
  day: string,
): number {
  return readActionMark(readFlag, 'loot', locationId, day);
}

/** 本地点这一次的**探索是否免费**（`seer.puppet`）*/
export function freeExploreMark(
  readFlag: (flag: string) => string | null,
  locationId: string,
  day: string,
): boolean {
  return readActionMark(readFlag, 'freeExplore', locationId, day) > 0;
}

/** 本日**补一件收获**（`sleepless.weaveDream`） */
export function lootGrantMark(
  readFlag: (flag: string) => string | null,
  locationId: string,
  day: string,
): boolean {
  return readActionMark(readFlag, 'lootGrant', locationId, day) > 0;
}

/** 本地点今日**事件延后几格**（`warrior.intimidate`） */
export function eventDelayMarkTurns(
  readFlag: (flag: string) => string | null,
  locationId: string,
  day: string,
): number {
  return readActionMark(readFlag, 'eventDelay', locationId, day);
}

/** 本日**多几次占卜**（`reader.takenote`） */
export function divinationDailyMarkBonus(
  readFlag: (flag: string) => string | null,
  locationId: string,
  day: string,
): number {
  return readActionMark(readFlag, 'divinationDaily', locationId, day);
}

/** 本日**移动的行动点折扣**（`sailor.tailwind`；1 = 没有折扣） */
export function travelApDiscountOf(
  readFlag: (flag: string) => string | null,
  locationId: string,
  day: string,
): number {
  return readActionMark(readFlag, 'travelDiscount', locationId, day);
}

/**
 * **战斗侧要的三个标记**（M2.65）。
 *
 * 一次读全，命令层再一次性把用掉的那几个删掉 —— 判定层不认识 flags，
 * 它只回报「这一回合用掉了哪几条」（见 `RoundResult.consumedActionMarks`）。
 */
export interface BattleActionMarks {
  /** 本回合第一次出手的伤害倍率（默认 1） */
  nextAttack: number;
  /** 本回合受到的伤害倍率（默认 1） */
  guardDamage: number;
  /** 本回合对方出手的伤害削减（默认 0） */
  enemyDamage: number;
}

/** 战斗侧三条标记的读取点（一个函数读完，省得命令层拼三次键） */
export function battleActionMarks(
  readFlag: (flag: string) => string | null,
  locationId: string,
  day: string,
): BattleActionMarks {
  return {
    nextAttack: readActionMark(readFlag, 'nextAttack', locationId, day),
    guardDamage: readActionMark(readFlag, 'guardDamage', locationId, day),
    enemyDamage: readActionMark(readFlag, 'enemyDamage', locationId, day),
  };
}

/**
 * 战斗结束（或回合结束）时**要清掉的标记键**。
 *
 * 判定层回报「用掉了哪几条」（`RoundResult.consumedActionMarks`），
 * 命令层拿这张表把键删掉 —— 「用完即消」这条纪律在战斗侧只有这一处实现。
 */
export function battleMarkFlag(mark: ActionMarkId, locationId: string, day: string): string {
  return actionMarkFlag(mark, locationId, day);
}

/**
 * **行动表检查**（M2.38 任务 1 的后半）：每一条行动的 `effect` 都必须有落点。
 *
 * 判据三条：
 *   ① `kind` 必须在 `KIND_HANDLED` 里（resolver 有分支）；
 *   ② 带 `field` / `grant` / `variant` 的 payload，那个名字必须在 `ACTION_FIELD_EFFECTS` 里；
 *   ③ M2.65：**落点必须是活的** —— `mark` 要在 `ACTION_MARK_READERS` 里有读取函数，
 *      `item` 要在 `ACTION_ITEM_PLANNERS` 里有分支。
 *
 * ⚠️ `pending` 的 field **不算错**（它是诚实记账），但会被单独列出来 ——
 * 「已登记未实现」这件事必须**看得见**，否则它和「已实现」长得一模一样（K19）。
 */
export const KIND_HANDLED = ['none', 'query', 'buff', 'produce', 'move'] as const;

export interface ActionEffectAudit {
  actionId: string;
  kind: string;
  field: string;
  /** `handled` = 有机制；`pending` = 已登记未实现；`orphan` = **没有读取点** */
  status: 'handled' | 'pending' | 'orphan';
  note: string;
}

/** 落点是不是活的（判据 ③）—— 返回 null 表示活着，否则是「为什么不算活」 */
function deadLanding(spec: FieldEffect): string | null {
  if (spec.to === 'mark') {
    return ACTION_MARK_READERS[spec.mark] === undefined
      ? '标记「' + spec.mark + '」不在 ACTION_MARK_READERS 里（写了没人读）'
      : null;
  }
  if (spec.to === 'item') {
    return ACTION_ITEM_PLANNERS[spec.effect] === undefined
      ? '物品落点「' + spec.effect + '」不在 ACTION_ITEM_PLANNERS 里（搬不动东西）'
      : null;
  }
  return null;
}

/** 一条落点登记的审计结论（①②③ 全过才算 `handled`） */
function auditOne(actionId: string, kind: string, field: string, spec: FieldEffect): ActionEffectAudit {
  if (spec.to === 'pending') {
    return { actionId, kind, field, status: 'pending', note: spec.note };
  }
  const dead = deadLanding(spec);
  if (dead !== null) {
    return { actionId, kind, field, status: 'orphan', note: dead };
  }
  return { actionId, kind, field, status: 'handled', note: '落点：' + spec.to };
}

export function auditActionEffects(actions: readonly PathwayAction[]): ActionEffectAudit[] {
  return actions.map((action) => {
    const kind = action.effect.kind;
    const payload = (action.effect.payload ?? {}) as Readonly<Record<string, unknown>>;
    const field = actionEffectKeyOf(payload);
    if (!(KIND_HANDLED as readonly string[]).includes(kind)) {
      return { actionId: action.id, kind, field, status: 'orphan' as const, note: 'kind「' + kind + '」在 resolver 里没有分支' };
    }
    if (kind === 'none' || kind === 'move') {
      return { actionId: action.id, kind, field, status: 'handled' as const, note: kind === 'none' ? '无效果' : '移动（登记未实现）' };
    }
    if (field === '') {
      if (kind === 'query') {
        return { actionId: action.id, kind, field, status: 'handled' as const, note: '无 field 的查询' };
      }
      /*
       * ⚠️ `produce` 的效果**不一定写在 `field` 里** —— M2.29 有三条写的是
       * `grant: 'freeExplore'` / `grant: 'travelApDiscount'` / `variant: true`。
       * 判据要把这两个键也认下来，否则会把「有落点、只是键名不同」误报成 orphan
       *（K4 的老形状：判据只认一种写法，于是另一种写法被当成不存在）。
       */
      if (kind === 'produce') {
        const grant = typeof payload.grant === 'string' ? payload.grant : '';
        if (grant !== '') {
          const spec = ACTION_FIELD_EFFECTS[grant];
          if (!spec) {
            return { actionId: action.id, kind, field: grant, status: 'orphan' as const, note: 'grant「' + grant + '」不在 ACTION_FIELD_EFFECTS 里（没有任何读取点）' };
          }
          return auditOne(action.id, kind, grant, spec);
        }
        if (payload.variant === true) {
          const spec = ACTION_FIELD_EFFECTS['variant'];
          return auditOne(action.id, kind, 'variant', spec ?? { to: 'pending', note: 'variant 未登记' });
        }
      }
      return { actionId: action.id, kind, field, status: 'orphan' as const, note: 'kind「' + kind + '」没有 field / grant / variant，没有任何东西可读' };
    }
    if (kind === 'query') {
      const known = ACTION_QUERY_FIELDS[field] !== undefined;
      return {
        actionId: action.id,
        kind,
        field,
        status: known ? ('handled' as const) : ('orphan' as const),
        note: known ? '查询字段已登记' : '查询字段「' + field + '」不在 ACTION_QUERY_FIELDS 里',
      };
    }
    const spec = ACTION_FIELD_EFFECTS[field];
    if (!spec) {
      return { actionId: action.id, kind, field, status: 'orphan' as const, note: 'field「' + field + '」不在 ACTION_FIELD_EFFECTS 里（没有任何读取点）' };
    }
    return auditOne(action.id, kind, field, spec);
  });
}
