import { newShortId } from '../../infra/ids.ts';
import { isTradeable, CURRENCY_ITEM_ID } from '../../domain/item/item.ts';
import {
  checkTradeRequest,
  describeTrade,
  expiresAt,
  settleTrade,
  tradeTimeoutLabel,
  weeklyWindowStart,
} from '../../domain/trade/trade.ts';
import type { CommandContext, CommandResult } from '../index.ts';
import { formatCurrency, parseCurrency } from '../../domain/currency/index.ts';
import { parseAtTarget, parsePositiveInt } from '../args.ts';
import { expireStaleTrades, requireCharacter } from './common.ts';
import { wonderEffectsOf } from './wonder-hooks.ts';

export const TRADE_USAGE =
  '用法：.交易 @玩家 物品 [数量] 价格（例：.交易 @123456 辅助材料·银粉 2 60）';

/** 交易单号：确定性模式下由「谁卖给谁、卖什么、多少钱、什么时候」派生 */
export function newTradeId(seedInput?: string): string {
  return newShortId(seedInput ?? 'trade');
}

export async function handleTrade(ctx: CommandContext): Promise<CommandResult> {
  const gate = requireCharacter(ctx);
  if (!gate.ok) return gate.result;
  const seller = gate.character;
  const { deps, msg, now } = ctx;

  expireStaleTrades(deps, now);

  const [targetArg, itemArg, ...rest] = ctx.args;
  if (!targetArg || !itemArg || rest.length === 0 || rest.length > 2) {
    return { privateText: TRADE_USAGE, detailToPrivate: true };
  }

  const buyerQq = parseAtTarget(targetArg);
  if (!buyerQq) return { privateText: `请用 @ 指定交易对象。\n${TRADE_USAGE}`, detailToPrivate: true };
  const buyer = deps.characters.findByUserId(buyerQq);
  if (!buyer) return { privateText: '对方还没有角色，无法交易。', detailToPrivate: true };

  /*
   * M2.18 任务 C2：**敌对教会之间不做生意**。
   *
   * 判据用 M2.15 交付的 relationOf（对称 / 自反中立 / 未声明即中立三条性质都在里面），
   * **不重实现** —— 少写一遍就少漏一条。
   *
   * 拒绝要把原因说明白（任务书 §九）：「你们的神不共戴天」比「操作失败」有用得多。
   */
  const sellerChurchId = seller.churchId ?? null;
  const buyerChurchId = buyer.churchId ?? null;
  if (
    sellerChurchId &&
    buyerChurchId &&
    sellerChurchId !== buyerChurchId &&
    deps.churches.relationOf(sellerChurchId, buyerChurchId) === 'hostile'
  ) {
    const mine = deps.churches.byId(sellerChurchId)?.name ?? sellerChurchId;
    const theirs = deps.churches.byId(buyerChurchId)?.name ?? buyerChurchId;
    return {
      privateText: [
        '你们信的神不共戴天（' + mine + ' ↔ ' + theirs + '）—— 这笔交易做不成。',
        '同门之间、或与不敌对的人之间才能交易。',
      ].join('\n'),
      detailToPrivate: true,
    };
  }

  const item = deps.items.findByNameOrName(itemArg);
  if (!item) return { privateText: `没有这件物品：${itemArg}`, detailToPrivate: true };

  let qty = 1;
  let price: number | null = null;
  if (rest.length === 1) {
    price = parseCurrency(rest[0] ?? '');
  } else {
    qty = parsePositiveInt(rest[0]) ?? 0;
    price = parseCurrency(rest[1] ?? '');
  }
  // M2.5 追加：价格支持三层货币输入 —— 8（默认便士）/ 8p / 8s / 8g / 1g5s3p
  if (price === null || price < 1) {
    return {
      privateText:
        '价格必须是正整数。默认单位是**便士**，也可以写 8p（便士）/ 8s（苏勒）/ 8g（金镑）/ 1g5s3p。\n' +
        TRADE_USAGE,
      detailToPrivate: true,
    };
  }

  const sellerAvailable = deps.inventory.countByBind(seller.id, item.id, 'unbound');
  const buyerWallet = deps.inventory.count(buyer.id, CURRENCY_ITEM_ID);
  const since = weeklyWindowStart(now);
  const fingerprint = deps.fingerprint.fingerprintOf(msg);
  const weeklyVolume = fingerprint
    ? Math.max(
        // 有设备指纹：按设备统计（同设备多账号会被一起算进来）
        deps.trades.volumeSinceDevice(fingerprint.key, since),
        deps.trades.volumeSince(seller.id, since),
        deps.trades.volumeSince(buyer.id, since),
      )
    : Math.max(
        deps.trades.volumeSince(seller.id, since),
        deps.trades.volumeSince(buyer.id, since),
      );

  const check = checkTradeRequest({
    sellerId: seller.id,
    buyerId: buyer.id,
    qty,
    price,
    sellerAvailable,
    itemTradeable: isTradeable(item),
    buyerPenny: buyerWallet,
    pendingCount: deps.trades.pendingCountOf(seller.id),
    weeklyVolume,
  });
  if (!check.ok) return { privateText: check.reason, detailToPrivate: true };

  // 物品先冻结：从卖家可用栏位移出，取消或超时再还回去
  if (!deps.inventory.freeze(seller.id, item.id, qty, now)) {
    return { privateText: '物品冻结失败（数量不足），交易未创建。', detailToPrivate: true };
  }

  /*
   * M2.13：**幸运硬币**（神奇物品，被动：税率 -20%）—— 税率看的是**卖家**的背包：
   * 东西是他的，卖出去赚多少也是他的事。倍率由命令层算好喂进来（判定层不认识仓储）。
   */
  const settlement = settleTrade({
    itemId: item.id,
    qty,
    price,
    taxMultiplier: wonderEffectsOf(deps, seller.id, now).tradeTaxMultiplier,
  });
  const id = newTradeId([seller.id, buyer.id, item.id, qty, price, now].join('|'));
  deps.trades.insert({
    id,
    sellerId: seller.id,
    buyerId: buyer.id,
    itemId: item.id,
    qty,
    price,
    tax: settlement.tax,
    status: 'pending',
    createdAt: now,
    confirmedAt: null,
    deviceKey: fingerprint?.key ?? null,
  });

  deps.characters.appendEvents([
    {
      type: 'trade_open',
      characterId: seller.id,
      payload: { tradeId: id, itemId: item.id, qty, price, tax: settlement.tax, buyerId: buyer.id },
      reason: `交易发起:${id}`,
      seed: `trade:${id}`,
      createdAt: now,
    },
  ]);
  deps.audit.write({
    userId: msg.userId,
    command: '交易发起',
    input: `${item.id} × ${qty} @ ${price}`,
    output: `单号 ${id}，买家 ${buyer.userId}`,
    createdAt: now,
  });

  const summary = describeTrade({
    id,
    itemName: item.name,
    qty,
    price,
    tax: settlement.tax,
    expiresAt: expiresAt(now),
  });

  return {
    privateText: [
      `交易单已创建，物品已冻结。`,
      summary,
      '',
      `等待 ${buyer.name} 发送 .确认 ${id}；${tradeTimeoutLabel()}未确认自动取消并解冻` +
        '（买卖双方都可以先用 .取消 撤单）。',
    ].join('\n'),
    groupText: `【${seller.name}】挂出了一笔交易，等待对方确认。`,
    detailToPrivate: true,
    extra: [
      {
        scene: 'private',
        targetId: buyer.userId,
        text: [
          `${seller.name} 想和你交易：`,
          summary,
          '',
          `发送 .确认 ${id} 接受，或 .取消 ${id} 拒绝。`,
        ].join('\n'),
      },
    ],
  };
}
