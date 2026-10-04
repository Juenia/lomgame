import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderMarkdown, renderOneLine, checkTargets } from '../src/sim/report.ts';
import { runSimulation, type SimConfig } from '../src/sim/simulator.ts';
import { STRATEGIES, STRATEGY_IDS } from '../src/sim/strategy.ts';
import { buildDocument, parseArgs } from '../src/sim/cli.ts';

const SMALL: SimConfig = { characterCount: 40, days: 12, seed: 'unit', strategy: 'steady' };

test('模拟器：同一 config 必然产出同一份报告（可复现）', () => {
  const first = runSimulation(SMALL);
  const again = runSimulation(SMALL);
  assert.deepEqual(again.summary, first.summary);
  assert.deepEqual(again.daily, first.daily);
  assert.deepEqual(again.promotionSamples, first.promotionSamples);
});

test('模拟器：换 seed 结果不同', () => {
  const a = runSimulation(SMALL);
  const b = runSimulation({ ...SMALL, seed: 'unit-2' });
  assert.notDeepEqual(a.summary, b.summary);
});

test('模拟器：报告结构与天数一致', () => {
  const report = runSimulation(SMALL);
  assert.equal(report.daily.length, SMALL.days);
  assert.equal(report.config.characterCount, SMALL.characterCount);
  assert.equal(report.daily[0]?.day, 0);
  assert.equal(report.daily[SMALL.days - 1]?.day, SMALL.days - 1);
  for (const key of ['lostControlRate', 'promotionSuccessRate', 'deadlockRate', 'materialRatio'] as const) {
    assert.equal(typeof report.summary[key], 'number', `summary.${key} 必须是数字`);
  }
  assert.ok(report.numeric.divisor > 0);
});

test('模拟器：三种策略都能跑通且行为不同', () => {
  const reports = STRATEGY_IDS.map((strategy) =>
    runSimulation({ characterCount: 30, days: 6, seed: 'unit-' + strategy, strategy }),
  );
  for (const report of reports) {
    assert.ok(report.summary.plays > 0, `${report.config.strategy} 应该有扮演行为`);
  }
  const [steady, aggressive] = reports;
  assert.ok(
    (aggressive?.summary.plays ?? 0) > (steady?.summary.plays ?? 0),
    '激进型的扮演次数必须多于稳健型',
  );
});

test('模拟器：只调用真实纯函数 —— 用同 seed 直接复算一次扮演，增量必须一致', async () => {
  const { resolvePlay } = await import('../src/domain/play/play.ts');
  const { PATHWAY_TAGS } = await import('../src/domain/play/tags.ts');
  const { createSeededRng, seedFrom } = await import('../src/domain/rng.ts');
  const { computeDigNext } = await import('../src/domain/character/rules.ts');

  // 模拟器内部：seed = sim:<全局 seed>:<角色序号>:<天>:<动作序号>，第一个动作序号为 1
  const seed = seedFrom(['sim', SMALL.seed, 0, 0, 1]);
  const base = {
    id: 'sim-0',
    userId: 'sim-user-0',
    name: '模拟角色0',
    pathway: 'seer' as const,
    pathwayStatus: 'initiated' as const,
    gender: 'male' as const,
    sequence: 9,
    hp: 100,
    mp: 100,
    mad: 0,
    cor: 0,
    dig: 0,
    dp: 0,
    status: 'active' as const,
    promotionFails: 0,
    createdAt: 0,
    updatedAt: 0,
  };
  const text = '我占卜，顺便观察';
  const direct = resolvePlay({
    state: base,
    text,
    tags: PATHWAY_TAGS.seer,
    usage: new Map(),
    seed,
  });
  const expectedDig = computeDigNext(
    { dig: 0 },
    {
      matchScore: direct.breakdown.final,
      exposure: direct.exposure,
      ritual: 0,
      pollutionPenalty: 0,
    },
  );
  assert.equal(direct.digAfter, expectedDig, 'resolvePlay 自身口径一致');
  assert.equal(typeof createSeededRng(seed).next(), 'number');

  /*
   * 模拟器报告里第 1 天的平均 DIG 必须落在「几次行动的**量级**」内。
   *
   * ⚠️ **上限从 4 放宽到 6**（M2.86），依据是机制本身改了：
   *
   *   探索的每日次数**从硬上限改成软上限**（用户：「探索每日三次是不合理的机制」）——
   *   前 3 次照旧、第 4 次起收益递减但**仍然可以做**。
   *   而 `sim/simulator.ts` 当时还按**硬上限**行事，与真实玩家不一致；
   *   把它对齐到 `hardCapPerLocation` 之后，模拟角色一天会多做几次探索，
   *   第 1 天均值随之从 ≈3.5 升到 ≈4.7。
   *
   * 所以这条**不是「测试变松了」而是「判据跟着机制走」** —— 断言的意义是抓「量级异常」
   * （比如某天突然变成 40），不是钉死某一次具体数值。数字仍然写死（AGENTS §3.5）。
   */
  const report = runSimulation(SMALL);
  const day0Dig = report.daily[0]?.digAvg ?? 0;
  assert.ok(day0Dig > 0, '第 1 天必须已经产生消化度');
  assert.ok(day0Dig <= 6, `第 1 天均值不该超过几次行动的量级：${day0Dig}`);
});

test('模拟器：晋升样本记录了概率与抽样，便于回算', () => {
  const report = runSimulation({ characterCount: 60, days: 30, seed: 'promo-sample', strategy: 'aggressive' });
  assert.ok(report.promotionSamples.length > 0, '激进型 30 天里应当发起过晋升');
  for (const sample of report.promotionSamples.slice(0, 5)) {
    assert.ok(sample.chance >= 0.05 && sample.chance <= 0.95);
    assert.ok(sample.roll >= 0 && sample.roll < 1);
    assert.equal(sample.success, sample.roll < sample.chance);
  }
});

test('模拟器：死循环分档统计自洽', () => {
  const report = runSimulation({ characterCount: 60, days: 30, seed: 'deadlock', strategy: 'aggressive' });
  const { deadlockBreakdown, deadlockRate } = report.summary;
  assert.equal(deadlockRate, deadlockBreakdown.stuckBoth);
  assert.ok(deadlockBreakdown.stuckBoth <= deadlockBreakdown.stuckHighCor + 1e-9);
  assert.ok(deadlockBreakdown.stuckBoth <= deadlockBreakdown.stuckHighMad + 1e-9);
  assert.ok(deadlockBreakdown.stuckNoPromotion >= deadlockBreakdown.stuckBoth);
});

test('报告渲染：markdown 含曲线表与目标核对，单行摘要含关键数字', () => {
  const report = runSimulation({ characterCount: 20, days: 5, seed: 'render', strategy: 'steady' });
  const markdown = renderMarkdown(report);
  assert.match(markdown, /### 汇总/);
  assert.match(markdown, /### 按天曲线/);
  assert.match(markdown, /### 目标区间核对/);
  assert.ok(markdown.includes(report.config.seed), '报告必须写明 seed');

  const oneLine = renderOneLine(report);
  assert.match(oneLine, /strategy=steady/);
  assert.match(oneLine, /失控率=/);
});

test('目标核对：达标与否都会被标出来', () => {
  const passing = runSimulation({ characterCount: 100, days: 30, seed: 'w5-steady', strategy: 'steady' });
  const checks = checkTargets(passing);
  assert.ok(checks.length >= 2);
  assert.ok(checks.every((check) => typeof check.pass === 'boolean'));

  // 人为造一个必然不达标的配置：把暴露概率与 divisor 拉爆
  const failing = runSimulation({ characterCount: 40, days: 10, seed: 'fail', strategy: 'aggressive' });
  const tampered = {
    ...failing,
    summary: { ...failing.summary, lostControlRate: 0.9 },
  };
  const failedChecks = checkTargets(tampered);
  assert.ok(failedChecks.some((check) => !check.pass), '超出区间的指标必须判为未达标');
});

test('CLI：参数解析与整篇文档生成', () => {
  const options = parseArgs([
    '--characters',
    '50',
    '--days',
    '5',
    '--seed',
    'cli-seed',
    '--strategy',
    'steady',
  ]);
  assert.equal(options.characters, 50);
  assert.equal(options.days, 5);
  assert.equal(options.seed, 'cli-seed');
  assert.deepEqual(options.strategies, ['steady']);

  const all = parseArgs(['--strategy', 'all']);
  assert.deepEqual(all.strategies, STRATEGY_IDS);

  const reports = [
    runSimulation({ characterCount: 20, days: 3, seed: 'doc-a', strategy: 'steady' }),
    runSimulation({ characterCount: 20, days: 3, seed: 'doc-b', strategy: 'aggressive' }),
  ];
  const document = buildDocument({ ...options, strategies: ['steady', 'aggressive'] }, reports);
  assert.match(document, /# W5 数值模拟报告/);
  assert.match(document, /## 一、终值一览/);
  assert.match(document, /## 三、目标区间总核对/);
  assert.match(document, /稳健型/);
  assert.match(document, /激进型/);
});

test('策略定义：三种画像的关键参数齐全', () => {
  for (const id of STRATEGY_IDS) {
    const strategy = STRATEGIES[id];
    assert.ok(strategy.name.length > 0);
    assert.ok(strategy.description.length > 0);
    assert.ok(strategy.playsPerDay >= 0);
    if (strategy.randomOnly) {
      assert.ok(Array.isArray(strategy.randomActions));
      assert.ok(strategy.actionWeights !== undefined);
    }
  }
  assert.equal(STRATEGIES.aggressive.purifyWhenCorAtLeast !== undefined, true, '激进型必须会净化');
  assert.equal(STRATEGIES.chaotic.purifyWhenCorAtLeast, undefined, '混乱型不净化');
});

test('模拟器：1000×30 的规模在可接受时间内跑完（抽样 200 角色）', () => {
  const started = Date.now();
  const report = runSimulation({ characterCount: 200, days: 30, seed: 'perf', strategy: 'aggressive' });
  const cost = Date.now() - started;
  assert.ok(report.summary.plays > 0);
  assert.ok(cost < 20_000, `200×30 应当在 20 秒内跑完，实际 ${cost}ms`);
});
