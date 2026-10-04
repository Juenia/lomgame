/**
 * **遇见 <cardId> <key>**（M2.120）—— 日常事件的结算命令。
 *
 * ⚠️ 它**不是给玩家手打的**（不进 `.帮助`），而是菜单选项的 `command`：
 * 玩家在「今天遇到的事」里选一个，菜单把这条指令当成他说的话再走一遍路由。
 *
 * 为什么不把选择直接塞进菜单的 key：那样菜单的 `command` 就成了一句路由解析不了的话
 *（M2.107 踩过：点按钮报「没有 .背包 这条指令」）。走一条**真实存在的指令**，
 * 路由的每一层（限流、幂等、未决拦截）都自动适用。
 *
 * ⚠️ 名字叫「遇见」而不是「遭遇」：`遭遇` 已经是**生物遭遇**那条命令（M2.8）。
 */
import { EventEngine } from '../../domain/event/engine.ts';
import { chosenOption } from '../../domain/play/encounter.ts';
import { createSeededRng, seedFrom } from '../../domain/rng.ts';
import type { CommandContext, CommandResult } from '../index.ts';
import { applyFor, requireCharacter, today } from './common.ts';
import { renderDeltaSummary } from './render.ts';

export const DAILY_USAGE = '用法：.遇见（日常事件；不用手打，选一个就行）';

/** 今天已经遇到几次（dailyCounters 的键）—— 与 `.扮演` 的 `play` 分开计数 */
export const ENCOUNTER_COUNTER_KEY = 'encounter';

export async function handleDailyEncounter(ctx: CommandContext): Promise<CommandResult> {
  const gate = requireCharacter(ctx);
  if (!gate.ok) return gate.result;
  const character = gate.character;
  const { deps, msg, now } = ctx;

  const cardId = ctx.args[0] ?? '';
  const key = ctx.args[1] ?? '';
  const card = deps.engine.byId(cardId);
  if (card === null) return { privateText: '这件事已经过去了。', detailToPrivate: true };
  const option = chosenOption(card, key);
  if (option === null) return { privateText: '没有这个选项。', detailToPrivate: true };

  const seed = seedFrom([msg.messageId, character.id, now, cardId, key]);
  /*
   * 结算走**这一支的效果**（`option.effects`），不是卡的 `effects` ——
   * 「相对应的选择」意味着选择本身要决定结果。
   *
   * 转成 `EffectDelta[]` 用的是既有的 `EventEngine.toDeltas`（把这一支的效果临时当成
   * 「这张卡的效果」）—— 复制一份映射逻辑没有意义，那条映射改一次就要改两处。
   */
  const { deltas, flagsToSet } = EventEngine.toDeltas({ ...card, effects: option.effects });
  const applied = applyFor(deps, character, deltas, '日常遭遇', now, seed);
  if (applied.rejected) return { privateText: applied.rejected, detailToPrivate: true };
  for (const flag of flagsToSet) deps.flags.set(character.id, flag, 1);
  deps.characters.update(applied.newState);
  deps.characters.appendEvents(applied.events);
  deps.dailyCounters.increment(character.id, today(ctx), ENCOUNTER_COUNTER_KEY);

  const lines: string[] = [];
  /*
   * ⚠️ **选项没写 `text` 就不重复卡正文**。
   *
   * 卡正文是**引子**（「你把银链绕在指上…」），玩家在弹卡那一步已经读过了；
   * 结算时再抄一遍，一条消息里同一段出现两次 —— 那正是用户反复说的「多余」。
   * 写了 `text` 的选项才显示（「相对应的选择」要读起来不一样时，作者自己写）。
   */
  if (option.text !== undefined) {
    for (const line of option.text.split('\n')) lines.push(line);
    lines.push('');
  }
  const summary = renderDeltaSummary(applied.events, false, (id) => deps.items.nameOf(id));
  if (summary.length > 0) lines.push('', ...summary);
  lines.push('', `当前：消化 ${applied.newState.dig.toFixed(1)} / 疯狂 ${applied.newState.mad} / 污染 ${applied.newState.cor}`);

  return {
    privateText: lines.join('\n'),
    groupText: `【${character.name}】遇上了一件事。`,
    detailToPrivate: true,
  };
}
