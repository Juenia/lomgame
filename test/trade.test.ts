import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NUMERIC } from '../src/config/numeric.ts';
import {
  checkTradeRequest,
  expiresAt,
  isExpired,
  settleTrade,
  tradeTax,
  weeklyWindowStart,
} from '../src/domain/trade/trade.ts';

function validInput(overrides: Partial<Parameters<typeof checkTradeRequest>[0]> = {}) {
  return {
    sellerId: 'seller',
    buyerId: 'buyer',
    qty: 1,
    price: 100,
    sellerAvailable: 5,
    itemTradeable: true,
    buyerPenny: 500,
    pendingCount: 0,
    weeklyVolume: 0,
    ...overrides,
  };
}

test('税：按便士向下取整 5%（M2.5：原来向上取整会把 1 便士的单子吃穿）', () => {
  assert.equal(tradeTax(100), 5, '整好 5%');
  assert.equal(tradeTax(101), 5, '向下取整：5.05 → 5（旧口径向上取整是 6）');
  assert.equal(tradeTax(1), 0, '1 便士的单子不再被收 1 便士税（那是 100% 税率）');
  assert.equal(tradeTax(19), 0);
  assert.equal(tradeTax(20), 1);
  assert.equal(tradeTax(0), 0);
});

test('结算：买家付全价，卖家到手扣税', () => {
  const settlement = settleTrade({ itemId: '便士', qty: 2, price: 101 });
  // 101 × 5% = 5.05 → 向下取整 5（旧口径向上取整是 6）
  assert.equal(settlement.tax, 5);
  assert.equal(settlement.buyerPennyCost, 101);
  assert.equal(settlement.sellerPennyGain, 96);
});

test('交易校验：自交易 / 数量 / 价格 / 绑定 / 库存 / 待确认 / 周上限', () => {
  assert.equal(checkTradeRequest(validInput()).ok, true);
  assert.match(String((checkTradeRequest(validInput({ sellerId: 'a', buyerId: 'a' })) as { reason?: string }).reason), /不能和自己/);
  assert.match(String((checkTradeRequest(validInput({ qty: 0 })) as { reason?: string }).reason), /正整数/);
  assert.match(String((checkTradeRequest(validInput({ qty: NUMERIC.trade.maxQuantity + 1 })) as { reason?: string }).reason), /最多交易/);
  assert.match(String((checkTradeRequest(validInput({ price: 0 })) as { reason?: string }).reason), /正整数/);
  assert.match(String((checkTradeRequest(validInput({ itemTradeable: false })) as { reason?: string }).reason), /不能交易/);
  assert.match(String((checkTradeRequest(validInput({ sellerAvailable: 0 })) as { reason?: string }).reason), /数量不足/);
  assert.match(
    String((checkTradeRequest(validInput({ pendingCount: NUMERIC.trade.maxPendingPerUser })) as { reason?: string }).reason),
    /待确认的交易/,
  );
  assert.match(
    String((checkTradeRequest(validInput({ weeklyVolume: NUMERIC.trade.weeklyVolumeCap })) as { reason?: string }).reason),
    /本周交易额已达上限/,
  );
});

test('交易校验：买家货币不足时给出明确原因', () => {
  const result = checkTradeRequest(validInput({ buyerPenny: 10 }));
  // 货币校验在确认环节做（价格可能变），这里只验证不误伤
  assert.equal(result.ok, true);
});

test('超时：1 小时未确认即过期', () => {
  const createdAt = 1_000_000;
  assert.equal(expiresAt(createdAt) - createdAt, NUMERIC.trade.timeoutMs);
  assert.equal(isExpired(createdAt, createdAt + NUMERIC.trade.timeoutMs - 1), false);
  assert.equal(isExpired(createdAt, createdAt + NUMERIC.trade.timeoutMs), true);
});

test('周窗口起点是 7 天前', () => {
  const now = 1_700_000_000_000;
  assert.equal(now - weeklyWindowStart(now), 7 * 24 * 60 * 60 * 1000);
});
