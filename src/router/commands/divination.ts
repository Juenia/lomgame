import { NUMERIC } from '../../config/numeric.ts';
import { DIVINATION_COUNTER_KEY, divinationDailyLimit, divinationMpCost, resolveDivination } from '../../domain/divination/divination.ts';
import { createSeededRng, seedFrom } from '../../domain/rng.ts';
import { renderCardText } from './common.ts';
import { FLAG_LOCATION } from '../../infra/db/flags.ts';
import { divinationDailyMarkBonus } from '../../domain/menu/pathway-action-resolve.ts';
import type { CommandContext, CommandResult } from '../index.ts';
import { abilityEffectsOf, applyFor, requireCharacter, today } from './common.ts';
import { renderDeltaSummary } from './render.ts';
import { mortalGuard } from './mortal-guard.ts';
import { wonderEffectsOf } from './wonder-hooks.ts';
import { pvpWaitNudge } from './pvp-hooks.ts';

export const DIVINATION_USAGE = '用法：.占卜 问题（例：.占卜 我该不该去老码头）';

export async function handleDivination(ctx: CommandContext): Promise<CommandResult> {
  const gate = requireCharacter(ctx);
  if (!gate.ok) return gate.result;
  const character = gate.character;
  const { deps, msg, now } = ctx;

  // M2.7.6：占卜要「有东西可占」—— 普通人手上什么都没有（M2.7.7 起走统一入口守卫）
  {
    const guard = mortalGuard(ctx, '占卜');
    if (guard) return guard;
  }

  const question = ctx.args.join(' ').trim();
  if (!question) return { privateText: DIVINATION_USAGE, detailToPrivate: true };

  const effects = abilityEffectsOf(deps, character);
  // M2.13：被动的神奇物品（占卜水晶：每日占卜次数 +1）
  const wonder = wonderEffectsOf(deps, character.id, now);
  /*
   * M2.13：**占卜水晶**（神奇物品，被动：每日占卜次数 +1）。
   * 它与愚者序列 8 能力的 divinationDailyBonus 相加，不是互相覆盖 ——
   * 一个是「途径给你的」，一个是「东西给你的」，两个都该算数。
   */
  /*
   * M2.65：**速记**（reader.takenote）留下的「本日多记一条」。
   *
   * 它是**当日上限的加数**，不是一次性道具 —— 所以读完不删：
   * 键里带着日期，跨天自然对不上（第二道保险），语义也正是「本日多一条」。
   */
  const noteBonus = divinationDailyMarkBonus(
    (flag) => deps.flags.value(character.id, flag),
    deps.flags.value(character.id, FLAG_LOCATION) ?? '',
    today(ctx),
  );
  const limit = divinationDailyLimit(effects) + wonder.divinationBonus + noteBonus;
  const date = today(ctx);
  const used = deps.dailyCounters.countOf(character.id, date, DIVINATION_COUNTER_KEY);
  if (used >= limit) {
    /*
     * M2.11 前置 3：与 .扮演 同一手法 —— 一条**明确没有效果**的指令，
     * 在等待对手出招的时候要多一句「你在等谁、他多久没动了」。
     * 不在战斗里时 pvpWaitNudge 返回 null，这一行一个字都不会多。
     */
    const nudge = pvpWaitNudge(deps, character, now);
    return {
      privateText: [
        `今天的占卜已经用完了（每日 ${limit} 次${noteBonus > 0 ? '，其中 ' + noteBonus + ' 次是速记记下来的' : ''}）。`,
        ...(nudge ? [nudge] : []),
      ].join('\n'),
      detailToPrivate: true,
    };
  }

  // 冷却：愚者序列 8 的能力会把冷却减半（乘数来自 abilities 表）
  const cooldownMs = Math.round(
    NUMERIC.divination.cooldownMs * (effects.divinationCooldownMultiplier ?? 1),
  );
  const remaining = deps.cooldowns.remainingMs(character.id, '占卜', cooldownMs, now);
  if (remaining > 0) {
    return {
      privateText: `卜象还没散去，请 ${Math.ceil(remaining / 1000)} 秒后再问。`,
      detailToPrivate: true,
    };
  }

  const cost = divinationMpCost();
  if (character.mp < cost) {
    return { privateText: `灵性不足（需要 ${cost}，当前 ${character.mp}）。`, detailToPrivate: true };
  }

  const seed = seedFrom([msg.messageId, character.id, now, 'divination']);
  const applied = applyFor(deps, character, [{ type: 'mp', value: -cost }], '占卜', now, seed);
  if (applied.rejected) return { privateText: applied.rejected, detailToPrivate: true };

  const rng = createSeededRng(seed);
  // M2.85 内容填充 P1：把塔罗牌池交给判定层（牌面来自 deps.tarot，原作数据直出）
  const outcome = resolveDivination({ texts: deps.fragments['卜象'] ?? [], rng, seed, cards: deps.tarot });
  const state = applied.newState;
  deps.characters.update(state);
  deps.characters.appendEvents(applied.events);
  deps.dailyCounters.increment(character.id, date, DIVINATION_COUNTER_KEY);
  deps.cooldowns.touch(character.id, '占卜', now);

  const lines: string[] = [];
  lines.push(`你的问题：${question}`);
  lines.push('');
  lines.push(renderCardText(deps, `{{${'卜象'}}}`, seed, {}));
  /*
   * M2.85 内容填充 P1：**摊开的牌**。
   *
   * 占卜本来就该是「摊牌」—— 牌名 / 编号 / 英文名 / 对应途径 / 象征全部来自
   * `src/data/tarot.yaml`（原作数据直出，未做任何推测性补全）。
   */
  if (outcome.tarot) {
    lines.push('');
    lines.push(`你摊开了牌：**${outcome.tarot.name}**（${outcome.tarot.number} · ${outcome.tarot.nameEn}）—— ${outcome.tarot.pathwayName}`);
    lines.push(`> ${outcome.tarot.symbolism}`);
  }
  lines.push('');
  lines.push(...renderDeltaSummary(applied.events, false, (id) => deps.items.nameOf(id)));
  /*
   * M2.12（愚者序列 7「命运碎片」）：**多看到一条卜象**。
   * 它加的是岔路的条数，不是准确度 —— 序列 7 的人不是算得更准，是看得见更多的可能。
   * 与「占卜每日 +1 次」（序列 8 的小丑）是两种不同的东西：那个是次数，这个是**视野**。
   */
  const extraOmen = effects.divinationExtraOmen ?? 0;
  for (let index = 0; index < extraOmen; index += 1) {
    lines.push('');
    lines.push('（同一件事的另一条线也落下来了：）');
    lines.push(renderCardText(deps, `{{${'卜象'}}}`, seed + ':omen' + index, {}));
  }
  lines.push(`今日剩余占卜：${Math.max(0, limit - used - 1)} 次`);

  return {
    privateText: lines.join('\n'),
    groupText: `【${state.name}】摊开了牌。`,
    detailToPrivate: true,
  };
}
