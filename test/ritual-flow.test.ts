/**
 * **晋升仪式流程（M2.87）** 的单元测试。
 *
 * ## 这份测试守的是一个**设计判断**
 *
 * 用户否掉了我上一版的计时模型：
 *
 * > 「39个游戏日也不对，拿现实时间去要求就是纯折磨，而是应该设计一个剧情流程，
 * >  让他去完成流程，达成仪式，也有可能被破坏，仪式失败，以此类推所有的仪式」
 *
 * 所以这里测的不是「函数能跑」，是**三件事**：
 *   ① 时长被翻译成**判定次数**而不是等待天数；
 *   ② 解析器**不把说明句当步骤**（否则玩家会去做原作没要求的事）；
 *   ③ 流程**可失败**（「仪式失败」是用户明确要的）。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parse as parseYaml } from 'yaml';
import {
  RITUAL_STEP_LABELS,
  advanceStep,
  cnToNum,
  currentStepIndex,
  flowLine,
  isFlowComplete,
  parseRitualSteps,
  sustainChanceFor,
  sustainChecksFor,
  type RitualProgress,
  type RitualStep,
} from '../src/domain/ritual/flow.ts';

interface Rite { id: string; seq: number; ritual: string; sequenceTitle: string }
const RITES: Rite[] = (
  parseYaml(readFileSync(new URL('../src/data/advancement-rites.yaml', import.meta.url), 'utf8')) as {
    advancement_rites: Rite[];
  }
).advancement_rites;

/* ═══════════ 1. 时长 → 判定次数（这是用户否掉计时的落点） ═══════════ */

test('sustainChecksFor：年数翻倍只多判定几次，绝不变成苦工', () => {
  /*
   * 判据：3 年与 300 年必须**拉开差距**（否则「三百年」白写），
   * 但差距必须**有上限**（否则又变回「拿现实时间折磨」）。
   */
  const y3 = sustainChecksFor(3);
  const y300 = sustainChecksFor(300);
  assert.ok(y3 < y300, '300 年该比 3 年难：' + y3 + ' vs ' + y300);
  assert.ok(y3 >= 3, '最短的也该有 3 次 —— 一次就过没有仪式感');
  /*
   * ⚠️ 上限 8 是**改过一次**的：第一版给 24，实机点了几下才发现
   * 24 × 45% = 期望 53 次点击 —— 与用户否掉的「计时」是同一种折磨换了形式。
   */
  assert.ok(y300 <= 8, '最长的封顶 8 次 —— 超过就成苦工了：' + y300);
  assert.equal(y300, 8);
  assert.equal(sustainChecksFor(0), 3);
  // 单调不减
  let last = 0;
  for (let y = 0; y <= 500; y += 1) {
    const n = sustainChecksFor(y);
    assert.ok(n >= last, y + ' 年时次数下降了');
    last = n;
  }
});

test('sustainChanceFor：次数越多单次越难，但都落在合理区间', () => {
  for (let t = 3; t <= 8; t += 1) {
    const p = sustainChanceFor(t);
    assert.ok(p > 0.6 && p < 0.95, t + ' 次的成功率 ' + p + ' 越界');
  }
  assert.ok(sustainChanceFor(8) < sustainChanceFor(3), '次数多的该更难');
  // 期望点击次数必须留在个位数量级 —— 这是「不许变成苦工」的量化判据
  const worst = 8 / sustainChanceFor(8);
  assert.ok(worst <= 12, '最长的那条期望要点 ' + worst.toFixed(1) + ' 次 —— 太多了');
});

/* ═══════════ 2. 说明句不许变成步骤 ═══════════ */

test('parseRitualSteps：三类说明句必须被剔除（都在真数据里）', () => {
  /*
   * 第一版把「该仪式**不需要**仪式举行者占据主导地位」拆成了一个 perform 步骤。
   * 玩家会去做一件原作没要求的事 —— 而这比「少拆一步」糟得多。
   */
  const arbiter2 = RITES.find((r) => r.id === 'arbiter_2')!;
  const steps = parseRitualSteps(arbiter2.ritual);
  assert.ok(
    !steps.some((s) => s.what.includes('不需要')),
    '「不需要…」是说明，不该成为步骤：' + JSON.stringify(steps.map((s) => s.what)),
  );
  // 反例条件
  const error2 = RITES.find((r) => r.id === 'error_2')!;
  assert.ok(!parseRitualSteps(error2.ritual).some((s) => s.what.includes('无效')), '「无效」是反例条件');
  // 间隔约束
  const criminal5 = RITES.find((r) => r.id === 'criminal_5')!;
  assert.ok(!parseRitualSteps(criminal5.ritual).some((s) => s.what.includes('间隔')), '「间隔」不是步骤');
});

test('parseRitualSteps：同一条仪式里的时长只产生一个 sustain（不去重会重复计）', () => {
  /*
   * corpse_collector_4 的原文里「六十天」出现两次（要求 + 失败条件），
   * 第一版拆出**两个** `维持 ×4` —— 玩家要做两遍同一件事。
   */
  const c4 = RITES.find((r) => r.id === 'corpse_collector_4')!;
  const sustains = parseRitualSteps(c4.ritual).filter((s) => s.kind === 'sustain');
  assert.equal(sustains.length, 1, '时长只该产生一个 sustain，实际 ' + sustains.length);
});

/* ═══════════ 3. 覆盖率（写死，内容一变就该红） ═══════════ */

test('解析覆盖率：97 / 132，玩家可达区间（序列 5—2）不低于 60 / 88', () => {
  const withSteps = RITES.filter((r) => parseRitualSteps(r.ritual).length > 0);
  assert.equal(RITES.length, 132, '仪式总数变了');
  assert.equal(withSteps.length, 97, '能拆出步骤的条数变了 —— 确认是加内容而不是解析退化');
  /*
   * ⚠️ 拆不出的 35 条**不都是失败**：其中大部分是「一句话目标」型
   * （「愚弄一次时间、历史或者命运」），它们本来就只有一件事。
   * 所以这里不要求 100%。
   */
  const reachable = RITES.filter((r) => r.seq >= 2 && r.seq <= 5);
  const reachableOk = reachable.filter((r) => parseRitualSteps(r.ritual).length > 0);
  assert.equal(reachable.length, 88, '序列 5—2 的仪式总数变了');
  assert.ok(reachableOk.length >= 60,
    '玩家真正要走的那一段覆盖率过低：' + reachableOk.length + '/' + reachable.length);
});

test('解析出的每一步都说得通（kind 合法、times 与 chance 在界内、what 非空）', () => {
  for (const r of RITES) {
    for (const s of parseRitualSteps(r.ritual)) {
      assert.ok(RITUAL_STEP_LABELS[s.kind] !== undefined, r.id + ' 有非法 kind：' + s.kind);
      assert.ok(s.times >= 1 && s.times <= 24, r.id + ' 的 times 越界：' + s.times);
      assert.ok(s.chance > 0 && s.chance <= 1, r.id + ' 的 chance 越界：' + s.chance);
      assert.ok(s.what.length >= 3, r.id + ' 有一步的 what 太短：「' + s.what + '」');
      // what 必须是原文的子串 —— 可追溯，不许拼接
      assert.ok(r.ritual.includes(s.what), r.id + ' 的步骤描述不是原文子串：「' + s.what + '」');
    }
  }
});

/* ═══════════ 4. 流程推进与失败（用户明确要「仪式失败」） ═══════════ */

const mkSteps = (over: Partial<RitualStep>[] = []): RitualStep[] =>
  over.length > 0
    ? over.map((o) => ({ kind: 'perform', what: '做一件事', times: 1, chance: 0.5, ...o }))
    : [
        { kind: 'travel', what: '去一个地方', times: 1, chance: 0.5 },
        { kind: 'sustain', what: '维持很久', times: 3, chance: 0.5 },
      ];

const mkProgress = (steps: RitualStep[], done: number[] = []): RitualProgress => ({
  riteId: 'test',
  done: steps.map((_, i) => done[i] ?? 0),
  startedAt: 0,
});

test('advanceStep：掷过阈值才算成功，掷不过就是失败', () => {
  const steps = mkSteps();
  const p = mkProgress(steps);
  // chance = 0.5，roll = 0.4 → 成功
  const ok = advanceStep(steps, p, 0, 0.4);
  assert.equal(ok.kind, 'advanced');
  assert.equal(ok.progress.done[0], 1);
  // roll = 0.5 → 失败（>= 而非 >）
  const bad = advanceStep(steps, p, 0, 0.5);
  assert.equal(bad.kind, 'failed');
  assert.equal(bad.progress.done[0], 0, '失败不该推进计数');
});

test('advanceStep：失败**不清零、不倒**（那太狠，不是设计）', () => {
  const steps = mkSteps();
  const p = mkProgress(steps, [0, 2]); // sustain 已经做了 2 次（要 3 次）
  const r = advanceStep(steps, p, 1, 0.99);
  assert.equal(r.kind, 'failed');
  assert.equal(r.progress.done[1], 2, '失败之后已完成的次数必须留着');
});

test('advanceStep：多步流程全部走完才算 complete', () => {
  const steps = mkSteps();
  // 第一步已完成，第二步还差 1 次
  const p = mkProgress(steps, [1, 2]);
  const r = advanceStep(steps, p, 1, 0.1);
  assert.equal(r.kind, 'complete', '两步都满了该判完成');
  assert.ok(isFlowComplete(steps, r.progress));
});

test('advanceStep：sustain 要累计够 times 次，不是一次就过', () => {
  const steps = mkSteps();
  let p = mkProgress(steps, [1, 0]);
  const a = advanceStep(steps, p, 1, 0.1);
  assert.equal(a.kind, 'advanced');
  assert.equal(a.progress.done[1], 1, '第一次只该记 1');
  p = a.progress;
  const b = advanceStep(steps, p, 1, 0.1);
  assert.equal(b.progress.done[1], 2, '第二次记 2');
  const c = advanceStep(steps, b.progress, 1, 0.1);
  assert.equal(c.kind, 'complete', '第三次满了该完成');
});

test('currentStepIndex：指向第一个没走完的那一步', () => {
  const steps = mkSteps();
  assert.equal(currentStepIndex(steps, mkProgress(steps)), 0);
  assert.equal(currentStepIndex(steps, mkProgress(steps, [1, 0])), 1);
  assert.equal(currentStepIndex(steps, mkProgress(steps, [1, 3])), 2, '全走完时返回 steps.length');
});

test('flowLine：玩家看到的是一串勾，不是天数', () => {
  const steps = mkSteps();
  const line = flowLine(steps, mkProgress(steps, [1, 1]));
  assert.ok(line.includes('✓'), '该有已完成的勾：' + line);
  assert.ok(line.includes('1/3'), 'sustain 该显示累计：' + line);
  assert.ok(!/天|日/.test(line), '不该出现天数 —— 那正是被否掉的模型：' + line);
});

/* ═══════════ 5. 中文数字 ═══════════ */

test('cnToNum：真数据里的写法都能解析，解析不了返回 null', () => {
  assert.equal(cnToNum('三百'), 300);
  assert.equal(cnToNum('一百'), 100);
  assert.equal(cnToNum('六十'), 60);
  assert.equal(cnToNum('十'), 10);
  assert.equal(cnToNum('13'), 13);
  assert.equal(cnToNum('很多'), null);
});

/* ═══════════ 6. 五种步骤都有中文名 ═══════════ */

test('RITUAL_STEP_LABELS：五种步骤都有中文名（不许漏到界面上）', () => {
  for (const k of ['isolate', 'travel', 'perform', 'sustain', 'offering'] as const) {
    assert.ok(/[\u4e00-\u9fa5]/.test(RITUAL_STEP_LABELS[k]), k + ' 没有中文名');
  }
});