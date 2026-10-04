/**
 * 出站队列：游标语义、裁剪可见性、长轮询唤醒。
 *
 * 这三件事都属于"错了不报错"的那一类：
 *   · 游标算错 → 同一条发两遍，或者中间少发一条；
 *   · 裁剪不可见 → 上游以为世界安静了；
 *   · 唤醒丢失 → 偶尔卡满一个长轮询周期（只在有负载时出现）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Outbox } from '../src/outbox.ts';

const text = (targetId: string, extra: Record<string, unknown> = {}) => ({
  kind: 'text' as const,
  scene: 'group' as const,
  targetId,
  text: 'hi',
  ...extra,
});

test('队列：seq 从 1 起、take 只给 cursor 之后的', () => {
  const outbox = new Outbox(10);
  const a = outbox.push(text('g1'), 1000);
  const b = outbox.push(text('g1'), 1001);
  assert.equal(a.seq, 1);
  assert.equal(b.seq, 2);
  const first = outbox.take({ cursor: 0, limit: 10 });
  assert.deepEqual(first.items.map((i) => i.seq), [1, 2]);
  assert.equal(first.cursor, 2);
  // 用返回的游标再取：什么都不该有
  const second = outbox.take({ cursor: first.cursor, limit: 10 });
  assert.deepEqual(second.items, []);
  assert.equal(second.cursor, 2);
});

test('队列：limit 生效，游标推到最后一条而不是最后一条之前', () => {
  const outbox = new Outbox(10);
  for (let i = 0; i < 5; i += 1) outbox.push(text('g1'), 1000 + i);
  const page = outbox.take({ cursor: 0, limit: 2 });
  assert.deepEqual(page.items.map((i) => i.seq), [1, 2]);
  assert.equal(page.cursor, 2);
  const next = outbox.take({ cursor: page.cursor, limit: 2 });
  assert.deepEqual(next.items.map((i) => i.seq), [3, 4]);
});

test('队列：按 platform 过滤，但主动推送（没有 platform）谁都拿得到', () => {
  const outbox = new Outbox(10);
  outbox.push(text('g1', { platform: 'koishi' }), 1);
  outbox.push(text('g1', { platform: 'bee' }), 2);
  outbox.push(text('g1'), 3); // 世界播报：没有来源
  const koishi = outbox.take({ cursor: 0, limit: 10, platform: 'koishi' });
  assert.deepEqual(koishi.items.map((i) => i.seq), [1, 3]);
  const bee = outbox.take({ cursor: 0, limit: 10, platform: 'bee' });
  assert.deepEqual(bee.items.map((i) => i.seq), [2, 3]);
});

test('队列：裁剪会报 gap，并给出还能从哪接着取', () => {
  const outbox = new Outbox(3);
  for (let i = 0; i < 6; i += 1) outbox.push(text('g1'), 1000 + i);
  // 最旧的 3 条被挤掉了，剩下 seq 4、5、6
  const stale = outbox.take({ cursor: 1, limit: 10 });
  assert.equal(stale.gap, true, '游标落在被裁掉的那一段里，必须显式说 gap');
  assert.equal(stale.earliest, 4);
  assert.deepEqual(stale.items.map((i) => i.seq), [4, 5, 6]);
  // 游标本来就是最新的（0 = 我什么都没收过，队列还留着最早的 4）—— 不算断
  const fresh = outbox.take({ cursor: 4, limit: 10 });
  assert.equal(fresh.gap, undefined);
  assert.deepEqual(fresh.items.map((i) => i.seq), [5, 6]);
});

test('队列：wait 会被新数据立刻唤醒（不是等满超时）', async () => {
  const outbox = new Outbox(10);
  const started = Date.now();
  const waiting = outbox.wait(5000);
  setTimeout(() => outbox.push(text('g1'), Date.now()), 20);
  await waiting;
  const cost = Date.now() - started;
  assert.ok(cost < 2000, '应该在几十毫秒内被唤醒，实际 ' + cost + 'ms');
});

test('队列：没有数据时 wait 到点就返回（不会挂死）', async () => {
  const outbox = new Outbox(10);
  const started = Date.now();
  await outbox.wait(30);
  assert.ok(Date.now() - started >= 25);
});

test('队列：统计里能看出队列在涨、以及有没有人在等', () => {
  const outbox = new Outbox(2);
  outbox.push(text('g1'), 1);
  outbox.push(text('g1'), 2);
  outbox.push(text('g1'), 3);
  const stats = outbox.stats;
  assert.equal(stats.size, 2);
  assert.equal(stats.dropped, 1);
  assert.equal(stats.firstSeq, 2);
  assert.equal(stats.lastSeq, 3);
  assert.equal(stats.waiters, 0);
});
