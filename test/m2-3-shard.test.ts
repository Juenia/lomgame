/**
 * M2.3 任务四：分片计划 + 合并脚本的单测。
 *
 * 合并是「报告数字的唯一来源」，所以这里逐项钉死合并口径（任务书 §6.4 那张表）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planShards, shardArgs } from '../scripts/vplayer-shard.ts';
import { mergeShards, renderMergedReport, METRIC_PROVENANCE } from '../src/vplayer/merge.ts';
import { SHARD_SCHEMA, type ShardJson } from '../src/vplayer/shard-json.ts';

function baseShard(index: number, overrides: Partial<ShardJson> = {}): ShardJson {
  const dig = [index * 10, index * 10 + 10];
  return {
    schema: SHARD_SCHEMA,
    shard: index,
    shards: 2,
    seed: `vplayer-m23:shard:${index}`,
    // M2.4：世界 seed 全局一个（所有分片相同）+ 世界事件证据
    worldSeed: 'world',
    worldEvents: {
      count: 2,
      byType: { rumor: 2 },
      byVisibility: { anonymous: 2 },
      ids: ['rumor:1:0', 'rumor:1:1'],
      digest: 'deadbeef',
    },
    players: 2,
    days: 3,
    baseEpoch: 0,
    startedAt: '2026-01-01T00:00:00.000Z',
    costMs: 1000 * (index + 1),
    stage: 'M2.3',
    analysis: {
      totalActions: 10,
      totalPlayers: 2,
      byPersona: [
        {
          persona: 'steady',
          players: 2,
          actions: 10,
          promotionsAttempted: 1,
          promotionsSucceeded: 1,
          lostControls: 0,
          reachedSequence8: 1,
          avgDig: 10,
          avgMad: 20,
          avgCor: 5,
          rejectRate: 0.1,
        },
      ],
      promotion: { attempted: 1, succeeded: 1, rate: 1, completions: 1 },
      funnel: [
        { stage: '建号', count: 2, rate: 1 },
        { stage: '调制魔药', count: 1, rate: 0.5 },
        { stage: '服用魔药', count: 1, rate: 0.5 },
        { stage: 'DIG 达标', count: 1, rate: 0.5 },
        { stage: '晋升成功（序列 8）', count: 1, rate: 0.5 },
      ],
      finals: { sequenceDistribution: { '9': 1, '8': 1 }, digAvg: 10, madAvg: 20, corAvg: 5, hpAvg: 90 },
      percentiles: { dig: { p50: 10, p90: 10 }, mad: { p50: 20, p90: 20 }, cor: { p50: 5, p90: 5 } },
      rejectRate: 0.1,
      rejectSamples: [],
      rejectionByCommand: [{ command: '探索', count: 1 }],
      replyOutcomes: [{ command: '扮演', outcome: '你在原地站了一会儿。', count: 5 }],
      // M2.6：组合货币与通缉的实测统计（分片合并要能把它们加回去）
      currencyCombo: {
        attempts: 2,
        created: 2,
        mismatched: 0,
        byToken: { '2s': { attempts: 2, created: 2, penny: 24 } },
        samples: [{ token: '2s', expectedPenny: 24, actualPenny: 24, ok: true }],
        plainAttempts: 4,
      },
      wanted: {
        issued: 1,
        active: 1,
        byLevel: { '1': 1 },
        encounters: 3,
        claims: 1,
        claimedPenny: 50,
        characters: 1,
      },
      // M2.6.1：袭击的三类结果
      assault: {
        attempts: 4,
        blockedByGap: 1,
        resisted: 0,
        hit: 2,
        missed: 1,
        hitRate: 2 / 3,
        damage: 70,
        byDiff: { '0': 2, '1': 1, '3': 1 },
        sequenceMin: 9,
        sequenceMax: 8,
      },
    },
    coverage: {
      commands: [
        { key: '扮演', count: 8, pass: false },
        { key: '状态', count: 2, pass: false },
      ],
      cards: [{ key: 'daily_001', count: 1, pass: true }],
      locations: [{ key: '廷根市', count: 1, pass: true }],
      recipes: [{ key: 'seer_9', count: 1, pass: true }],
      lostControlTexts: [{ key: '失控文本', count: 1, pass: true }],
      contentGaps: [],
      longChain: {
        characters: 2,
        initiated: 2,
        toSeq8: { count: 1, base: 2, required: 5, pass: false },
        toSeq7: { count: 0, base: 1, required: 5, pass: false },
        fullChain: 0,
      },
      pass: false,
      failures: [],
    },
    anomalies:
      index === 0
        ? [
            {
              level: 'P1',
              code: 'NO_STATE_CHANGE',
              playerId: 0,
              day: 1,
              virtualNow: 0,
              command: '扮演',
              detail: '连续 10 次无变化',
            },
          ]
        : [],
    profileSummary: [{ persona: 'steady', players: 2, loginAvg: 2, actionsAvg: 5, goalMix: 'promote:2' }],
    cards: [{ id: 'daily_001', conds: [] }],
    values: { dig, mad: dig.map((value) => value + 5), cor: dig.map(() => 1), hp: [100, 100] },
    personaPlayers: { steady: 2 },
    lostControl: index,
    characters: 2,
    rejectedActions: 1,
    thresholds: { minCommandCount: 10, minPromotions: 5 },
    // M2.7：分片必须带地理统计（SHARD_SCHEMA 升到 /3 就是因为这个字段）
    geo: {
      birthCities: { tingen: 5 },
      travelsStarted: index + 1,
      travelsArrived: index,
      travelsOngoing: 0,
      travelEvents: { bandit: index + 1 },
      travelChoices: { fight: index },
      travelPenny: 20 * (index + 1),
    },
    ...overrides,
  };
}

test('分片计划：玩家均分、seed 确定性派生、每片独立 JSON 与报告路径', () => {
  const even = planShards({ shards: 4, players: 200, days: 14, seed: 'vplayer-m23', out: 'data/vplayer-shards' });
  assert.equal(even.length, 4);
  assert.deepEqual(even.map((plan) => plan.players), [50, 50, 50, 50]);
  assert.deepEqual(even.map((plan) => plan.seed), [
    'vplayer-m23:shard:0',
    'vplayer-m23:shard:1',
    'vplayer-m23:shard:2',
    'vplayer-m23:shard:3',
  ]);
  /*
   * M2.13.1 任务 D：JSON 文件名**带库前缀**。
   *
   * 原来叫 shard-0.json（不含前缀），而同 out 目录下每一轮都写同名文件 ——
   * 同 seed 的两轮（开/关前置 4）里，后跑的会把先跑的覆盖掉，m213 那一轮就是这么没的。
   * 现在文件名与 dbPath / 报告前缀用**同一个库前缀**，谁也覆盖不了谁。
   */
  assert.equal(even[0]!.jsonPath.replace(/\\/g, '/'), 'data/vplayer-shards/vplayer-m23-shard-0.json');

  // 除不尽时余数分给前几片，总和必须一分不少
  const odd = planShards({ shards: 4, players: 201, days: 14, seed: 's', out: 'o' });
  assert.deepEqual(odd.map((plan) => plan.players), [51, 50, 50, 50]);
  assert.equal(odd.reduce((total, plan) => total + plan.players, 0), 201);

  // 同参数必然同计划（可复现）
  assert.deepEqual(planShards({ shards: 4, players: 200, days: 14, seed: 'vplayer-m23', out: 'data/vplayer-shards' }), even);
});

test('分片计划：CLI 参数带上 --json / --shard / --shards（合并脚本靠这三个认出分片）', () => {
  const plan = planShards({ shards: 4, players: 200, days: 14, seed: 'vplayer-m23', out: 'data/vplayer-shards' })[2]!;
  const args = shardArgs(plan);
  const valueOf = (name: string): string | undefined => args[args.indexOf(`--${name}`) + 1];
  assert.equal(valueOf('seed'), 'vplayer-m23:shard:2');
  assert.equal(valueOf('players'), '50');
  assert.equal(valueOf('days'), '14');
  assert.equal(valueOf('json'), plan.jsonPath);
  assert.equal(valueOf('shard'), '2');
  assert.equal(valueOf('shards'), '4');
  assert.ok(args.includes('--no-strict'), '分片轮不是验收轮，不能拿 200 人的包线卡 50 人的片');
});

/**
 * M2.7.7：P0/P1 的口径守卫。
 *
 * 为什么单独一条：M2.7.6 的交付说明把 P1 写成了 0/0/1/0（实际 0/1/1/3 = 5 条）——
 * 累加逻辑本身没错，错的是**报告里没有一处能自证这个数字是怎么来的**，
 * 写报告的人从四份分片 stdout 里各抄了一个数。
 * 所以这里守两件事：
 *   1. merged.anomalies 必须等于各片之和（累加）；
 *   2. 合并报告里那张逐片表的**合计行**必须等于逐片之和（表格自己自证）。
 * 第 2 条才是真正防再犯的那一条 —— 它保证「引用合并报告的人」看到的数字不会错。
 */
test('M2.7.7 口径：合并报告的 P1 = 各片之和，且逐片表的合计行自己自证', () => {
  const p1 = (playerId: number, command: string) => ({
    level: 'P1' as const,
    code: 'NO_STATE_CHANGE' as const,
    playerId,
    day: 1,
    virtualNow: 0,
    command,
    detail: '连续 10 次指令后角色状态没有变化',
  });
  const p0 = {
    level: 'P0' as const,
    code: 'HTTP_STATUS' as const,
    playerId: 9,
    day: 2,
    virtualNow: 0,
    command: '状态',
    detail: 'HTTP 500',
  };
  // 刻意做成 2 / 0 / 3 这种不均匀的分布：如果谁又把某一片的数字当成合计，立刻对不上
  const shards = [
    baseShard(0, { anomalies: [p1(1, '.魔药'), p1(2, '.魔药'), p0] }),
    baseShard(1, { anomalies: [] }),
    baseShard(2, { anomalies: [p1(3, '.魔药'), p1(4, '.魔药'), p1(5, '.魔药')] }),
  ];
  const merged = mergeShards(shards);

  assert.equal(merged.anomalies.filter((a) => a.level === 'P1').length, 5, 'P1 必须累加');
  assert.equal(merged.anomalies.filter((a) => a.level === 'P0').length, 1);
  assert.deepEqual(
    merged.anomaliesPerShard.map((ofShard) => ofShard.length),
    [3, 0, 3],
    '逐片明细必须保留（否则报告无法自证）',
  );

  const report = renderMergedReport(merged, { commandLine: 'test', stage: 'M2.7.7' });
  assert.match(report, /P0 1 条、P1 5 条。/, '首行的合计必须与累加值一致');
  assert.match(
    report,
    /\| \*\*合计\*\* \| \*\*1\*\* \| \*\*5\*\* \| \*\*6\*\* \|/,
    '逐片表的合计行必须是各片之和（这一行就是引用口径）',
  );
  assert.match(report, /\| 片 0 \| 1 \| 2 \| 3 \|/, '片 0 的明细');
  assert.match(report, /\| 片 2 \| 0 \| 3 \| 3 \|/, '片 2 的明细');
});

test('合并：动作 / P0P1 / 覆盖率 / 长链路都累加，分母跟着一起加', () => {
  const merged = mergeShards([baseShard(0), baseShard(1)]);
  assert.equal(merged.players, 4);
  assert.equal(merged.days, 3);
  assert.equal(merged.shards, 2);
  assert.equal(merged.analysis.totalActions, 20);
  assert.equal(merged.analysis.totalPlayers, 4);
  assert.equal(merged.anomalies.length, 1, 'P1 累加');
  assert.equal(merged.rejectedActions, 2);
  assert.equal(merged.analysis.rejectRate, 2 / 20, '拒绝率必须用合并后的总数算，不是平均各片的比率');

  // 长链路：分子分母都加
  const created = merged.analysis.funnel[0]!;
  const promoted = merged.analysis.funnel[4]!;
  assert.equal(created.count, 4);
  assert.equal(promoted.count, 2);
  assert.equal(promoted.rate, 0.5, '分母是合并后的建号数');

  // 覆盖率：按 key 累加，pass 按合并后的总数重算
  const play = merged.coverage.commands.find((item) => item.key === '扮演')!;
  const status = merged.coverage.commands.find((item) => item.key === '状态')!;
  assert.equal(play.count, 16);
  assert.equal(play.pass, true, '两片各 8 次，合并 16 ≥ 10 应当达标（单看任何一片都不达标）');
  assert.equal(status.count, 4);
  assert.equal(status.pass, false);

  // M2.13 前置 1：长链路两段各自判定（分子分母都累加）
  assert.equal(merged.coverage.longChain.toSeq8.count, 2, '两片各 1 人停在序列 8 → 合并 2');
  assert.equal(merged.coverage.longChain.toSeq8.base, 4, '第一段的分母是合并后的「已入途径」');
  assert.equal(merged.coverage.longChain.toSeq7.count, 0);
  assert.equal(merged.coverage.longChain.toSeq8.pass, false, '2 < 5，按合并后的总数重算');
  assert.ok(merged.coverage.failures.some((line) => line.includes('入途径 → 序列 8 完成 2 人')));
  assert.ok(merged.coverage.failures.some((line) => line.includes('序列 8 → 序列 7 完成 0 人')));
});

test('合并：数值得按玩家数加权，百分位由全量值重算（不是把分片百分位再平均）', () => {
  // 片 0 的 dig = [0, 10]，片 1 的 dig = [10, 20] → 合并后 [0, 10, 10, 20]
  const merged = mergeShards([baseShard(0), baseShard(1)]);
  assert.deepEqual(merged.values.dig, [0, 10, 10, 20]);
  assert.equal(merged.analysis.finals.digAvg, 10);
  assert.equal(merged.analysis.percentiles.dig.p50, 10);
  assert.equal(merged.analysis.percentiles.dig.p90, 20, 'P90 必须来自全量值，两片各自的 P90 都是 10 —— 平均会得到错的 10');

  const steady = merged.analysis.byPersona.find((entry) => entry.persona === 'steady')!;
  assert.equal(steady.players, 4);
  assert.equal(steady.actions, 20);
  assert.equal(steady.avgDig, 10);
  assert.equal(steady.rejectRate, 0.1);
  assert.equal(merged.profileSummary[0]!.players, 4, '画像人数累加');
  assert.equal(merged.profileSummary[0]!.goalMix, 'promote:4');

  assert.equal(merged.wallClockMs, merged.costMaxMs, '并行跑：墙钟由最慢那片决定');
  assert.deepEqual(merged.costMsPerShard, [1000, 2000]);
});

test('合并：口径不对的分片必须直接拒绝（不能把不同版本的报告拼在一起）', () => {
  const broken = baseShard(0, { schema: 'w8-vplayer/9' });
  assert.throws(() => mergeShards([broken]), /不认识的分片口径/);
  assert.throws(() => mergeShards([]), /没有分片结果/);

  const wrongDays = baseShard(1, { days: 7 });
  assert.throws(() => mergeShards([baseShard(0), wrongDays]), /分片天数不一致/);
});

test('合并报告：首行写明口径，并标注每个指标来自分片还是不分片小轮', () => {
  const social = baseShard(0, {
    shard: 0,
    shards: 1,
    players: 20,
    days: 3,
    seed: 'vplayer-m23-social',
    social: {
      tradesCreated: 10,
      tradesConfirmed: 4,
      tradesExpired: 3,
      partyActions: 25,
      partyTasks: 3,
      partiesWithTwoPlus: 2,
    },
  });
  const merged = mergeShards([baseShard(0), baseShard(1)], { social, wallClockMs: 600_000 });
  const report = renderMergedReport(merged, {
    commandLine: 'node scripts/vplayer-merge.ts --shards "data/vplayer-shards/*.json" --out docs/M2.3-回归报告.md',
    stage: 'M2.3',
    socialSource: 'data/vplayer-social/social.json',
  });

  assert.match(report, /^# M2\.3 回归报告（分片合并）/);
  assert.match(report, /口径（首行必读）/, '首行必须写清口径（任务书 §6.6）');
  assert.match(report, /不可直接比较/, '必须声明分片与不分片不可比');
  assert.match(report, /社交失真/, '必须写清分片的代价（任务书 §6.5）');
  assert.match(report, /来自不分片小轮/, '社交指标一节必须标注来源');
  assert.match(report, /交易成交率：40\.0%/);
  assert.match(report, /指标来源对照/);
  for (const entry of METRIC_PROVENANCE) {
    assert.ok(report.includes(entry.metric), `对照表里必须有「${entry.metric}」`);
  }
  assert.match(report, /墙钟 10\.0 分钟/);
});

test('合并报告：没给社交小轮时必须明确写出「口径不完整」而不是静默留空', () => {
  const report = renderMergedReport(mergeShards([baseShard(0), baseShard(1)]), {
    commandLine: 'node scripts/vplayer-merge.ts --shards "x/*.json"',
    stage: 'M2.3',
  });
  assert.match(report, /社交指标缺失/);
  assert.match(report, /请补跑 20×3/);
});
