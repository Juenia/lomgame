/**
 * M2.67：**势力系统里「只落数据」的四件东西接上判定**。
 *
 * ## 这一份守什么
 *
 * M2.59 交付了势力系统，但内容表与状态表里有四处**没有判定读取点**（盘点结果，见 M2.66 交付说明）：
 *
 * | 字段 | 处境 | 这一轮的落点 |
 * | --- | --- | --- |
 * | `resources.wealth` 财力 | 11 家各写了一份，零读取 | ① 进「这次投入多少」的加权；② 决定公告**挂多久**（enduranceOf） |
 * | `resources.mystic` 神秘侧 | 同上 | 进「这次投入多少」的加权（**按事件类型**：目击看神秘侧、灾厄看人力） |
 * | `influence` 影响力 | 表里有列、代码只做 round-trip（**永远 0.5**） | 属地之外的手伸长度 + **会涨会落** |
 * | `manpower` 人力 | 有读取点（旧口径） | 进同一张权重表（口径统一，不再是「唯一算数的那一项」） |
 *
 * 四条纪律照旧：缺省 = 中性（不排斥现有数据）、判定层纯函数零 IO、数值跟着函数走、
 * 每一项都有端到端证据。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadContent, loadPowers } from '../src/data/loader.ts';
import {
  INFLUENCE_NEUTRAL,
  PowerIndex,
  decayInfluence,
  enduranceOf,
  influenceDeltaOf,
  reachFactorOf,
  relevanceOf,
  resolvePowerReactions,
  resourceMixOf,
  type Power,
  type PowerEvent,
  type PowerEventKind,
  type PowerState,
} from '../src/domain/world/power.ts';
import { notePowerReactions, decayPowerAlert } from '../src/infra/power-reactions.ts';
import { createHarness } from './helpers/app.ts';

const POWERS = loadPowers().powers;
const CONTENT = loadContent();

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

function ev(kind: PowerEventKind, patch: Partial<PowerEvent> = {}): PowerEvent {
  return { kind, locationId: 'loc_a', severity: 0.6, at: 1000, sourceId: 'src1', ...patch };
}

function stateOf(powerId: string, patch: Partial<PowerState> = {}): PowerState {
  return { powerId, alert: 0, influence: INFLUENCE_NEUTRAL, reactionCount: 0, lastReactionAt: null, ...patch };
}

const KINDS: readonly PowerEventKind[] = ['sighting', 'calamity', 'environment', 'rumor'];

/* ================================================================== *
 * 一、三项资源都进判定（没有一项是摆设）
 * ================================================================== */

test('M2.67 资源：三张权重表每行都为 1 —— 于是 mix 与单项资源同一个尺子', () => {
  /*
   * 判据：对每一种事件类型，把三项资源都设成 1 → mix 必须是 1；都设成 0 → mix 必须是 0。
   * 这等价于「每行权重和为 1」，而且顺手排除了「某一项权重是 0」（那就是**摆设**——
   * 正是这一轮要修的形状：wealth / mystic 此前权重就是 0）。
   */
  for (const kind of KINDS) {
    const full = fakePower({ resources: { manpower: 1, wealth: 1, mystic: 1 } });
    const none = fakePower({ resources: { manpower: 0, wealth: 0, mystic: 0 } });
    assert.equal(resourceMixOf(full, ev(kind)), 1, kind + '：三项满值时本钱必须是 1');
    assert.equal(resourceMixOf(none, ev(kind)), 0, kind + '：三项为零时本钱必须是 0');

    // 每一项**单独**都能把 mix 抬起来（没有权重为 0 的摆设）
    for (const key of ['manpower', 'wealth', 'mystic'] as const) {
      const only = fakePower({ resources: { manpower: 0, wealth: 0, mystic: 0, [key]: 1 } });
      assert.ok(resourceMixOf(only, ev(kind)) > 0, kind + '：' + key + ' 对这件事一点用都没有 —— 那就是摆设');
    }
  }
});

test('M2.67 资源：同一份资源在不同事件上本钱不同（目击看神秘侧、灾厄看人力）', () => {
  const mysticHeavy = fakePower({ resources: { manpower: 0.2, wealth: 0.2, mystic: 1 } });
  const muscleHeavy = fakePower({ resources: { manpower: 1, wealth: 0.2, mystic: 0.1 } });

  assert.ok(
    resourceMixOf(mysticHeavy, ev('sighting')) > resourceMixOf(muscleHeavy, ev('sighting')),
    '撞见不该撞见的东西：神秘侧强的那家本钱更多',
  );
  assert.ok(
    resourceMixOf(muscleHeavy, ev('calamity')) > resourceMixOf(mysticHeavy, ev('calamity')),
    '大灾：人多的那家本钱更多',
  );
});

test('M2.67 资源（真实内容）：灵异的事第一次由教会领跑，而不是警察', () => {
  /*
   * 这是**这一轮的行为改变**，用真实内容表量出来（而不是只断言公式）：
   * 警察厅 manpower 0.8 / mystic 0.1，黑夜女神教会 manpower 0.6 / mystic 0.8。
   *
   * 旧口径（只看 manpower）下：警察 0.88 > 教会 0.76 —— 灵异事件由警察领跑，
   * 而内容表里写的明明是「神秘侧力量：对付非凡事件的本钱」。
   */
  const police = POWERS.find((power) => power.type === 'police')!;
  const church = POWERS.find((power) => power.type === 'church')!;
  const sighting = ev('sighting');

  const policeMix = resourceMixOf(police, sighting);
  const churchMix = resourceMixOf(church, sighting);
  assert.ok(police.resources.mystic < church.resources.mystic, '对照前提：教会的神秘侧确实更强');
  assert.ok(police.resources.manpower > church.resources.manpower, '对照前提：警察的人力确实更多');
  assert.ok(
    churchMix > policeMix,
    '对目击，教会的本钱必须比警察高（' + churchMix.toFixed(3) + ' vs ' + policeMix.toFixed(3) + '）',
  );

  // 而两家的**相关度**没变（这一轮不动 relevanceOf）—— 变的只有本钱
  assert.ok(relevanceOf(police, sighting) > 0, '警察仍然在意目击，只是本钱不如教会');
});

/* ================================================================== *
 * 二、财力 → 公告挂多久
 * ================================================================== */

test('M2.67 财力：公告时长随财力线性变化，中性财力 = ×1', () => {
  assert.equal(enduranceOf(fakePower({ resources: { manpower: 0.5, wealth: 0.5, mystic: 0.3 } })), 1);
  assert.equal(enduranceOf(fakePower({ resources: { manpower: 0.5, wealth: 0, mystic: 0.3 } })), 0.5);
  assert.equal(enduranceOf(fakePower({ resources: { manpower: 0.5, wealth: 1, mystic: 0.3 } })), 1.5);
});

test('M2.67 财力（端到端）：富的那家公告挂得久', () => {
  const h = createHarness({ deterministicIds: true });
  try {
    const rich = fakePower({
      id: 'rich', name: '有钱的', home_region: '', resources: { manpower: 0.9, wealth: 1, mystic: 0.5 },
    });
    const poor = fakePower({
      id: 'poor', name: '没钱的', home_region: '', resources: { manpower: 0.9, wealth: 0, mystic: 0.5 },
    });
    const index = new PowerIndex([rich, poor]);
    const reactions = notePowerReactions({
      db: h.app.db,
      powerIndex: index,
      worldEvents: h.app.router.deps.worldEvents,
      locationId: 'loc_a',
      locationName: '某地',
      kind: 'sighting',
      severity: 0.9,
      sourceId: 'm2-67-wealth',
      now: h.now(),
    });
    assert.equal(reactions.length, 2, '对照前提：两家都该动（否则比不出时长）');
    const rows = h.app.router.deps.worldEvents.all();
    const byPower = new Map(rows.map((row) => [row.factionId ?? '', row]));
    const richRow = byPower.get('rich');
    const poorRow = byPower.get('poor');
    assert.ok(richRow !== undefined && poorRow !== undefined, '对照前提：两条公告都落了库');
    const richTtl = (richRow.expiresAt ?? 0) - h.now();
    const poorTtl = (poorRow.expiresAt ?? 0) - h.now();
    assert.ok(poorTtl > 0 && richTtl > poorTtl, '富的那条必须挂得更久（' + richTtl + ' vs ' + poorTtl + '）');
    assert.ok(richTtl / poorTtl > 2.5, 'wealth 1 vs 0 的比值应当接近 3（1.5 / 0.5）');
  } finally {
    h.app.close();
  }
});

/* ================================================================== *
 * 三、影响力 → 区外的手伸长度 + 会涨会落
 * ================================================================== */

test('M2.67 影响力：属地内不看它，属地外中性值 = ×1（缺省不改变任何东西）', () => {
  assert.equal(reachFactorOf(0.1, true), 1, '自家地盘上再没影响力也压得住');
  assert.equal(reachFactorOf(INFLUENCE_NEUTRAL, false), 1, '缺省影响力在区外必须恰好中性');
  assert.ok(reachFactorOf(0.2, false) < 1, '影响力低于中性 → 手伸不长');
  assert.ok(reachFactorOf(0.9, false) > 1, '影响力高于中性 → 区外更有分量');
});

test('M2.67 影响力：太低就不在属地之外动手（倍率之外还有一道门槛）', () => {
  const power = fakePower({ id: 'weak', home_region: 'ruen' });
  const index = new PowerIndex([power], () => [], () => 'other_region');
  const event = ev('sighting', { severity: 1 });
  const base = { powers: [power], event, isHomeOf: (id: string, loc: string | null) => index.isHomeOf(id, loc) };

  const abroad = resolvePowerReactions({
    ...base,
    states: new Map([['weak', stateOf('weak', { influence: 0.35 })]]),
  });
  const tooWeak = resolvePowerReactions({
    ...base,
    states: new Map([['weak', stateOf('weak', { influence: 0.2 })]]),
  });
  assert.ok(abroad.length > 0, '影响力 0.35（过门槛）时它仍然会伸手');
  assert.deepEqual(tooWeak, [], '影响力 0.2 时它管不到别人的地盘 —— 不是「弱一点」，是压根不动');
});

test('M2.67 影响力：属地内涨、属地外落，且向中性值回归', () => {
  const home = { powerId: 'p', powerName: 'P', action: 'patrol' as const, locationId: 'l', strength: 1, reason: '', id: 'x' };
  const abroad = { ...home, strength: 0.5 };
  assert.ok(influenceDeltaOf(home, true) > 0, '在自家地盘上压住一次 → 影响力上升');
  assert.ok(influenceDeltaOf(abroad, false) < 0, '把手伸到别人的地方 → 影响力下降');
  assert.equal(influenceDeltaOf(home, true), 0.05);
  assert.equal(influenceDeltaOf(abroad, false), -0.04);
  assert.equal(influenceDeltaOf({ ...home, strength: 0 }, true), 0, '零强度不改变任何东西');

  // 回归：高的落、低的涨、中性的不动
  assert.ok(decayInfluence(1, 24) < 1, '影响力会回落');
  assert.ok(decayInfluence(1, 24) > INFLUENCE_NEUTRAL, '但不会一天掉到中性');
  assert.ok(decayInfluence(0, 24) > 0, '掉下去的影响力会慢慢长回来');
  assert.equal(decayInfluence(INFLUENCE_NEUTRAL, 240), INFLUENCE_NEUTRAL, '中性的永远中性');
});

test('M2.67 影响力（端到端）：反应之后真的写进了 power_state，tick 之后真的回归', () => {
  const h = createHarness({ deterministicIds: true });
  try {
    const power = fakePower({ id: 'homebody', name: '守家的', home_region: '' });
    const index = new PowerIndex([power]);
    const deps = h.app.router.deps;

    notePowerReactions({
      db: h.app.db,
      powerIndex: index,
      worldEvents: deps.worldEvents,
      locationId: 'loc_a',
      locationName: '某地',
      kind: 'sighting',
      severity: 0.9,
      sourceId: 'm2-67-influence',
      now: h.now(),
    });
    const row = h.app.db
      .prepare('SELECT influence, reaction_count FROM power_state WHERE power_id = ?')
      .get('homebody') as { influence: number; reaction_count: number };
    assert.ok(row.reaction_count > 0, '对照前提：它确实动过一次');
    assert.ok(
      row.influence > INFLUENCE_NEUTRAL,
      '在自己地盘上动一次 → 影响力必须涨（实际 ' + row.influence + '）',
    );

    // 跑一次衰减：影响力向中性值回归
    decayPowerAlert(h.app.db, index, h.now(), 240);
    const after = h.app.db
      .prepare('SELECT influence FROM power_state WHERE power_id = ?')
      .get('homebody') as { influence: number };
    assert.ok(after.influence < row.influence, '衰减必须把它拉回来');
    assert.ok(after.influence >= INFLUENCE_NEUTRAL, '但不该穿过中性值');
  } finally {
    h.app.close();
  }
});

/* ================================================================== *
 * 四、对照侧：不传状态时一切照旧
 * ================================================================== */

test('M2.67 对照侧：没有状态行的势力不受影响力规则影响（缺省 = 中性）', () => {
  const power = fakePower({ id: 'p', home_region: 'ruen' });
  const index = new PowerIndex([power], () => [], () => 'other_region');
  const withNoState = resolvePowerReactions({
    powers: [power],
    event: ev('sighting', { severity: 0.9 }),
    states: new Map(),
    isHomeOf: (id, loc) => index.isHomeOf(id, loc),
  });
  const withNeutralState = resolvePowerReactions({
    powers: [power],
    event: ev('sighting', { severity: 0.9 }),
    states: new Map([['p', stateOf('p')]]),
    isHomeOf: (id, loc) => index.isHomeOf(id, loc),
  });
  assert.deepEqual(
    withNoState.map((r) => r.strength),
    withNeutralState.map((r) => r.strength),
    '没有状态行 与 中性状态行 必须得到同一个强度（否则缺省值就在偷偷改玩法）',
  );
  assert.ok(withNoState.length > 0, '对照前提：它本来就会动');
  assert.ok(CONTENT.powers.length === POWERS.length, '内容表读得到');
});
