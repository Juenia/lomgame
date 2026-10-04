/**
 * M2.38 任务 1（**P0**）：`.行动` —— 途径专属行动的**执行入口**。
 *
 * ## 为什么要有这条指令
 *
 * M2.29 交付的行动是**纯文案**：`pathwayActionFor` 只有一个调用点，且只取
 * `label` / `command` / `preview`，`effect` 从来没被读过。
 * 没有入口 ⇒ 效果无处施加 ⇒ 那张表永远只是提示。这条指令就是那个入口。
 *
 * ## ★ M2.65：从「写标记」补齐到「搬东西」
 *
 * M2.38 落地的入口只做了两件事：走数值入口（delta）+ 写标记（mark）。
 * 于是五条写着 `consume` 的行动（秘偶代行 / 顺风 / 改装 / 总装 / 排程）
 * **一件东西都没扣过** —— 全是白拿。
 *
 * 现在这里多了两步，顺序是有讲究的：
 *
 *   1. `planActionItems` 先算清单（纯函数，读 `consume` / `variant` / `grant`）；
 *   2. 清单不成立 ⇒ **整条行动不发生**（不扣东西、不写标记、不留痕）；
 *   3. 数值（自身开销 needs + 效果，一起走 apply）→ **物品**（InventoryRepo）→ 标记（flags）→ 事件流。
 *
 * 为什么物品挪到数值之后：数值那一步可能被拒（AP / DP 不能透支），
 * 先扣东西再被拒就是「白白吃掉玩家一件道具」。
 *
 * ## 对既有读数的影响：**零**
 *
 * vplayer（跑批）**不会发 `.行动`**（它的指令表里没有这条）⇒ 跑批行为一个字节都不变。
 */
import { NUMERIC } from '../../config/numeric.ts';
import { CLAMP, type EffectDelta } from '../../domain/effect/apply.ts';
import { PATHWAY_ACTIONS, type PathwayAction } from '../../domain/menu/pathway-actions.ts';
import { resolvePathwayAction } from '../../domain/menu/pathway-action-resolve.ts';
import { planActionItems } from '../../domain/menu/pathway-action-items.ts';
import { createSeededRng, seedFrom } from '../../domain/rng.ts';
import { FLAG_LOCATION } from '../../infra/db/flags.ts';
import type { CommandContext, CommandResult } from '../index.ts';
import { abilityEffectsOf, applyFor, requireCharacter, today } from './common.ts';
import { renderDeltaSummary } from './render.ts';

export const ACTION_USAGE =
  '用法：.行动 <名称> [物品]（途径专属行动，例：.行动 化身 / .行动 改装 淬火匕首）；' +
  '不带名称则列出当前可用的行动';

/**
 * 把参数切成「行动名 + 剩下的东西」。
 *
 * ⚠️ 行动名可能带空格（内容表里现在没有，但 `PathwayAction.name` 是自由字符串），
 * 所以按**最长前缀**匹配，剩下的部分才算玩家点名的物品 ——
 * 先到先得（短的先匹配）会把「总装 铜哨」切成「总装」+「铜哨」之外的东西。
 */
function splitActionArgs(
  tokens: readonly string[],
  unlocked: readonly PathwayAction[],
): { action: PathwayAction | null; rest: string[] } {
  for (let n = Math.min(tokens.length, 3); n >= 1; n -= 1) {
    const name = tokens.slice(0, n).join(' ');
    const hit = unlocked.find((entry) => entry.name === name);
    if (hit !== undefined) return { action: hit, rest: tokens.slice(n) };
  }
  return { action: null, rest: [...tokens] };
}

export async function handleAction(ctx: CommandContext): Promise<CommandResult> {
  const gate = requireCharacter(ctx);
  if (!gate.ok) return gate.result;
  const character = gate.character;
  const { deps, msg, now } = ctx;

  if (!character.pathway) {
    return { privateText: '你还没有走上任何途径 —— 途径专属行动要入途径之后才有。', detailToPrivate: true };
  }

  // 解锁口径与 locations.yaml 的 min_seq 一致：数字越小越强，action.seq >= 玩家序列 才可用
  const seq = character.sequence ?? 9;
  const unlocked = PATHWAY_ACTIONS.filter((entry) => entry.pathway === character.pathway && entry.seq >= seq);

  const tokens = ctx.args.map((token) => token.trim()).filter((token) => token !== '');
  if (tokens.length === 0) {
    const lines = ['【' + character.pathway + '】你现在能用的途径专属行动：', ''];
    for (const entry of unlocked) {
      lines.push('  · ' + entry.name + '（解锁序列 ' + entry.seq + '）—— ' + entry.preview);
      lines.push('      可用场景：' + entry.contexts.join(' / '));
    }
    lines.push('', '用 `.行动 <名称>` 执行；要消耗物品的行动可以在后面点名一件（例：`.行动 改装 淬火匕首`）。');
    return { privateText: lines.join(String.fromCharCode(10)), detailToPrivate: true };
  }

  const picked = splitActionArgs(tokens, unlocked);
  const action = picked.action;
  if (action === null) {
    return {
      privateText:
        '没有这个行动：' + tokens.join(' ') + '。你现在能用的是：' +
        (unlocked.map((entry) => entry.name).join('、') || '（一条都没有）'),
      detailToPrivate: true,
    };
  }

  const locationId = deps.flags.value(character.id, FLAG_LOCATION) ?? '';
  if (locationId === '') {
    return { privateText: '你还不在任何地点上 —— 先 `.移动` 过去再用行动。', detailToPrivate: true };
  }

  const date = today(ctx);

  /*
   * ---- 第一步：物品清单（纯函数）----
   *
   * 它读的是 action.effect.payload 里的 consume / variant / grant，
   * 与 resolvePathwayAction 各读各的键、**同源同表**（都在 domain/menu 里）。
   */
  const plan = planActionItems({
    payload: (action.effect.payload ?? {}) as Readonly<Record<string, unknown>>,
    // ⚠️ 用**内容索引**而不是仓储：库里的 items 没有 variants 那一列（见 domain/item/item.ts）
    items: deps.itemIndex.all(),
    slots: deps.inventory.list(character.id),
    named: picked.rest,
  });
  if (!plan.ok) {
    return {
      privateText: '【' + action.name + '】' + plan.reason + String.fromCharCode(10) + ACTION_USAGE,
      detailToPrivate: true,
    };
  }

  const outcome = resolvePathwayAction({
    action,
    character,
    locationId,
    day: date,
    abilityEffects: abilityEffectsOf(deps, character),
  });

  /*
   * ---- 第二步：**自身开销**（`needs`）与效果一起走唯一数值入口 ----
   *
   * 为什么合成一次 apply 而不是先扣开销再apply效果：两次调用会写两批事件，
   * 而玩家看到的是「同一条指令扣了两次」；更糟的是第一次成功、第二次被拒时
   * 回执会一半真一半假。合成一次，整批要么都算要么都不算（apply 的既定语义）。
   */
  const need = action.needs;
  const costDeltas: EffectDelta[] = [];
  if (need === 'mp') {
    const mpCost = NUMERIC.pathwayAction.mpCost;
    // MP 是软约束（apply 里没有硬底线，只会夹到 0），所以不足要在这里当面拦
    if (character.mp < mpCost) {
      return {
        privateText: '【' + action.name + '】灵性不足（需要 ' + mpCost + '，当前 ' + character.mp + '）。',
        detailToPrivate: true,
      };
    }
    costDeltas.push({ type: 'mp', value: -mpCost });
  }

  const seed = seedFrom([msg.messageId, character.id, now, 'action', action.id]);
  const lines: string[] = ['【' + action.name + '】' + action.preview];

  /* ---- 第三步：数值（唯一入口） ---- */
  const deltas: EffectDelta[] = [...costDeltas, ...outcome.deltas];
  let state = character;
  if (deltas.length > 0) {
    const applied = applyFor(deps, character, deltas, action.name, now, seed);
    if (applied.rejected) return { privateText: applied.rejected, detailToPrivate: true };
    deps.characters.update(applied.newState);
    deps.characters.appendEvents(applied.events);
    state = applied.newState;
    lines.push('', ...renderDeltaSummary(applied.events, false, (id) => deps.items.nameOf(id)));
  }

  /* ---- 第四步：物品（走 InventoryRepo，全有或全无） ---- */
  const itemEvents: DomainEventLike[] = [];
  if (plan.picks.length > 0) {
    if (!deps.inventory.tryRemoveMany(character.id, plan.picks, now)) {
      // 计划算过一遍还失败 = 背包在两步之间被动过（同一 tick 的另一条指令）
      return {
        privateText: '【' + action.name + '】东西在你动手之前不见了 —— 背包和刚才算的不一样。',
        detailToPrivate: true,
      };
    }
    if (plan.text !== '') lines.push('', plan.text);
  }
  if (plan.grants.length > 0) {
    deps.inventory.addMany(character.id, plan.grants, now);
    const gained = plan.grants
      .map((grant) => '「' + deps.items.nameOf(grant.itemId) + '」')
      .join('、');
    lines.push('', '你手上多了一件东西：' + gained + '。');
    for (const grant of plan.grants) {
      itemEvents.push({
        type: 'item_gain',
        characterId: character.id,
        payload: {
          itemId: grant.itemId,
          quantity: grant.quantity,
          bindType: grant.bindType,
          source: action.id,
        },
        reason: action.name,
        seed,
        createdAt: now,
      });
    }
  }

  /* ---- 第五步：标记（由判定层在作用域内消费） ---- */
  for (const mark of outcome.marks) deps.flags.set(character.id, mark.flag, now, mark.value);

  /*
   * ---- 第六步：留痕 ----
   *
   * **每一次使用都进事件流**。没有这一条，「行动被用过」在库里查不到 ——
   * 而它是本轮唯一能被统计的东西（效果的落点分散在 state / flags / inventory 三处，
   * 只有事件流能把它们串成「某玩家用了某行动、动了哪几件东西」）。
   */
  deps.characters.appendEvents([
    {
      type: 'action_used',
      characterId: character.id,
      payload: {
        actionId: action.id,
        kind: action.effect.kind,
        locationId,
        marks: outcome.marks.map((mark) => mark.flag),
        picked: plan.picks.map((pick) => pick.itemId),
        granted: plan.grants.map((grant) => grant.itemId),
      },
      reason: action.name,
      seed,
      createdAt: now,
    },
    ...itemEvents,
  ]);

  if (outcome.text !== action.preview) lines.push('', outcome.text);
  lines.push('', '当前：HP ' + state.hp + ' · MP ' + state.mp);
  return {
    privateText: lines.join(String.fromCharCode(10)),
    groupText: state.name + '用了「' + action.name + '」。',
    detailToPrivate: true,
  };
}

/** appendEvents 收的事件形状（只是给上面那个数组一个名字，避免 any） */
type DomainEventLike = Parameters<CommandContext['deps']['characters']['appendEvents']>[0][number];
