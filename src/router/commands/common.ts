import type { CharacterState } from '../../domain/character/types.ts';
import {
  capsFromAbilityEffects,
  NO_ABILITY_EFFECTS,
  type AbilityEffect,
} from '../../domain/ability/ability.ts';
import { mortalCapsFor } from '../../domain/initiation/index.ts';
/*
 * M2.88：**当地权柄的理智倍率** —— 在 `applyFor` 里乘（那是全项目唯一的数值入口），
 * 所以「这一带疯狂涨得快」不需要在几十处 delta 生成点重复。
 */
import { madRateAt } from '../../domain/world/authority-effects.ts';

/**
 * **一个 NPC 现在的序列。**
 *
 * ## 为什么要有这个函数（M2.89 抓到的一个真 bug）
 *
 * 项目里有**两张**表都能回答这个问题：
 *
 *   · `npc_tracks`（YAML）：**设定层**——他是谁、最终走到哪一档。有 `currentSequence`。
 *   · `npcProgress`（库）：**运行时层**——世界 tick 让他晋升 / 移动之后的当前位置。
 *     开局是**空的**，因为它记的是「演化」，不是「设定」。
 *
 * 而三处调用点全都写的是 `npcProgress.of(id)?.sequence ?? 9` —— 于是**开局时所有 NPC
 * 的序列都是 9**（最低档）。后果不是报错，是两条静默失效：
 *
 *   ① `sabotageChance(npcSequence, …)` 要求 `npcSequence <= 6` ⇒ **永远返回 0**
 *      ⇒ 「交恶的高序列会搅你的仪式」这条机制**从来没生效过**；
 *   ② `schemeTierOf(9)` = `petty` ⇒ 阴谋系统**只会生成最低档**「街面上的算计」。
 *
 * 判据：**设定层是兜底，运行时层是覆盖**。顺序不能反 ——
 * 反了就会「世界还没跑起来时，所有人都变回最弱」。
 */
export function npcSequenceOf(deps: RouterDeps, npcId: string): number {
  const runtime = deps.npcProgress.of(npcId)?.sequence;
  if (typeof runtime === 'number') return runtime;
  /*
   * ⚠️ M2.164：兜底也走名册（轨道 + 居民两张表）。只查轨道的话，
   * 名册里那些**有序列的非凡者**（值夜者序列 8、占卜者序列 9）会一律被判成 9 ——
   * 于是「他会来搅你的仪式」对整张名册永远不成立，而且不报错。
   */
  /*
   * ⚠️ 用可选链：这是**兜底函数**，调用点里有一批只造了半个 deps 的用例
   * （m2-90 的「设定层是兜底」直接手搓 { npcProgress, npcTracks }）。
   * 少了它，那些用例会在这一行崩 —— 而它本来要做的事只是「尽量答一个序列」。
   */
  const entry = deps.npcRoster?.byId(npcId) ?? null;
  if (entry !== null && typeof entry.sequence === 'number') return entry.sequence;
  /*
   * 再退一层：只造了半个 deps 的调用方（没有 roster）仍然按原来的轨道表答 ——
   * 这条回退不是冗余：名册**合并**了轨道，所以正常路径走上面那一行就够；
   * 只有手搓 deps 的用例会走到这里，而它们期望的正是「设定层兜底」。
   */
  const track = deps.npcTracks?.find((t) => t.id === npcId);
  if (track !== undefined && typeof track.currentSequence === 'number') return track.currentSequence;
  return 9;
}
import { applyWithCaps, type ApplyResult, type EffectDelta } from '../../domain/effect/apply.ts';
import type { TriggerContext } from '../../domain/event/trigger.ts';
import { createSeededRng, seedFrom } from '../../domain/rng.ts';
import { renderTemplate } from '../../cards/template.ts';
import { pickAftershockText } from '../../cards/lost-control.ts';
import type { PathwayId } from '../../domain/character/types.ts';
import { isExpired } from '../../domain/trade/trade.ts';
import { dateKey } from '../../infra/date.ts';
import { worldClock, type WorldClock } from '../../domain/world/clock.ts';
import {
  worldModifiers,
  type WeatherId,
  type WorldModifiers,
} from '../../domain/world/weather.ts';
import type { CommandContext, CommandResult, RouterDeps } from '../index.ts';
import { settleArrival } from './arrival.ts';

export const NO_CHARACTER_TEXT = '你还没有角色。发送 .创建 姓名 开始。';

/**
 * M2.3 §3.6：群里不接数字回复 ——
 * 「A 回 1，系统不知道是回给谁的菜单」。所以群里遇到需要选项的入口，
 * 一律只播报摘要 + 把玩家引到私聊，绝不在群里摆一张没法用的菜单。
 */
export const GROUP_MENU_HINT = '选项在私聊里：单独发一条同样的指令给我就行。';

export function noCharacterResult(ctx: CommandContext): CommandResult {
  return {
    privateText: NO_CHARACTER_TEXT,
    groupText: `【${ctx.msg.nickname || ctx.msg.userId}】还没有角色。`,
    detailToPrivate: true,
  };
}

export type CharacterGate = { ok: true; character: CharacterState } | { ok: false; result: CommandResult };

/**
 * 「有角色才能继续」的统一闸门。
 *
 * M2.7 起它多了一件事：**到达是惰性的**。
 * 每次进任何指令之前，先把「已经到点的行程」结算掉（切城市、落地点、了结路上的事）。
 * 为什么不放到世界 tick：世界 tick 是每 5 分钟一次、而且 startOps=false（实例测试 / 压测）
 * 时根本不跑；移动的到达判定必须与玩家的动作同一个时钟，否则会出现
 * 「压测里所有人都到不了」这种只存在于测试环境的假象。
 *
 * 到达信息写进 ctx.arrivalNotes，由路由层附到「下一步」菜单上 ——
 * 不在这里直接返回，是为了让每条指令的回执格式保持不变（127 条既有断言都建立在它之上）。
 */
export function requireCharacter(ctx: CommandContext): CharacterGate {
  const found = ctx.deps.characters.findByUserId(ctx.msg.userId);
  if (!found) return { ok: false, result: noCharacterResult(ctx) };
  const settled = settleArrival(ctx.deps, found, ctx.now);
  if (settled.arrived && settled.lines.length > 0) {
    ctx.arrivalNotes = [...(ctx.arrivalNotes ?? []), ...settled.lines];
  }
  return { ok: true, character: settled.character };
}

export function triggerContextFor(
  deps: RouterDeps,
  character: CharacterState,
  date: string,
  location?: string,
): TriggerContext {
  return {
    character,
    flags: deps.flags.asSet(character.id),
    date,
    location,
    partySize: deps.parties.partySizeOf(character.id),
  };
}

/** 已解锁能力的合并效果（查 abilities 表 + flags 解锁标记，不硬编码途径） */
export function abilityEffectsOf(deps: RouterDeps, character: CharacterState): AbilityEffect {
  // M2.7.6：普通人没有途径，也就没有能力 —— 不必查库，直接给空效果集
  if (!character.pathway) return NO_ABILITY_EFFECTS;
  return deps.abilities.effectsOf(character.id, character.pathway);
}

/**
 * M2.2：当前世界（时段 / 月相 / 雾日 + 该地点天气）→ 影响聚合。
 * 所有倍率都从 config/numeric.ts 的 world 段算出来，命令层只负责传下去。
 */
export function worldViewFor(
  deps: RouterDeps,
  now: number,
  locationId?: string,
  path?: PathwayId,
): { clock: WorldClock; weather: WeatherId; modifiers: WorldModifiers } {
  deps.world.ensure(now, deps.worldSeed ?? 'world');
  const clock = worldClock(now, deps.world.seed());
  const weather: WeatherId = locationId ? deps.world.weatherOf(locationId) : 'clear';
  const modifiers = worldModifiers({ clock, weather, ...(path ? { path } : {}) });
  return { clock, weather, modifiers };
}

/** 带能力上限的唯一数值入口：业务代码统一走这里 */
export function applyFor(
  deps: RouterDeps,
  state: CharacterState,
  deltas: readonly EffectDelta[],
  reason: string,
  now: number,
  seed?: string,
): ApplyResult {
  const effects = abilityEffectsOf(deps, state);
  /*
   * M2.88：**当地权柄的理智倍率。**
   *
   * 放在这里是刻意的，与上面那段注释同一个理由 —— 所有数值改动都从 `applyFor` 走，
   * 于是「这一带疯狂涨得快」不需要在几十处 delta 的生成点里重复一遍。
   *
   * ⚠️ **只放大正的 mad**（在涨的那些）。
   *
   * 如果连负的一起乘，`madRate = 2` 会变成「疯狂涨一倍、`.休息` 也降一倍」——
   * 那等于权柄没有净效果，只是把刻度尺换了。
   * 玩家该感受到的是「这地方压得人喘不过气」，不是「这地方的数字比较大」。
   */
  const here = state.currentLocationId ?? state.currentCityId ?? null;
  const madRate = madRateAt(deps.world, here, now);
  const adjusted =
    madRate === 1
      ? deltas
      : deltas.map((d) =>
          d.type === 'mad' && d.value > 0
            ? { ...d, value: Math.max(1, Math.round(d.value * madRate)) }
            : d,
        );
  /*
   * M2.7.6：普通人的上限叠在能力上限之上。
   * 放在**唯一数值入口**这里是刻意的 —— 所有数值改动都从 applyFor 走，
   * 于是「普通人 MAD 最多 20」这一条不需要在任何一个 delta 的生成处重复。
   */
  const caps = { ...capsFromAbilityEffects(effects), ...mortalCapsFor(state) };
  return applyWithCaps(state, adjusted, reason, now, seed, caps);
}

/** 当前可触发的事件卡 id（供探索按地点交集使用） */
export function eligibleCardIds(
  deps: RouterDeps,
  ctx: CommandContext,
  character: CharacterState,
  date: string,
  locationName?: string,
): string[] {
  return deps.engine
    .eligible(triggerContextFor(deps, character, date, locationName), {
      date,
      location: locationName,
      // M2.69：次数而不是集合 —— 上限由 EventEngine.eligible 统一比（daily_limit 的唯一读取点）
      triggeredToday: deps.eventTriggers.countsOn(character.id, date),
      types: ['daily', 'random', 'hidden'],
      inCooldown: (card) =>
        deps.eventTriggers.inCooldown(character.id, card.id, date, card.trigger.cooldown_days),
    })
    .map((card) => card.id);
}

/**
 * 超时交易懒清扫（NUMERIC.trade.timeoutMs 未确认 → 取消并解冻物品）。
 * 每个交易相关指令入口都会调用一次，main 里另有定时器兜底。
 */
export function expireStaleTrades(deps: RouterDeps, now: number): number {
  let expired = 0;
  for (const trade of deps.trades.listPending()) {
    if (!isExpired(trade.createdAt, now)) continue;
    deps.inventory.add(trade.sellerId, trade.itemId, trade.qty, 'unbound', now);
    deps.trades.updateStatus(trade.id, 'expired', null);
    deps.characters.appendEvents([
      {
        type: 'trade_expire',
        characterId: trade.sellerId,
        payload: { tradeId: trade.id, itemId: trade.itemId, qty: trade.qty },
        reason: `交易超时:${trade.id}`,
        seed: `trade:${trade.id}`,
        createdAt: now,
      },
    ]);
    deps.audit.write({
      userId: trade.sellerId,
      command: '交易超时',
      input: trade.id,
      output: `解冻 ${trade.itemId} × ${trade.qty}`,
      createdAt: now,
    });
    expired += 1;
  }
  return expired;
}

export function today(ctx: CommandContext): string {
  return dateKey(ctx.now);
}

/** 失控恢复后的「余波」文本（同 seed 同文本） */
export function aftershockLine(deps: RouterDeps, pathway: PathwayId, seed: string): string {
  const rng = createSeededRng(seedFrom([seed, 'aftershock']));
  const raw = pickAftershockText(deps.lostControlPool, Math.floor(rng.next() * 1000));
  return renderTemplate(raw, deps.fragments, rng, {});
}

/**
 * 卡片文本渲染：把 {{片段}} 按 seed 拼成完整文本。
 * 同一 seed 必然得到同一段文本（复现时文案也一致）。
 */
export function renderCardText(
  deps: RouterDeps,
  text: string,
  seed: string,
  context: Record<string, string> = {},
): string {
  return renderTemplate(text, deps.fragments, createSeededRng(seedFrom([seed, 'text'])), context);
}
