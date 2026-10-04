import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NUMERIC } from '../src/config/numeric.ts';
import { planCharacterTick } from '../src/domain/daily/tick.ts';
import { createSeededRng, seedFrom } from '../src/domain/rng.ts';
import { dateKey } from '../src/infra/date.ts';
import { runDailyTick } from '../src/infra/tick.ts';
import type { CharacterState } from '../src/domain/character/types.ts';
import { createHarness } from './helpers/app.ts';

function makeState(overrides: Partial<CharacterState> = {}): CharacterState {
  return {
    id: 'char-1', userId: 'u1', name: '克莱恩', pathway: 'seer', pathwayStatus: 'initiated', gender: 'male', sequence: 9,
    hp: 100, mp: 40, mad: 0, cor: 0, dig: 0, dp: 0,
    status: 'active', promotionFails: 0, createdAt: 0, updatedAt: 0,
    ...overrides,
  };
}

function scriptedRng(values: number[]): { next(): number } {
  let index = 0;
  return { next: () => values[index++] ?? 0 };
}

test('每日计划：MP +30（M2.85 起不再恢复行动点）', () => {
  const plan = planCharacterTick({ state: makeState({ mp: 40 }), rng: scriptedRng([0.99]) });
  assert.deepEqual(plan.deltas, [{ type: 'mp', value: NUMERIC.tick.mpRestore }]);
  assert.equal(plan.status, 'active');
  assert.equal(plan.lostControl?.triggered, false);
});

test('每日计划：MP 已满时不产生多余的 delta', () => {
  const plan = planCharacterTick({ state: makeState({ mp: 100 }), rng: scriptedRng([0.99]) });
  assert.deepEqual(plan.deltas, []);
});

test('每日计划：失控角色先自然解除，且当天不再重复判定（防死循环）', () => {
  const state = makeState({ status: 'lost_control', mad: 100, cor: 100 });
  // 抽样 0 会必然命中失控，但因为「刚恢复」必须不判定
  const plan = planCharacterTick({ state, rng: scriptedRng([0, 0]) });
  assert.equal(plan.recoveredFrom, 'lost_control');
  assert.equal(plan.status, 'active');
  assert.equal(plan.lostControl, null);
});

test('每日计划：MAD/COR 过阈值时触发失控，HP 损失在配置区间内', () => {
  const state = makeState({ mad: 95, cor: 90 });
  const plan = planCharacterTick({ state, rng: scriptedRng([0, 0.5]) });
  assert.equal(plan.status, 'lost_control');
  assert.equal(plan.lostControl?.triggered, true);
  assert.ok((plan.lostControl?.hpLoss ?? 0) >= NUMERIC.tick.lostControlHpMin);
  assert.ok((plan.lostControl?.hpLoss ?? 0) <= NUMERIC.tick.lostControlHpMax);
  assert.ok(plan.deltas.some((delta) => delta.type === 'mad' && delta.value === NUMERIC.tick.lostControlMad));
  assert.ok(plan.deltas.some((delta) => delta.type === 'hp'));
});

test('每日结算：恢复落库、写 seed 事件、第二次执行直接 skipped', async () => {
  const h = createHarness();
  const character = await h.createCharacter('20001', '克莱恩');
  h.repos.characters.update({ ...h.repos.characters.findById(character.id)!, mp: 30, updatedAt: h.now() });

  const first = runDailyTick(h.app.router.deps, h.now());
  assert.equal(first.skipped, false);
  assert.equal(first.characters, 1);

  const state = h.repos.characters.findById(character.id)!;
  assert.equal(state.mp, 60);

  const events = h.app.db
    .prepare("SELECT seed FROM domain_events WHERE reason LIKE '每日tick:%'")
    .all() as Array<{ seed: string }>;
  assert.ok(events.length > 0, '每日结算必须写事件');
  assert.ok(events.every((event) => event.seed.startsWith('tick:')), 'seed 形如 tick:<date>:<角色>');

  const again = runDailyTick(h.app.router.deps, h.now());
  assert.equal(again.skipped, true, '同一天重复执行必须幂等');
  const tickRows = h.app.db.prepare('SELECT COUNT(*) AS n FROM daily_ticks').get() as { n: number };
  assert.equal(tickRows.n, 1, 'daily_ticks 只应有一条当天记录');
  h.app.close();
});

test('每日结算：跨天后可以再跑一次', async () => {
  const h = createHarness();
  await h.createCharacter('20001', '克莱恩');
  assert.equal(runDailyTick(h.app.router.deps, h.now()).skipped, false);
  h.advance(24 * 60 * 60 * 1000);
  assert.equal(runDailyTick(h.app.router.deps, h.now()).skipped, false);
  const tickRows = h.app.db.prepare('SELECT COUNT(*) AS n FROM daily_ticks').get() as { n: number };
  assert.equal(tickRows.n, 2);
  h.app.close();
});

test('每日结算：失控会私聊通知，且与计划一致（不靠运气）', async () => {
  const h = createHarness();
  const character = await h.createCharacter('20001', '克莱恩');
  h.repos.characters.update({
    ...h.repos.characters.findById(character.id)!,
    mad: 95,
    cor: 90,
    updatedAt: h.now(),
  });

  const before = h.repos.characters.findById(character.id)!;
  const date = dateKey(h.now());
  const expected = planCharacterTick({
    state: before,
    rng: createSeededRng(seedFrom(['tick', date, character.id])),
  });

  const summary = runDailyTick(h.app.router.deps, h.now());
  assert.equal(summary.lostControl, expected.lostControl?.triggered ? 1 : 0);

  const after = h.repos.characters.findById(character.id)!;
  assert.equal(after.status, expected.status);
  if (expected.lostControl?.triggered) {
    assert.equal(summary.notifications.length, 1);
    assert.equal(summary.notifications[0]?.userId, '20001');
    assert.match(summary.notifications[0]?.text ?? '', /你失控了/);
    assert.match(summary.notifications[0]?.text ?? '', /\.休息 或 \.净化/);
  }
  h.app.close();
});

test('每日结算：顺带清理超时交易', async () => {
  const h = createHarness();
  const a = await h.createCharacter('20001', '克莱恩');
  const b = await h.createCharacter('20002', '正义', 'warrior');
  h.repos.inventory.add(a.id, '辅助材料·银粉', 1, 'unbound', h.now());
  h.repos.inventory.add(b.id, '便士', 200, 'unbound', h.now());

  h.advance(11_000);
  const created = await h.send({ rawText: '.交易 @20002 辅助材料·银粉 1 50', userId: '20001' });
  const id = /单号：([A-F0-9]{6})/.exec(created[0]?.text ?? '')?.[1];
  assert.ok(id);
  assert.equal(h.repos.inventory.count(a.id, '辅助材料·银粉'), 0, '创建时冻结');

  h.advance(NUMERIC.trade.timeoutMs + 1000);
  const summary = runDailyTick(h.app.router.deps, h.now());
  assert.ok(summary.tradesExpired >= 1);
  assert.equal(h.repos.trades.getById(id!)?.status, 'expired');
  assert.equal(h.repos.inventory.count(a.id, '辅助材料·银粉'), 1, '超时后解冻');
  h.app.close();
});
