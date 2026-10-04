import { NUMERIC } from '../../config/numeric.ts';
import { planPurify, recoveryCounterKey } from '../../domain/recovery/recovery.ts';
import { createSeededRng, seedFrom } from '../../domain/rng.ts';
import type { CommandContext, CommandResult } from '../index.ts';
import { aftershockLine, applyFor, requireCharacter, today } from './common.ts';
import { renderDeltaSummary } from './render.ts';
import { tollOnAction } from './wanted-hooks.ts';

export const PURIFY_USAGE = '用法：.净化（消耗材料，每日 1 次）';

export async function handlePurify(ctx: CommandContext): Promise<CommandResult> {
  const gate = requireCharacter(ctx);
  if (!gate.ok) return gate.result;
  const character = gate.character;
  const { deps, msg, now } = ctx;
  const plan = planPurify(character);
  const date = today(ctx);

  // 应急开关（W6）：净化消耗减半，只在 P0 死循环时打开，回执里会明确标注
  const halfCost = deps.switches.purifyHalfCost;
  if (halfCost) {
    plan.materials = plan.materials
      .map((need) => ({ ...need, qty: Math.max(0, need.qty - 1) }))
      .filter((need) => need.qty > 0);
  }

  const used = deps.dailyCounters.countOf(character.id, date, recoveryCounterKey(plan));
  if (used >= plan.dailyLimit) {
    return { privateText: `今天已经净化过了（每日 ${plan.dailyLimit} 次）。`, detailToPrivate: true };
  }
  const missing = plan.materials.filter(
    (need) => deps.inventory.count(character.id, need.itemId) < need.qty,
  );
  if (missing.length > 0) {
    const detail = missing
      .map(
        (need) =>
          `${deps.items.nameOf(need.itemId)}（需要 ${need.qty}，现有 ${deps.inventory.count(character.id, need.itemId)}）`,
      )
      .join('、');
    return { privateText: `净化材料不足：${detail}`, detailToPrivate: true };
  }

  // 先扣材料；若随后结算失败则补还
  if (plan.materials.length > 0 && !deps.inventory.tryRemoveMany(character.id, plan.materials, now)) {
    return { privateText: '材料扣除失败，净化中止。', detailToPrivate: true };
  }

  const seed = seedFrom([msg.messageId, character.id, now, 'purify']);
  const applied = applyFor(
    deps,
    character,
    plan.deltas,
    '净化',
    now,
    seed,
  );
  if (applied.rejected) {
    deps.inventory.addMany(
      character.id,
      plan.materials.map((need) => ({ itemId: need.itemId, quantity: need.qty, bindType: 'unbound' as const })),
      now,
    );
    return { privateText: applied.rejected, detailToPrivate: true };
  }

  // M2.6：净化同样在"此刻所在的地点"上结算通缉遭遇
  const toll = tollOnAction({ deps, state: applied.newState, now, seed });
  const state = {
    ...toll.state,
    status: plan.clearsLostControl ? ('active' as const) : toll.state.status,
    updatedAt: now,
  };
  const events = [...applied.events];
  for (const need of plan.materials) {
    events.push({
      type: 'item_delta',
      characterId: character.id,
      payload: { itemId: need.itemId, quantity: -need.qty },
      reason: '净化',
      seed,
      createdAt: now,
    });
  }
  deps.characters.update(state);
  deps.characters.appendEvents(events);
  deps.dailyCounters.increment(character.id, date, recoveryCounterKey(plan));

  const lines = [...plan.privateText];
  if (halfCost) lines.push('', '【应急】净化消耗已减半（封测热修开关）。');
  lines.push('', ...renderDeltaSummary(applied.events, false, (id) => deps.items.nameOf(id)));
  lines.push(...toll.lines);
  if (plan.clearsLostControl) {
    lines.push('', '镜子里的你终于和你同步了。');
    // 普通人不会失控（MAD/COR 上限低于闸门），但类型上 pathway 仍可为空：
    // 为空时不给余波文案，而不是拿一条别的途径的文本顶上
    if (character.pathway) lines.push(aftershockLine(deps, character.pathway, seed));
  }
  lines.push('', `当前：HP ${state.hp}/100 · MAD ${state.mad} · COR ${state.cor}`);

  return {
    privateText: lines.join('\n'),
    groupText: plan.groupText.replace('{name}', state.name),
    detailToPrivate: true,
  };
}

export const PURIFY_DAILY_LIMIT = NUMERIC.recovery.purify.dailyLimit;
