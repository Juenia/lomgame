/**
 * M2.169：**神明的阴谋是世界级的**（用户口径：「不要小打小闹」）。
 *
 * 这一条守五件事：
 *   ① 关系网是真的（两端都得在神座表里 —— 写错就等于那条边永远匹配不上）
 *   ② **觊觎是有方向的**（原初魔女觊觎月亮 ≠ 月亮觊觎原初魔女 —— 第一版写成了无向）
 *   ③ 阶段是累积的：结盟 → 渗透 → 削弱 → 神战 → 陨落，390 天，跳不过去
 *   ④ 结算默认是**失败或半成**，而且旧日杀不死（原作明写「无法真正杀死祂」）
 *   ⑤ 端到端：一场阴谋真的能**改掉神座**（这是「世界级」与「一条播报」的分界）
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { DivineRelationFileSchema, type DivineRelation } from '../src/domain/world/divine-relation.ts';
import {
  DIVINE_SCHEME_URGE_PER_HOUR,
  SCHEME_STAGE_DAYS,
  SCHEME_STAGES,
  canSchemeAgainst,
  exposureGain,
  nextStageAt,
  resolveScheme,
  stageAfter,
  type DivineSchemeState,
} from '../src/domain/world/divine-scheme.ts';
import { mergeThroneState } from '../src/domain/world/divine-throne-state.ts';
import { mergeScars } from '../src/domain/world/world-scar.ts';
import { churchFateLineOf, fateAfterFall, stillActive } from '../src/domain/world/church-fate.ts';
import {
  contributionOf,
  creditLineOf,
  firstCreditOf,
  meddleChance,
  meddleEffect,
  meddleOutcome,
} from '../src/domain/world/divine-meddling.ts';
import { createHarness } from './helpers/app.ts';
import { advanceWorld } from '../src/infra/world-tick.ts';

process.env.TEMP = process.env.TEMP ?? 'data/tmp';
const REL = new URL('../src/data/divine-relations.yaml', import.meta.url);
function loadRelations(): DivineRelation[] {
  const parsed = DivineRelationFileSchema.safeParse(parse(readFileSync(REL, 'utf8')));
  assert.ok(parsed.success, '关系网 schema 不过');
  return parsed.data.divine_relations;
}

test('M2.169 关系网：9 条边，三种类型都有，而且都要有原作出处', () => {
  const relations = loadRelations();
  assert.equal(relations.length, 9, '关系条数变了 —— meta.count 与这条断言都要跟着改');
  const kinds = new Set(relations.map((r) => r.kind));
  for (const kind of ['ally', 'rival', 'covet']) assert.ok(kinds.has(kind as never), '少了 ' + kind + ' 这一类');
  for (const relation of relations) {
    assert.notEqual(relation.a, relation.b, '自己跟自己建关系');
    assert.ok(relation.source.length > 0, relation.a + '-' + relation.b + ' 没写原作出处');
  }
  // 真实内容里两端都在神座表里（loader 也查，这里再钉一遍：改数据时立刻红）
  const thrones = parse(readFileSync(new URL('../src/data/divine-thrones.yaml', import.meta.url), 'utf8')) as {
    divine_thrones: Array<{ pathway: string }>;
  };
  const ids = new Set(thrones.divine_thrones.map((t) => t.pathway));
  for (const relation of relations) {
    assert.ok(ids.has(relation.a), relation.a + ' 不在神座表里');
    assert.ok(ids.has(relation.b), relation.b + ' 不在神座表里');
  }
});

test('M2.169 谁能对谁下手：**觊觎有方向**、水火不容无向、盟友不下手', () => {
  const edges = [
    { a: 'assassin', b: 'apothecary', kind: 'covet' },   // 原初魔女觊觎月亮的位置
    { a: 'sleepless', b: 'warrior', kind: 'rival' },
    { a: 'sleepless', b: 'mother', kind: 'ally' },
  ];
  // 有向：a 觊觎 b 成立，反过来不成立
  assert.equal(canSchemeAgainst({ schemer: 'assassin', target: 'apothecary', edges }), 'covet');
  assert.equal(canSchemeAgainst({ schemer: 'apothecary', target: 'assassin', edges }), null, '觊觎被当成了双向的');
  // rival 无向：两边都能下手
  assert.equal(canSchemeAgainst({ schemer: 'sleepless', target: 'warrior', edges }), 'rival');
  assert.equal(canSchemeAgainst({ schemer: 'warrior', target: 'sleepless', edges }), 'rival');
  // 盟友不下手（那一条边是给「联手」用的）
  assert.equal(canSchemeAgainst({ schemer: 'sleepless', target: 'mother', edges }), null);
  // 毫无关系 ⇒ 不下手（世界级阴谋不该随机落在一个没有缘由的目标上）
  assert.equal(canSchemeAgainst({ schemer: 'sun', target: 'reader', edges }), null);
});

test('M2.169 阶段：累积、跳不过去，一条完整的链以年计', () => {
  assert.deepEqual([...SCHEME_STAGES], ['ally', 'infiltrate', 'weaken', 'war', 'fall']);
  assert.equal(stageAfter('ally'), 'infiltrate');
  assert.equal(stageAfter('war'), 'fall');
  assert.equal(stageAfter('fall'), null, '陨落之后没有下一阶段 —— 那一步是结算');
  const totalDays = SCHEME_STAGES.reduce((sum, stage) => sum + SCHEME_STAGE_DAYS[stage], 0);
  assert.equal(totalDays, 390, '一条完整的链应当以年计（原作那场神战不是一夜之间的事）');
  assert.equal(nextStageAt('ally', 1000), 1000 + SCHEME_STAGE_DAYS['ally'] * 86_400_000);
  // 做得越急、同谋越多，暴露得越快
  assert.ok(exposureGain({ stage: 'war', allies: 0 }) > exposureGain({ stage: 'ally', allies: 0 }));
  assert.ok(exposureGain({ stage: 'ally', allies: 2 }) > exposureGain({ stage: 'ally', allies: 0 }));
  assert.ok(DIVINE_SCHEME_URGE_PER_HOUR > 0 && DIVINE_SCHEME_URGE_PER_HOUR < 0.01);
});

test('M2.169 结算：默认失败或半成；旧日**杀不死**', () => {
  const base: DivineSchemeState = {
    id: 'x', schemer: 'assassin', target: 'apothecary', goal: 'fall',
    stage: 'fall', progress: 4, exposed: 0, allies: [], startedAt: 0, dueAt: 0, outcome: '',
  };
  // 掷 0.99（最小）⇒ 必然没成
  assert.equal(resolveScheme({ scheme: base, targetUnkillable: false, rng: { next: () => 0.99 } }).result, 'foiled');
  // 掷 0.01 ⇒ 成了（普通目标）
  assert.equal(resolveScheme({ scheme: base, targetUnkillable: false, rng: { next: () => 0.01 } }).result, 'done');
  // 同样是掷 0.01，但目标是「杀不死的那一档」⇒ 最多只能封住
  const half = resolveScheme({ scheme: base, targetUnkillable: true, rng: { next: () => 0.01 } });
  assert.equal(half.result, 'half', '原作明写旧日「无法真正杀死祂」');
  assert.ok(half.note.includes('杀不死'));
  // 暴露度越高越难成：同一掷值下，暴露 90 的那一局会失败
  const exposed: DivineSchemeState = { ...base, exposed: 90 };
  assert.equal(resolveScheme({ scheme: exposed, targetUnkillable: false, rng: { next: () => 0.4 } }).result, 'foiled');
  // ⚠️ 成功率是 0.35（底）+ 0 − 0.4×暴露；所以掷 0.4 **不够**，要掷到 0.35 以下
  assert.equal(resolveScheme({ scheme: base, targetUnkillable: false, rng: { next: () => 0.3 } }).result, 'done');
  // 同谋越多越容易成（原作那次是两个打一个）
  const lone: DivineSchemeState = { ...base, allies: [] };
  const pair: DivineSchemeState = { ...base, allies: ['criminal'] };
  assert.ok(
    resolveScheme({ scheme: pair, targetUnkillable: false, rng: { next: () => 0.45 } }).result ===
      'done' &&
      resolveScheme({ scheme: lone, targetUnkillable: false, rng: { next: () => 0.45 } }).result ===
        'foiled',
    '同谋该让成功率上来',
  );
});

test('M2.169 神座状态：内容为底、状态覆盖', () => {
  const content = [
    { pathway: 'apothecary', seat: '原始月亮（堕落母神）', seatKind: 'outsider', state: 'occupied' },
  ] as never;
  // 没有状态 ⇒ 逐字返回内容
  assert.deepEqual(mergeThroneState(content, []), content);
  // 有状态 ⇒ 盖上（seat / seatKind / state 三样）
  const merged = mergeThroneState(content, [
    { pathway: 'apothecary', seat: '原始月亮（堕落母神）', seatKind: 'outsider', state: 'sealed', since: 1, changedBy: 'x', fallNote: '被封住了' },
  ]);
  assert.equal(merged[0]!.state, 'sealed');
  assert.equal(merged[0]!.seat, '原始月亮（堕落母神）', '陨落/封印时不该丢掉「上一任是谁」');
});

test('M2.169 端到端：一场阴谋真的能**改掉神座**', () => {
  const h = createHarness();
  try {
    const deps = h.app.router.deps;
    let now = h.now();
    assert.equal(deps.divineThroneState!.all().length, 0, '一开始不该有运行时状态');
    // 构造一条走到最后一格的阴谋（`fall` 阶段且已到期）
    deps.divineSchemes!.create({
      id: 'dscheme:test', schemer: 'assassin', target: 'reader', goal: 'fall',
      stage: 'fall', progress: 4, exposed: 0, allies: ['criminal'],
      startedAt: now - 400 * 86_400_000, dueAt: now - 1, outcome: '',
    });
    /*
     * ⚠️ 结算本身是**掷骰**的（最高成功率 0.95，默认失败或半成 —— 这是设计）。
     * 所以判据不能只跑一次就断言「神座变了」：那会变成一条 flaky 用例。
     * 改成：多开几局一直跑到**有一局成了**为止 —— 它验证的是「这条链是通的」，
     * 而不是「这一局一定成」。20 局全败的概率是 0.5^20（约百万分之一）。
     */
    let state = deps.divineThroneState!.of('reader');
    for (let attempt = 0; attempt < 20 && state === null; attempt += 1) {
      deps.divineSchemes!.create({
        id: 'dscheme:test' + attempt, schemer: 'assassin', target: 'reader', goal: 'fall',
        stage: 'fall', progress: 4, exposed: 0, allies: ['criminal', 'criminal', 'criminal'],
        startedAt: now - 400 * 86_400_000, dueAt: now - 1, outcome: '',
      });
      now += 3_600_000;
      advanceWorld(deps, now);
      state = deps.divineThroneState!.of('reader');
    }
    assert.ok(state !== null, '20 局都没能改动神座 —— 这条链是死的');
    assert.ok(['vacant', 'sealed'].includes(state!.state), '结算后的状态不对：' + state!.state);
    assert.ok(state!.seat.length > 0, '丢掉了「原来那位是谁」');
    const closed = deps.divineSchemes!.all().filter((s) => s.outcome !== '');
    assert.ok(closed.length >= 1, '阴谋没有留下结局');
    // 而且这件事玩家看得到
    const ev = deps.worldEvents.all().filter((e) => e.id.startsWith('divine-scheme-end-') || e.id.startsWith('divine-scheme-exposed-'));
    assert.ok(ev.length >= 1, '没有世界播报');
  } finally {
    h.app.close();
  }
});

test('M2.169 伤痕叠加：内容为底，三样一起变（危险 / 堕落源 / 掉落）', () => {
  const base = {
    id: 'tingen', name: '廷根市', min_seq: 9, max_seq: 0, danger: 1,
    loot: [{ itemId: '夜香草', weight: 15, minQty: 1, maxQty: 1, bindType: 'bound' }],
    events: [], adjacent: [], corruption_source: false,
  } as never;
  // 没有伤痕 ⇒ **逐字返回原对象**（与加这一层之前逐位相同）
  assert.equal(mergeScars(base, []), base);
  assert.equal(mergeScars(base, [{ id: 's', kind: 'x', pathway: 'p', locationId: '别处', since: 1, note: '', dangerBonus: 3, corruption: true, lootItem: '', lootChance: 0 }]), base);
  const scar = {
    id: 'scar:fall:sun', kind: 'divine_fall', pathway: 'sun', locationId: 'tingen', since: 1,
    note: '永恒烈阳倒下的地方 —— 那里的东西变了。', dangerBonus: 2, corruption: true,
    lootItem: '辅助材料·陨落真神造成的污染物', lootChance: 0.25,
  };
  const merged = mergeScars(base, [scar]);
  assert.equal(merged.danger, 3, '危险度要叠上去');
  assert.equal(merged.corruption_source, true, '神明陨落的地方会变成堕落源');
  assert.equal(merged.loot.length, 2, '掉落里要多出陨落者的残骸');
  assert.ok(merged.loot.some((l) => l.itemId === '辅助材料·陨落真神造成的污染物'));
  // 危险度有上限（地点 schema 是 0—5）—— 连着几场神战也不会溢出
  const many = mergeScars(base, [scar, { ...scar, id: 'b', dangerBonus: 4 }]);
  assert.equal(many.danger, 5);
  // 原对象没被改（纯函数）
  assert.equal((base as { danger: number }).danger, 1);
  assert.equal((base as { loot: unknown[] }).loot.length, 1);
});

test('M2.169 陨落者的残骸是**真的材料**（平时不在任何掉落表里）', () => {
  const items = parse(readFileSync(new URL('../src/data/items.yaml', import.meta.url), 'utf8')) as {
    items: Array<{ id: string }>;
  };
  const ids = new Set(items.items.map((i) => i.id));
  for (const id of ['辅助材料·陨落真神造成的污染物', '辅助材料·陨落于背叛的真神尸液', '辅助材料·神战遗迹的神力残片']) {
    assert.ok(ids.has(id), '缺少陨落材料：' + id);
  }
  // 而它们**不在**任何地点的常规掉落表里 —— 只有神陨落之后才拿得到
  const locations = parse(readFileSync(new URL('../src/data/locations.yaml', import.meta.url), 'utf8')) as {
    locations: Array<{ id: string; loot: Array<{ itemId: string }> }>;
  };
  const inContent = locations.locations.filter((l) =>
    l.loot.some((entry) => entry.itemId.includes('陨落')),
  );
  assert.deepEqual(inContent.map((l) => l.id), [], '陨落材料不该出现在常规掉落表里 —— 那它就只是普通材料了');
});

test('M2.169 端到端：一位神倒下 ⇒ 地上留下伤痕，而探索能捡到东西', () => {
  const h = createHarness();
  try {
    const deps = h.app.router.deps;
    let now = h.now();
    assert.equal(deps.worldScars!.all().length, 0, '一开始不该有伤痕');
    // 多开几局，直到有一局真的成了（结算本身是掷骰的 —— 见上一条的说明）
    for (let attempt = 0; attempt < 20 && deps.worldScars!.all().length === 0; attempt += 1) {
      deps.divineSchemes!.create({
        id: 'dscheme:scar' + attempt, schemer: 'assassin', target: 'sun', goal: 'fall',
        stage: 'fall', progress: 4, exposed: 0, allies: ['criminal', 'criminal', 'criminal'],
        startedAt: now - 400 * 86_400_000, dueAt: now - 1, outcome: '',
      });
      now += 3_600_000;
      advanceWorld(deps, now);
    }
    const scars = deps.worldScars!.all();
    assert.ok(scars.length > 0, '20 局都没能在地上留下痕迹 —— 这条链是断的');
    const scar = scars[0]!;
    assert.ok(scar.lootItem.length > 0, '伤痕没写它留下什么');
    assert.ok(scar.note.length > 0, '伤痕没写那句话');
    // 伤痕真的挂在一个**存在的地点**上（写错的话探索永远读不到）
    assert.ok(deps.locations.get(scar.locationId) !== null, '伤痕挂在不存在的地点上：' + scar.locationId);
    // 而且那个地点现在读起来是「危险 + 堕落源 + 多一样掉落」
    const merged = mergeScars(deps.locations.get(scar.locationId)!, deps.worldScars!.atLocation(scar.locationId));
    assert.ok(merged.danger > deps.locations.get(scar.locationId)!.danger, '危险度没叠上去');
    assert.ok(merged.loot.length > deps.locations.get(scar.locationId)!.loot.length, '掉落里没多出东西');
  } finally {
    h.app.close();
  }
});

test('M2.169 教会的命运：动手的那一位**有没有教会**，决定教会是塌了还是被接手', () => {
  // 正神之间的暗算（黑夜女神对战神）：有教会 ⇒ 吞并
  const absorbed = fateAfterFall({
    targetChurches: ['god_of_war'], schemerChurches: ['night_goddess'], allyChurches: [],
    at: 1, by: 'x', targetName: '战神', schemerName: '黑夜女神',
  });
  assert.equal(absorbed.length, 1);
  assert.equal(absorbed[0]!.fate, 'absorbed');
  assert.equal(absorbed[0]!.controlledBy, 'night_goddess', '原作：黑夜女神教会彻底控制战神教会');
  assert.equal(stillActive(absorbed[0]!.fate), true, '被接手的教会照常出人');
  // 邪神（没有教会）掀翻正神 ⇒ 没人接手，只是塌了
  const crippled = fateAfterFall({
    targetChurches: ['eternal_blazing_sun'], schemerChurches: [], allyChurches: [],
    at: 1, by: 'x', targetName: '永恒烈阳', schemerName: '真实造物主',
  });
  assert.equal(crippled[0]!.fate, 'crippled');
  assert.equal(crippled[0]!.controlledBy, '');
  assert.equal(stillActive(crippled[0]!.fate), false, '失了庇护的教会不再出清剿队');
  assert.ok(crippled[0]!.note.includes('没有人撑腰'));
  // 同谋有教会时也能接手
  const byAlly = fateAfterFall({
    targetChurches: ['god_of_war'], schemerChurches: [], allyChurches: ['night_goddess'],
    at: 1, by: 'x', targetName: '战神', schemerName: '某个隐秘存在',
  });
  assert.equal(byAlly[0]!.controlledBy, 'night_goddess');
  // 一个神可能带两家教会，两家都要落
  const two = fateAfterFall({
    targetChurches: ['a', 'b'], schemerChurches: [], allyChurches: [],
    at: 1, by: 'x', targetName: '某位', schemerName: '某位',
  });
  assert.equal(two.length, 2);
  // 玩家读到的那一句
  assert.ok(churchFateLineOf('战神教会', absorbed[0]!, '黑夜女神教会').includes('已经被'));
  assert.ok(churchFateLineOf('烈阳教会', crippled[0]!, '').includes('失了庇护'));
});

test('M2.169 端到端：神倒下 ⇒ 教会跟着变，而且玩家看得到', () => {
  const h = createHarness();
  try {
    const deps = h.app.router.deps;
    let now = h.now();
    for (let attempt = 0; attempt < 20 && deps.churchStates!.all().length === 0; attempt += 1) {
      deps.divineSchemes!.create({
        id: 'dscheme:church' + attempt, schemer: 'assassin', target: 'sun', goal: 'fall',
        stage: 'fall', progress: 4, exposed: 0, allies: ['criminal', 'criminal', 'criminal'],
        startedAt: now - 400 * 86_400_000, dueAt: now - 1, outcome: '',
      });
      now += 3_600_000;
      advanceWorld(deps, now);
    }
    const states = deps.churchStates!.all();
    assert.ok(states.length > 0, '20 局之后教会状态没变 —— 这条链是断的');
    assert.ok(['crippled', 'absorbed'].includes(states[0]!.fate), '状态不对：' + states[0]!.fate);
    // 教会的 id 必须是真实存在的（写错的话玩家永远看不到那一行）
    assert.ok(deps.churches.byId(states[0]!.churchId) !== undefined, '教会 id 不存在：' + states[0]!.churchId);
    // 玩家看得到：世界播报里有教会那一条
    const ev = deps.worldEvents.all().filter((e) => e.id.startsWith('divine-church-fate-'));
    assert.ok(ev.length >= 1, '教会的变化没有任何玩家可见的入口 —— 那就只是「只落数据」');
    assert.ok(ev[0]!.text.includes('【世界 · 教会】'));
  } finally {
    h.app.close();
  }
});

test('M2.169 插手：序列越高越稳，而**做成与被发现是两次独立判定**', () => {
  // 高序列更稳（成率高、被发现低）—— 低序列插手是真的危险
  assert.ok(meddleChance(1).success > meddleChance(9).success);
  assert.ok(meddleChance(1).exposed < meddleChance(9).exposed);
  assert.ok(meddleChance(9).exposed > 0.3, '凡人插手有三成以上会被抓 —— 这是「刺激」的来源之一');
  assert.ok(meddleChance(9).success < 0.7);
  // 两次独立判定：掷 [低, 高] ⇒ 做成了但没被发现；掷 [高, 低] ⇒ 没做成却被发现
  const rolls = (a: number, b: number) => {
    const seq = [a, b];
    let k = 0;
    return { next: () => seq[Math.min(k++, 1)]! };
  };
  const done = meddleOutcome({ side: 'inform', sequence: 9, rng: rolls(0.1, 0.9) });
  assert.equal(done.success, true);
  assert.equal(done.exposed, false);
  const caught = meddleOutcome({ side: 'inform', sequence: 9, rng: rolls(0.9, 0.1) });
  assert.equal(caught.success, false);
  assert.equal(caught.exposed, true, '做成与否和被发现是两件事 —— 写成同一次判定会让「被抓」变成「没做成」的同义词');
  assert.ok(caught.note.includes('知道是你'));
  assert.ok(meddleOutcome({ side: 'aid', sequence: 9, rng: rolls(0.1, 0.9) }).note.includes('办得很干净'));
  // 插手对那一局的影响：告密推向「被察觉」，助推把时间表往前拽
  assert.equal(meddleEffect({ side: 'inform', success: true }).exposure, 30);
  assert.equal(meddleEffect({ side: 'inform', success: true }).accelerateDays, 0);
  assert.equal(meddleEffect({ side: 'aid', success: true }).accelerateDays, 30);
  assert.equal(meddleEffect({ side: 'aid', success: true }).exposure, 0);
  assert.ok(meddleEffect({ side: 'inform', success: false }).exposure > 0, '没成也留痕迹');
});

test('M2.169 端到端：.神战 看得见、插得了手、而且**不会白插**', async () => {
  const h = createHarness();
  try {
    const deps = h.app.router.deps;
    const now = h.now();
    await h.createCharacter('u-meddle', '插手的人');
    deps.divineSchemes!.create({
      id: 'dscheme:live', schemer: 'assassin', target: 'sun', goal: 'fall',
      stage: 'infiltrate', progress: 1, exposed: 20, allies: [],
      startedAt: now - 100 * 86_400_000, dueAt: now + 47 * 86_400_000, outcome: '',
    });
    // ① 看得见（而且写清了走到哪一步、还剩多久、对面察觉没有）
    const see = await h.send({ rawText: '.神战', userId: 'u-meddle' });
    const text = see.map((m) => m.text).join('\n');
    assert.ok(text.includes('【神战】'));
    assert.ok(text.includes('永恒烈阳'), '要写出被图谋的是谁');
    assert.ok(text.includes('还剩约 47 天'), '要写出倒计时 —— 那是紧张感的来源');
    assert.ok(text.includes('插手'), '要告诉玩家他能做什么');
    // ② 插手之后：那一局的暴露度/时间表真的变了，而且账上记了
    const before = deps.divineSchemes!.of('dscheme:live')!;
    const meddle = await h.send({ rawText: '.神战 告密', userId: 'u-meddle' });
    assert.ok(meddle.map((m) => m.text).join('\n').includes('【神战 · 告密】'));
    const after = deps.divineSchemes!.of('dscheme:live')!;
    assert.ok(after.exposed > before.exposed, '插手没有改变那一局 —— 那就只是文字');
    const characterId = deps.characters.findByUserId('u-meddle')!.id;
    const rows = deps.divineMeddling!.ofCharacter(characterId);
    assert.equal(rows.length, 1, '账上没有记录');
    assert.equal(rows[0]!.side, 'inform');
    // ③ 同一局不能再插一次（一局一次，选了就站了队）
    const twice = await h.send({ rawText: '.神战 助推', userId: 'u-meddle' });
    assert.ok(twice.map((m) => m.text).join('\n').includes('已经插过手'), '同一局该被拦住');
    assert.equal(deps.divineMeddling!.ofCharacter(characterId).length, 1, '被拦住的那一次不该记账');
  } finally {
    h.app.close();
  }
});

test('M2.169 成神仪式的账：**参与**导致陨落才算数（旁观不算）', async () => {
  const h = createHarness();
  try {
    const deps = h.app.router.deps;
    const now = h.now();
    const id = 'u-falls';
    await h.createCharacter(id, '踩着神上位的人');
    const characterId = deps.characters.findByUserId(id)!.id;
    deps.divineSchemes!.create({
      id: 'dscheme:won', schemer: 'assassin', target: 'sun', goal: 'fall',
      stage: 'fall', progress: 4, exposed: 0, allies: [],
      startedAt: now, dueAt: now, outcome: '',
    });
    // 没插手 ⇒ 不算
    assert.equal(deps.divineMeddling!.firstCreditCaused(characterId), 0);
    deps.divineMeddling!.record({ characterId, schemeId: 'dscheme:won', side: 'aid', success: true, exposed: false, score: 9, at: now });
    // 插手了但那一局还没了结 ⇒ 不算（陨落还没发生）
    assert.equal(deps.divineMeddling!.firstCreditCaused(characterId), 0, '那一局还没落地就不该算');
    // 那一局成了 ⇒ 算一次（原作：在自身参与之事导致一位神灵陨落时晋升）
    deps.divineSchemes!.close({ id: 'dscheme:won', outcome: 'done', at: now });
    assert.equal(deps.divineMeddling!.firstCreditCaused(characterId), 1);
    // 而没成的那一局不算
    deps.divineSchemes!.create({
      id: 'dscheme:lost', schemer: 'assassin', target: 'mother', goal: 'fall',
      stage: 'fall', progress: 4, exposed: 0, allies: [], startedAt: now, dueAt: now, outcome: '',
    });
    deps.divineMeddling!.record({ characterId, schemeId: 'dscheme:lost', side: 'aid', success: true, exposed: false, score: 9, at: now });
    deps.divineSchemes!.close({ id: 'dscheme:lost', outcome: 'foiled', at: now });
    assert.equal(deps.divineMeddling!.firstCreditCaused(characterId), 1, '被掀桌子的那一局不该算');
  } finally {
    h.app.close();
  }
});

test('M2.169 多位玩家参与：**一场陨落只认一个首功**（用户那一问）', async () => {
  // ① 分量：告密不算（它是阻止陨落，不是导致）
  assert.equal(contributionOf({ side: 'inform', success: true, sequence: 1, first: true }), 0);
  // ② 助推成功 = 10 − 序列；第一个动手的 +3
  assert.equal(contributionOf({ side: 'aid', success: true, sequence: 9, first: false }), 1);
  assert.equal(contributionOf({ side: 'aid', success: true, sequence: 1, first: false }), 9);
  assert.equal(contributionOf({ side: 'aid', success: true, sequence: 9, first: true }), 4);
  // ③ 失败只留 1 分（痕迹，但不足以拿首功）
  assert.equal(contributionOf({ side: 'aid', success: false, sequence: 1, first: true }), 1);
  // ④ 首功：分最高者；并列时**先动手的优先**（他先承担了风险）
  assert.equal(firstCreditOf([{ characterId: 'a', score: 5, at: 10 }, { characterId: 'b', score: 9, at: 20 }]), 'b');
  assert.equal(firstCreditOf([{ characterId: 'a', score: 5, at: 10 }, { characterId: 'b', score: 5, at: 20 }]), 'a');
  // ⑤ 全是告密者 ⇒ 谁都不算（没人推，它是自己掉下来的）
  assert.equal(firstCreditOf([{ characterId: 'a', score: 0, at: 10 }]), null);
  assert.equal(firstCreditOf([]), null);
  // ⑥ 玩家读到的那一句（分母是「这一局有几个人的手」）
  assert.ok(creditLineOf({ rank: 1, total: 3, score: 9 }).includes('分量最重的是你'));
  assert.ok(creditLineOf({ rank: 2, total: 3, score: 4 }).includes('第 2'));
  assert.ok(creditLineOf({ rank: 1, total: 1, score: 4 }).includes('只有你伸了手'));

  // ⑦ 端到端：三个玩家插手同一局 ⇒ 只有**一个人**算「参与导致神陨落」
  const h = createHarness();
  try {
    const deps = h.app.router.deps;
    const now = h.now();
    const NAMES: Record<string, string> = { 'u-a': '甲', 'u-b': '乙', 'u-c': '丙' };
    for (const id of ['u-a', 'u-b', 'u-c']) await h.createCharacter(id, NAMES[id]!);
    deps.divineSchemes!.create({
      id: 'dscheme:many', schemer: 'assassin', target: 'sun', goal: 'fall',
      stage: 'fall', progress: 4, exposed: 0, allies: [],
      startedAt: now, dueAt: now + 10 * 86_400_000, outcome: '',
    });
    for (const id of ['u-a', 'u-b', 'u-c']) {
      const sent = await h.send({ rawText: '.神战 助推', userId: id });
      assert.ok(sent.map((m) => m.text).join('\n').includes('【神战 · 助推】'), id + ' 没能插手');
    }
    assert.equal(deps.divineMeddling!.ofScheme('dscheme:many').length, 3, '三个人都该留下记录');
    // 那一局成了
    deps.divineSchemes!.close({ id: 'dscheme:many', outcome: 'done', at: now });
    const ids = ['u-a', 'u-b', 'u-c'].map((id) => deps.characters.findByUserId(id)!.id);
    const credits = ids.map((id) => deps.divineMeddling!.firstCreditCaused(id));
    assert.equal(credits.reduce((sum, n) => sum + n, 0), 1, '一场陨落只该有一个人拿到首功 —— 实际：' + JSON.stringify(credits));
    // 而「参与过」是三个都算（这是两件事：有赏赐与有名字，与成神无关）
    assert.deepEqual(ids.map((id) => deps.divineMeddling!.meddledAndWon(id)), [1, 1, 1]);
  } finally {
    h.app.close();
  }
});
