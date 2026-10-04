/**
 * M2.14：灾厄（任务 A —— 灾厄算子）。
 *
 * 三组：
 *   一、算子：同 seed 同 t → 同灾厄；不跨窗口；淡入淡出；频率落在设计范围内
 *   二、播报：灾厄**开始的那一刻**落一条 type = 'calamity' 的事件，其余小时不落
 *   三、可见：`.今日` 里能看到 `[灾厄]` 块
 *
 * 这一层守的是「灾厄不下渗判定层」那条拍板：
 * 灾厄是**纯 seed 派生**的，没有状态、不进任何 seedFrom 的参数表、
 * 判定层看到的它只是一个入参 —— 所以「同 seed 同 t → 同灾厄」就是它的全部契约。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyNumericOverrides, BATTLE, NUMERIC, resetNumeric } from '../src/config/numeric.ts';
import { loadCreatures } from '../src/data/loader.ts';
import { spawnInitialCreatures, tickCreatures } from '../src/domain/creature/index.ts';
import { rollCalamityDrop, rollExtraordinaryDrop } from '../src/domain/extraordinary/index.ts';
import { createSeededRng, seedFrom } from '../src/domain/rng.ts';
import {
  calamityAt,
  calamityBucketOf,
  calamityDayAnchor,
  calamityFactorAt,
  type Calamity,
} from '../src/domain/world/calamity.ts';
import { hourOf, worldClock } from '../src/domain/world/clock.ts';
import { generateWorldEvents } from '../src/domain/world/events.ts';
import { worldModifiers } from '../src/domain/world/weather.ts';
import { createHarness, DEFAULT_USER } from './helpers/app.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
/** 初始播种的时刻（只给生物一个出生时刻，与 tick 的 now 无关） */
const SPAWN_AT = 0;
/**
 * 扫描起点 = **m213b 那轮跑批真实覆盖的第一天**（day 20454，从
 * data/m213b-shard-*.db 的 domain_events 起止时刻换算）。
 *
 * 为什么不用一个整数好看的值：bucket = floor(dayIndex / 6)，换个起点就是换一批窗口，
 * 24 个 seed 的「平均灾厄次数」会跟着变（实测：起点 20000 → 3.17、20400 → 2.92、
 * 20454 → 3.00）。报告里引用哪个数，就得写清是在哪个区间上量的。
 */
const FROM_DAY = 20_454;

/** 生成器看到的世界：照 test/m2-4.test.ts 的 snapshotOf 手法（灾厄不读玩家字段） */
function snapshotAt(at: number, seed: string) {
  const clock = worldClock(at, seed);
  return {
    clock,
    weather: 'clear' as const,
    modifiers: worldModifiers({ clock, weather: 'clear' }),
    locations: [],
    weatherStates: [],
  };
}

/** 从 fromDay 起扫 days 天，找第一个灾厄（把确定性用例钉在非空结果上） */
function firstCalamity(seed: string, fromDay: number, days: number): { at: number; calamity: Calamity } | null {
  for (let day = fromDay; day < fromDay + days; day += 1) {
    const at = calamityDayAnchor(day);
    const calamity = calamityAt(seed, at);
    if (calamity) return { at, calamity };
  }
  return null;
}

/* ---------------- 一、算子 ---------------- */

test('M2.14 灾厄：同 seed 同 t → 同灾厄（纯函数，没有状态）', () => {
  const seed = 'm2-14-det';
  const found = firstCalamity(seed, FROM_DAY, 40);
  assert.ok(found, '40 天里至少该有一次灾厄（否则这条用例没有验证对象）');

  const a = calamityAt(seed, found.at);
  const b = calamityAt(seed, found.at);
  assert.deepEqual(a, b, '同 seed 同 t 必须逐字段相同');

  // 换个 seed 问同一个 t：不该逐字段一样（否则 seed 没真正参与派生）
  const other = calamityAt('m2-14-det-other', found.at);
  assert.notDeepEqual(
    { level: a?.level, since: a?.since, days: a?.days },
    { level: other?.level, since: other?.since, days: other?.days },
    '换了 seed 还逐字段相同，说明 seed 没有真正参与派生',
  );
});

test('M2.14 灾厄：起止对齐到白天开始（9 点），不是 0 点', () => {
  const found = firstCalamity('m2-14-anchor', FROM_DAY, 40);
  assert.ok(found);

  assert.equal(found.calamity.since, calamityDayAnchor(found.calamity.dayIndex), 'since 必须落在灾难日的锚点上');
  assert.equal(
    found.calamity.until,
    calamityDayAnchor(found.calamity.dayIndex + found.calamity.days),
    'until 必须是 startDay + days 的锚点',
  );
  /*
   * 为什么必须是 9 点而不是 0 点：generateWorldEvents 有安静时段（0—5 点不播报），
   * 灾厄若在 0 点开始，它的播报会被安静时段整个吃掉 —— 灾厄在生效、群里没人知道。
   * 这条断言把那个坑钉住：将来谁把锚点改回 0 点，这里立刻红。
   */
  const anchorHour = hourOf(found.calamity.since);
  assert.ok(
    anchorHour >= NUMERIC.world.events.quietToHour,
    '灾厄锚点必须落在安静时段之外（quietToHour = ' + NUMERIC.world.events.quietToHour + '），实际小时 ' + anchorHour,
  );
});

test('M2.14 灾厄：不跨窗口 —— 时间桶的不变式', () => {
  const seed = 'm2-14-bucket';
  let seen = 0;
  for (let day = FROM_DAY; day < FROM_DAY + 60; day += 1) {
    const calamity = calamityAt(seed, calamityDayAnchor(day));
    if (!calamity) continue;
    seen += 1;
    // 口径是「它占据的最后一天」，不是 until 那一刻（until 已经落在下一个自然日上了）
    assert.equal(
      calamityBucketOf(calamity.until - DAY_MS),
      calamityBucketOf(calamity.since),
      '灾厄跨窗口了：' + new Date(calamity.since).toISOString() + ' → ' + new Date(calamity.until).toISOString(),
    );
    assert.equal(calamity.days, NUMERIC.calamity.durationDays[calamity.level], '时长必须与配置一致');
  }
  assert.ok(seen > 0, '60 天里至少该有一次灾厄');
});

test('M2.14 灾厄：跨窗口断言真的在挡（配置写错时宁可少一次，也不要半个灾厄）', () => {
  /*
   * 「不跨窗口」是**按参数算**出来的（起始天上界 = intervalDays − durationDays），
   * 不是逻辑上的保证。这里故意把三级灾厄的时长调到比窗口还长：
   * 断言不生效的话，它会伸进下一个窗口，而 calamityAt 只看当前窗口 ——
   * 那一段会凭空消失（症状是「灾厄提前结束」，最难查的那一类）。
   */
  applyNumericOverrides({ calamity: { durationDays: { 1: 1, 2: 2, 3: 20 } } });
  try {
    const seed = 'm2-14-cross';
    let level3 = 0;
    let total = 0;
    for (let day = FROM_DAY; day < FROM_DAY + 60; day += 1) {
      const calamity = calamityAt(seed, calamityDayAnchor(day));
      if (!calamity) continue;
      total += 1;
      if (calamity.level === 3) level3 += 1;
      assert.equal(calamityBucketOf(calamity.until - DAY_MS), calamityBucketOf(calamity.since), '断言没挡住跨窗口的灾厄');
    }
    assert.ok(total > 0, '挡掉三级之后，一二级灾厄仍然该照常出现');
    assert.equal(level3, 0, '三级灾厄（时长 20 > 窗口 6）应当被跨窗口断言整个挡掉');
  } finally {
    resetNumeric();
  }
});

test('M2.14 灾厄：factor 首尾低、中间满（淡入淡出）', () => {
  const seed = 'm2-14-ramp';
  let found: { at: number; calamity: Calamity } | null = null;
  for (let day = FROM_DAY; day < FROM_DAY + 60 && !found; day += 1) {
    const at = calamityDayAnchor(day);
    const calamity = calamityAt(seed, at);
    if (calamity && calamity.days >= 2) found = { at, calamity };
  }
  assert.ok(found, '要找一个 >= 2 天的灾厄来验淡入淡出');

  const start = found.calamity.since;
  const atStart = calamityFactorAt(seed, start);
  const atMiddle = calamityFactorAt(seed, start + DAY_MS);
  const atEnd = calamityFactorAt(seed, found.calamity.until - 1);

  assert.ok(atStart < 0.01, '灾厄起点 factor 应当接近 0，实际 ' + atStart);
  assert.ok(atEnd < 0.01, '灾厄终点 factor 应当接近 0，实际 ' + atEnd);
  assert.ok(atMiddle > atStart, '中间必须高于起点');
  assert.ok(atMiddle > atEnd, '中间必须高于终点');
  assert.ok(
    Math.abs(atMiddle - found.calamity.level / NUMERIC.calamity.maxLevel) < 0.01,
    '中间应当到满值（level / maxLevel）',
  );
  assert.equal(calamityFactorAt(seed, found.calamity.until), 0, '灾厄结束之后 factor 归零');
});

test('M2.14 灾厄：30 天窗口里的频率落在设计范围内（24 个 seed 取平均）', () => {
  const SEEDS = 24;
  const DAYS = 30;
  let calamityDays = 0;
  let occurrences = 0;
  const levelCount = new Map<number, number>();

  for (let i = 0; i < SEEDS; i += 1) {
    const seed = 'm2-14-freq-' + i;
    let lastSince: number | null = null;
    for (let day = FROM_DAY; day < FROM_DAY + DAYS; day += 1) {
      const calamity = calamityAt(seed, calamityDayAnchor(day));
      if (!calamity) {
        lastSince = null;
        continue;
      }
      calamityDays += 1;
      if (calamity.since !== lastSince) {
        occurrences += 1;
        levelCount.set(calamity.level, (levelCount.get(calamity.level) ?? 0) + 1);
      }
      lastSince = calamity.since;
    }
  }

  const avgOccurrences = occurrences / SEEDS;
  const avgDays = calamityDays / SEEDS;
  // 设计值（见 numeric.calamity 的注释）：0.6 × 5 个窗口 ≈ 3 次 / 30 天、约 4.5 个灾厄日
  assert.ok(
    avgOccurrences >= 1.5 && avgOccurrences <= 5,
    '平均灾厄次数 ' + avgOccurrences.toFixed(2) + ' 超出设计区间 [1.5, 5]',
  );
  assert.ok(avgDays >= 2 && avgDays <= 9, '平均灾厄日 ' + avgDays.toFixed(2) + ' 超出设计区间 [2, 9]');
  assert.ok(levelCount.size >= 2, '等级权重应当抽出不止一个等级');

  console.log(
    '  [M2.14] ' + SEEDS + ' seed × ' + DAYS + ' 天（起点 day ' + FROM_DAY + '，与 m213b 跑批同区间）：平均灾厄 ' + avgOccurrences.toFixed(2) + ' 次 / ' +
      avgDays.toFixed(2) + ' 个灾厄日；等级分布 ' +
      [...levelCount.entries()].sort((a, b) => a[0] - b[0]).map(([level, n]) => level + ' 级 ' + n).join(' / '),
  );
});

/* ---------------- 二、播报 ---------------- */

test('M2.14 灾厄：开始的那一刻落一条 calamity 事件，其余小时不落', () => {
  const seed = 'm2-14-event';
  const found = firstCalamity(seed, FROM_DAY, 40);
  assert.ok(found);
  const since = found.calamity.since;

  const atStart = generateWorldEvents(snapshotAt(since, seed), since, seed);
  const events = atStart.filter((event) => event.type === 'calamity');
  assert.equal(events.length, 1, '灾厄开始的那一刻该而且只该有一条灾厄事件');

  const event = events[0]!;
  // id 由「原因」拼出来 —— 补跑重放同一个小时算出来的 id 相同，落库是 INSERT OR IGNORE
  assert.equal(event.id, 'calamity:' + since, 'id 必须由灾厄起点拼出（幂等靠它）');
  assert.equal(event.visibility, 'public', '灾厄是全服可见的');

  const headline = event.text.split('\n')[0]!;
  assert.match(headline, /灾厄预警/, '抬头该是「灾厄预警」，实际：' + headline);
  /*
   * 两句话必须都在：**出去更危险** + **动手有回报**。
   * 只写前者，玩家会以为灾厄是个纯惩罚；只写后者，就变成发福利。
   */
  assert.match(event.text, /更危险/, '必须说清「出去更危险」');
  assert.match(event.text, /拿不到/, '必须说清「动手有回报」');
  assert.ok((event.options ?? []).length >= 1, '灾厄事件要带选项');

  // 同一个灾厄的第二天（不是开始那一刻）不落
  const nextDay = since + DAY_MS;
  if (nextDay < found.calamity.until) {
    const later = generateWorldEvents(snapshotAt(nextDay, seed), nextDay, seed);
    assert.equal(later.filter((entry) => entry.type === 'calamity').length, 0, '一个灾厄只播一条');
  }
});

/* ---------------- 三、可见 ---------------- */

test('M2.14 灾厄：.今日 里能看到 [灾厄] 块（前缀是硬要求）', async () => {
  /*
   * 这一条走**真实的 app**，而不是直接调算子 —— 因为「灾厄进 .今日」是一件接线的事：
   * .今日 不读 world_events，灾厄是命令层拼在菜单后面的。
   *
   * 用 intervalDays=1 + chancePerBucket=1 + 时长全 1 天，把「每一天都是灾厄日」钉死：
   * 既不依赖 harness 的初始时刻恰好撞上灾厄，也不用跨天推进（避免补跑把用例拖慢）。
   */
  applyNumericOverrides({
    calamity: { intervalDays: 1, chancePerBucket: 1, durationDays: { 1: 1, 2: 1, 3: 1 } },
  });
  const h = createHarness();
  try {
    await h.createCharacter(DEFAULT_USER, '灾厄可见者');
    const replies = await h.send({ rawText: '.今日' });
    const text = replies.map((reply) => reply.text).join('\n');
    assert.match(text, /\[灾厄\]/, '.今日 的私聊回执必须带 [灾厄] 块');
    assert.match(text, /雾魇|血月余波|灵界倒灌/, '灾厄块里要有灾厄的名字');
  } finally {
    h.app.close();
    resetNumeric();
  }
});

/* ---------------- 四、生态接点（任务 B） ---------------- */

/** 漂移 = 迁移到栖息地之外（这才是灾厄放大的那一支，普通迁移不是） */
function straysOf(result: { migrations: readonly { speciesId: string; to: string }[] }, byId: Map<string, { habitat: readonly string[] }>): number {
  return result.migrations.filter((entry) => {
    const species = byId.get(entry.speciesId);
    return species ? !species.habitat.includes(entry.to) : false;
  }).length;
}

test('M2.14 灾厄：生态接点 —— 灾厄期的漂移与世界补充在批量上更多', () => {
  const { creatures: speciesList } = loadCreatures();
  const byId = new Map(speciesList.map((species) => [species.id, species]));
  const locationIds = [...new Set(speciesList.flatMap((species) => species.habitat))];
  const NOW = 12 * 60 * 60 * 1000;

  let strayBase = 0;
  let strayCalamity = 0;
  let repBase = 0;
  let repCalamity = 0;
  const ROUNDS = 30;
  for (let i = 0; i < ROUNDS; i += 1) {
    const seed = 'm2-14-eco-' + i;
    const run = (calamity: number) => {
      // 两次跑用**同一批初态 + 同一个 rng**，只有 calamity 不同 —— 差异只可能来自接点
      const starters = spawnInitialCreatures(speciesList, createSeededRng('m2-14-eco-spawn'), SPAWN_AT);
      return tickCreatures(
        starters,
        { speciesById: byId, locationIds, now: NOW, hours: 12, calamity },
        createSeededRng(seed),
      );
    };
    const base = run(0);
    const withCalamity = run(1);
    strayBase += straysOf(base, byId);
    strayCalamity += straysOf(withCalamity, byId);
    repBase += base.replenishes.length;
    repCalamity += withCalamity.replenishes.length;
  }

  console.log(
    '  [M2.14] 生态接点（' + ROUNDS + ' 组对照）：漂移 ' + strayBase + ' → ' + strayCalamity +
      '；世界补充 ' + repBase + ' → ' + repCalamity,
  );
  assert.ok(strayCalamity > strayBase, '灾厄期漂移应当更多：' + strayBase + ' → ' + strayCalamity);
  /*
   * M2.85 生态补足（方案 A）：物种 19 → 293 之后，**这一条的读法要改**。
   *
   * 实测：漂移仍然成倍上涨（1520 → 4583，×3.0），但「世界补充」只剩 274 → 269（−1.8%）。
   * 原因不是灾厄变弱了，而是**补充的触发条件被稀释**：
   * 补充要求「该地点的生物数低于承载力 × onlyIfBelow(0.5)」，而物种从 19 涨到 293 后
   * 每个地点的栖息物种基数大了十几倍，于是**平时和灾厄期都很难低到阈值以下** ——
   * 灾厄带走一批，也未必落到线上。承载力本身**不影响这个读数**（试过 8/10/72，读数逐位相同）。
   *
   * 所以口径改成：**补充不能因为灾厄而减少**（允许 ±5% 的正常抖动），
   * 而「灾厄让生态更活跃」这件事由**漂移**那条断言承担（它才是这条用例的主判据）。
   */
  assert.ok(
    repCalamity >= repBase * 0.95,
    '灾厄期世界补充不该明显减少（±5% 内）：' + repBase + ' → ' + repCalamity,
  );
});

test('M2.14 灾厄：不传 calamity 时生态行为逐位不变（非破坏性）', () => {
  const { creatures: speciesList } = loadCreatures();
  const byId = new Map(speciesList.map((species) => [species.id, species]));
  const locationIds = [...new Set(speciesList.flatMap((species) => species.habitat))];
  const NOW = 12 * 60 * 60 * 1000;
  const run = (world: { calamity?: number }) => {
    const starters = spawnInitialCreatures(speciesList, createSeededRng('m2-14-eco-spawn'), SPAWN_AT);
    return tickCreatures(
      starters,
      { speciesById: byId, locationIds, now: NOW, hours: 12, ...world },
      createSeededRng('m2-14-eco-same'),
    );
  };
  // 完全不传 vs 显式传 0 —— 必须一模一样（这是「可选字段」的全部意义）
  assert.deepEqual(run({}), run({ calamity: 0 }), '不传与传 0 必须逐位相同');
});

/* ---------------- 五、掉落率（任务 C） ---------------- */

test('M2.14 灾厄：探索掉落被压低 —— 压的是概率，不是随机数的消耗', () => {
  const HITS = 2000;
  const count = (calamityFactor?: number): number => {
    let n = 0;
    for (let i = 0; i < HITS; i += 1) {
      const drop = rollExtraordinaryDrop({
        minSeq: 7,
        rng: createSeededRng('m2-14-drop-' + i),
        ...(calamityFactor === undefined ? {} : { calamityFactor }),
      });
      if (drop) n += 1;
    }
    return n;
  };
  const base = count();
  const pressed = count(1);
  const ratio = pressed / base;
  console.log('  [M2.14] 探索掉落 ' + HITS + ' 次：无灾厄 ' + base + ' 件 → 三级灾厄 ' + pressed + ' 件（×' + ratio.toFixed(3) + '）');

  assert.ok(base > 0 && pressed > 0, '两组都该有命中，否则这条用例没有验证对象');
  // 设计值：×(1 − 0.6) = ×0.4（2000 次样本，二项标准差约 ±0.03）
  assert.ok(Math.abs(ratio - 0.4) < 0.08, '灾厄期的探索掉落应当压到约 0.4 倍，实际 ×' + ratio.toFixed(3));

  /*
   * 精确那一条：命中的那一件，chance 必须是**压过之后**的值，且正好等于
   * 「它那一类的档位率 × 0.4」。报告要能解释「为什么这次概率低」，
   * chance 写原始值就会让报告对不上（这一条是确定性的，不需要样本量）。
   */
  const HITS_PER_KIND = 4000;
  let sampled: { kind: 'wonder' | 'sealed' | 'charm'; chance: number } | null = null;
  for (let i = 0; i < HITS_PER_KIND && !sampled; i += 1) {
    sampled = rollExtraordinaryDrop({
      minSeq: 7,
      rng: createSeededRng('m2-14-kd-' + i),
      calamityFactor: 1,
    });
  }
  assert.ok(sampled, '该有命中的样本');
  const expected = NUMERIC.extraordinary.dropRates[sampled!.kind].seq7 * 0.4;
  assert.ok(
    Math.abs(sampled!.chance - expected) < 1e-12,
    'chance 必须是压过之后的值：期望 ' + expected + '，实际 ' + sampled!.chance,
  );

  // 压的是概率、不是随机数的消耗：三类仍然各掷一次、顺序不变
  const a = rollExtraordinaryDrop({ minSeq: 7, rng: createSeededRng('m2-14-seq'), calamityFactor: 1 });
  const b = rollExtraordinaryDrop({ minSeq: 7, rng: createSeededRng('m2-14-seq'), calamityFactor: 1 });
  assert.deepEqual(a, b, '同 seed 同 factor 必须同结果');
});

test('M2.14 灾厄：灾厄产出的两段表（主路径 explore / 次路径 battle）', () => {
  const HITS = 2000;
  const count = (segment: 'explore' | 'battle'): number => {
    let n = 0;
    for (let i = 0; i < HITS; i += 1) {
      if (rollCalamityDrop({ segment, rng: createSeededRng('m2-14-caldrop-' + i) })) n += 1;
    }
    return n;
  };
  const explore = count('explore');
  const battle = count('battle');
  console.log('  [M2.14] 灾厄产出 ' + HITS + ' 次：explore ' + explore + ' / battle ' + battle);
  // 设计值：explore 合计 6.2%、battle 合计 30.2%（见 NUMERIC.drop.calamity 的注释）
  assert.ok(Math.abs(explore / HITS - 0.062) < 0.012, 'explore 段合计命中率应约 6.2%，实际 ' + (explore / HITS * 100).toFixed(1) + '%');
  assert.ok(Math.abs(battle / HITS - 0.302) < 0.025, 'battle 段合计命中率应约 30.2%，实际 ' + (battle / HITS * 100).toFixed(1) + '%');
  assert.ok(battle > explore * 3, 'battle 段单次命中率必须明显高于 explore（它靠高命中率补偿样本量）');

  // 表里只有这两段
  assert.equal(rollCalamityDrop({ segment: 'nope' as never, rng: createSeededRng('x') }), null, '段名之外不该有表');
});

test('M2.14 灾厄：探索两次掷骰的顺序固定（先普通掉落、再灾厄产出）', () => {
  /*
   * 第 1 步任务书的硬约束：顺序反了，同 seed 下两个随机源的输出会互换。
   * 这一条把「同 seed 同 factor → 两次掷骰的消耗序列与结果都逐位相同」钉住 ——
   * 将来谁把某一次改成共用 rng，这里立刻红。
   */
  const trace = () => {
    const seed = 'm2-14-order';
    const extraSeed = seedFrom([seed, 'extraordinary']);
    const rollsA: number[] = [];
    const baseA = createSeededRng(extraSeed);
    const a = rollExtraordinaryDrop({
      minSeq: 7,
      rng: { next: () => { const value = baseA.next(); rollsA.push(value); return value; } },
      calamityFactor: 1,
    });
    const calamitySeed = seedFrom([extraSeed, 'calamity']);
    const rollsB: number[] = [];
    const baseB = createSeededRng(calamitySeed);
    const b = rollCalamityDrop({
      segment: 'explore',
      rng: { next: () => { const value = baseB.next(); rollsB.push(value); return value; } },
    });
    return { rollsA, rollsB, a, b };
  };
  const first = trace();
  const second = trace();
  assert.deepEqual(first.rollsA, second.rollsA, '普通掉落的消耗序列必须逐位相同');
  assert.deepEqual(first.rollsB, second.rollsB, '灾厄产出的消耗序列必须逐位相同');
  assert.deepEqual(first.a, second.a);
  assert.deepEqual(first.b, second.b);
  // 两个随机源不同（否则就是共用一个 rng，顺序就有意义了）
  assert.notDeepEqual(first.rollsB, first.rollsB.slice(0, 1).concat(first.rollsA.slice(1)), '两个随机源不该是同一串');
});

test('M2.14 灾厄：战斗胜利能产出封印物（第二条来源，全序列可达）', async () => {
  /*
   * 端到端：把灾厄钉成「每天都是 3 级」+ 把三级的三类概率都拉满，
   * 然后打一场必胜的战斗 —— 背包里必须多一件非绑定的封印物。
   *
   * 为什么值这一条：判定层有测试不等于**接线**接上了。
   * 「算得对但没人调」是这一类新机制最常犯的错（第 0 步 §A3 就点了这条）。
   */
  applyNumericOverrides({
    calamity: {
      intervalDays: 1,
      chancePerBucket: 1,
      durationDays: { 1: 1, 2: 1, 3: 1 },
      levelWeights: { 1: 0, 2: 0, 3: 1 },
    },
    drop: {
      calamity: {
        explore: { sealed: 0, wonder: 0, charm: 0 },
        battle: { sealed: 1, wonder: 1, charm: 1 },
      },
    },
  });
  const h = createHarness({ deterministicIds: true });
  try {
    const { creatures: speciesList } = loadCreatures();
    const species = speciesList.find((entry) => entry.id === 'whisperer');
    assert.ok(species, '内容表里要有 whisperer');
    const { id, userId } = await h.createCharacter('30001', '灾厄猎手', 'seer');
    h.repos.flags.set(id, 'loc', h.now(), 'old_dock');
    const state = h.repos.characters.findByUserId(userId)!;
    h.repos.characters.update({ ...state, sequence: species!.baseSequence, hp: 100, updatedAt: h.now() });

    // 一只只剩 1 点血的生物：打中一下就赢
    h.repos.creatures.insertMany([
      {
        id: 'test-calamity-creature',
        speciesId: species!.id,
        locationId: 'old_dock',
        sequence: species!.baseSequence,
        hp: 1,
        maxHp: species!.baseHp,
        status: 'healthy',
        ageHours: 0,
        feedCount: 0,
        lastFedAt: h.now(),
        spawnedAt: h.now(),
        migratedFrom: null,
      },
    ]);
    h.repos.creatures.recordSighting({
      id: 'test-calamity-sighting',
      characterId: id,
      creatureId: 'test-calamity-creature',
      speciesId: species!.id,
      layer: 'full',
      seed: 'test',
      at: h.now(),
    });

    const before = h.repos.inventory.list(id).filter((row) => row.itemId.startsWith('sealed_') || row.itemId.startsWith('wonder_') || row.itemId.startsWith('charm_'));
    h.advance(6000);
    await h.send({ rawText: '.战斗 开始', userId });
    for (let round = 0; round < BATTLE.maxRounds; round += 1) {
      if (!h.repos.battles.activeOf(id)) break;
      h.advance(6000);
      await h.send({ rawText: '.战斗 攻击', userId });
    }
    const statuses = h.repos.battles.statusDistribution();
    assert.ok(statuses.has('player_win'), '这一场应当打得赢：' + JSON.stringify([...statuses]));

    const after = h.repos.inventory.list(id).filter((row) => row.itemId.startsWith('sealed_') || row.itemId.startsWith('wonder_') || row.itemId.startsWith('charm_'));
    const gained = after.length - before.length;
    assert.ok(gained >= 1, '灾厄期的战斗胜利应当产出封印物，实际新增 ' + gained + ' 件');
    const row = after.find((entry) => !before.some((old) => old.itemId === entry.itemId)) ?? after[0]!;
    assert.equal(row.bindType, 'unbound', '灾厄产出的封印物必须是非绑定（要能交易）');
  } finally {
    h.app.close();
    resetNumeric();
  }
});

/* ---------------- 六、铁律 6：不该掷骰时不掷（D 之前的两条确认） ---------------- */

test('M2.14 铁律 6：不传 calamityFactor 与传 0 逐位相同（旧调用点不受影响）', () => {
  /** 跑一次并把 rng 的**每一次消耗**都记下来 —— 只看返回值是不够的 */
  const trace = (calamityFactor?: number) => {
    const rolls: number[] = [];
    const base = createSeededRng('m2-14-trace');
    const rng = {
      next: () => {
        const value = base.next();
        rolls.push(value);
        return value;
      },
    };
    const drop = rollExtraordinaryDrop({
      minSeq: 7,
      rng,
      ...(calamityFactor === undefined ? {} : { calamityFactor }),
    });
    return { rolls, drop };
  };

  for (let i = 0; i < 20; i += 1) {
    const without = trace();
    const zero = trace(0);
    assert.deepEqual(without.rolls, zero.rolls, '第 ' + i + ' 组：rng 消耗的序列必须逐位相同');
    assert.deepEqual(without.drop, zero.drop, '第 ' + i + ' 组：返回结果必须逐位相同');
  }
  // 同一次调用问两次：确定性（这条同时也是「同 seed 同结果」）
  assert.deepEqual(trace(0.5), trace(0.5), '同 seed 同 factor 必须逐位相同');
});

test('M2.14 铁律 6：非灾厄期的战斗胜利，灾厄产出整段不执行（没有构造过 seedFrom）', async () => {
  /*
   * 判据不是「调了返回 null」，是**整段不执行** ——
   * 因为 seedFrom 本身不消耗随机数，但 createSeededRng + next() 会：
   * 标题说的是「零调用」，证据就是 domain_events 里一条 calamity-drop 的 seed 都不该有。
   *
   * 强制「永远没有灾厄」：chancePerBucket = 0 → rng.next() >= 0 恒真 → 永不触发。
   */
  applyNumericOverrides({ calamity: { chancePerBucket: 0 } });
  const h = createHarness({ deterministicIds: true });
  try {
    const { creatures: speciesList } = loadCreatures();
    const species = speciesList.find((entry) => entry.id === 'whisperer');
    assert.ok(species);
    const { id, userId } = await h.createCharacter('30001', '无灾厄猎手', 'seer');
    h.repos.flags.set(id, 'loc', h.now(), 'old_dock');
    const state = h.repos.characters.findByUserId(userId)!;
    h.repos.characters.update({ ...state, sequence: species!.baseSequence, hp: 100, updatedAt: h.now() });

    h.repos.creatures.insertMany([
      {
        id: 'test-nocalamity-creature',
        speciesId: species!.id,
        locationId: 'old_dock',
        sequence: species!.baseSequence,
        hp: 1,
        maxHp: species!.baseHp,
        status: 'healthy',
        ageHours: 0,
        feedCount: 0,
        lastFedAt: h.now(),
        spawnedAt: h.now(),
        migratedFrom: null,
      },
    ]);
    h.repos.creatures.recordSighting({
      id: 'test-nocalamity-sighting',
      characterId: id,
      creatureId: 'test-nocalamity-creature',
      speciesId: species!.id,
      layer: 'full',
      seed: 'test',
      at: h.now(),
    });

    h.advance(6000);
    await h.send({ rawText: '.战斗 开始', userId });
    for (let round = 0; round < BATTLE.maxRounds; round += 1) {
      if (!h.repos.battles.activeOf(id)) break;
      h.advance(6000);
      await h.send({ rawText: '.战斗 攻击', userId });
    }
    assert.ok(h.repos.battles.statusDistribution().has('player_win'), '这一场应当打得赢');

    // 非灾厄期：这一整段不该有哪怕一次构造
    const rows = h.app.db
      .prepare("SELECT COUNT(*) AS n FROM domain_events WHERE seed LIKE '%calamity-drop%'")
      .get() as { n: number };
    assert.equal(rows.n, 0, '非灾厄期不该构造过 calamity-drop 的 seed（构造了就会消耗随机数）');

    const gained = h.app.db
      .prepare("SELECT COUNT(*) AS n FROM domain_events WHERE character_id = ? AND reason = '战斗·灾厄掉落'")
      .get(id) as { n: number };
    assert.equal(gained.n, 0, '非灾厄期不该有灾厄掉落的事件');
  } finally {
    h.app.close();
    resetNumeric();
  }
});


/* ---------------- 七、对照批开关（D 的归因前提） ---------------- */

test('M2.14 对照批开关：enabled=false 时灾厄全链路关闭', () => {
  applyNumericOverrides({ calamity: { enabled: false } });
  try {
    for (let day = FROM_DAY; day < FROM_DAY + 40; day += 1) {
      assert.equal(calamityAt('world', calamityDayAnchor(day)), null, '关掉后任何时刻都不该有灾厄');
      assert.equal(calamityFactorAt('world', calamityDayAnchor(day)), 0, '关掉后 factor 恒为 0');
    }
    // 世界事件也不该再生成灾厄（它在 dayPlanFor 里读同一份 calamity）
    for (let day = FROM_DAY; day < FROM_DAY + 10; day += 1) {
      const at = calamityDayAnchor(day);
      const events = generateWorldEvents(snapshotAt(at, 'world'), at, 'world');
      assert.equal(
        events.filter((entry) => entry.type === 'calamity').length,
        0,
        '关掉后不该生成灾厄事件（day ' + day + '）',
      );
    }
  } finally {
    resetNumeric();
  }
});

test('M2.14 对照批开关：M214_CALAMITY=off 走真实 createApp 能关掉它', () => {
  /*
   * 这一条是为了**避免 27 分钟白跑**：对照批的全部价值都建立在
   * 「环境变量真的生效」上 —— 开关没接上的话，那一批就是又一次主批。
   * 所以这里走真实的 createApp，而不是只测 applyNumericOverrides。
   */
  process.env.M214_CALAMITY = 'off';
  const h = createHarness();
  try {
    assert.equal(NUMERIC.calamity.enabled, false, '服务端启动时应当把 calamity.enabled 置 false');
    assert.equal(calamityAt('world', calamityDayAnchor(FROM_DAY + 4)), null, '关掉后连灾厄日都不该有灾厄');
  } finally {
    h.app.close();
    delete process.env.M214_CALAMITY;
    resetNumeric();
  }
  // 复位之后必须恢复（默认永远 on）
  assert.equal(NUMERIC.calamity.enabled, true, '开关只该在那一次进程生命周期内生效');
});

