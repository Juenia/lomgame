import type { CommandContext, CommandResult } from '../index.ts';
import { expireStaleTrades, requireCharacter } from './common.ts';

export const CANCEL_USAGE = '用法：.取消 单号（例：.取消 A1B2C3）';

export async function handleCancel(ctx: CommandContext): Promise<CommandResult> {
  const gate = requireCharacter(ctx);
  if (!gate.ok) return gate.result;
  const actor = gate.character;
  const { deps, msg, now } = ctx;

  expireStaleTrades(deps, now);

  const id = (ctx.args[0] ?? '').trim().toUpperCase();
  if (!id) return { privateText: CANCEL_USAGE, detailToPrivate: true };

  const trade = deps.trades.getById(id);
  if (!trade) return { privateText: `没有这笔交易：${id}`, detailToPrivate: true };
  if (trade.status !== 'pending') {
    return { privateText: `这笔交易已经结束（${trade.status}）。`, detailToPrivate: true };
  }
  if (trade.sellerId !== actor.id && trade.buyerId !== actor.id) {
    return { privateText: '这笔交易与你无关。', detailToPrivate: true };
  }

  deps.inventory.add(trade.sellerId, trade.itemId, trade.qty, 'unbound', now);
  deps.trades.updateStatus(id, 'cancelled', null);
  deps.characters.appendEvents([
    {
      type: 'trade_cancel',
      characterId: trade.sellerId,
      payload: { tradeId: id, itemId: trade.itemId, qty: trade.qty, by: actor.id },
      reason: `交易取消:${id}`,
      seed: `trade:${id}`,
      createdAt: now,
    },
  ]);
  deps.audit.write({
    userId: msg.userId,
    command: '交易取消',
    input: id,
    output: `解冻 ${trade.itemId} × ${trade.qty}`,
    createdAt: now,
  });

  const counterpartyId = trade.sellerId === actor.id ? trade.buyerId : trade.sellerId;
  const counterparty = deps.characters.findById(counterpartyId);
  const itemName = deps.items.nameOf(trade.itemId);

  return {
    privateText: `已取消交易 ${id}（${itemName} × ${trade.qty}），物品已解冻。`,
    groupText: `【${actor.name}】取消了一笔交易。`,
    detailToPrivate: true,
    extra: counterparty
      ? [
          {
            scene: 'private',
            targetId: counterparty.userId,
            text: `交易 ${id} 已被对方取消，${itemName} × ${trade.qty} 已解冻。`,
          },
        ]
      : [],
  };
}
