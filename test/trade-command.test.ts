import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NUMERIC } from '../src/config/numeric.ts';
import { createHarness } from './helpers/app.ts';

const A = '20001';
const B = '20002';

async function setup() {
  const h = createHarness();
  const a = await h.createCharacter(A, '克莱恩', 'seer');
  const b = await h.createCharacter(B, '正义', 'warrior');
  h.repos.inventory.add(a.id, '辅助材料·银粉', 3, 'unbound', h.now());
  h.repos.inventory.add(b.id, '便士', 500, 'unbound', h.now());
  return { h, a, b };
}

function tradeIdOf(text: string): string {
  const matched = /单号：([A-F0-9]{6})/.exec(text);
  assert.ok(matched, `回复里应带单号：${text}`);
  return matched[1]!;
}

test('.交易：创建待确认单、冻结物品、私聊通知买家', async () => {
  const { h, a, b } = await setup();
  h.advance(11_000);
  const sent = await h.send({ rawText: `.交易 @${B} 辅助材料·银粉 1 100`, userId: A, scene: 'group' });

  // 群聊一条完整回执 + 买家私聊通知（extra 通道），共 2 条
  assert.equal(sent.length, 2, '群聊完整回执 + 买家通知');
  assert.equal(sent[0]?.scene, 'group');
  const id = tradeIdOf(sent[0]?.text ?? '');
  assert.match(sent[0]?.text ?? '', /物品：辅助材料·银粉 × 1/);
  assert.match(sent[0]?.text ?? '', /税 5/);
  assert.equal(sent[1]?.scene, 'private');
  assert.equal(sent[1]?.targetId, B, '必须私聊通知买家');
  assert.match(sent[1]?.text ?? '', new RegExp(`.确认 ${id}`));

  assert.equal(h.repos.inventory.count(a.id, '辅助材料·银粉'), 2, '物品立即冻结');
  const trade = h.repos.trades.getById(id)!;
  assert.equal(trade.status, 'pending');
  assert.equal(trade.tax, 5);
  assert.equal(trade.buyerId, b.id);
  assert.equal(trade.sellerId, a.id);
  h.app.close();
});

test('.交易 → .确认：一手交钱一手交货，扣 5% 税，落审计', async () => {
  const { h, a, b } = await setup();
  h.advance(11_000);
  const created = await h.send({ rawText: `.交易 @${B} 辅助材料·银粉 1 100`, userId: A });
  const id = tradeIdOf(created[0]?.text ?? '');

  const confirmed = await h.send({ rawText: `.确认 ${id}`, userId: B });
  assert.match(confirmed[0]?.text ?? '', /交易完成/);
  assert.equal(confirmed[1]?.targetId, A, '卖家也要收到通知');

  assert.equal(h.repos.inventory.count(b.id, '便士'), 400, '买家付出 100');
  assert.equal(h.repos.inventory.count(a.id, '便士'), 95, '卖家到手 95，5 是税');
  assert.equal(h.repos.inventory.count(b.id, '辅助材料·银粉'), 1);
  assert.equal(h.repos.inventory.count(a.id, '辅助材料·银粉'), 2);

  const trade = h.repos.trades.getById(id)!;
  assert.equal(trade.status, 'completed');
  assert.ok(trade.confirmedAt !== null);

  const audits = h.app.db
    .prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE command = '交易完成'")
    .get() as { n: number };
  assert.equal(audits.n, 1);

  // 交易也进事件账本：双方各一条，seed 由单号推导 → 可复现
  const ledger = h.app.db
    .prepare("SELECT character_id, type, seed FROM domain_events WHERE type IN ('trade_open','trade_buy','trade_sell') ORDER BY id")
    .all() as Array<{ character_id: string; type: string; seed: string }>;
  assert.deepEqual(
    ledger.map((row) => row.type),
    ['trade_open', 'trade_buy', 'trade_sell'],
  );
  assert.ok(ledger.every((row) => row.seed === `trade:${id}`), '交易事件的 seed 必须与单号一致');
  h.app.close();
});

test('.交易：1 小时未确认自动取消并解冻', async () => {
  const { h, a } = await setup();
  h.advance(11_000);
  const created = await h.send({ rawText: `.交易 @${B} 辅助材料·银粉 2 80`, userId: A });
  const id = tradeIdOf(created[0]?.text ?? '');
  assert.equal(h.repos.inventory.count(a.id, '辅助材料·银粉'), 1);

  h.advance(NUMERIC.trade.timeoutMs + 1000);
  const late = await h.send({ rawText: `.确认 ${id}`, userId: B });
  assert.match(late[0]?.text ?? '', /自动取消|已经结束/);
  assert.equal(h.repos.inventory.count(a.id, '辅助材料·银粉'), 3, '超时必须解冻');
  assert.equal(h.repos.trades.getById(id)?.status, 'expired');
  h.app.close();
});

test('.取消：双方都能取消，物品解冻并通知对方', async () => {
  const { h, a } = await setup();
  h.advance(11_000);
  const created = await h.send({ rawText: `.交易 @${B} 辅助材料·银粉 1 50`, userId: A });
  const id = tradeIdOf(created[0]?.text ?? '');

  h.advance(11_000);
  const cancelled = await h.send({ rawText: `.取消 ${id}`, userId: B });
  assert.match(cancelled[0]?.text ?? '', /已取消交易/);
  assert.equal(cancelled[1]?.targetId, A);
  assert.equal(h.repos.inventory.count(a.id, '辅助材料·银粉'), 3);
  assert.equal(h.repos.trades.getById(id)?.status, 'cancelled');
  h.app.close();
});

test('.交易：绑定物品不可交易', async () => {
  const { h, a } = await setup();
  h.repos.inventory.add(a.id, '辅助材料·圣盐', 2, 'bound', h.now());
  h.advance(11_000);
  const sent = await h.send({ rawText: `.交易 @${B} 辅助材料·圣盐 1 20`, userId: A });
  assert.match(sent[0]?.text ?? '', /数量不足（当前 0 个非绑定）/);
  h.app.close();
});

test('.交易：身份物（bindable=false）不可交易', async () => {
  const { h, a } = await setup();
  h.repos.inventory.add(a.id, '教会徽记', 1, 'unbound', h.now());
  h.advance(11_000);
  const sent = await h.send({ rawText: `.交易 @${B} 教会徽记 1 20`, userId: A });
  assert.match(sent[0]?.text ?? '', /不能交易/);
  h.app.close();
});

test('.交易：待确认单数上限', async () => {
  const { h, a } = await setup();
  h.repos.inventory.add(a.id, '便士', 100, 'unbound', h.now());
  for (let i = 0; i < NUMERIC.trade.maxPendingPerUser; i += 1) {
    h.advance(11_000);
    const sent = await h.send({ rawText: `.交易 @${B} 便士 1 1`, userId: A });
    assert.match(sent[0]?.text ?? '', /单号：/, `第 ${i + 1} 笔应成功`);
  }
  h.advance(11_000);
  const blocked = await h.send({ rawText: `.交易 @${B} 便士 1 1`, userId: A });
  assert.match(blocked[0]?.text ?? '', /待确认的交易/);
  assert.equal(h.repos.trades.pendingCountOf(a.id), NUMERIC.trade.maxPendingPerUser);
  h.app.close();
});

test('.交易：周交易额上限拦截（防小号转移资产）', async () => {
  const { h } = await setup();
  h.advance(11_000);
  const sent = await h.send({
    rawText: `.交易 @${B} 辅助材料·银粉 1 ${NUMERIC.trade.weeklyVolumeCap + 1}`,
    userId: A,
  });
  assert.match(sent[0]?.text ?? '', /本周交易额已达上限/);
  assert.equal(h.repos.trades.count(), 0, '被拒时不能落单，也不能冻结物品');
  h.app.close();
});

test('.交易：买家货币不足时确认被拒，交易仍挂着', async () => {
  const { h, b } = await setup();
  h.advance(11_000);
  const created = await h.send({ rawText: `.交易 @${B} 辅助材料·银粉 1 900`, userId: A });
  const id = tradeIdOf(created[0]?.text ?? '');

  h.advance(11_000);
  const confirmed = await h.send({ rawText: `.确认 ${id}`, userId: B });
  assert.match(confirmed[0]?.text ?? '', /货币不足/);
  assert.equal(h.repos.trades.getById(id)?.status, 'pending');
  assert.equal(h.repos.inventory.count(b.id, '便士'), 500);
  h.app.close();
});

test('.交易：任何人都不能确认别人的单子', async () => {
  const { h } = await setup();
  const c = await h.createCharacter('20003', '阿尔杰', 'sleepless');
  h.repos.inventory.add(c.id, '便士', 100, 'unbound', h.now());
  h.advance(11_000);
  const created = await h.send({ rawText: `.交易 @${B} 辅助材料·银粉 1 10`, userId: A });
  const id = tradeIdOf(created[0]?.text ?? '');

  h.advance(11_000);
  const wrong = await h.send({ rawText: `.确认 ${id}`, userId: '20003' });
  assert.match(wrong[0]?.text ?? '', /只有买家能确认/);
  h.app.close();
});

test('.交易：支持 OneBot 的 CQ at 码', async () => {
  const { h } = await setup();
  h.advance(11_000);
  const sent = await h.send({
    rawText: `.交易 [CQ:at,qq=${B}] 辅助材料·银粉 1 30`,
    userId: A,
  });
  assert.match(sent[0]?.text ?? '', /单号：/);
  h.app.close();
});

test('.交易：参数不合法时的用法提示', async () => {
  const { h } = await setup();
  h.advance(11_000);
  assert.match((await h.send({ rawText: '.交易', userId: A }))[0]?.text ?? '', /用法：\.交易/);
  h.advance(11_000);
  assert.match((await h.send({ rawText: '.交易 @12345 辅助材料·银粉 1 10', userId: A }))[0]?.text ?? '', /对方还没有角色/);
  h.advance(11_000);
  assert.match((await h.send({ rawText: `.交易 @${B} 辅助材料·银粉 abc`, userId: A }))[0]?.text ?? '', /价格必须是正整数/);
  h.app.close();
});
