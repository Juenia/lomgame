import { PATHWAY_LABELS } from '../../domain/character/rules.ts';
// M2.92：「到顶了」与「这一档缺内容」要说成两句话（下面那个 if 分支）
import { CONTENT_MAX_SEQUENCE } from '../../config/content-scope.ts';
import {
  checkPromotion,
  promotionRequirement,
  resolvePromotion,
  sequenceGatingFor,
} from '../../domain/promotion/promotion.ts';
import { createSeededRng, seedFrom } from '../../domain/rng.ts';
import { isInitiated, type CharacterStatus, type InitiatedCharacter } from '../../domain/character/types.ts';
import { mortalRefusal } from './mortal-guard.ts';
import type { CommandContext, CommandResult } from '../index.ts';
import { applyFor, requireCharacter } from './common.ts';
import { renderDeltaSummary } from './render.ts';

export const PROMOTE_USAGE = '用法：.晋升（需要消化度达标 + 本序列魔药已服用 + 晋升材料）';

export async function handlePromote(ctx: CommandContext): Promise<CommandResult> {
  const gate = requireCharacter(ctx);
  if (!gate.ok) return gate.result;
  const character = gate.character;
  const { deps, msg, now } = ctx;

  // M2.7.6：普通人没有序列，也就没有下一个位置可去（M2.7.7 起走统一入口守卫）
  if (!isInitiated(character)) return mortalRefusal(ctx, character, '晋升');

  const recipe = deps.recipes
    .forPathway(character.pathway)
    .find((candidate) => candidate.seq === character.sequence);
  if (!recipe) {
    /*
     * M2.92：**「没有配方」有两种意思，必须分开说。**
     *
     *   · 一种是**到顶了**：本版内容做到 `CONTENT_TARGET_SEQ = 2`，玩家可达序列 1
     *     （见 config/content-scope.ts）。序列 1 的玩家再往上就是序列 0 —— 那是「成神」，
     *     这一版没有；
     *   · 另一种是**这一档真缺内容**：中间的某一层漏了（M2.32 的 seq 7 就是现场），
     *     那是缺陷。
     *
     * 原来两句共用一句「这个序列暂时没有对应的晋升路径」—— 走到顶的玩家会以为
     * 是自己漏了什么，然后一遍遍重试。判据就在这里：`sequence <= CONTENT_MAX_SEQUENCE`
     * 说明他不是缺东西，是到头了。
     */
    if (character.sequence <= CONTENT_MAX_SEQUENCE) {
      return {
        privateText:
          `序列 ${character.sequence} 已经是这一版的顶了 —— 再往上（序列 ${character.sequence - 1}）还没有内容。` +
          String.fromCharCode(10) +
          '> 这不是你漏了什么。你手上的东西、做过的仪式、走过的路都算数 —— 只是这一版到这里为止。',
        detailToPrivate: true,
      };
    }
    return { privateText: '这个序列暂时没有对应的晋升路径。', detailToPrivate: true };
  }

  const requirement = promotionRequirement(recipe, character);
  /*
   * P6 落地（M2.33）：**「这一档的 `.晋升` 关了吗」是一条路径级决策，所以它在命令层。**
   *
   * 放进 `checkPromotion` 会连 `.仪式` 一起关掉（那个函数是两条路共用的，`ritual.ts:105` 也调它）——
   * 而设计意图是「`.晋升` 关闭 ⇒ `.仪式` 是**唯一路径**」，不是两条都断
   * （P7 警告过那个形状：K13，玩家永久卡住、一直撞同一条拒绝）。
   *
   * 位置：在 `checkPromotion` **之前** —— 关着的路不该先让人去凑材料再发现走不通。
   *
   * ⚠️ 当前表里最小的值是 0.1（M2.31 拍的「不归零」）⇒ 这一支现在不会被走到；
   * 它是给批次 C/D 的序列 0—3 准备的，也是把「0 = 关闭」这条语义变成可执行判据的那一行。
   */
  const gating = sequenceGatingFor(requirement.targetSequence);
  if (gating <= 0) {
    return {
      privateText:
        `序列 ${requirement.targetSequence} 已经没有捷径可走了（.晋升 在这一档关闭）—— 用 .仪式。`,
      detailToPrivate: true,
    };
  }
  const check = checkPromotion({
    state: character,
    requirement,
    ownedOf: (itemId) => deps.inventory.count(character.id, itemId),
    hasRequiredFlag: deps.flags.has(character.id, requirement.requiredFlag),
  });
  if (!check.ok) return { privateText: check.reason, detailToPrivate: true };

  const seed = seedFrom([msg.messageId, character.id, now, 'promote']);
  const fails = character.promotionFails ?? 0;
  const outcome = resolvePromotion({
    state: character,
    requirement,
    fails,
    rng: createSeededRng(seed),
    seed,
  });

  // 材料先扣后判定：扣不动就什么都不发生
  if (!deps.inventory.tryRemoveMany(character.id, outcome.consumed, now)) {
    return { privateText: '晋升材料扣除失败，仪式中止（材料未消耗）。', detailToPrivate: true };
  }

  const applied = applyFor(
    deps,
    character,
    outcome.deltas,
    `晋升:${character.sequence}->${outcome.targetSequence}`,
    now,
    seed,
  );
  const nextStatus: CharacterStatus = outcome.status;
  const state = {
    ...applied.newState,
    status: nextStatus,
    promotionFails: outcome.success ? 0 : fails + 1,
    updatedAt: now,
  };

  const events = [...applied.events];
  for (const need of outcome.consumed) {
    events.push({
      type: 'item_delta',
      characterId: character.id,
      payload: { itemId: need.itemId, quantity: -need.qty },
      reason: `晋升:${character.sequence}->${outcome.targetSequence}`,
      seed,
      createdAt: now,
    });
  }
  events.push({
    type: outcome.success ? 'promotion_success' : 'promotion_fail',
    characterId: character.id,
    payload: {
      from: character.sequence,
      to: outcome.targetSequence,
      chance: outcome.chance.chance,
      base: outcome.chance.base,
      failBonus: outcome.chance.failBonus,
      roll: outcome.roll,
      failsAfter: state.promotionFails,
    },
    reason: '晋升判定',
    seed,
    createdAt: now,
  });

  if (outcome.flagsToSet.length > 0) deps.flags.setMany(character.id, outcome.flagsToSet, now);

  deps.characters.update(state);
  deps.characters.appendEvents(events);

  const lines: string[] = [];
  lines.push(
    `晋升判定：${PATHWAY_LABELS[character.pathway]} 序列 ${character.sequence} → ${outcome.targetSequence}`,
  );
  lines.push(
    `成功率 ${(outcome.chance.chance * 100).toFixed(1)}%` +
      `（基础 ${(outcome.chance.base * 100).toFixed(1)}%` +
      // M2.33（P6 落地）：高序列惩罚要**写出来** —— 否则玩家看到「基础 69%、成功率 13.8%」会以为算错了
      `${outcome.chance.gating < 1 ? ` × 高序列惩罚 ${outcome.chance.gating}` : ''}` +
      `${outcome.chance.failBonus > 0 ? ` + 连续失败保护 ${(outcome.chance.failBonus * 100).toFixed(0)}%` : ''}）` +
      `，抽样 ${outcome.roll.toFixed(3)}`,
  );
  lines.push('');
  lines.push(...outcome.narrative);
  lines.push('');
  lines.push(...renderDeltaSummary(applied.events, false, (id) => deps.items.nameOf(id)));
  if (outcome.success) {
    const ability = deps.abilities.get(`${character.pathway}_${outcome.targetSequence}`);
    lines.push('');
    lines.push(`你晋升为「${ability?.name ?? '未知'}」，新的能力已经在你身上。`);
  } else {
    lines.push('');
    lines.push(`你进入了重伤状态。连续失败 ${state.promotionFails} 次` +
      `${(state.promotionFails >= 2 ? '，下一次成功率会得到加成' : '')}。`);
  }

  return {
    privateText: lines.join('\n'),
    groupText: outcome.success
      ? `【${state.name}】的气息变了。`
      : `【${state.name}】的仪式失败了。`,
    detailToPrivate: true,
  };
}
