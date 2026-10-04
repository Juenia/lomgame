import { EventEngine } from '../../domain/event/engine.ts';
import { PATHWAY_TAGS } from '../../domain/play/tags.ts';
import { PLAY_SCORE } from '../../domain/play/score.ts';
import { playDigDiminish, playEscalationMad, resolvePlay } from '../../domain/play/play.ts';
import { createSeededRng, seedFrom } from '../../domain/rng.ts';
import { cardDisplayName } from '../../domain/display.ts';
import { PATHWAY_LABELS } from '../../domain/character/rules.ts';
import { NUMERIC } from '../../config/numeric.ts';
import { weatherLabel, weatherRow } from '../../domain/world/weather.ts';
import { dateKey } from '../../infra/date.ts';
import type { EventCard } from '../../cards/schema.ts';
import { buildPlayMenu, pathwayKit } from '../../domain/menu/index.ts';
import { menuCharacterFor, worldSnapshotFor } from '../menu.ts';
import type { CommandContext, CommandResult } from '../index.ts';
import { wonderEffectsOf } from './wonder-hooks.ts';
import { applyFor, GROUP_MENU_HINT, renderCardText, requireCharacter, worldViewFor } from './common.ts';
// M2.90：日常动作推进仪式流程 —— 全项目只有这一份实现（探索 / 扮演 / 事件 / 战斗共用）
import { dailyFlowLines } from './ritual.ts';
import { renderDeltaSummary } from './render.ts';
import { isInitiated, type InitiatedCharacter } from '../../domain/character/types.ts';
import { mortalRefusal } from './mortal-guard.ts';
import { pvpWaitNudge } from './pvp-hooks.ts';
import { CLAMP } from '../../domain/effect/apply.ts';

export const PLAY_USAGE = '用法：.扮演 你在做什么（例：.扮演 在书店里替人占卜今天的运势）';

/** 当天扮演次数（每日计数器的 key；M2.2 的扮演加压按它累计） */
export const PLAY_COUNTER_KEY = 'play';

/** 一次扮演 → 消化判定 → 暴露抽卡 → 落库 → 渲染 */
export async function handlePlay(ctx: CommandContext): Promise<CommandResult> {
  const { msg, args, now, deps } = ctx;
  const text = args.join(' ').trim();

  // M2.3 §3.1：不带参数的 .扮演 = 打开扮演菜单（选项从途径 / 序列 / 天气 / 时段 / 状态生成）
  if (!text) {
    const gate = requireCharacter(ctx);
    if (!gate.ok) return gate.result;
    const character = gate.character;
    // M2.7.6：连菜单都不给 —— 一张全是「你做不了这件事」的菜单比拒绝更让人困惑
    if (!isInitiated(character)) return mortalRefusal(ctx, character, '扮演');
    const menu = buildPlayMenu(
      menuCharacterFor(deps, character, now),
      worldSnapshotFor(deps, now, character),
      pathwayKit(character.pathway),
    );
    return {
      privateText: deps.pendingMenus.open(character.id, 'play', menu, now),
      groupText: `【${character.name}】在琢磨今天该做什么。`,
      detailToPrivate: true,
      menuOpened: true,
    };
  }

  const character = deps.characters.findByUserId(msg.userId);
  if (!character) {
    return {
      privateText: '你还没有角色。发送 .创建 姓名 开始。',
      groupText: `【${msg.nickname || msg.userId}】还没有角色。`,
      detailToPrivate: true,
    };
  }
  /*
   * M2.7.6：**普通人不能扮演。**
   *
   * 扮演的语义是「以途径的方式行事」—— 消化度是模仿得有多像的度量。
   * 一个还不知道途径是什么的人没有可模仿的对象，所以这不是难度问题，
   * 而是这件事对他还不存在。
   */
  if (!isInitiated(character)) return mortalRefusal(ctx, character, '扮演');

  const date = dateKey(now);
  const seed = seedFrom([msg.messageId, character.id, now]);
  const tags = PATHWAY_TAGS[character.pathway];
  const usage = deps.tagUsage.usageOf(character.id, date);
  // M2.2：夜晚（不眠者 +20% 消化 / 其他途径 MAD +1）与天气的扮演系数
  const world = worldViewFor(deps, now, undefined, character.pathway);
  // M2.13：被动的神奇物品（记录笔记：扮演消化 +10%）
  const wonder = wonderEffectsOf(deps, character.id, now);
  // M2.2 §5.6：「激进行为 MAD 涨得更猛」——当天第 N 次之后的每次扮演额外加压
  const playedToday = deps.dailyCounters.countOf(character.id, date, PLAY_COUNTER_KEY);
  const escalationMad = playEscalationMad(playedToday);
  const outcome = resolvePlay({
    state: character,
    text,
    tags,
    usage,
    seed,
    world: {
      mad: world.modifiers.playMad + escalationMad,
      /*
       * M2.13：**记录笔记**（神奇物品，被动 +10% 消化度）乘在世界倍率之上。
       * 它与 M2.2 的「不眠者夜晚 +20%」是两条独立的线：
       * 一个是「什么时候做」，一个是「做完有没有记下来」。
       * 没有这件物品时 wonder.playDigMultiplier 恒为 1 —— 行为与 M2.12 逐位一致。
       */
      /*
       * M2.118：**再乘一个「今天演过几次」的衰减**（用户要的软上限）。
       * 不禁止扮演，只是同一天里越往后消化得越少 ——
       * 「一天刷满」这条路就此堵上，而「想演就演」不受影响。
       */
      digMultiplier:
        world.modifiers.playDigMultiplier * wonder.playDigMultiplier * playDigDiminish(playedToday),
    },
  });

  // 1) 消化结算（事件带 seed，可复现）
  const digResult = applyFor(deps, character, outcome.deltas, '扮演消化', now, seed);
  let state = digResult.newState;
  const events = [...digResult.events];

  // 2) 暴露判定：命中则从 random 池抽一张暴露卡，由卡的 effects 决定 MAD/COR 涨幅
  let exposedCard: EventCard | null = null;
  if (outcome.exposed) {
    const rng = createSeededRng(seedFrom([seed, 'exposure']));
    // M2.69：次数（daily_limit 的实际判据在 EventEngine.eligible 里）
  const triggeredToday = deps.eventTriggers.countsOn(character.id, date);
    const card = deps.engine.pick(
      { character: state, flags: deps.flags.asSet(character.id), date },
      rng,
      {
        date,
        triggeredToday,
        types: ['random'],
        inCooldown: (candidate) =>
          deps.eventTriggers.inCooldown(character.id, candidate.id, date, candidate.trigger.cooldown_days),
      },
    );
    if (card) {
      const application = EventEngine.applyCard(state, card, { now, seed });
      state = application.result.newState;
      events.push(...application.result.events);
      deps.flags.setMany(character.id, application.flagsToSet, now);
      deps.eventTriggers.mark(character.id, card.id, date);
      exposedCard = card;
    }
  }

  deps.characters.update(state);
  deps.characters.appendEvents(events);
  deps.tagUsage.record(character.id, date, [
    ...outcome.breakdown.matchedCore,
    ...outcome.breakdown.matchedSecondary,
  ]);
  // 当天扮演次数（加压旋钮的计数依据；与标签用量分开记，语义不同）
  deps.dailyCounters.increment(character.id, date, PLAY_COUNTER_KEY);

  /*
   * state 是 apply 的产物：apply 只改数值，不改 pathway / sequence ——
   * 所以「已入途径」这条性质在它身上仍然成立（入口处已经挡过普通人）。
   * 类型系统看不到这一点，这里显式收窄并说明理由。
   */
  const initiatedState = state as InitiatedCharacter;
  /*
   * M2.11 前置 3：**在等待对手出招的时候，做了一件什么都不改变的事 —— 要有人告诉他。**
   *
   * M2.10 的 2 条 P1 就是从这里来的：玩家在 PVP 里等对手，
   * 连着发 .扮演，而 DIG 已经满了 → 状态不变 → 累积到 10 次。
   *
   * ⚠️ 这不是异常判定的补丁（noChangeStreak 一个数都没动，见 session.ts 的 ACTION_COMMANDS）。
   * 它补的是**信息的空白**：玩家做这件事的时候并不知道它没有收益，
   * 而回执上也没有任何一句话告诉他。现在有了 —— 而且只在真的没收益时才出现。
   *
   * 「没收益」的判据用 DIG 有没有动，而不是「标签有没有用满」：
   * 标签用量只是 DIG 不涨的**一种**原因，而且玩家看不到那个计数器的原文。
   */
  const digDiminish = playDigDiminish(playedToday);
  const noDigGain = state.dig <= character.dig;
  const nudge = noDigGain ? pvpWaitNudge(deps, initiatedState, now) : null;
  const noGainNote = !noDigGain
    ? null
    : state.dig >= CLAMP.dig[1]
      ? '你的消化度已经满了，扮演不再有收益。'
      : '这一次扮演没有让消化度往前挪（今天这些标签已经用满了）。';
  /*
   * M2.90：**扮演也在推进仪式流程。**
   *
   * 用户否掉计时模型的原话是「拿现实时间去要求就是纯折磨」，而改成流程之后
   * 唯一的推进方式一度只有 `.仪式 推进` —— 那只是把折磨从时钟搬到了手指上。
   * 扮演是玩家最常做的事，它当然该算「在别处下的功夫」。
   *
   * 位置在最后：仪式那一行是这次扮演的**额外**产物，不该挤掉消化与提醒的位置。
   */
  const flowLines = dailyFlowLines(deps, initiatedState, now, String(msg.messageId) + ':play');
  return {
    privateText: [
      renderPlayDetail(deps, initiatedState, text, outcome, exposedCard, events, seed, world, playedToday),
      ...(noGainNote && nudge ? ['', noGainNote, nudge] : []),
      ...(flowLines.length > 0 ? ['', ...flowLines] : []),
    ].join('\n'),
    groupText:
      exposedCard?.texts.group !== undefined
        ? renderCardText(deps, exposedCard.texts.group, seed, {})
        : `【${state.name}】扮演告一段落，消化 ${outcome.digBefore.toFixed(1)} → ${outcome.digAfter.toFixed(1)}。`,
    detailToPrivate: true,
    // M2.3 §4.1：结果摘要进「下一步」菜单首屏
    menuNotes: [
      `DIG ${character.dig.toFixed(1)} → ${state.dig.toFixed(1)}（${state.dig - character.dig >= 0 ? '+' : ''}${(state.dig - character.dig).toFixed(1)}）`,
      ...(state.mad !== character.mad ? [`MAD ${character.mad} → ${state.mad}`] : []),
    ],
  };
}

/** 一次扮演 → 消化判定 → 暴露抽卡 → 落库 → 渲染 */
function renderPlayDetail(
  deps: CommandContext['deps'],
  state: { name: string; pathway: keyof typeof PATHWAY_LABELS; dig: number; mad: number; cor: number },
  text: string,
  outcome: ReturnType<typeof resolvePlay>,
  card: EventCard | null,
  events: Parameters<typeof renderDeltaSummary>[0],
  seed: string,
  world: ReturnType<typeof worldViewFor>,
  playedToday: number,
): string {
  const { breakdown } = outcome;
  const lines: string[] = [];
  lines.push(`【${state.name}】${PATHWAY_LABELS[state.pathway]}途径 · 消化判定`);
  lines.push(`你的行动：${text}`);

  const hit = (list: string[]): string => (list.length > 0 ? list.join('、') : '无');
  lines.push(`契合：${hit(breakdown.matchedCore)}    沾边：${hit(breakdown.matchedSecondary)}`);
  if (breakdown.matchedForbidden.length > 0) {
    lines.push(`违背途径：${hit(breakdown.matchedForbidden)}（扣分）`);
  }
  if (breakdown.cappedTags.length > 0) {
    lines.push(`今日已达上限：${hit(breakdown.cappedTags)}（同一标签每日最多计入 ${PLAY_SCORE.tagDailyCap} 次）`);
  }

  lines.push(
    `匹配分 ${breakdown.raw.toFixed(2)}` +
      ` → 复读惩罚 ÷${1 + breakdown.dominantRepeat}（当日重复 ${breakdown.dominantRepeat} 次）` +
      ` → 多样性 ×${breakdown.diversity.toFixed(2)}` +
      ` = ${breakdown.final.toFixed(2)}`,
  );

  if (breakdown.final === 0) {
    lines.push(`这次行动不太像「${PATHWAY_LABELS[state.pathway]}」的做法。`);
    lines.push(`可以试试：${hit(PATHWAY_TAGS[state.pathway].core.slice(0, 3))}`);
  }

  lines.push(
    outcome.exposed
      ? `暴露判定：命中（暴露 +1，消化额外 +0.3）`
      : `暴露判定：未命中（rng ${outcome.exposureRoll.toFixed(3)}）`,
  );

  // M2.2：世界时钟与天气对这次扮演的影响（写清楚，玩家才知道"为什么今晚更难受"）
  const worldNotes: string[] = [];
  if (world.clock.timeOfDay === 'night') {
    worldNotes.push(
      state.pathway === 'sleepless'
        ? `夜晚 · 不眠者：消化 ×${world.modifiers.playDigMultiplier.toFixed(2)}`
        : `夜晚：疯狂 +${NUMERIC.world.timeOfDay.nightPlayMad}`,
    );
  }
  const weatherMad = weatherRow(world.weather).playMad;
  if (weatherMad !== 0) {
    worldNotes.push(`${weatherLabel(world.weather)}：疯狂 ${weatherMad > 0 ? '+' : ''}${weatherMad}`);
  }
  if (outcome.worldMad > 0) {
    worldNotes.push(`今日第 ${playedToday + 1} 次扮演：疯狂 +${outcome.worldMad}`);
  }
  if (world.clock.fullMoon) worldNotes.push('月圆：消化更顺，但失控概率 +10%');
  if (worldNotes.length > 0) lines.push(`世界影响：${worldNotes.join('　')}`);

  lines.push('');
  for (const line of renderDeltaSummary(events, false, (id) => deps.items.nameOf(id))) lines.push(line);

  if (card) {
    lines.push('');
    // M2.40：念名字不念 id（唯一出处见 domain/display.ts）
    lines.push(`事件【${cardDisplayName(card)}】`);
    for (const line of renderCardText(deps, card.texts.priv, seed, {}).split('\n')) lines.push(line);
  }

  lines.push('');
  /*
   * M2.118：**衰减要说出来**。不说的话玩家只会觉得「扮演没用了 / 是不是坏了」，
   * 而这句话本身就是在告诉他「今天是演得够多了」—— 这正是软上限该有的读法。
   */
  const decay = playDigDiminish(playedToday);
  if (decay < 1) {
    lines.push(`> 今天已经演了 ${playedToday + 1} 次 —— 消化只算 ${Math.round(decay * 100)}%（明天再来是全额）。`, '');
  }
  lines.push(`当前：消化 ${state.dig.toFixed(1)} / 疯狂 ${state.mad} / 污染 ${state.cor}`);
  return lines.join('\n');
}
