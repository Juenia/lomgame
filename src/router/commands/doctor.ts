/**
 * **就医**（M2.112）—— 用户要的那条路：
 *
 * > 「重伤状态完全无法行动　休息每日一次　机制问题　且无法购买恢复药物
 * >   应该增加一个**使用货币可以呼叫医生上门治疗**」
 *
 * ## 为什么必须有这一条
 *
 * 重伤之后（M2.108 起）探索会被拒，而唯一的恢复路径 `.休息` **每日只有 1 次、只回 20 HP**。
 * 一个 0/100 的玩家要连按五天才能出门 —— 那不是「代价」，那是**卡住**。
 *
 * 医生是**付费**的出口：一次治到满，代价是钱。钱能解决的问题就不是死局。
 *
 * ## 与 `.休息` 的分工
 *
 *   `.休息`  免费，每日 1 次，回 20 HP（清失控）
 *   `.就医`  花钱，不限次数，**回满 + 清重伤**（贵，但立刻能走）
 */
import { NUMERIC } from '../../config/numeric.ts';
import { CURRENCY_ITEM_ID } from '../../domain/item/item.ts';
import { formatCurrency } from '../../domain/currency/currency.ts';
import type { CommandContext, CommandResult } from '../index.ts';
import { requireCharacter } from './common.ts';

export const DOCTOR_USAGE = '用法：.就医（花钱请医生上门：回满生命，并解掉重伤）';

export async function handleDoctor(ctx: CommandContext): Promise<CommandResult> {
  const gate = requireCharacter(ctx);
  if (!gate.ok) return gate.result;
  const character = gate.character;
  const { deps, now } = ctx;

  const fee = NUMERIC.recovery.doctor.fee;
  const healed = NUMERIC.recovery.doctor.hp;
  // 已经好好的就别花这个钱（也免得玩家误点）
  if (character.hp >= 100 && character.status !== 'injured') {
    return { privateText: '你身上没伤 —— 医生看了一眼就走了，没收钱。', detailToPrivate: true };
  }
  const purse = deps.inventory.count(character.id, CURRENCY_ITEM_ID);
  if (purse < fee) {
    return {
      privateText:
        '医生要 ' + formatCurrency(fee) + '，你只有 ' + formatCurrency(purse) + '。\n' +
        '> 凑不出钱的话，先 `.休息`（免费，每日 1 次，回 20 生命）撑着。',
      detailToPrivate: true,
    };
  }
  const paid = deps.inventory.tryRemoveMany(character.id, [{ itemId: CURRENCY_ITEM_ID, qty: fee }], now);
  if (!paid) return { privateText: '钱不够。', detailToPrivate: true };

  const healedHp = Math.min(100, character.hp + healed);
  const next = {
    ...character,
    hp: healedHp,
    status: 'active' as const,
    updatedAt: now,
  };
  deps.characters.update(next);

  return {
    privateText: [
      '医生来得很快。他看了一眼，没多问，收下 ' + formatCurrency(fee) + '。',
      '',
      '> 伤口被处理干净了，你试着站起来 —— 能动。',
      '',
      `当前：HP ${healedHp}/100 · MAD ${character.mad} · COR ${character.cor}`,
    ].join('\n'),
    groupText: `【${character.name}】请了医生。`,
    nextActions: [{ label: '出门看看', command: '探索' }, { label: '状态', command: '状态' }],
    detailToPrivate: true,
  };
}
