/**
 * M2.59：文明势力实体与反应引擎。
 *
 * 这一份守的是「哪个势力反应」这个问题第一次有答案：
 *
 *   1. 内容表：11 家势力，id 与既有 factions 表的重叠部分完全一致（通缉链路零改动）；
 *   2. 属地判定：领地优先、区域次之、home_region 为空则无处不在；
 *   3. 相关性：不同**类型**的势力在意不同的事（警察厅管目击、黑帮管灾厄）；
 *   4. 反应强度与门槛：不是每家都会动，且一次最多三家（防刷屏）；
 *   5. 动作：不同类型的势力对同一件事做出**不同**的事（这是「谁动了」的内容）；
 *   6. 警觉会涨也会落（闭环）；
 *   7. 幂等：同一次事件重放得到同一批反应 id。
 *
 * 第 3、5 两条是这一层区别于「给势力加几个字段」的地方：
 * 势力不是装饰性的名片，它要**对不同的事做出不同的反应**。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadContent, loadPowers } from '../src/data/loader.ts';
import {
  PowerIndex,
  PowerSchema,
  actionOf,
  alertDeltaOf,
  decayAlert,
  relevanceOf,
  resolvePowerReactions,
  type Power,
  type PowerEvent,
  type PowerState,
} from '../src/domain/world/power.ts';

const CONTENT = loadContent();
const POWERS = CONTENT.powers;
const REGIONS = new Set(CONTENT.regions.map((region) => region.id));

/** 造一家测试用的势力（不依赖内容表当前写了什么） */
function fakePower(patch: Partial<Power> = {}): Power {
  return {
    id: 'p1',
    name: '试验势力',
    type: 'police',
    description: '',
    home_region: '',
    stance: 'neutral',
    goals: [],
    resources: { manpower: 0.5, wealth: 0.5, mystic: 0.3 },
    relations: [],
    ...patch,
  };
}

function ev(patch: Partial<PowerEvent> = {}): PowerEvent {
  return { kind: 'sighting', locationId: 'loc_a', severity: 0.6, at: 1000, sourceId: 'src1', ...patch };
}

function stateOf(powerId: string, alert: number): PowerState {
  return { powerId, alert, influence: 0.5, reactionCount: 0, lastReactionAt: null };
}

/* ================================================================== *
 * 一、内容表（真实数据）
 * ================================================================== */

test('M2.59 势力：内容表有 11 家，且 id 全部合法、区域存在', () => {
  assert.equal(POWERS.length, 11, '势力数应当是 11 —— 内容表改了要先想清楚为什么');
  const ids = POWERS.map((power) => power.id);
  assert.equal(ids.length, new Set(ids).size, '势力 id 不能重复');
  for (const power of POWERS) {
    if (power.home_region !== '') {
      assert.ok(REGIONS.has(power.home_region), power.id + ' 的 home_region 不存在：' + power.home_region);
    }
    assert.ok(power.goals.length >= 1, power.id + ' 至少要有一个目标 —— 没有目标的势力不会对任何事反应');
  }
});

test('M2.59 势力：与既有 factions 表的重叠 id 完全一致（通缉链路零改动）', () => {
  /*
   * 这是兼容性的核心一条：powers.yaml 里 police / church / gang 三家的 id
   * 必须与 M2.6 的 factions 表**逐字相同** —— 否则 wanted_states.faction_id
   * 会指向一个在新表里查不到的 id，而症状只是「通缉后没人来抓」。
   */
  const ids = new Set(POWERS.map((power) => power.id));
  for (const legacy of ['police', 'church', 'gang']) {
    assert.ok(ids.has(legacy), '既有势力 id 必须保留：' + legacy);
  }
  // 无主**不该**出现在这里：它的语义是「没有任何人管」，给它目标等于制造一个势力
  assert.ok(!ids.has('none'), 'none（无主）不该是一个有目标的势力');
});

test('M2.59 势力：七家正神教会都有实体（信仰同时也是世俗力量）', () => {
  const churchIds = new Set(POWERS.filter((p) => p.type === 'church').map((p) => p.id));
  for (const id of ['night_goddess', 'god_of_war', 'storm_lord', 'god_of_steam', 'god_of_knowledge', 'earth_mother', 'eternal_blazing_sun']) {
    assert.ok(churchIds.has(id), '缺教会的势力实体：' + id);
  }
});

test('M2.59 势力：loader 在真实内容上不报势力相关的错', () => {
  const related = CONTENT.issues.filter((issue) => /势力 |home_region/.test(issue.message));
  assert.deepEqual(related.map((issue) => issue.message), [], '真实内容上势力校验不该报任何东西');
});

test('M2.59 势力：schema 拦住越界的资源与关系', () => {
  // 资源必须在 0—1（写错量级是最常见的内容错，而症状是「那家势力行为完全失控」）
  assert.equal(PowerSchema.safeParse({ id: 'x', name: 'x', type: 'police', resources: { manpower: 5 } }).success, false);
  assert.equal(PowerSchema.safeParse({ id: 'x', name: 'x', type: 'police', resources: { manpower: 0.5 } }).success, true);
  // 类型是枚举：写错一个名字启动就报错
  assert.equal(PowerSchema.safeParse({ id: 'x', name: 'x', type: '不存在的类型' }).success, false);
  // 关系 kind 是枚举
  assert.equal(
    PowerSchema.safeParse({ id: 'x', name: 'x', type: 'police', relations: [{ to: 'y', kind: '不认识' }] }).success,
    false,
  );
});

/* ================================================================== *
 * 二、属地判定
 * ================================================================== */

test('M2.59 势力：属地判定是两级 —— 领地优先，区域次之', () => {
  const index = new PowerIndex(
    [fakePower({ id: 'police', home_region: 'loen' }), fakePower({ id: 'storm', home_region: 'sunia' })],
    (id) => (id === 'police' ? ['tingen'] : []),
    (loc) => (loc === 'coral_reef' ? 'sunia' : 'loen'),
  );
  assert.equal(index.isHomeOf('police', 'tingen'), true, '领地内算主场');
  assert.equal(index.isHomeOf('police', 'backlund'), true, '领地外但在主场区域内，也算');
  assert.equal(index.isHomeOf('storm', 'coral_reef'), true, '区域匹配');
  assert.equal(index.isHomeOf('storm', 'tingen'), false, '既不在领地也不在主区域 → 不是主场');
});

test('M2.59 势力：home_region 为空的势力无处不在', () => {
  const index = new PowerIndex([fakePower({ id: 'crown', home_region: '' })], () => [], () => 'loen');
  assert.equal(index.isHomeOf('crown', '任何地方'), true, '空 home_region = 哪里都插得上手');
  // 全境事件（locationId 为 null）只有无处不在的势力算主场
  assert.equal(index.isHomeOf('crown', null), true);
  const local = new PowerIndex([fakePower({ id: 'gang', home_region: 'loen' })], () => [], () => 'loen');
  assert.equal(local.isHomeOf('gang', null), false, '一场全境灾厄对只管一块地的黑帮不是主场');
});

/* ================================================================== *
 * 三、相关性与动作：不同类型的势力在意不同的事、做不同的事
 * ================================================================== */

test('M2.59 势力：不同类型的势力在意不同的事', () => {
  const police = fakePower({ id: 'police', type: 'police' });
  const gang = fakePower({ id: 'gang', type: 'gang' });
  const sighting = ev({ kind: 'sighting' });
  const calamity = ev({ kind: 'calamity' });
  assert.ok(
    relevanceOf(police, sighting) > relevanceOf(police, calamity),
    '警察厅对目击比对灾厄在意（它管街上，不管世界）',
  );
  assert.ok(
    relevanceOf(gang, calamity) > relevanceOf(gang, sighting),
    '黑帮对灾厄比对目击在意（灾难是行情）',
  );
  assert.ok(relevanceOf(gang, calamity) > 0, '黑帮不是对什么都无感 —— 它只是关心的东西不一样');
});

test('M2.59 势力：长期目标会给相关事件加成', () => {
  const plain = fakePower({ goals: ['随便什么'] });
  const purifier = fakePower({ goals: ['净化污染'] });
  const environment = ev({ kind: 'environment' });
  assert.ok(
    relevanceOf(purifier, environment) > relevanceOf(plain, environment),
    '目标里写着「净化污染」的势力对环境异象更敏感',
  );
});

test('M2.59 势力：同一件事，不同类型的势力做不同的事', () => {
  const event = ev({ kind: 'environment', severity: 0.9 });
  assert.equal(actionOf(fakePower({ type: 'police' }), event, 0.9), 'lockdown');
  assert.equal(actionOf(fakePower({ type: 'church' }), event, 0.9), 'purify');
  assert.equal(actionOf(fakePower({ type: 'gang' }), event, 0.9), 'exploit', '黑帮只会趁乱动手');
  assert.equal(actionOf(fakePower({ type: 'royal' }), event, 0.9), 'lockdown');
  // 强度低时动作不同：投入少只能先看看
  assert.equal(actionOf(fakePower({ type: 'police' }), event, 0.3), 'patrol');
  assert.equal(actionOf(fakePower({ type: 'church' }), event, 0.3), 'investigate');
});

/* ================================================================== *
 * 四、反应引擎：门槛、上限、属地加成、幂等
 * ================================================================== */

test('M2.59 势力：不是每家都会动 —— 强度过不了门槛就不出现', () => {
  const weak = fakePower({ id: 'weak', resources: { manpower: 0.4, wealth: 0.5, mystic: 0.3 } });
  const reactions = resolvePowerReactions({
    // 严重度极低 + 资源很少 → 反应强度低于门槛
    powers: [weak],
    event: ev({ severity: 0.05 }),
    states: new Map(),
  });
  assert.deepEqual(reactions, [], '小事 + 没本钱 = 不动，这是「不是每家都会动」的落点');
});

test('M2.59 势力：一次事件最多三家（防刷屏）', () => {
  const many = Array.from({ length: 11 }, (_, i) =>
    fakePower({ id: 'p' + i, name: '势力' + i, type: 'police' }),
  );
  const reactions = resolvePowerReactions({
    powers: many,
    event: ev({ severity: 0.9 }),
    states: new Map(),
  });
  assert.ok(reactions.length > 0, '强度足够时应当有势力动');
  assert.ok(reactions.length <= 3, '最多三家 —— 一次灾厄不该让 11 家全动，实际 ' + reactions.length);
  // 取的是强度最高的那几家
  for (let i = 1; i < reactions.length; i += 1) {
    assert.ok(reactions[i - 1]!.strength >= reactions[i]!.strength, '结果必须按强度降序');
  }
});

test('M2.59 势力：属地加成让本土势力更容易动', () => {
  const power = fakePower({ id: 'local', resources: { manpower: 0.3, wealth: 0.5, mystic: 0.3 } });
  const event = ev({ severity: 0.3 });
  const withoutHome = resolvePowerReactions({ powers: [power], event, states: new Map() });
  const withHome = resolvePowerReactions({
    powers: [power],
    event,
    states: new Map(),
    isHomeOf: () => true,
  });
  assert.ok(
    withHome.length >= withoutHome.length,
    '属地加成不该让反应变少：' + withoutHome.length + ' -> ' + withHome.length,
  );
  if (withoutHome.length > 0 && withHome.length > 0) {
    assert.ok(withHome[0]!.strength > withoutHome[0]!.strength, '在自家地盘上反应更强');
  }
});

test('M2.59 势力：警觉越高反应越强（闭环的一半）', () => {
  const power = fakePower({ id: 'edgy' });
  // 严重度要够高，否则连基线都过不了门槛 —— 那样这条用例什么也测不到
  const event = ev({ severity: 0.8 });
  const calm = resolvePowerReactions({ powers: [power], event, states: new Map() });
  const alert = resolvePowerReactions({
    powers: [power],
    event,
    states: new Map([['edgy', stateOf('edgy', 1)]]),
  });
  if (calm.length > 0 && alert.length > 0) {
    assert.ok(alert[0]!.strength > calm[0]!.strength, '刚出过事的势力下一次反应更强');
  }
  assert.ok(calm.length > 0, '前提：这件事本来就会让它动');
});

test('M2.59 势力：反应 id 幂等 —— 同一次事件重放得到同一批 id', () => {
  const power = fakePower({ id: 'p', type: 'church' });
  const a = resolvePowerReactions({ powers: [power], event: ev({ severity: 0.8 }), states: new Map() });
  const b = resolvePowerReactions({ powers: [power], event: ev({ severity: 0.8 }), states: new Map() });
  assert.deepEqual(a.map((r) => r.id), b.map((r) => r.id), '同输入必须同 id（否则重放会重复播报）');
  assert.ok(a[0]!.id.includes('src1'), 'id 里要含事件来源，才能保证跨事件唯一');
});

/* ================================================================== *
 * 五、警觉：有涨有落
 * ================================================================== */

test('M2.59 势力：警觉会涨也会落，不是单调计数器', () => {
  const power = fakePower({ id: 'p' });
  const reactions = resolvePowerReactions({ powers: [power], event: ev({ severity: 0.8 }), states: new Map() });
  assert.ok(reactions.length > 0, '前提：先要有一次反应');
  const delta = alertDeltaOf(reactions[0]!);
  assert.ok(delta > 0 && delta < 0.2, '单次涨幅要小 —— 警觉是靠次数攒起来的：' + delta);
  assert.equal(alertDeltaOf({ ...reactions[0]!, strength: 0 }), 0, '零强度不涨警觉');
  const start = 0.6;
  assert.ok(decayAlert(start, 24) < start, '一天之后要落一点');
  assert.ok(decayAlert(start, 24) > 0, '不该归零 —— 警觉不是开关');
  assert.equal(decayAlert(0, 10), 0);
  assert.equal(decayAlert(start, 0), start);
});

test('M2.59 势力：空势力表不崩（内容缺失时的兜底）', () => {
  const index = new PowerIndex([]);
  assert.equal(index.size, 0);
  assert.equal(index.isHomeOf('anyone', 'anywhere'), false);
  assert.deepEqual(resolvePowerReactions({ powers: [], event: ev(), states: new Map() }), []);
  assert.equal(actionOf(fakePower({ type: 'order' }), ev(), 0.9), 'investigate', '未实现的类型要有默认动作');
});

test('M2.59 势力：读不到 powers 文件时报问题而不是抛异常', () => {
  const result = loadPowers('不存在的文件.yaml', REGIONS);
  assert.ok(result.issues.length > 0, '读不出文件时要报问题，不能静默返回空表');
  assert.equal(result.powers.length, 0);
});
