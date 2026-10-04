/**
 * **世界节奏的随机间隔（M2.88）**。
 *
 * 用户的要求：
 *
 * > 「主动推送的事件改为随机时间触发，不要再定时触发」
 * > 「后台可以设置一个随机的时间范围，从那个时间范围里随机」
 *
 * 这份测试守三件事：
 *   ① 掷出来的延迟**永远落在配置范围内**；
 *   ② **同一个种子得到同一个延迟**（项目其余部分全是 seed 派生的，跑批要可复现）；
 *   ③ 分布**真的散得开**（若每次都落在同一个值，那还是定时）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHarness } from './helpers/app.ts';
import { loadOpsSettings } from '../src/data/loader.ts';
import { nextDelayMs, parseOpsSettings, type RandomInterval } from '../src/domain/ops/settings.ts';

const RANGE: RandomInterval = { min_minutes: 25, max_minutes: 95, note: '' };

/* ═══════════ 1. 范围 ═══════════ */

test('nextDelayMs：一万个时刻掷出来都落在 [min, max] 内', () => {
  /*
   * 越界的症状不是报错，是「后台把范围调成 10—20，实际却跑出 40 分钟」——
   * 那时人会去怀疑时钟，不会怀疑这个函数。
   */
  const lo = RANGE.min_minutes * 60_000;
  const hi = RANGE.max_minutes * 60_000;
  for (let t = 1_700_000_000_000; t < 1_700_000_000_000 + 10_000_000; t += 1000) {
    const d = nextDelayMs(RANGE, t);
    assert.ok(d >= lo && d <= hi, '越界：' + d / 60000 + ' 分钟（种子 ' + t + '）');
  }
});

test('nextDelayMs：min === max 时退化成固定间隔（边界不炸）', () => {
  const fixed: RandomInterval = { min_minutes: 30, max_minutes: 30, note: '' };
  for (let t = 1_700_000_000_000; t < 1_700_000_000_000 + 100_000; t += 7000) {
    assert.equal(nextDelayMs(fixed, t), 30 * 60_000);
  }
});

/* ═══════════ 2. 可复现 ═══════════ */

test('nextDelayMs：同一个种子 → 同一个延迟（跑批可复现）', () => {
  for (const t of [1_700_000_000_000, 1_700_000_060_000, 1_700_000_123_456]) {
    assert.equal(nextDelayMs(RANGE, t), nextDelayMs(RANGE, t), '种子 ' + t + ' 两次结果不同');
  }
});

test('nextDelayMs：不同种子确实不同（不是常数伪装成随机）', () => {
  const seen = new Set<number>();
  for (let t = 1_700_000_000_000; t < 1_700_000_000_000 + 200 * 60_000; t += 60_000) {
    seen.add(nextDelayMs(RANGE, t));
  }
  assert.ok(seen.size >= 150, '200 个不同时刻只掷出 ' + seen.size + ' 种延迟 —— 分布太窄');
});

test('nextDelayMs：把值域铺满（两端都够得着）', () => {
  const lo = RANGE.min_minutes * 60_000;
  const hi = RANGE.max_minutes * 60_000;
  const span = hi - lo;
  let nearLo = 0, nearHi = 0;
  for (let t = 1_700_000_000_000; t < 1_700_000_000_000 + 5000 * 60_000; t += 60_000) {
    const d = nextDelayMs(RANGE, t);
    if (d < lo + span * 0.15) nearLo += 1;
    if (d > hi - span * 0.15) nearHi += 1;
  }
  assert.ok(nearLo > 100, '最低段只掷到 ' + nearLo + ' 次 —— 范围下端形同虚设');
  assert.ok(nearHi > 100, '最高段只掷到 ' + nearHi + ' 次 —— 范围上端形同虚设');
});

/* ═══════════ 3. 配置层 ═══════════ */

test('配置：ops-settings.yaml 读得到，且范围合法', () => {
  const s = loadOpsSettings();
  assert.ok(s.world_tick.min_minutes > 0, '最短间隔必须为正');
  assert.ok(
    s.world_tick.max_minutes >= s.world_tick.min_minutes,
    '最长不能小于最短 —— 那会让随机范围是空的',
  );
  assert.ok(s.world_tick.max_minutes <= 24 * 60, '最长间隔不该超过一天');
});

test('配置：坏配置被挡住（max < min）', () => {
  const bad = parseOpsSettings({ world_tick: { min_minutes: 60, max_minutes: 10 }, daily_check_minutes: 1 });
  assert.equal(bad.ok, false, 'max < min 必须被拦下');
  if (!bad.ok) assert.ok(bad.issues.some((i) => i.includes('max_minutes')), '错误里该指明是哪个字段：' + bad.issues.join('；'));
});

test('配置：读不到文件时退回默认值，**不抛**', () => {
  /*
   * 它是运维参数不是内容 —— 读不到时该照常跑起来，而不是把服务拦在门外。
   * （对照：内容表的错必须拒绝启动，那是「卡写错了」。）
   */
  const s = loadOpsSettings('C:/绝对不存在的路径/ops.yaml');
  assert.ok(s.world_tick.min_minutes > 0, '该退回一份可用的默认值');
  assert.ok(s.world_tick.max_minutes >= s.world_tick.min_minutes);
});

test('配置：非法值被挡住（零 / 负 / 超过一天）', () => {
  assert.equal(parseOpsSettings({ world_tick: { min_minutes: 0, max_minutes: 10 }, daily_check_minutes: 1 }).ok, false);
  assert.equal(parseOpsSettings({ world_tick: { min_minutes: -5, max_minutes: 10 }, daily_check_minutes: 1 }).ok, false);
  assert.equal(parseOpsSettings({ world_tick: { min_minutes: 10, max_minutes: 2000 }, daily_check_minutes: 1 }).ok, false, '超过一天的间隔该被挡');
});

/* ═══════════ 4. 不影响可测路径 ═══════════ */

test('端到端：改成随机自排程之后，harness 照常起、世界照常读', () => {
  /*
   * 定时器只在 ops 打开时跑，而测试/跑批靠**惰性推进** ——
   * 所以把固定轮询改成随机自排程，不该影响任何可测路径。
   */
  const h = createHarness();
  try {
    assert.ok(Array.isArray(h.app.router.deps.world.groups()), '世界状态读得到');
    assert.ok(h.app.router.deps.engine.cards.length > 0, '内容照常加载');
  } finally {
    h.app.close();
  }
});