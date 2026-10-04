/**
 * .举报 指令（M2.6）：把通缉犯卖给衙门，换赏金。
 *
 *   .举报 @某人      消耗 1 AP
 *     对方**在势力范围内**且**被这个势力通缉** → 举报成功，拿赏金
 *     否则                                      → 举报失败，信誉 -5
 *
 * 为什么这条指令值得存在（任务书 §主任务三）：
 *   它是「不变强线」的收益来源之一 —— 情报贩子不需要晋升、不需要打怪，
 *   靠"知道谁被通缉、人此刻在哪"就能赚钱。这也让通缉这件事从
 *   「被通缉者的麻烦」变成「所有人的机会」，博弈才成立。
 *
 * 三条判定细节（都写在 domain/wanted.resolveReport 里，这里是它的调用方）：
 *   1. 目标必须**还在追捕方的地盘上**。人已经躲进无主地点了，举报必失败 ——
 *      否则"逃到势力范围外"这条设计就被举报机制绕过去了。
 *   2. 4 级全境通缉任何一家都接案，其余等级只认发通缉的那一家
 *      （被警察厅通缉的人，教会不接这个案子）。
 *   3. 同一个人对同一条通缉令**只能领一次赏**（幂等键 = 通缉令 id + 举报人）。
 *      别人还可以接着领 —— 赏金是衙门出的，不是从上一个举报人手里抢的。
 */
import { NUMERIC } from '../../config/numeric.ts';
import { seedFrom } from '../../domain/rng.ts';
import { CURRENCY_ITEM_ID } from '../../domain/item/item.ts';
import { formatCurrency } from '../../domain/currency/index.ts';
import { factionLabel, factionOfLocation } from '../../domain/faction/faction.ts';
import { resolveReport } from '../../domain/wanted/wanted.ts';
import type { CharacterState, DomainEvent } from '../../domain/character/types.ts';
import type { CommandContext, CommandResult } from '../index.ts';
import { applyFor, requireCharacter } from './common.ts';
import { renderDeltaSummary } from './render.ts';
import { addReputation, locationOrDefault, reputationOf } from './wanted-hooks.ts';

export const REPORT_USAGE =
  '用法：.举报 @某人（对方要在势力范围内且正被通缉，才能领到赏金）';

const CFG = NUMERIC.wanted;

function resolveTarget(ctx: CommandContext, raw: string): CharacterState | null {
  const { deps } = ctx;
  return (
    deps.characters.findByUserId(raw) ??
    deps.characters.all().find((candidate) => candidate.name === raw) ??
    null
  );
}

export async function handleReport(ctx: CommandContext): Promise<CommandResult> {
  const gate = requireCharacter(ctx);
  if (!gate.ok) return gate.result;
  const reporter = gate.character;
  const { deps, msg, now } = ctx;

  const raw = ctx.args.join(' ').trim().replace(/^@/, '');
  if (!raw) return { privateText: REPORT_USAGE, detailToPrivate: true };

  const target = resolveTarget(ctx, raw);
  if (!target) return { privateText: '找不到这个人：' + raw + '\n' + REPORT_USAGE, detailToPrivate: true };
  if (target.id === reporter.id) {
    return { privateText: '举报自己没有任何意义。', detailToPrivate: true };
  }
  const seed = seedFrom([msg.messageId, reporter.id, now, 'report', target.id]);
  let reporterState = reporter;
  const events: DomainEvent[] = [];

  const targetLocationId = locationOrDefault(deps, target.id);
  const targetFactionId = factionOfLocation(targetLocationId);
  const outcome = resolveReport({
    targetStates: deps.wanted.listActiveOf(target.id, now),
    targetFactionId,
    now,
  });

  const lines: string[] = [];
  lines.push('【举报 · ' + target.name + '】');
  lines.push('');

  if (!outcome.ok) {
    // 失败：信誉 -5（任务书 §主任务三）。这是「乱咬人」的代价
    const reputation = addReputation(deps, reporter.id, CFG.reportFailReputation, now);
    events.push({
      type: 'report_failed',
      characterId: reporter.id,
      payload: {
        targetId: target.id,
        targetLocationId,
        targetFactionId,
        reputationBefore: reputation - CFG.reportFailReputation,
        reputationAfter: reputation,
      },
      reason: '举报失败:' + outcome.reason,
      seed,
      createdAt: now,
    });
    lines.push(outcome.reason);
    lines.push('信誉 ' + CFG.reportFailReputation + ' → 当前 ' + reputation + '。');
    deps.characters.appendEvents(events);
    deps.characters.update(reporterState);
    const deltaLines = renderDeltaSummary(events, false, (id) => deps.items.nameOf(id));
    if (deltaLines.length > 0) {
      lines.push('');
      lines.push(...deltaLines);
    }
    return {
      privateText: lines.join('\n'),
      // 举报失败是私事：群里只说一句含糊的，不暴露"谁举报了谁"
      groupText: '【' + reporterState.name + '】在治安官那里说了些什么，没人听。',
      detailToPrivate: true,
    };
  }

  // 成功：领赏。同一人 × 同一条通缉令只能领一次
  const wantedId = outcome.wantedId ?? seedFrom(['wanted-unknown', target.id]);
  const claimId = seedFrom(['bounty', wantedId, reporter.id]);
  const claimed = deps.wanted.claim({
    id: claimId,
    wantedId,
    claimerId: reporter.id,
    rewardPenny: outcome.rewardPenny,
    now,
  });

  if (!claimed) {
    lines.push('这个案子你已经报过了 —— 赏金不会给第二遍。');
    lines.push('（对方仍然在通缉中，别人还可以领。）');
    deps.characters.appendEvents(events);
    deps.characters.update(reporterState);
    return {
      privateText: lines.join('\n'),
      groupText: '【' + reporterState.name + '】又去了趟治安官那里。',
      detailToPrivate: true,
    };
  }

  deps.inventory.add(reporter.id, CURRENCY_ITEM_ID, outcome.rewardPenny, 'unbound', now);
  events.push({
    type: 'bounty_claimed',
    characterId: reporter.id,
    payload: {
      wantedId,
      targetId: target.id,
      level: outcome.level,
      factionId: targetFactionId,
      rewardPenny: outcome.rewardPenny,
      locationId: targetLocationId,
    },
    reason: '举报领赏:' + target.name,
    seed,
    createdAt: now,
  });
  deps.characters.appendEvents(events);
  deps.characters.update(reporterState);

  lines.push('你把知道的一切都倒了出来：' + outcome.reason + '。');
  lines.push(
    factionLabel(targetFactionId) + '的人当场点了头，' +
      formatCurrency(outcome.rewardPenny) + ' 拍在你手里。',
  );
  lines.push('');
  lines.push('赏金 ' + formatCurrency(outcome.rewardPenny) + '（' + outcome.rewardPenny + ' 便士）');
  lines.push('当前信誉 ' + reputationOf(deps, reporter.id) + '。');

  // 可见性（任务书 §主任务四）：通缉犯被抓 → **全服播报**
  // MVP 没有"关押"这个状态，"落网"落在两件事上：通缉犯被举报成功，以及 2 级以上遭遇命中。
  const captured = '【通缉犯落网】' + target.name + ' 被人在' + factionLabel(targetFactionId) +
    '的地界上认了出来，治安官已经出发。';

  const deltaLines = renderDeltaSummary(events, false, (id) => deps.items.nameOf(id));
  if (deltaLines.length > 0) {
    lines.push('');
    lines.push(...deltaLines);
  }

  return {
    privateText: lines.join('\n'),
    detailToPrivate: true,
    extra: [
      /*
       * 「抓到通缉犯」是**独立信息**（说给旁边人听的），不能塞进 groupText。
       *
       * groupText 的口径是「群聊摘要」—— 63 处里 62 处是那个语义
       * （「【张三】在琢磨今天该做什么。」）。群聊与私聊合并之后摘要不再单独发送，
       * 于是借用这个通道的播报会**凭空消失**（实测就丢了这一条）。
       * extra 本来就是「额外投递」的通道，语义正对。
       *
       * 只在群里播：私聊场景下没有「旁边人」，旧行为也是私聊不发播报。
       */
      ...(msg.scene === 'group'
        ? [{ scene: msg.scene, targetId: msg.sceneId, text: captured }]
        : []),
      {
        scene: 'private',
        targetId: target.userId,
        text:
          '有人在' + factionLabel(targetFactionId) + '那里把你卖了 —— 治安官正在找你。\n' +
          '（现在离开势力范围还来得及：无主地点不会被追捕。）',
      },
    ],
  };
}
