import type { DomainEvent } from '../../domain/character/types.ts';
import type { EffectDelta } from '../../domain/effect/apply.ts';
import {
  resolveExtraordinaryUse,
  type ExtraordinaryTarget,
} from '../../domain/extraordinary/index.ts';
import { isConsumedOnUse, isUsable, type ItemDef } from '../../domain/item/item.ts';
import { createSeededRng, seedFrom } from '../../domain/rng.ts';
import type { CharacterState } from '../../domain/character/types.ts';
import type { CommandContext, CommandResult } from '../index.ts';
import { parsePositiveInt } from '../args.ts';
import { battleTurn } from './battle.ts';
import { checkTaboosFor } from './taboo-hooks.ts';
import { applyFor, requireCharacter } from './common.ts';
import { markedLocationsOf } from './explore.ts';
import { renderDeltaSummary } from './render.ts';
import { setCurrentLocation } from './wanted-hooks.ts';

export const USE_USAGE =
  '用法：.使用 物品 [数量]（例：.使用 安神药剂 / .使用 灰雾之眼 / .使用 传送符 迷雾街区）';

/** M2.13：隐身符留下的「这段时间内不被通缉」标记（值是到期时刻的毫秒数） */
export const FLAG_HIDE_WANTED_UNTIL = 'hide_wanted_until';

/** 物品效果 → apply 的 delta 口径（数量倍率在这里乘） */
export function itemEffectDeltas(item: ItemDef, quantity: number): EffectDelta[] {
  const effect = item.effect;
  if (!effect) return [];
  const deltas: EffectDelta[] = [];
  for (const field of ['hp', 'mp', 'mad', 'cor', 'dig', 'dp'] as const) {
    const value = effect[field];
    if (value !== undefined && value !== 0) deltas.push({ type: field, value: value * quantity });
  }
  return deltas;
}

export async function handleUse(ctx: CommandContext): Promise<CommandResult> {
  const gate = requireCharacter(ctx);
  if (!gate.ok) return gate.result;
  const character = gate.character;
  const { deps, msg, now } = ctx;

  const query = ctx.args[0];
  if (!query) return { privateText: USE_USAGE, detailToPrivate: true };
  const quantity = parsePositiveInt(ctx.args[1]) ?? 1;

  const item = deps.items.findByNameOrName(query);
  if (!item) return { privateText: `没有这件物品：${query}`, detailToPrivate: true };

  const owned = deps.inventory.count(character.id, item.id);
  if (owned < 1) {
    return { privateText: `你只有 0 个${item.name}。`, detailToPrivate: true };
  }

  const seed = seedFrom([msg.messageId, character.id, now, 'use']);

  /*
   * ==================================================================
   * M2.13：**封印物与符咒走另一条路**
   * ==================================================================
   *
   * 它们与消耗品不是同一类东西（见 domain/item/item.ts 的注释）：
   *   消耗品（夜香草 / 苦艾酒）—— 效果就是「把某个数值改一改」，走 `itemEffectDeltas` + `apply`；
   *   封印物与符咒         —— 效果是「**接下来做什么**」（无视序列差 / 重抽 / 传送 / 隐身），
   *                          数值只是它的代价。所以它们走判定层 `resolveExtraordinaryUse`。
   *
   * 分派判据用 `type`，不是 `kind` —— `kind` 只管背包分类。
   */
  if (item.type === 'sealed' || item.type === 'charm') {
    return useExtraordinary(ctx, character, item, seed);
  }

  if (!isUsable(item)) {
    return { privateText: `${item.name}不能直接使用。`, detailToPrivate: true };
  }

  const applied = applyFor(
    deps,
    character,
    itemEffectDeltas(item, quantity),
    `使用:${item.id}`,
    now,
    seed,
  );
  if (applied.rejected) return { privateText: applied.rejected, detailToPrivate: true };

  if (!deps.inventory.tryRemove(character.id, item.id, quantity, now)) {
    return { privateText: `${item.name}数量不足。`, detailToPrivate: true };
  }

  const events = [
    ...applied.events,
    {
      type: 'item_delta',
      characterId: character.id,
      payload: { itemId: item.id, quantity: -quantity },
      reason: `使用:${item.id}`,
      seed,
      createdAt: now,
    },
  ];

  deps.characters.update(applied.newState);
  deps.characters.appendEvents(events);

  const lines: string[] = [`你使用了 ${item.name} × ${quantity}。`];
  lines.push(...renderDeltaSummary(applied.events, false, (id) => deps.items.nameOf(id)));
  const state = applied.newState;
  lines.push('');
  lines.push(
    `当前：HP ${state.hp}/100 · MP ${state.mp}/100 · SAN ${100 - state.mad} · 疯狂 ${state.mad} · 污染 ${state.cor}`,
  );

  /*
   * M2.17（任务 B2）：**教义检查点之二 —— 使用物品之后**。
   *
   * location 读的是「脚下地点」（flags 的 loc，与 .使用 的其它判定同源）——
   * 使用物品本身不指定地点，但「在哪儿用」是判据要问的事。
   *
   * ⚠️ 覆盖范围：这一处管**普通物品**（材料 / 消耗品 / 灵性物品）。
   * 封印物 / 符咒走 useExtraordinary → battleTurn 那条路，本轮不在那里开检查点
   * （它们是战斗链路，判据要等 M2.18 的对抗层）。
   */
  const taboo = checkTaboosFor(ctx, state, 'use', {
    locationId: deps.flags.value(character.id, 'loc'),
    cityId: character.currentCityId ?? null,
  });
  lines.push(...taboo.receipt);

  return {
    privateText: lines.join('\n'),
    groupText: `【${state.name}】使用了 ${item.name}。`,
    detailToPrivate: true,
  };
}

/**
 * 目标视图（灰雾之眼要用）。
 *
 * 非战斗时「目标」是**脚下地点里的一只生物** —— 这是探索前最有用的一条信息，
 * 也是唯一一条不引入新指令就能拿到的目标。战斗时是正在打的那一只。
 *
 * ⚠️ 查询在命令层（判定层不认识 SQL），喂进去的是一份纯数据。
 */
function targetViewOf(deps: CommandContext['deps'], character: CharacterState): ExtraordinaryTarget | null {
  const battle = deps.battles.activeOf(character.id);
  if (battle) {
    return {
      sequence: battle.creatureSequence,
      hp: battle.creatureHp,
      maxHp: battle.creatureMaxHp,
      name: battle.speciesName,
      locationId: null,
      locationName: null,
    };
  }
  const locationId = deps.flags.value(character.id, 'loc');
  if (!locationId) return null;
  const here = deps.creatures.atLocation(locationId);
  const pick = here[0];
  if (!pick) return null;
  const species = deps.creatureIndex.byId(pick.speciesId);
  return {
    sequence: pick.sequence,
    hp: pick.hp,
    maxHp: pick.maxHp,
    name: species?.name ?? pick.speciesId,
    locationId,
    locationName: deps.locations.get(locationId)?.name ?? locationId,
  };
}

/** 把一次封印物 / 符咒的使用走完：判定 → 提交代价 → 分发动作 → 扣物品 */
function useExtraordinary(
  ctx: CommandContext,
  character: CharacterState,
  item: ItemDef,
  seed: string,
): CommandResult {
  const { deps, now } = ctx;
  const target = targetViewOf(deps, character);
  const use = resolveExtraordinaryUse(character, item, target, createSeededRng(seed));
  if (!use.ok) {
    return { privateText: use.reason ?? `${item.name}现在用不了。`, detailToPrivate: true };
  }

  /*
   * 战斗类效果（封印之刃 / 血月之刃 / 命运骰子）**必须有对手** ——
   * 它们作用在「这一回合的那一下」上，非战斗时没有那一下。
   *
   * 有对手时直接**转发到战斗回合**（`.使用 封印之刃` ≡ `.战斗 物品 封印之刃`）：
   * 让玩家为了同一件事记两套说法，是「同一件事有两个入口」那类 bug 的温床。
   * 代价那一边也交给战斗链路提交（同源：都读 item.sideEffect），这里不重复提交。
   */
  const action = use.action;
  const battleAction =
    action?.kind === 'attack' || action?.kind === 'power_attack' || action?.kind === 'reroll';
  if (battleAction) {
    const battle = deps.battles.activeOf(character.id);
    if (!battle) {
      return {
        privateText: `${item.name}要在动手的时候用 —— 现在你面前没有对手。`,
        detailToPrivate: true,
      };
    }
    return battleTurn(ctx, character, battle, { kind: 'extraordinary', extraordinaryId: item.id });
  }

  const lines: string[] = [];
  const deltas: EffectDelta[] = [...use.deltas];
  const events: DomainEvent[] = [];

  /* ---- 传送：参数要先校验，不合法就整条指令作废（代价也不该付） ---- */
  if (action?.kind === 'teleport') {
    const wanted = ctx.args.slice(1).join(' ').trim();
    if (!wanted) {
      return { privateText: `要去哪？用法：.使用 ${item.name} <地点名>`, detailToPrivate: true };
    }
    const location = deps.locations.findByNameOrId(wanted);
    if (!location) {
      return { privateText: `没有这个地方：${wanted}`, detailToPrivate: true };
    }
    const marked = markedLocationsOf(deps, character.id);
    if (!marked.includes(location.id)) {
      return {
        privateText: `${location.name}你还没去过 —— 传送符只能把你送回走过的地方。`,
        detailToPrivate: true,
      };
    }
    setCurrentLocation(deps, character.id, location.id, now);
    lines.push(`纸角烧起来的时候，你已经在${location.name}了。`);
    lines.push('（传送符只能去**你去过**的地方 —— 它省的是路，不是路本身。）');
  }

  /*
   * ---- 时间沙漏（M2.85）：效果已下线 ----
   *
   * 它原来的效果是「重置一次每日行动点 + 之后几天恢复减半」，两个半边都长在
   * 行动值机制上；机制移除之后它没有可做的事情。物品本身保留（封印物收藏），
   * 是否换一个新效果留给后续拍板 —— 见交付说明的登记项。
   */

  /* ---- 隐身符：一段时间内不被通缉标记 ---- */
  if (action?.kind === 'hide_wanted') {
    const until = now + action.hours * 3600 * 1000;
    deps.flags.set(character.id, FLAG_HIDE_WANTED_UNTIL, now, String(until));
    lines.push(`${action.hours} 小时之内，没有人会把你和那张通缉令对上。`);
  }

  /* ---- 灰雾之眼：看到目标的几项 ---- */
  if (action?.kind === 'reveal') {
    if (!target) {
      lines.push('那只眼睛转了转，什么也没看见 —— 这里没有值得看的东西。');
    } else {
      const parts: string[] = [];
      if (action.fields.includes('location')) {
        parts.push('在' + (target.locationName ?? '某个地方'));
      }
      if (action.fields.includes('hp')) {
        parts.push(`HP ${target.hp ?? '?'}/${target.maxHp ?? '?'}`);
      }
      if (action.fields.includes('sequence')) {
        parts.push(`序列 ${target.sequence ?? '?'}`);
      }
      lines.push(`你看见了：${target.name ?? '某个东西'} —— ${parts.join(' · ')}。`);
    }
  }

  /* ---- 提交代价与数值变化（唯一数值入口） ---- */
  if (deltas.length > 0) {
    const applied = applyFor(deps, character, deltas, `使用:${item.id}`, now, seed);
    if (applied.rejected) return { privateText: applied.rejected, detailToPrivate: true };
    events.push(...applied.events);
    deps.characters.update(applied.newState);
  }

  /* ---- 消耗（只有符咒会被扣掉；封印物不扣，代价写在 sideEffect 里） ---- */
  if (isConsumedOnUse(item)) {
    if (!deps.inventory.tryRemove(character.id, item.id, 1, now)) {
      return { privateText: `${item.name}数量不足。`, detailToPrivate: true };
    }
    events.push({
      type: 'item_delta',
      characterId: character.id,
      payload: { itemId: item.id, quantity: -1 },
      reason: `使用:${item.id}`,
      seed,
      createdAt: now,
    });
  }

  /*
   * 留档：**每一次封印物的使用都要有记录**。
   * 报告里的「封印物使用次数（按物品）」直接数这一条 ——
   * 没有它，「序列 9 用封印物打赢序列 8」这件事就只剩回执里的一句话。
   */
  events.push({
    type: 'extraordinary_used',
    characterId: character.id,
    payload: {
      itemId: item.id,
      type: item.type,
      sealLevel: item.sealLevel ?? null,
      actionKind: action?.kind ?? 'numeric',
      /** 用的时候有没有对手（报告要区分「战斗里用的」与「平时用的」） */
      inBattle: deps.battles.activeOf(character.id) !== null,
    },
    reason: `使用封印物:${item.id}`,
    seed,
    createdAt: now,
  });
  deps.characters.appendEvents(events);

  const head = `你使用了 ${item.name}。`;
  if (use.sealWarning) lines.unshift(use.sealWarning);
  lines.unshift(head);
  lines.push(...renderDeltaSummary(events, false, (id) => deps.items.nameOf(id)));

  const state = deps.characters.findByUserId(ctx.msg.userId) ?? character;
  lines.push('');
  lines.push(
    `当前：HP ${state.hp}/100 · MP ${state.mp}/100 · 疯狂 ${state.mad} · 污染 ${state.cor}`,
  );

  return {
    privateText: lines.join('\n'),
    groupText: `【${state.name}】用了一件不该随便用的东西。`,
    detailToPrivate: true,
  };
}
