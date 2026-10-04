import { NUMERIC } from '../../config/numeric.ts';
import { planRest, recoveryCounterKey } from '../../domain/recovery/recovery.ts';
import { createSeededRng, seedFrom } from '../../domain/rng.ts';
import type { CommandContext, CommandResult } from '../index.ts';
import { aftershockLine, applyFor, requireCharacter, today } from './common.ts';
import { tollOnAction } from './wanted-hooks.ts';
import { renderDeltaSummary } from './render.ts';

export const REST_USAGE = '用法：.休息（每日 1 次；失控时可直接解除）';

export async function handleRest(ctx: CommandContext): Promise<CommandResult> {
  const gate = requireCharacter(ctx);
  if (!gate.ok) return gate.result;
  const character = gate.character;
  const { deps, msg, now } = ctx;
  const plan = planRest(character);
  const date = today(ctx);

  const used = deps.dailyCounters.countOf(character.id, date, recoveryCounterKey(plan));
  if (used >= plan.dailyLimit) {
    return { privateText: `今天已经休息过了（每日 ${plan.dailyLimit} 次）。`, detailToPrivate: true };
  }
  const seed = seedFrom([msg.messageId, character.id, now, 'rest']);
  const applied = applyFor(
    deps,
    character,
    plan.deltas,
    '休息',
    now,
    seed,
  );
  if (applied.rejected) return { privateText: applied.rejected, detailToPrivate: true };

  // M2.6：在势力范围内休息也会被找上门 —— 反过来，逃到无主地点休息就是安全的，
  // 这正是「必须离开势力范围」这条设计给玩家的收益
  const toll = tollOnAction({ deps, state: applied.newState, now, seed });
  /*
   * M2.108：**休息也治伤**（用户问「生命为 0 会产生什么变化」时查出来的缺口）。
   *
   * 原来只有 `clearsLostControl`（失控）会写回 `active` —— 而重伤（`injured`）是战斗
   * 与 PVP 那两条路写下的，**没有任何一条路把它清掉**：玩家被打到 HP 0 之后，
   * 哪怕休息回满了血，状态仍然是「重伤」，于是**永久不能 PVP / 不能袭击**。
   * 唯一的出口是晋升成功（`promotion.ts` 会把它写成 `active`）—— 那不叫出口，那叫卡死。
   *
   * 判据：休息之后 HP 回到正数 ⇒ 伤就好了。HP 仍是 0（不可能，休息回 20）时不写。
   */
  const healed = toll.state.status === 'injured' && toll.state.hp > 0;
  const state = {
    ...toll.state,
    status: plan.clearsLostControl || healed ? ('active' as const) : toll.state.status,
    updatedAt: now,
  };
  deps.characters.update(state);
  deps.characters.appendEvents(applied.events);
  deps.dailyCounters.increment(character.id, date, recoveryCounterKey(plan));

  const lines = [...plan.privateText, '', ...renderDeltaSummary(applied.events, false, (id) => deps.items.nameOf(id)), ...toll.lines];
  if (plan.clearsLostControl) {
    lines.push('', '你把自己从失控里拽了回来。');
    // 普通人不会失控（MAD/COR 上限低于闸门），但类型上 pathway 仍可为空：
    // 为空时不给余波文案，而不是拿一条别的途径的文本顶上
    if (character.pathway) lines.push(aftershockLine(deps, character.pathway, seed));
  }
  if (healed) lines.push('', '伤收口了。你试着活动了一下，能站起来了。');
  lines.push('', `当前：HP ${state.hp}/100 · MAD ${state.mad} · COR ${state.cor}`);

  return {
    privateText: lines.join('\n'),
    groupText: plan.groupText.replace('{name}', state.name),
    detailToPrivate: true,
  };
}

export const REST_DAILY_LIMIT = NUMERIC.recovery.rest.dailyLimit;
