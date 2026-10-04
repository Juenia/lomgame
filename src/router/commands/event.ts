import { EventEngine } from '../../domain/event/engine.ts';
import { createSeededRng, seedFrom } from '../../domain/rng.ts';
import { cardDisplayName } from '../../domain/display.ts';
import { dateKey } from '../../infra/date.ts';
import type { CommandContext, CommandResult } from '../index.ts';
import { applyFor, renderCardText } from './common.ts';
// M2.90：日常动作推进仪式流程 —— 全项目只有这一份实现（探索 / 扮演 / 事件 / 战斗共用）
import { dailyFlowLines } from './ritual.ts';
import { renderDeltaSummary } from './render.ts';
import { setCurrentLocation, tollOnAction } from './wanted-hooks.ts';

export const EVENT_USAGE = '用法：.事件 [地点]（例：.事件 老码头），消耗 1 行动点';

/**
 * .事件：主动探索一次，消耗 1 行动点。
 * AP 先扣后执行：先在内存里扣，确认有卡可触发才落库；没卡可触发就当没发生（等于自动退还）。
 */
export async function handleEvent(ctx: CommandContext): Promise<CommandResult> {
  const { msg, args, now, deps } = ctx;
  const location = args.join(' ').trim() || undefined;

  const character = deps.characters.findByUserId(msg.userId);
  if (!character) {
    return {
      privateText: '你还没有角色。发送 .创建 姓名 途径 开始。',
      groupText: `【${msg.nickname || msg.userId}】还没有角色。`,
      detailToPrivate: true,
    };
  }

  const date = dateKey(now);
  const seed = seedFrom([msg.messageId, character.id, now, 'event']);
  const paid = applyFor(deps, character, [], '事件', now, seed);

  const rng = createSeededRng(seed);
  // M2.69：次数（daily_limit 的实际判据在 EventEngine.eligible 里）
  const triggeredToday = deps.eventTriggers.countsOn(character.id, date);
  const card = deps.engine.pick(
    { character: paid.newState, flags: deps.flags.asSet(character.id), date, location },
    rng,
    {
      date,
      location,
      triggeredToday,
      // 隐藏卡也在这个池子里：它们靠严格 cond（cor>=30 / dig>=80）实现稀有，而不是另一套流程
      types: ['daily', 'hidden'],
      inCooldown: (candidate) =>
        deps.eventTriggers.inCooldown(character.id, candidate.id, date, candidate.trigger.cooldown_days),
    },
  );

  if (!card) {
    return {
      privateText: location
        ? `${location}今天什么都没有发生。行动点没有消耗。`
        : '今天已经没有能遇到的事了。行动点没有消耗。',
      groupText: `【${character.name}】在原地站了一会儿，什么也没遇到。`,
      detailToPrivate: true,
    };
  }

  const application = EventEngine.applyCard(paid.newState, card, { now, seed });
  // M2.6：带地点参数的事件会把他挪过去（地点参数是中文名或 id，两者都认）
  const locationId = location ? (deps.locations.findByNameOrId(location)?.id ?? null) : null;
  if (locationId) setCurrentLocation(deps, character.id, locationId, now);
  const toll = tollOnAction({
    deps,
    state: application.result.newState,
    now,
    seed,
    ...(locationId ? { locationId } : {}),
  });
  const state = toll.state;
  const events = [...paid.events, ...application.result.events];

  deps.characters.update(state);
  deps.characters.appendEvents(events);
  deps.flags.setMany(character.id, application.flagsToSet, now);
  deps.eventTriggers.mark(character.id, card.id, date);

  const textContext = { 地点: location ?? '某处' };
  const lines: string[] = [];
  /*
   * M2.45 第二十三版：**回执分层**（与 .探索 同一套规范）。
   *
   * 原来卡片正文、数值变化、代价、行动点全是同级裸行 —— 用户对探索回执的原话是
   * 「全部是最顶层的显示，文本堆积在一块」，这里是同一个毛病。
   * 现在：卡片小标题独占一行且加粗 → 正文裸文本 → 「**变化**」+ 引用块 → 行动点进引用块。
   */
  // M2.40：念名字不念 id
  lines.push(`**事件 · ${cardDisplayName(card)}**${location ? ` · ${location}` : ''}`);
  lines.push(...renderCardText(deps, card.texts.priv, seed, textContext).split('\n'));
  const deltas = renderDeltaSummary(events, false, (id) => deps.items.nameOf(id));
  if (deltas.length > 0) {
    lines.push('');
    lines.push('**变化**');
    for (const line of deltas) lines.push('> ' + line);
  }
  for (const line of toll.lines) lines.push(line);
  /*
   * M2.90：**事件也算一次「在别处下的功夫」**（与探索同一份逻辑）。
   *
   * 放在代价之后：产物归产物、代价归代价，仪式那一行是**额外**的 ——
   * 挤在「变化」与代价中间会让人以为它是这次事件的结算内容。
   */
  const flowLines = dailyFlowLines(deps, state, now, String(msg.messageId) + ':event');
  if (flowLines.length > 0) lines.push('', ...flowLines);
  lines.push('');

  return {
    privateText: lines.join('\n'),
    groupText: card.texts.group
      ? renderCardText(deps, card.texts.group, seed, textContext)
      : `【${state.name}】触发了一次事件。`,
    detailToPrivate: true,
  };
}
