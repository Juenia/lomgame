import { formatCurrency } from '../../domain/currency/index.ts';
import { CURRENCY_ITEM_ID } from '../../domain/item/item.ts';
import { isExpired, settleTrade, tradeTimeoutLabel } from '../../domain/trade/trade.ts';
import { withTransaction } from '../../infra/db/sqlite.ts';
import type { CommandContext, CommandResult } from '../index.ts';
import { expireStaleTrades, requireCharacter } from './common.ts';
import { wonderEffectsOf } from './wonder-hooks.ts';

export const CONFIRM_USAGE = '用法：.确认 单号（例：.确认 A1B2C3）';

export async function handleConfirm(ctx: CommandContext): Promise<CommandResult> {
  const gate = requireCharacter(ctx);
  if (!gate.ok) return gate.result;
  const buyer = gate.character;
  const { deps, msg, now } = ctx;

  expireStaleTrades(deps, now);

  const id = (ctx.args[0] ?? '').trim().toUpperCase();
  if (!id) return { privateText: CONFIRM_USAGE, detailToPrivate: true };

  const trade = deps.trades.getById(id);
  if (!trade) return { privateText: `没有这笔交易：${id}`, detailToPrivate: true };
  if (trade.status !== 'pending') {
    return { privateText: `这笔交易已经结束（${trade.status}）。`, detailToPrivate: true };
  }
  if (isExpired(trade.createdAt, now)) {
    deps.inventory.add(trade.sellerId, trade.itemId, trade.qty, 'unbound', now);
    deps.trades.updateStatus(id, 'expired', null);
    return {
      privateText: `这笔交易已超过 ${tradeTimeoutLabel()}，自动取消，物品已解冻。`,
      detailToPrivate: true,
    };
  }
  if (trade.buyerId !== buyer.id) {
    return { privateText: '只有买家能确认这笔交易。', detailToPrivate: true };
  }

  const wallet = deps.inventory.count(buyer.id, CURRENCY_ITEM_ID);
  if (wallet < trade.price) {
    return {
      privateText:
        `货币不足（需要 ${formatCurrency(trade.price)}，你有 ${formatCurrency(wallet)}）。` +
        '交易仍然挂着，筹到钱再确认。',
      detailToPrivate: true,
    };
  }

  const seller = deps.characters.findById(trade.sellerId);
  /*
   * M2.13：税额在**确认的那一刻**按**卖家此刻**的背包算（幸运硬币的税率 -20%）。
   * 不按挂单时算：挂单只是一个报价，东西还在他手上 —— 他中途把硬币卖了，
   * 税率就该跟着回去。挂在单子上的那一笔只是给玩家看的预览。
   */
  const settlement = settleTrade({
    itemId: trade.itemId,
    qty: trade.qty,
    price: trade.price,
    taxMultiplier: wonderEffectsOf(deps, trade.sellerId, now).tradeTaxMultiplier,
  });

  // 一手交钱一手交货：整体事务，任何一步失败就回滚
  const paid = withTransaction(deps.db, () => {
    if (!deps.inventory.tryRemove(buyer.id, CURRENCY_ITEM_ID, settlement.buyerPennyCost, now)) return false;
    deps.inventory.add(trade.sellerId, CURRENCY_ITEM_ID, settlement.sellerPennyGain, 'unbound', now);
    deps.inventory.add(buyer.id, trade.itemId, trade.qty, 'unbound', now);
    deps.trades.updateStatus(id, 'completed', now, settlement.tax);
    return true;
  });

  if (!paid) return { privateText: '货币扣除失败，交易未完成。', detailToPrivate: true };

  deps.characters.appendEvents([
    {
      type: 'trade_buy',
      characterId: buyer.id,
      payload: {
        tradeId: id,
        itemId: trade.itemId,
        qty: trade.qty,
        price: settlement.buyerPennyCost,
        tax: settlement.tax,
        sellerId: trade.sellerId,
      },
      reason: `交易完成:${id}`,
      seed: `trade:${id}`,
      createdAt: now,
    },
    {
      type: 'trade_sell',
      characterId: trade.sellerId,
      payload: {
        tradeId: id,
        itemId: trade.itemId,
        qty: trade.qty,
        price: settlement.price,
        tax: settlement.tax,
        pennyGain: settlement.sellerPennyGain,
        buyerId: buyer.id,
      },
      reason: `交易完成:${id}`,
      seed: `trade:${id}`,
      createdAt: now,
    },
  ]);
  deps.audit.write({
    userId: msg.userId,
    command: '交易完成',
    input: id,
    output: `${trade.itemId} × ${trade.qty} 作价 ${trade.price} 便士，税 ${settlement.tax} 便士`,
    createdAt: now,
  });

  const itemName = deps.items.nameOf(trade.itemId);
  return {
    privateText: [
      `交易完成：${itemName} × ${trade.qty}`,
      `你付出 ${formatCurrency(settlement.buyerPennyCost)}，收到 ${itemName} × ${trade.qty}（非绑定）。`,
    ].join('\n'),
    groupText: `【${buyer.name}】和【${seller?.name ?? '某人'}】完成了一笔交易。`,
    detailToPrivate: true,
    extra: seller
      ? [
          {
            scene: 'private',
            targetId: seller.userId,
            text: [
              `交易完成：${itemName} × ${trade.qty}`,
              `买家付出 ${formatCurrency(settlement.buyerPennyCost)}，系统扣税 ${formatCurrency(settlement.tax)}，` +
                `你到手 ${formatCurrency(settlement.sellerPennyGain)}。`,
            ].join('\n'),
          },
        ]
      : [],
  };
}
