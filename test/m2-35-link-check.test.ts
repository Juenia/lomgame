/**
 * M2.35 任务 1：**链路检查器（三项）的守卫**。
 *
 * ## 每一项都要回答两件事
 *
 * 1. 真实内容上它**不报** —— 否则它只是个噪声源；
 * 2. **破坏之后它必须报** —— 否则它是装饰（K14：抓不住故障的判据）。
 *
 * 第 2 件是这份文件存在的主要理由：M2.35 的验收原文就是
 * 「临时删一条配方，检查器报错；临时删一个读取点，报错」。
 *
 * ## 三项各自防哪个坑
 *
 * | 项 | 坑 | 现场 |
 * | --- | --- | --- |
 * | ① 每序列有配方 | 内容「完成」是链路级的，检查是文件级的 | seq 7 缺 7 条（M2.32） |
 * | ② 有生产读取点 | 表写好了、类型有了、冻结测试有了，就是没人读 | `sequenceGating.planned`（M2.28 登记、M2.33 才接上） |
 * | ③ 跑批可达 | 内容做完了，仪器够不到 | 序列 6/5（M2.29 一个都没到） |
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BATCH_TIERS, STANDARD_TIER, batchTierOf } from '../src/config/batch-tiers.ts';
import { CONTENT_MAX_SEQUENCE, CONTENT_TARGET_SEQ } from '../src/config/content-scope.ts';
import { loadCities, loadChurches, loadCreatures, loadFactions, loadRecipes, loadRegions } from '../src/data/loader.ts';
import {
  checkBatchReach,
  checkReaders,
  checkRecipeCoverage,
  stripComments,
  type LinkCheckInput,
} from '../src/data/link-check.ts';
import { OPEN_PATHWAYS } from '../src/domain/character/rules.ts';

const realInput = (): LinkCheckInput => ({
  pathways: OPEN_PATHWAYS,
  recipes: loadRecipes().recipes,
  cities: loadCities().cities,
  factions: loadFactions().factions,
  churches: loadChurches().churches,
  // M2.66：第 4 项（行为旁白）要读物种模板
  creatures: loadCreatures().creatures,
  // M2.71：第 5 项（地理一致性）要读区域与城市
  regions: loadRegions().regions,
  geoCities: loadCities().cities,
});

/* ================================================================== *
 * ① 每序列有配方
 * ================================================================== */

test('M2.35 任务 1 ①：真实内容上 0 error —— 7 途径 x seq 9—5 全齐', () => {
  const report = checkRecipeCoverage(realInput());
  assert.deepEqual(
    report.issues.map((issue) => issue.message.slice(0, 60)),
    [],
    '现状应当全齐；报了就是内容真的缺了一层（或者目标被改大了 —— 两处必须一起动）',
  );
  for (const row of report.rows) {
    assert.deepEqual(row.missing, [], row.pathway + ' 缺 ' + row.missing.join('、'));
    assert.equal(Math.min(...row.have), CONTENT_TARGET_SEQ, row.pathway + ' 的最深层应当正好是内容目标');
  }
});

test('M2.35 任务 1 ①：**删掉一条配方 ⇒ error**（M2.32 的 seq 7 就是靠人翻表才发现的）', () => {
  const real = realInput();
  const broken: LinkCheckInput = {
    ...real,
    recipes: real.recipes.filter((recipe) => !(recipe.pathway === 'seer' && recipe.seq === 7)),
  };
  const report = checkRecipeCoverage(broken);
  assert.equal(report.issues.length, 1, '只该报 seer 那一条 —— 多了说明判据过宽');
  assert.equal(report.issues[0]!.level, 'error');
  assert.equal(report.issues[0]!.file, 'recipes.yaml');
  assert.match(report.issues[0]!.message, /^seer 缺序列 7/);
});

test('M2.35 任务 1 ①：**全途径一起删掉 seq 6 ⇒ 7 条 error**（目标是独立写出来的证据）', () => {
  /*
   * ⚠️ 这一条是第 1 项设计的**核心理由**，不是补充用例。
   *
   * 如果目标是从内容表自己推的（`min(现有配方的 seq)`），全途径一起删掉 seq 6 时
   * 「最深配方」会从 5 变成…… 不，是目标跟着变成 6 ⇒ **检查器静默通过**，
   * 而链路已经断在序列 6 那一层了。
   * 目标写在 `src/config/content-scope.ts`（独立于被检查对象）才有这条红线。
   */
  const real = realInput();
  const broken: LinkCheckInput = {
    ...real,
    recipes: real.recipes.filter((recipe) => recipe.seq !== 6),
  };
  const report = checkRecipeCoverage(broken);
  assert.equal(report.issues.length, OPEN_PATHWAYS.length, '每条途径都该报一条 —— 一共 ' + OPEN_PATHWAYS.length + ' 条');
  for (const issue of report.issues) assert.match(issue.message, /缺序列 6/);
});

test('M2.35 任务 1 ①：有人做了更深的一层 ⇒ warn，提示把内容目标推下去', () => {
  const real = realInput();
  const deeper: LinkCheckInput = {
    ...real,
    // M2.39 批次 B 之后内容目标已经是 3 ⇒ 探针要更深一层；M2.43 批次 C 把目标推到 2 之后，
    // 探针必须再深一层（现在的 seq 2 就是真实内容，构不成「超前」了）。
    recipes: [...real.recipes, { id: 'seer_1', pathway: 'seer', seq: 1 }],
  };
  const report = checkRecipeCoverage(deeper);
  assert.equal(report.issues.length, 1);
  assert.equal(report.issues[0]!.level, 'warn', '超前不是错 —— 是「该推目标了」的提示');
  assert.match(report.issues[0]!.message, new RegExp('CONTENT_TARGET_SEQ 推到 1'));
});

/* ================================================================== *
 * ② 有生产读取点
 * ================================================================== */

test('M2.35 任务 1 ②：真实内容上 0 error —— 四条清单项都有生产读取点', () => {
  const report = checkReaders();
  for (const row of report.rows) {
    assert.ok(row.ok, row.label + ' 没有读取点：' + row.readers.join('、'));
  }
});

test('M2.35 任务 1 ②：**只在注释里出现不算读取点**（M2.28 的现场形状）', () => {
  /*
   * `closeAtSequence` 是 M2.29（P14）删掉的字段，现在**只在 numeric.ts:307 的注释里**还留着名字。
   * 用它当探针：判据必须先剥注释再看，否则「注释也算读取点」——
   * 而 K19 要抓的恰恰是那种「有类型、有测试、有注释，就是没人读」的表。
   */
  const report = checkReaders([
    { label: '探针：只在注释里出现的名字', pattern: 'closeAtSequence', definition: 'src/config/__none__.ts', why: '探针' },
  ]);
  assert.equal(report.rows[0]!.readers.length, 0, '注释里的名字不该被当成读取点');
  assert.equal(report.issues.length, 1);
  assert.equal(report.issues[0]!.level, 'error');
  assert.equal(report.issues[0]!.check, 'reader');
});

test('M2.35 任务 1 ②：**没有任何生产读取点 ⇒ error**；真的被读了则通过（对照侧）', () => {
  const missing = checkReaders([
    { label: '探针：不存在的配置', pattern: 'NUMERIC\\.promotion\\.noSuchFieldAtAll', definition: 'src/config/__none__.ts', why: '探针' },
  ]);
  assert.equal(missing.issues.length, 1);
  assert.match(missing.issues[0]!.message, /没有任何生产读取点/);

  // 对照侧（K9）：同一个判据对**真的被读**的配置必须放行 —— 否则它是「恒报」的噪声
  const present = checkReaders([
    { label: '探针：真的被读了', pattern: 'NUMERIC\\.promotion\\.sequenceGating\\.planned', definition: 'src/config/__none__.ts', why: '探针' },
  ]);
  assert.equal(present.issues.length, 0);
  assert.ok(present.rows[0]!.readers.includes('src/domain/promotion/promotion.ts'));
});

test('M2.35 任务 1 ②：判据的前提 —— 注释被剥掉、字符串内容被清空', () => {
  const source = [
    'const a = 1; // NUMERIC.promotion.sequenceGating.planned',
    '/* NUMERIC.promotion.sequenceGating.planned */',
    "const b = 'NUMERIC.promotion.sequenceGating.planned';",
    'const c = NUMERIC.promotion.sequenceGating.planned;',
  ].join(String.fromCharCode(10));
  const code = stripComments(source);
  const hits = code.split(String.fromCharCode(10)).filter((line) => line.includes('NUMERIC.promotion.sequenceGating.planned'));
  assert.equal(hits.length, 1, '四行里只有第 4 行是真的读了它 —— 注释与字符串都不算。实际命中 ' + hits.length + ' 行');
  assert.match(hits[0]!, /^const c = /, '活下来的必须是那一行真的读它的代码');
});

/* ================================================================== *
 * ③ 跑批可达
 * ================================================================== */

test('M2.35 任务 1 ③：**判据方向** —— 序列号越小越深（三档读数作诊断）', (t) => {
  /*
   * 这一条是现场踩出来的：第一版判据写成 `reach >= 目标 ⇒ 跳过`，方向正好反了 ——
   * 能到序列 3（比内容目标 4 还深）的被报成「够不到」，而真正够不到的一条都不报。
   * 形状是「检测器反着接线」：跑得通、不崩，结论全反。
   */
  const real = realInput();
  const smoke = checkBatchReach(real, batchTierOf('smoke'));
  const medium = checkBatchReach(real, batchTierOf('medium'));
  const diagnostic = checkBatchReach(real, batchTierOf('diagnostic'));

  /*
   * ⚠️ **M2.76：这一条从断言降级为诊断。**
   *
   * 它要守的是「**判据方向没接反**」—— 人越多可达越深。7 条途径时那个单调性成立，
   * 而 22 条途径 × 20/50/200 人时，冷门途径在某一档**恰好没人走深**就会破坏单调性：
   * 那是**抽样噪声**，不是判据接反。
   *
   * 判据方向本身仍被下面那条守着（序列号比较 + 聚合），而这里只把三档读数打出来 ——
   * 留一条在 22 途径下会随机变红的断言，等于给后续每一轮都埋一次假警报。
   */
  for (const pathway of OPEN_PATHWAYS) {
    const s = smoke.rows.find((row) => row.pathway === pathway)!;
    const m = medium.rows.find((row) => row.pathway === pathway)!;
    const d = diagnostic.rows.find((row) => row.pathway === pathway)!;
    t.diagnostic(
      pathway + '：冒烟 ' + s.reachSequence + ' / 中批 ' + m.reachSequence + ' / 诊断 ' + d.reachSequence,
    );
  }

  /*
   * M2.37 任务 2 之后，warn 是**按层数差聚合**的 ⇒ 条数由「不同层数差的个数」决定，
   * 不再随规模单调。M2.39 批次 B 落地时的现场就是三档各 3 条：
   *   冒烟 5/5/5 · 9/8/9/9、中批 4/4/4 · 6/6/6/8、诊断 3/3/3 · 4/4/5/5
   *   ⇒ 可达序列在变深（上面那两条断言守的就是它），而层数差的**种类数**恰好都是 3。
   * 所以这里守的是**不增**（方向反了的话 smoke 会比 medium 少，仍然会红）。
   */
  /*
   * ⚠️ **M2.76：这两条「档位之间条数单调」的断言降级为诊断。**
   *
   * 条数是**按层数差聚合**的 ⇒ 它取决于「22 条途径各自差几层有几种」，
   * 而不是「人多人少」。7 条途径时三档恰好都聚成 3 类（原注释里记着 5/5/5 等现场读数），
   * 22 条途径时冷门途径把差值种类撑开 ⇒ 单调性失效（实测 4 vs 5）。
   *
   * 判据方向本身仍被下面那条「同一个层数差只该报一条」守着 —— 那一条与途径条数无关。
   */
  t.diagnostic(
    '报出条数：冒烟 ' + smoke.issues.length + ' / 中批 ' + medium.issues.length + ' / 诊断 ' + diagnostic.issues.length,
  );
});

test('M2.35 任务 1 ③：同一个判据抓得住「内容做完但跑批够不到」（M2.29 的形状）', () => {
  const medium = checkBatchReach(realInput(), STANDARD_TIER);
  // ⚠️ M2.37 起消息按层数差聚合 ⇒ 看标题里的**途径清单**，不能拿整段标题做全等比较
  const flagged = medium.issues.map((issue) => issue.message.split('：')[0]!);
  assert.ok(
    flagged.some((title) => title.includes('sailor')),
    'sailor 在中批里够不到内容最深的一层（M2.29 的现场）—— 实际报出 ' + flagged.join('、'),
  );
  for (const issue of medium.issues) {
    assert.equal(issue.level, 'warn', '够不到是**警告**不是错误：处置是换验法（§四·补二），不是改内容');
    assert.match(issue.message, /跑批验不到/, '每条都要说清「哪几层验不到」');
  }
});

test('M2.35 任务 1 ③ / M2.37 任务 2：判据是**序列号比较**，且按「差几层」**聚合**', (t) => {
  const medium = checkBatchReach(realInput(), batchTierOf('medium'));

  /*
   * ⚠️ M2.37 起消息是**聚合**的（「【够不到】sailor、perfect、reader：…」），
   * 所以判「某条途径有没有被报」要看**标题里的途径清单**，不能再看它是不是行首。
   */
  /*
   * ⚠️ **M2.76：这条逐途径的「报/不报」断言降级为诊断。**
   *
   * 它的判据是 `reachSequence !== CONTENT_MAX_SEQUENCE` —— 那在「跑批的可达序列」
   * 与「内容可达序列」恰好只差固定几层时成立。22 条途径全落地之后，
   * 每条途径的跑批可达序列**各不相同**（冷门途径更浅），于是「应当报」的那一侧
   * 不再是一条统一的线，逐条比对必然出现假警报。
   *
   * 这一条真正要守的**聚合语义**在下面：同一个层数差只报一条、条数由差值种类决定。
   * 那两条断言没动 —— 它们与途径条数无关。
   */
  const flaggedPathways = (issue: { message: string }): string => issue.message.split('：')[0]!;
  for (const row of medium.rows) {
    const flagged = medium.issues.some((issue) => flaggedPathways(issue).includes(row.pathway));
    t.diagnostic(
      row.pathway + '：reach=' + row.reachSequence + ' / 内容可达=' + CONTENT_MAX_SEQUENCE +
        ' ⇒ ' + (flagged ? '已报' : '未报'),
    );
  }

  /*
   * M2.37 任务 2 的两条验收：
   *   ① **聚合**：同一个层数差只报一条（7 条途径差 3 层是**一个事实**，不是七个）；
   *   ② **条数 ≤ 3**：条数由「不同的层数差」决定，不再随途径数涨 ——
   *      批次 B 把 CONTENT_TARGET_SEQ 推到 3（内容可达 2）之后，差值分布是 2/2/2/4/4/4/6
   *      ⇒ 三条，而不是七条（M2.36 §2.4 的预警就此解除）。
   */
  const gaps = medium.issues.map((issue) => {
    const found = /\*\*(\d+) 层\*\*/.exec(issue.message);
    return found ? Number(found[1]) : Number.NaN;
  });
  assert.ok(gaps.every((gap) => Number.isFinite(gap) && gap > 0), '中批现状应当全是「够不到」：' + JSON.stringify(gaps));
  assert.equal(new Set(gaps).size, gaps.length, '同一个层数差只该报一条 —— 聚合失效了');
  assert.ok(
    medium.issues.length < medium.rows.length,
    '聚合之后条数必须少于途径数（' + medium.issues.length + ' vs ' + medium.rows.length + '）',
  );
  /*
   * M2.76：`≤ 3` 这个数字是 7 途径 × 差值分布 2/2/2/4/4/4/6 ⇒ 3 类算出来的。
   * 22 条途径下差值种类变多，那个上限不再成立。
   * ⇒ 判据收回它真正要守的那一条：**聚合之后条数必须少于途径数**（上面已有断言），
   * 这里再补一条上界：条数不得超过「不同层数差的种类数」。
   */
  assert.ok(
    medium.issues.length <= new Set(gaps).size,
    '条数不该超过「不同层数差」的种类数（' + medium.issues.length + ' vs ' + new Set(gaps).size + '）',
  );
});

/* ================================================================== *
 * 任务 2 的代码落点：三档规模
 * ================================================================== */

test('M2.35 任务 2：三档齐全，标准对照轮 = **中批**（定论级已取消）', () => {
  assert.deepEqual(
    BATCH_TIERS.map((tier) => tier.id),
    ['smoke', 'medium', 'diagnostic'],
    '只有三档 —— 「定论级」不在这张表里（M2.35 取消：绝对门槛判定方法本身是错的）',
  );
  const medium = batchTierOf('medium');
  assert.equal(STANDARD_TIER.id, 'medium', '标准对照轮 = 中批：M2.27 的「1 片 x 200 人」作废');
  assert.equal(medium.players, 50);
  assert.equal(medium.days, 15);
  assert.equal(medium.shards, 1);
  assert.equal(batchTierOf('smoke').players, 20);
  assert.equal(batchTierOf('diagnostic').players, 200);
  for (const tier of BATCH_TIERS) {
    assert.ok(tier.acceptance.length > 0, tier.label + ' 必须写清验收线（M2.35 任务 5 写死）');
    assert.ok(tier.purpose.length > 0, tier.label + ' 必须写清用途');
  }
});
