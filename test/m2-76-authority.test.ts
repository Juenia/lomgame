/**
 * M2.76：**权柄 → 世界状态覆盖层**（机制验证）。
 *
 * 这一条验的是「权柄影响世界 seed」这件事**在结构上成立**：
 *   ① 覆盖写进去之后，读天气真的变了（而且是**所有下游**都变 —— 它们只经过 weatherOf）；
 *   ② 到期之后**自动失效**，不需要清理任务；
 *   ③ 地点覆盖优先于全服覆盖；
 *   ④ applyAuthority 的期限算对。
 *
 * ⚠️ **接线还没做**（触发方：世界 tick / 后台）—— 见 M2.76 交付说明的「未接线」一节。
 *    机制与内容都已就位，触发方接上即可生效。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadContent } from '../src/data/loader.ts';
import { applyAuthority, pickAuthority } from '../src/infra/authority.ts';
import { createSeededRng } from '../src/domain/rng.ts';
import { advanceWorld } from '../src/infra/world-tick.ts';
import { createHarness } from './helpers/app.ts';

const AUTHORITY = {
  id: 'authority_test',
  pathway: 'seer' as const,
  name: '权柄·测试',
  weather: 'storm',
  scope: '*',
  duration_hours: 3,
  broadcast: '风暴来了。',
  note: '',
  /*
   * M2.87：`effects` 是新增的**除天气以外的改写维度**。
   * 这个测试只关心天气那条路径，所以留空 —— 但这一个空数组是必须的：
   * zod 的 `.default([])` 让**输出类型**里它是必填的（输入可以省略）。
   * 这也是它该有的样子：读的人不必到处判 undefined。
   */
  effects: [],
};

test('M2.76 覆盖层：写进去之后读天气真的变了（所有下游共用这一条读路径）', () => {
  const h = createHarness();
  try {
    const now = h.now();
    const before = h.app.router.deps.world.weatherOf('old_dock', now);
    assert.notEqual(before, 'storm', '前置：老码头本来不该是风暴');

    applyAuthority(h.app.router.deps.world, AUTHORITY, now);
    assert.equal(
      h.app.router.deps.world.weatherOf('old_dock', now),
      'storm',
      '覆盖生效：读到的是权柄写的那个天气',
    );
    // 另一处地点同样生效（scope = '*' 是全服）
    assert.equal(h.app.router.deps.world.weatherOf('backlund', now), 'storm', '全服覆盖对每座城都生效');
  } finally {
    h.app.close();
  }
});

test('M2.76 覆盖层：到期之后**自动失效**，不需要清理任务', () => {
  const h = createHarness();
  try {
    const now = h.now();
    applyAuthority(h.app.router.deps.world, AUTHORITY, now);
    const until = now + 3 * 3_600_000;
    assert.equal(h.app.router.deps.world.weatherOf('old_dock', until - 1), 'storm', '到期前仍然生效');
    assert.notEqual(
      h.app.router.deps.world.weatherOf('old_dock', until + 1),
      'storm',
      '到期后自动失效 —— 读的时候带 until > now，所以不需要清理任务',
    );
    assert.deepEqual(h.app.router.deps.world.activeOverrides(until + 1), [], '过期的不再怎么查都不在');
  } finally {
    h.app.close();
  }
});

test('M2.76 覆盖层：地点覆盖优先于全服覆盖（更具体的优先）', () => {
  const h = createHarness();
  try {
    const now = h.now();
    applyAuthority(h.app.router.deps.world, AUTHORITY, now);
    h.app.router.deps.world.setOverride(
      { kind: 'weather', scope: 'old_dock', value: 'clear', until: now + 3_600_000, source: 'gm' },
      now,
    );
    assert.equal(h.app.router.deps.world.weatherOf('old_dock', now), 'clear', '地点覆盖压过全服覆盖');
    assert.equal(h.app.router.deps.world.weatherOf('backlund', now), 'storm', '别的地方仍走全服覆盖');
  } finally {
    h.app.close();
  }
});

test('M2.91 权柄内容表：每条一个可判定的天气、id 唯一、22 条途径都有人管', () => {
  const { authorities } = loadContent();
  /*
   * ⚠️ M2.91：这条原来断言「22 条、每条途径恰好一条」—— 那是**扩表之前**的口径。
   * 现在一条途径可以有多条权柄（愚者一系就有愚弄 / 重组 / 奇迹 / 历史 / 变形 / 空间牢笼），
   * 所以判据改成守**反面**：id 不许重复、22 条途径一条都不许空着。
   * 「各途径出手频率一样」这件事不再靠条数，靠 pickAuthority 的两级等权。
   */
  assert.ok(authorities.length >= 22, '权柄条数不该少于途径数：' + authorities.length);
  assert.equal(new Set(authorities.map((a) => a.id)).size, authorities.length, '权柄 id 不许重复');
  assert.equal(new Set(authorities.map((a) => a.pathway)).size, 22, '22 条途径每一条都要有权柄');
  for (const authority of authorities) {
    assert.ok(authority.weather.length > 0, authority.id + ' 缺 weather');
    assert.ok(authority.duration_hours > 0, authority.id + ' 的期限必须为正');
    assert.ok(authority.broadcast.length > 0, authority.id + ' 缺全服播报');
  }
});

test('M2.76 端到端：权柄真的会在世界 tick 里发生（接线验证）', () => {
  const h = createHarness();
  try {
    const deps = h.app.router.deps;
    assert.ok(deps.authorities.length > 0, '前置：RouterDeps 里注入了权柄');

    let now = h.now();
    let firedAt = -1;
    /*
     * 每小时 1/96 ⇒ 400 小时里至少发生一次的概率是 1 − (95/96)^400 ≈ 98.5%。
     * seed 固定（世界 seed + 小时键），所以这个循环是**确定性**的 —— 不是掷骰子碰运气。
     */
    for (let i = 0; i < 400; i += 1) {
      now += 3_600_000;
      advanceWorld(deps, now);
      if (deps.world.activeOverrides(now).length > 0) { firedAt = i; break; }
    }
    assert.ok(firedAt >= 0, '400 小时里没有发生任何权柄 —— 接线断了（世界 tick 没调 applyAuthority）');

    const overrides = deps.world.activeOverrides(now);
    assert.equal(overrides[0]!.kind, 'weather');
    assert.ok(overrides[0]!.source.startsWith('authority:'), '来源记为 authority:<id>（与失控事件的 source 同一口径）');
    /*
     * 覆盖生效之后，**读天气真的变了** —— 而且这是所有下游共用的那一条读路径。
     * 注意要按「覆盖写进去那一刻」的 now 去读：权柄有期限（6—8 小时），
     * 而循环里的 now 已经推进到了触发之后。
     */
    const weather = deps.world.overrideWeatherOf('old_dock', now);
    assert.notEqual(weather, null, '全服覆盖对任意地点都生效');
  } finally {
    h.app.close();
  }
});

test('M2.76 权柄选取：等权、可复现、空表返回 null', () => {
  const { authorities } = loadContent();
  const a = pickAuthority(authorities, createSeededRng('x'));
  const b = pickAuthority(authorities, createSeededRng('x'));
  assert.equal(a?.id, b?.id, '同 seed 同结果');
  assert.equal(pickAuthority([], createSeededRng('x')), null, '空表返回 null，不抛错');
  const counts = new Map<string, number>();
  const rng = createSeededRng('spread');
  for (let i = 0; i < 2200; i += 1) {
    const picked = pickAuthority(authorities, rng)!;
    counts.set(picked.id, (counts.get(picked.id) ?? 0) + 1);
  }
  // M2.91：条数不再写死 —— 判据是「每一条都抽到过」（两级等权下每条都有非零概率）
  assert.equal(counts.size, authorities.length, '2200 次抽样应当把每一条权柄都抽到过');
});

test('M2.91 两级等权：扩表之后各**途径**的出手频率仍然一致（条数不影响）', () => {
  /*
   * 这是本轮扩表的**配套判据**。
   *
   * 一级等权（在全部权柄里平抽）在「一条途径一条权柄」时是对的；一旦愚者有 6 条、
   * 别人 1 条，愚者就会出手 6 倍频繁 —— 那不是设计，是数据条数的副作用。
   * 所以 pickAuthority 改成两级：先按途径等权抽一次，再在该途径内等权抽。
   *
   * 两条一起守：
   *   ① **途径之间**的次数要贴住平均值（否则扩表把平衡改掉了）；
   *   ② **同一途径内部**的各条也都要被抽到（否则多写的权柄是摆设）。
   */
  const { authorities } = loadContent();
  const rng = createSeededRng('fairness');
  const byPathway = new Map<string, number>();
  const byAuthority = new Map<string, number>();
  const N = 22000;
  for (let i = 0; i < N; i += 1) {
    const picked = pickAuthority(authorities, rng)!;
    byPathway.set(picked.pathway, (byPathway.get(picked.pathway) ?? 0) + 1);
    byAuthority.set(picked.id, (byAuthority.get(picked.id) ?? 0) + 1);
  }
  assert.equal(byPathway.size, 22, '22 条途径都该有机会出手');
  const expected = N / 22;
  for (const [pathway, n] of byPathway) {
    assert.ok(
      Math.abs(n - expected) / expected < 0.15,
      pathway + ' 出手 ' + n + ' 次，偏离均匀值 ' + Math.round(expected) + ' 太多 —— 条数又影响到频率了',
    );
  }
  // 同途径内部每条都要抽到（愚者那一系扩表后有 6 条）
  const seerIds = authorities.filter((a) => a.pathway === 'seer').map((a) => a.id);
  assert.ok(seerIds.length > 1, '前置：愚者一系应当有多条权柄（扩表第一批量）');
  assert.deepEqual(seerIds.filter((id) => !byAuthority.has(id)), [], '愚者一系里有权柄一次都没被抽到');
});
