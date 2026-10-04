/**
 * 后台那五个「原先没做」的面板（M2.53）。
 *
 * 每一条都守着一个**会静默出错**的地方：
 *   · 日志缓冲：容量上限、meta 序列化失败不能把主流程打挂
 *   · 审计检索：归档表必须一起查（只查热表会让人以为「查不到」）
 *   · 世界状态：必须只读（世界是全服共享的，没有回滚就不该有写入口）
 *   · 内容校验：条目数不能是 0 —— 那说明根本没装载成功，而不是「没问题」
 *   · 模拟：上限要**明确拒绝**，不能默默跑一个缩水版（那样结论与参数不符）
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { searchAudit } from '../src/admin/audit.ts';
import { contentView } from '../src/admin/content.ts';
import { SIM_LIMITS, runSim } from '../src/admin/sim.ts';
import { worldView } from '../src/admin/world.ts';
import { LogBuffer, bufferedLogger } from '../src/infra/log-buffer.ts';
import { SimReportRepo } from '../src/infra/db/sim-reports.ts';
import { STRATEGY_IDS } from '../src/sim/strategy.ts';
import { migrate, openDatabase, type Db } from '../src/infra/db/sqlite.ts';

function freshDb(): Db {
  const db = openDatabase(':memory:');
  migrate(db);
  return db;
}

/* ---------------- 日志 ---------------- */

test('日志缓冲：容量是硬的，超了挤掉最旧的（内存不随运行时长增长）', () => {
  // 容量有下限（10）：太小的缓冲连一次启动都装不下，没有意义
  const buf = new LogBuffer(10);
  assert.equal(buf.capacity, 10);
  for (let i = 1; i <= 25; i += 1) buf.push('info', '第 ' + i + ' 条');
  assert.equal(buf.size(), 10);
  const recent = buf.recent({ limit: 20 });
  assert.equal(recent.length, 10);
  assert.equal(recent[0]!.message, '第 25 条', '最新的要在最前');
  assert.equal(recent[9]!.message, '第 16 条');
  assert.ok(buf.dropped() > 0, '挤掉了多少条要能说出来 —— 不然人不知道这个窗口有多短');
});

test('日志缓冲：meta 序列化失败不能把主流程打挂（记日志本身绝不能抛）', () => {
  const buf = new LogBuffer(10);
  const circular: Record<string, unknown> = { a: 1 };
  circular['self'] = circular;
  assert.doesNotThrow(() => buf.push('error', '带循环引用', circular));
  assert.equal(buf.recent()[0]!.meta, '（meta 无法序列化）');
  // 超长 meta 要被截断：有的地方会塞整个事件 payload 进来
  buf.push('info', '带大对象', { payload: 'x'.repeat(5000) });
  assert.ok((buf.recent()[0]!.meta ?? '').length < 900, 'meta 没截断，600 条就能吃掉几十兆');
});

test('日志缓冲：按级别与关键词过滤，同时写缓冲和控制台', () => {
  const buf = new LogBuffer(50);
  const seen: string[] = [];
  const logger = bufferedLogger(buf, {
    info: (m) => seen.push('info:' + m),
    warn: (m) => seen.push('warn:' + m),
    error: (m) => seen.push('error:' + m),
  });
  logger.info('适配器启动', { appId: '1' });
  logger.error('网关断了', { code: 4009 });
  logger.info('内容已装载');

  assert.deepEqual(seen.length, 3, '控制台也要照旧看得到');
  assert.equal(buf.counts().error, 1);
  assert.equal(buf.counts().info, 2);
  assert.equal(buf.recent({ level: 'error' }).length, 1);
  // 关键词要连 meta 一起找
  assert.equal(buf.recent({ q: '4009' }).length, 1);
  assert.equal(buf.recent({ q: '启动' }).length, 1);
  assert.equal(buf.recent({ q: '不存在的东西' }).length, 0);
});

/* ---------------- 审计检索 ---------------- */

test('审计检索：热表与归档表一起查（只查热表会让人以为「查不到」）', () => {
  const db = freshDb();
  db.prepare('INSERT INTO audit_logs (user_id, command, input, output, created_at) VALUES (?,?,?,?,?)')
    .run('u1', '状态', '.状态', 'HP 100', 1000);
  db.prepare('INSERT INTO audit_logs_archive (id, user_id, command, input, output, created_at, archived_at) VALUES (?,?,?,?,?,?,?)')
    .run(99, 'u1', '制作', '.制作', '成功', 500, 2000);

  const all = searchAudit(db, {});
  assert.equal(all.hot, 1);
  assert.equal(all.archived, 1);
  assert.equal(all.total, 2);
  assert.deepEqual(all.hits.map((h) => h.command), ['状态', '制作'], '要按时间倒序');
  assert.deepEqual(all.hits.map((h) => h.archived), [false, true], '要标出来自哪张表');

  // 过滤
  assert.equal(searchAudit(db, { command: '制作' }).total, 1);
  assert.equal(searchAudit(db, { userId: 'u1' }).total, 2);
  assert.equal(searchAudit(db, { text: '成功' }).total, 1);
  assert.equal(searchAudit(db, { from: 800 }).total, 1);
  assert.equal(searchAudit(db, { from: 800, to: 1200 }).total, 1);
  // 生效的条件要回显 —— 免得以为筛过了其实没筛
  assert.ok(searchAudit(db, { command: '制作' }).applied.some((x) => x.includes('制作')));
  assert.deepEqual(searchAudit(db, {}).applied, []);
});

test('审计检索：结果被截断时要明说，而不是假装只有这些', () => {
  const db = freshDb();
  for (let i = 0; i < 30; i += 1) {
    db.prepare('INSERT INTO audit_logs (user_id, command, input, output, created_at) VALUES (?,?,?,?,?)')
      .run('u1', '状态', '', '', 1000 + i);
  }
  const out = searchAudit(db, { limit: 10 });
  assert.equal(out.hits.length, 10);
  assert.equal(out.total, 30);
  assert.equal(out.truncated, true);
  assert.equal(searchAudit(db, { limit: 10, userId: 'nobody' }).truncated, false);
});

/* ---------------- 世界状态 ---------------- */

test('世界状态：只读，并且把天气连地点名一起给出来（界面上一列 id 没人看得懂）', () => {
  const db = freshDb();
  db.prepare("INSERT INTO locations (id, name, min_seq) VALUES ('loc_a', '老码头', 9)").run();
  db.prepare('INSERT INTO location_weather (location_id, weather, since, until, updated_at) VALUES (?,?,?,?,?)')
    .run('loc_a', 'fog', 1000, 2000, 1000);

  const view = worldView(db, 1500);
  assert.equal(view.readOnly, true, '世界面板必须是只读的');
  assert.equal(view.weather.rows.length, 1);
  assert.equal(view.weather.rows[0]!.locationName, '老码头', '地点名没连出来');
  assert.ok(view.weather.rows[0]!.weatherLabel.length > 0, '天气要显示中文');
  assert.deepEqual(view.weather.distribution.map((d) => d.count), [1]);
  assert.ok(Array.isArray(view.events.latest));
  assert.equal(typeof view.clock.timeOfDay, 'string');
});

test('世界状态：生态栏要能看出「哪条链路根本没跑起来」', () => {
  const db = freshDb();
  /*
   * 空库也要给全六个键 —— 面板就是按这六个画的，缺一个那格会变成 undefined。
   * 而「某几项恒为 0」正是这个面板存在的理由：实测第一次打开就发现
   * 只有迁移在动，捕食 / 进化 / 死亡累计全是 0，那不是节奏问题，是链路没跑起来。
   */
  const empty = worldView(db, Date.now());
  assert.deepEqual(
    Object.keys(empty.ecology.totals).sort(),
    ['birth', 'death', 'evolve', 'feed', 'migrate', 'replenish'],
  );
  assert.equal(empty.ecology.creatures, 0);
  assert.equal(empty.ecology.ticks.length, 0);

  db.prepare(
    'INSERT INTO creature_species (id, name, base_sequence, habitat_json, pathway_affinity_json, ' +
    'drops_json, behaviors_json, habits_json, tick_rate, base_hp, perception_json, updated_at) ' +
    "VALUES (?,?,?,'[]','[]','[]','[]','[]','hourly',?, '{}', ?)",
  ).run('wisp', '游魂', 9, 10, 1000);
  db.prepare(
    'INSERT INTO creatures (id, species_id, location_id, sequence, hp, max_hp, status, age_hours, feed_count, spawned_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
  ).run('c1', 'wisp', 'loc_a', 9, 10, 10, 'healthy', 0, 0, 1000);
  for (const [key, at, summary] of [
    ['k1', 1000, { migrate: 2, feed: 0, evolve: 0, birth: 1, death: 0, replenish: 0 }],
    ['k2', 2000, { migrate: 1, feed: 7, evolve: 0, birth: 0, death: 3, replenish: 0 }],
  ] as Array<[string, number, Record<string, number>]>) {
    db.prepare('INSERT INTO creature_ticks (tick_key, tick_at, executed_at, summary_json) VALUES (?,?,?,?)')
      .run(key, at, at + 1, JSON.stringify(summary));
  }

  const view = worldView(db, 3000);
  assert.equal(view.ecology.creatures, 1);
  assert.equal(view.ecology.species, 1);
  assert.equal(view.ecology.bySpecies[0]!.name, '游魂', '物种要显示中文名，不是 id');
  assert.equal(view.ecology.byLocation[0]!.name, 'loc_a', '地点名取不到时退回 id，不能空着');
  assert.deepEqual(view.ecology.totals, { migrate: 3, feed: 7, evolve: 0, birth: 1, death: 3, replenish: 0 });
  assert.equal(view.ecology.ticks[0]!.tickKey, 'k2', '最新的 tick 要在最前');
  // 累计是**加总**，不是取最后一次
  assert.equal(view.ecology.totals.migrate, 3);
});

/* ---------------- 内容校验 ---------------- */

test('内容校验：跑的是内容层与卡片层**本来就在跑**的检查，条目数不能是 0', () => {
  const view = contentView();
  assert.equal(view.loadError, null, '内容装载不该失败：' + String(view.loadError));
  // 条目数为 0 说明根本没装载成功 —— 那才是真问题，不能当成「通过」
  const byLabel = Object.fromEntries(view.checked.map((c) => [c.label, c.value]));
  assert.ok(byLabel['事件卡']! > 0, '一张事件卡都没装载到');
  assert.ok(byLabel['物品']! > 0);
  assert.ok(byLabel['地点']! > 0);
  assert.ok(byLabel['配方']! > 0);
  assert.ok(byLabel['能力']! > 0);
  for (const issue of view.issues) {
    assert.ok(issue.level === 'error' || issue.level === 'warn', '级别只有这两种：' + issue.level);
    assert.ok(issue.message.length > 0);
    assert.ok(issue.where.length > 0, '每条问题都要能定位');
    assert.ok(issue.source === 'cards' || issue.source === 'content');
  }
  assert.equal(view.counts.error, view.issues.filter((i) => i.level === 'error').length);
});

/* ---------------- 模拟 ---------------- */

test('模拟：上限是硬的，超了明确拒绝 —— 不能默默跑一个缩水版', () => {
  const db = freshDb();
  const bad = [
    { characters: 0, days: 1 },
    { characters: SIM_LIMITS.maxCharacters + 1, days: 1 },
    { characters: 10, days: SIM_LIMITS.maxDays + 1 },
    { characters: 10, days: 1, strategies: ['不存在的策略'] },
    // 用真实 id 凑「超过上限」的情况 —— 写死一个不存在的策略会被静默过滤，
    // 那样这条用例就永远通过了（曾经就写过一个不存在的 'balanced'）
    { characters: 10, days: 1, strategies: STRATEGY_IDS.slice(0, SIM_LIMITS.maxStrategies + 1) },
  ];
  for (const body of bad) {
    const out = runSim(db, body as Record<string, unknown>);
    assert.equal(out.ok, false, JSON.stringify(body) + ' 应该被拒绝');
    assert.ok(!out.ok && out.error.length > 0);
  }
  // 被拒绝时不该留下任何留档
  assert.equal(new SimReportRepo(db).count(), 0);
});

test('模拟：不传策略时默认取前几个，不该必然撞上「策略太多」', () => {
  const db = freshDb();
  /*
   * 原来默认取**全部**策略，而策略总数多于 maxStrategies ——
   * 于是「什么都不传」必然被拒，而且报的是策略问题。
   * 实测时一个真正超限的 300×30 请求就这样拿到了错误的报错，指错方向。
   */
  const out = runSim(db, { characters: 5, days: 2, seed: 'default-strategies' });
  assert.ok(out.ok, !out.ok ? out.error : '');
  assert.equal(out.runs.length, SIM_LIMITS.maxStrategies, '默认取前 maxStrategies 个');
});

test('模拟：人数与天数的问题要报人数与天数，不能被策略的问题顶掉', () => {
  const db = freshDb();
  const tooMany = runSim(db, { characters: 9999, days: 1, strategies: STRATEGY_IDS });
  assert.equal(tooMany.ok, false);
  assert.ok(!tooMany.ok && tooMany.error.includes('人数'), '报错指错了方向：' + (!tooMany.ok ? tooMany.error : ''));
});

test('模拟：小规模真的能跑完，结论里包含目标对照，并留档进 sim_reports', () => {
  const db = freshDb();
  const out = runSim(db, { characters: 8, days: 3, seed: 'admin-test', strategies: ['steady'] });
  assert.ok(out.ok, !out.ok ? out.error : '');
  assert.equal(out.runs.length, 1);
  const run = out.runs[0]!;
  assert.equal(run.strategy, 'steady');
  assert.ok(run.checks.length > 0, '要有 W5 目标对照');
  assert.ok(run.oneLine.length > 0);
  assert.ok(run.markdown.includes('失控'), '完整报告应当有内容');
  assert.equal(typeof run.elapsedMs, 'number');

  assert.ok(out.savedId, '结论要留档，不然复盘时找不到依据');
  const repo = new SimReportRepo(db);
  assert.equal(repo.count(), 1);
  assert.equal(repo.latest(1)[0]!.id, out.savedId);
  assert.deepEqual((repo.latest(1)[0]!.config as { seed: string }).seed, 'admin-test');
});

test('模拟：界面上的策略选项必须来自唯一出处（写死过一份，里面有个不存在的策略）', async () => {
  const { SIM_STRATEGY_CHOICES } = await import('../src/admin/sim.ts');
  assert.deepEqual(SIM_STRATEGY_CHOICES.map((s) => s.id), [...STRATEGY_IDS]);
  for (const s of SIM_STRATEGY_CHOICES) {
    assert.ok(s.name.length > 0, s.id + ' 没有中文名');
    assert.ok(s.description.length > 0, s.id + ' 没有说明');
  }
  // 界面上不该再写死一份策略表
  const { readFileSync } = await import('node:fs');
  const js = readFileSync('src/admin/console.js', 'utf8');
  assert.ok(!js.includes('均衡型'), 'console.js 又把策略表写死回来了');
});

test('模拟：同一次参数跑两遍结果一致（纯函数，不依赖数据库状态）', () => {
  const a = runSim(freshDb(), { characters: 6, days: 2, seed: 'same', strategies: ['steady'] });
  const b = runSim(freshDb(), { characters: 6, days: 2, seed: 'same', strategies: ['steady'] });
  assert.ok(a.ok && b.ok);
  assert.equal(a.runs[0]!.oneLine, b.runs[0]!.oneLine, '同一个种子必须给同一个结论');
});
