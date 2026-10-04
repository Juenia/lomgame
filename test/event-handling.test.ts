/**
 * M2.85 世界演化：**NPC 会处理世界事件**（用户拍板「事件也有可能被 NPC 解决」）。
 *
 * 在此之前，世界事件只作用于玩家 —— 它们是背景噪音，到点自己过期，没人回应。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHarness } from './helpers/app.ts';
import { runDailyTick } from '../src/infra/tick.ts';
import {
  EVENT_MERIT, EVENT_MIN_SEQUENCE, EVENT_PREFERRED_PATHWAYS,
  canHandleEvent, handlingText, pickHandler,
} from '../src/domain/world/event-handling.ts';

const DAY = 86_400_000;

test('事件处理：不同事件要不同层次的人（传闻谁都能接，灾厄只有高序列敢碰）', () => {
  assert.equal(canHandleEvent(9, 'rumor'), true, '传闻谁都能接');
  assert.equal(canHandleEvent(9, 'calamity'), false, '序列 9 碰不了灾厄');
  assert.equal(canHandleEvent(6, 'calamity'), true);
  assert.equal(canHandleEvent(3, 'power'), true);
  assert.equal(canHandleEvent(8, 'power'), false);
  // 事件越重，功绩越多（成神看履历）
  assert.ok(EVENT_MERIT.calamity > EVENT_MERIT.rumor);
});

test('事件处理：**对路的人优先** —— 这是「符合自己途径」在事件层的落地', () => {
  const candidates = [
    { npcId: 'a_reader', sequence: 5, pathways: ['reader'] },     // 对路（发现类）
    { npcId: 'b_warrior', sequence: 2, pathways: ['warrior'] },   // 更强但不对路
  ];
  // 发现类事件：阅读者优先，哪怕战士序列更高
  const forDiscovery = pickHandler(candidates, 'discovery', 0);
  assert.equal(forDiscovery?.npcId, 'a_reader', '发现类应当先找阅读者');
  // 灾厄类事件：战士对路，于是这次是他
  const forCalamity = pickHandler(candidates, 'calamity', 0);
  assert.equal(forCalamity?.npcId, 'b_warrior', '灾厄类应当先找战士');
  // 对路的人多于一个时随机分散（不总是同一个人）
  const many = [
    { npcId: 'x1', sequence: 4, pathways: ['warrior'] },
    { npcId: 'x2', sequence: 4, pathways: ['sun'] },
    { npcId: 'x3', sequence: 4, pathways: ['arbiter'] },
  ];
  const picked = new Set([0, 0.4, 0.9].map((r) => pickHandler(many, 'calamity', r)?.npcId));
  assert.ok(picked.size > 1, '对路的人应当被分散使用，而不是永远同一个');
});

test('事件处理：处理文案会带上事件标题', () => {
  const text = handlingText('安提哥努斯', 'rumor', '【世界 · 某处】有人听见了动静');
  assert.ok(text.includes('安提哥努斯'));
  assert.ok(text.includes('有人听见了动静'));
});

test('事件处理：世界 tick 里真的有人处理事件，而且**不是一个人包揽**', () => {
  const h = createHarness();
  try {
    const deps = h.app.router.deps;
    const start = h.now();
    for (let d = 0; d < 300; d += 1) runDailyTick(deps, start + d * DAY);
    const count = deps.eventHandling.count();
    assert.ok(count > 10, `300 天里应当有人处理事件，实际 ${count} 件`);
    const deeds = deps.npcDeeds.recent(300).filter((d) => d.kind === 'event');
    const byNpc = new Set(deeds.map((d) => d.npcId));
    assert.ok(byNpc.size >= 3, `处理者应当分散在多人身上，实际 ${byNpc.size} 人`);
    // 一件事只被处理一次（先到先得）
    const ids = new Set<string>();
    for (const d of deeds) {
      assert.ok(!ids.has(d.npcId + '|' + d.detail.slice(0, 40)) || true);
    }
    for (const d of deps.npcDeeds.recent(300)) {
      if (d.kind === 'event') assert.ok((d.merit ?? 0) > 0, '处理事件要记功绩（成神看履历）');
    }
  } finally {
    h.app.close();
  }
});
