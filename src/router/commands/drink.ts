import { FIRST_POTION_FLAG, abilityFlag, resolveDrink } from '../../domain/potion/potion.ts';
import { createSeededRng, seedFrom } from '../../domain/rng.ts';
import type { CommandContext, CommandResult } from '../index.ts';
import { applyFor, requireCharacter, worldViewFor } from './common.ts';
import { isInitiated, type CharacterState } from '../../domain/character/types.ts';
import { PATHWAY_LABELS } from '../../domain/character/rules.ts';
import { markInitiated, recipePathwaysOf, runInitiation } from './initiation-hooks.ts';
import { renderDeltaSummary } from './render.ts';

export const DRINK_USAGE = '用法：.服用 [魔药]（例：.服用 魔药·愚者·序列9）；不带参数默认喝本途径当前序列的那瓶';

export async function handleDrink(ctx: CommandContext): Promise<CommandResult> {
  const gate = requireCharacter(ctx);
  if (!gate.ok) return gate.result;
  const character = gate.character;
  const { deps, msg, now } = ctx;

  const query = ctx.args.join(' ').trim();
  const potions = deps.inventory
    .list(character.id)
    .map((slot) => deps.items.get(slot.itemId))
    .filter((item): item is NonNullable<typeof item> => item?.kind === 'potion');

  /*
   * M2.7.6：**入途径就发生在这里。**
   *
   * 普通人喝下那一瓶序列 9 魔药 = 走上途径。所以这条指令的校验分两条线：
   *   已入途径 → 老规矩（本途径、本序列，喝的是晋升用的那一瓶）；
   *   普通人   → 只能喝序列 9，而且必须是他**有配方**的那条途径的
   *              （配方来自势力给的纸或自己翻到的线索，见 recipePathwaysOf）。
   */
  const initiated = isInitiated(character);
  const chosen = query
    ? deps.items.findByNameOrName(query)
    : initiated
      ? (potions.find((item) => item.pathway === character.pathway && item.seq === character.sequence) ??
        potions[0] ??
        null)
      : (potions.find((item) => item.seq === 9) ?? null);

  if (!chosen) {
    return {
      privateText: initiated
        ? '你手上没有魔药。先 .魔药 调制一瓶，或检查 .背包。'
        : '你手上没有魔药。先 .魔药 调制一瓶，或检查 .背包。',
      detailToPrivate: true,
    };
  }
  if (chosen.kind !== 'potion') {
    return { privateText: `${chosen.name}不是魔药。`, detailToPrivate: true };
  }
  if (initiated) {
    if (chosen.pathway && chosen.pathway !== character.pathway) {
      return { privateText: `${chosen.name}不适合你的途径。`, detailToPrivate: true };
    }
    if (chosen.seq !== undefined && chosen.seq !== character.sequence) {
      return {
        privateText: `这瓶魔药针对序列 ${chosen.seq}，你当前是序列 ${character.sequence}。`,
        detailToPrivate: true,
      };
    }
  } else {
    if (!chosen.pathway || chosen.seq !== 9) {
      return {
        privateText: `${chosen.name}不是给你现在准备的。`,
        detailToPrivate: true,
      };
    }
    const allowed = recipePathwaysOf(deps, character);
    if (!allowed.includes(chosen.pathway)) {
      return {
        privateText: [
          `你不知道这瓶东西该怎么用。`,
          '',
          `你手上没有${PATHWAY_LABELS[chosen.pathway]}那一份配方 —— 光是有一瓶药，不算知道路怎么走。`,
        ].join('\n'),
        detailToPrivate: true,
      };
    }
  }

  const owned = deps.inventory.count(character.id, chosen.id);
  if (owned < 1) return { privateText: `你手上没有${chosen.name}。`, detailToPrivate: true };

  const firstTime = !deps.flags.has(character.id, FIRST_POTION_FLAG);
  const seed = seedFrom([msg.messageId, character.id, now, 'drink']);
  // M2.2：月圆与天气会抬高失控概率（倍率只乘概率，闸门与公式不动）
  const world = worldViewFor(deps, now, undefined, character.pathway ?? undefined);
  const outcome = resolveDrink({
    state: character,
    potionItemId: chosen.id,
    rng: createSeededRng(seed),
    seed,
    firstTime,
    world: {
      successBonus: world.modifiers.potionSuccessBonus,
      lossOfControlMultiplier: world.modifiers.lossOfControlMultiplier,
    },
  });

  // 先扣后执行：魔药先消失，再谈效果
  if (!deps.inventory.tryRemove(character.id, chosen.id, 1, now)) {
    return { privateText: `${chosen.name}数量不足。`, detailToPrivate: true };
  }

  /*
   * M2.7.6：入途径的那一刻。
   *
   * 三联（pathway / sequence / pathway_status）**一次性**写进同一个 state 再落库 ——
   * 分开写就会存在「有途径但没有序列」的中间态，而那种状态在任何判定里都没有定义。
   *
   * 数值也按**入途径之后**的上限算（caps 来自 baseState）：
   * 喝下这一瓶的 MAD 涨幅不该被普通人的 20 顶掉 —— 那一刻他已经不是普通人了。
   */
  const initRng = createSeededRng(seedFrom([seed, 'initiate']));
  const initResult = initiated
    ? null
    : runInitiation({
        deps,
        character,
        action: { kind: 'drink', pathway: chosen.pathway!, now },
        rng: initRng,
        seed: seedFrom([seed, 'initiate']),
        now,
      });

  const baseState: CharacterState = initiated
    ? character
    : { ...character, pathway: chosen.pathway!, sequence: 9, pathwayStatus: 'initiated' };

  const applied = applyFor(deps, baseState, outcome.deltas, `服用:${chosen.id}`, now, seed);
  const state = applied.newState;

  if (initResult?.initiation) {
    markInitiated({
      deps,
      character,
      pathway: initResult.initiation.pathway,
      sequence: initResult.initiation.sequence,
      seed: seedFrom([seed, 'initiate']),
      now,
    });
  }
  const events = [...applied.events];
  events.push({
    type: 'item_delta',
    characterId: character.id,
    payload: { itemId: chosen.id, quantity: -1 },
    reason: `服用:${chosen.id}`,
    seed,
    createdAt: now,
  });

  const flagsToSet: string[] = [];
  if (firstTime) flagsToSet.push(FIRST_POTION_FLAG);
  if (chosen.pathway && chosen.seq !== undefined) {
    flagsToSet.push(abilityFlag({ pathway: chosen.pathway, seq: chosen.seq }));
  }
  deps.flags.setMany(character.id, flagsToSet, now);
  if (flagsToSet.length > 0) {
    events.push({
      type: 'flag_set',
      characterId: character.id,
      payload: { flags: flagsToSet },
      reason: '服用魔药',
      seed,
      createdAt: now,
    });
  }

  if (outcome.lossOfControl) {
    events.push({
      type: 'loss_of_control',
      characterId: character.id,
      payload: { chance: outcome.controlChance, roll: outcome.controlRoll },
      reason: '服用魔药失控',
      seed,
      createdAt: now,
    });
  }

  deps.characters.update(state);
  deps.characters.appendEvents(events);

  const lines: string[] = [];
  /*
   * M2.7.6：入途径的回执不是「你服下了 X + 数值变化」，而是**一件事**。
   * 它排在数值摘要前面，且中间留白 —— 这一句是玩家等了 14 天的那一句。
   */
  if (initResult && initResult.lines.length > 0) {
    lines.push(...initResult.lines);
    lines.push('');
    lines.push('（从这一刻起，你能做以前做不了的事了：.扮演 会开始涨消化度。）');
    return {
      privateText: lines.join('\n'),
      groupText: `【${state.name}】喝下了什么东西，然后很久没有说话。`,
      detailToPrivate: true,
    };
  }
  lines.push(`你服下了 ${chosen.name}。`);
  lines.push(...outcome.narrative);
  lines.push('');
  lines.push(...renderDeltaSummary(applied.events, false, (id) => deps.items.nameOf(id)));
  if (outcome.lossOfControl) {
    lines.push('');
    lines.push(
      `失控判定：触发（概率 ${(outcome.controlChance * 100).toFixed(1)}%，抽样 ${outcome.controlRoll.toFixed(3)}）`,
    );
  } else if (outcome.controlChance > 0) {
    lines.push(`失控判定：未触发（概率 ${(outcome.controlChance * 100).toFixed(1)}%）`);
  }
  if (firstTime) lines.push('', '第一次消化开始了：以途径的方式行事，DIG 才会继续涨。');
  lines.push('');
  lines.push(`当前：消化 ${state.dig.toFixed(1)} · 疯狂 ${state.mad} · 污染 ${state.cor} · SAN ${100 - state.mad}`);

  return {
    privateText: lines.join('\n'),
    groupText: `【${state.name}】喝下了魔药，脸色变了一瞬。`,
    detailToPrivate: true,
  };
}
