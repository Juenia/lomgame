/**
 * M2.1 工具链单测：实测分布提取 / 经验投影 / 可见性预算 / 数值收尾
 * 这些东西决定闸门怎么定，必须自己也守住 —— 投影跑歪了，闸门就定歪了。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NUMERIC } from '../src/config/numeric.ts';
import { buildTrajectories, project } from '../src/sim/empirical.ts';
import { summarize, summarizeActionRates, type DailySample, type MeasuredDistribution } from '../src/sim/measured.ts';
import { lostControlPoolShares } from '../src/sim/visibility.ts';

function sampleOf(characterId: string, persona: string, day: number, mad: number, cor: number): DailySample {
  return { characterId, persona, day, mad, cor, dig: 60, sequence: 9 };
}

/** 最小分布：两个角色各 3 天，MAD 停在闸门上方一点点 */
function fixture(): MeasuredDistribution {
  const samples: DailySample[] = [
    sampleOf('a#0', 'aggressive', 0, 50, 40),
    sampleOf('a#0', 'aggressive', 1, 52, 41),
    sampleOf('a#0', 'aggressive', 2, 54, 42),
    sampleOf('a#1', 'aggressive', 0, 60, 45),
    sampleOf('a#1', 'aggressive', 1, 62, 46),
    sampleOf('a#1', 'aggressive', 2, 64, 47),
    sampleOf('b#0', 'steady', 0, 5, 2),
    sampleOf('b#0', 'steady', 1, 6, 3),
    sampleOf('b#0', 'steady', 2, 7, 4),
  ];
  const summary = summarize(samples);
  return {
    source: 'fixture',
    generatedAt: '2026-01-01T00:00:00.000Z',
    window: { characters: 3, days: 3 },
    samples,
    byPersona: summary.byPersona,
    byDay: summary.byDay,
    diagnostics: { records: 0, resync: 0, daysObserved: samples.length },
  };
}

test('M2.1 轨迹拼装：同一角色按天排序成一条轨迹，画像分组', () => {
  const pools = buildTrajectories(fixture().samples);
  assert.equal(pools.get('aggressive')?.length, 2);
  assert.equal(pools.get('steady')?.length, 1);
  assert.deepEqual(pools.get('aggressive')?.[0]?.mad, [50, 52, 54]);
});

test('M2.1 投影：闸门以上必触发、闸门以下绝不触发（判定走真实纯函数）', () => {
  const distribution = fixture();
  // 闸门压在 MAD 50 以下、divisor 极小 → aggressive 必然天天触发，steady 永远不触发
  const low = project(distribution, {
    charactersPerPersona: 200, days: 10, seed: 'unit',
    divisor: 1, madThreshold: 40, corThreshold: 40,
  });
  assert.equal(low.find((row) => row.persona === 'aggressive')?.lostControlRate, 1);
  assert.equal(low.find((row) => row.persona === 'steady')?.lostControlRate, 0);

  // 闸门抬到 MAD 100 → 谁都不越线
  const high = project(distribution, {
    charactersPerPersona: 200, days: 10, seed: 'unit',
    divisor: 400, madThreshold: 100, corThreshold: 100,
  });
  for (const row of high) assert.equal(row.lostControlRate, 0, row.persona + ' 不应触发');
});

test('M2.1 投影：候选闸门是临时拧进去的，跑完必须复位（否则污染同进程里的其它判定）', () => {
  const before = { ...NUMERIC.lossOfControl };
  project(fixture(), { charactersPerPersona: 10, days: 3, seed: 'unit', divisor: 7, madThreshold: 11, corThreshold: 13 });
  assert.deepEqual({ ...NUMERIC.lossOfControl }, before);
});

test('M2.1 投影可复现：同 seed 同配置 → 同一份结果', () => {
  const config = { charactersPerPersona: 50, days: 12, seed: 'repro', divisor: 90, madThreshold: 50, corThreshold: 45 };
  assert.deepEqual(project(fixture(), config), project(fixture(), config));
});

test('M2.1 可见性：失控池权重占比之和为 1；队伍版 lost_006/007 只在有队伍时进池', () => {
  const solo = lostControlPoolShares({ partySize: 1 });
  const party = lostControlPoolShares({ partySize: 2 });
  const sum = (rows: typeof solo): number => rows.reduce((total, row) => total + row.share, 0);
  assert.ok(Math.abs(sum(solo) - 1) < 1e-9, '独狼池的占比之和必须是 1');
  assert.ok(Math.abs(sum(party) - 1) < 1e-9, '有队伍时的占比之和必须是 1');
  // M2.1 方案 D 之后：lost_001/005 是独狼版（任何池子都在），lost_006/007 才是队伍版
  assert.equal(solo.some((row) => row.cardId === 'lost_001'), true, '独狼版要能在独狼池里抽到');
  assert.equal(solo.some((row) => row.cardId === 'lost_005'), true, '独狼版要能在独狼池里抽到');
  assert.equal(solo.some((row) => row.cardId === 'lost_006'), false, '队伍版不该进独狼池');
  assert.equal(solo.some((row) => row.cardId === 'lost_007'), false, '队伍版不该进独狼池');
  assert.equal(party.some((row) => row.cardId === 'lost_006'), true, '队伍版要能在有队伍时抽到');
  assert.equal(party.some((row) => row.cardId === 'lost_007'), true, '队伍版要能在有队伍时抽到');
  // 失控状态下的池子里，lost_00X 的权重占比应当很高（这正是「失控才看得到」的量化）
  const lostShare = solo.filter((row) => row.cardId.startsWith('lost_')).reduce((total, row) => total + row.share, 0);
  assert.ok(lostShare > 0.5, '独狼失控池里 lost_* 占比应超过一半，实际 ' + lostShare);
});

test('M2.1 行为频率：按画像 × 玩家日汇总，.扮演 与 .事件 分开统计', () => {
  const counts = new Map([
    ['a#0#0', { persona: 'aggressive', plays: 3, events: 1, actions: 10 }],
    ['a#0#1', { persona: 'aggressive', plays: 1, events: 0, actions: 5 }],
    ['b#0#0', { persona: 'chaotic', plays: 2, events: 2, actions: 4 }],
  ]);
  const rates = summarizeActionRates(counts);
  const aggressive = rates.find((row) => row.persona === 'aggressive');
  assert.equal(aggressive?.playerDays, 2);
  assert.equal(aggressive?.playsPerPlayerDay, 2);
  assert.equal(aggressive?.eventsPerPlayerDay, 0.5);
  assert.equal(aggressive?.actionsPerPlayerDay, 7.5);
  assert.equal(rates.find((row) => row.persona === 'chaotic')?.playsPerPlayerDay, 2);
});

test('M2.1 汇总：期末死循环用固定尺子 80/70，不跟着闸门走', () => {
  const samples = [
    sampleOf('x#0', 'aggressive', 0, 85, 75),
    sampleOf('x#1', 'aggressive', 0, 60, 50),
  ];
  const summary = summarize(samples);
  assert.equal(summary.byPersona[0]?.deadlockShare, 0.5, '超过 80/70 的才算死循环');
  assert.equal(NUMERIC.lossOfControl.deadlockMadThreshold, 80);
  assert.equal(NUMERIC.lossOfControl.deadlockCorThreshold, 70);
});
