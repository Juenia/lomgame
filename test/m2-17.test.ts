/**
 * M2.17 任务 B + C：教义 flag 与教会技能树。
 *
 * 分六段：
 *   §A 内容表与 schema   —— taboos 对象化之后，七家的形状与跨表引用
 *   §B 判据匹配          —— matchTaboos 是纯函数：同输入同输出、不消耗 rng
 *   §C 检查点是真开关    —— NUMERIC.church.taboo.checkAfter 改了就真的不检查
 *   §D 技能树            —— 解锁是**算出来的**，不是落库的
 *   §E secular 画像      —— 与 steady 逐项相同（对照组的硬约束）
 *   §F 集成              —— 真指令跑一遍：入教的违反、没入教的不违反
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NUMERIC } from '../src/config/numeric.ts';
import { loadContent, validateChurchAbilities, validateChurches } from '../src/data/loader.ts';
import { mergeAbilityEffects, unlockedChurchAbilities } from '../src/domain/ability/ability.ts';
import { currentRank } from '../src/domain/church/membership.ts';
import { ChurchIndex, TabooActionSchema, TabooSchema } from '../src/domain/church/index.ts';
import { isTabooChecked, matchTaboos, mergeTabooPenalties } from '../src/domain/church/taboo.ts';
import { PERSONA_SPECS, buildProfiles, personaName } from '../src/vplayer/profiles.ts';
import { createHarness, DEFAULT_USER, type Harness } from './helpers/app.ts';

const content = loadContent();
const index = new ChurchIndex(content.churches, content.cities, content.locations);
const churchOf = (id: string) => index.byId(id)!;
const goddess = churchOf('night_goddess');

/* ==================== §A 内容表与 schema ==================== */

test('M2.17-A1：七家的 taboos 都是对象、id 唯一，且**七家全部有判据**（M2.76 起没有纯声明）', () => {
  assert.equal(content.churches.length, 7);
  const withWhen: string[] = [];
  for (const church of content.churches) {
    assert.ok(church.taboos.length > 0, church.id + ' 的禁忌不该是空的');
    const ids = church.taboos.map((taboo) => taboo.id);
    assert.equal(new Set(ids).size, ids.length, church.id + ' 的禁忌 id 必须唯一');
    for (const taboo of church.taboos) {
      assert.ok(taboo.text.length > 0, church.id + '/' + taboo.id + ' 缺 text');
      assert.equal(Boolean(taboo.when), Boolean(taboo.penalty), church.id + '/' + taboo.id);
    }
    if (church.taboos.some((taboo) => taboo.when)) withWhen.push(church.id);
  }
  /*
   * ⚠️ **这一条在 M2.26 第三批被改成双向的**（K18：守卫的方向必须覆盖链路两端）。
   *
   * 它原来是单向的：`assert.deepEqual(withWhen, ['god_of_war', 'night_goddess'])` ——
   * 也就是**只防「未实现途径乱写判据」**，不防反方向。
   * 而反方向真的出事了：`sailor` 在 M2.19 就实现了，风暴之主的三条教义却一直是纯声明
   * （M2.19 的注释里写着「下一轮补」，那一轮一直没来）—— **有玩家能入教，教义却管不到他**。
   *
   * 现在右边改成从**内容表现场派生**（`pathway !== null` 的教会），于是两件事同时被守住：
   *   · 途径实现了却没补判据 ⇒ 红（sailor / perfect / reader / mother 都栽过或差点栽）；
   *   · 途径没实现却写了判据 ⇒ 红（写一条永远不会被检查的判据比不写更坏）。
   */
  const bound = content.churches.filter((church) => church.pathway !== null).map((church) => church.id);
  assert.deepEqual(
    withWhen.sort(),
    bound.sort(),
    '途径已实现的教会必须有判据；未实现的只能是纯声明（M2.26 第三批改成双向守卫）',
  );
  assert.deepEqual(bound.sort(), [
    'earth_mother',
    // M2.76：太阳途径落地 ⇒ 烈阳也补上了判据，七家全在
    'eternal_blazing_sun',
    'god_of_knowledge',
    'god_of_steam',
    'god_of_war',
    'night_goddess',
    'storm_lord',
  ], 'M2.76：22 条正途径全部落地 —— 七正神里**没有一家**还是纯声明了');
});

test('M2.17-A2：TabooSchema 拦住三种坏形状', () => {
  const base = { id: 'x', text: 'x' };
  assert.equal(TabooSchema.safeParse({ ...base, when: { action: 'explore' } }).success, false, '有 when 没 penalty');
  assert.equal(TabooSchema.safeParse({ ...base, penalty: { mad: 1 } }).success, false, '没 when 有 penalty');
  assert.equal(TabooSchema.safeParse({ ...base, when: { action: 'explore' }, penalty: { mad: 0, cor: 0 } }).success, false, 'penalty 全零');
  assert.equal(TabooSchema.safeParse({ ...base, when: { action: 'explore' }, penalty: { mad: 1 } }).success, true, '合法形状');
});

test('M2.17-A3：判据引用的地点/城市/action 全部合法（loader 交叉校验无 error）', () => {
  const issues = validateChurches(content.churches, content.cities, content.locations);
  const errors = issues.filter((issue) => issue.level === 'error');
  assert.deepEqual(errors, [], '内容表不该有 error 级问题：' + JSON.stringify(errors));
  const warns = issues.filter((issue) => issue.level === 'warn' && issue.message.includes('checkAfter'));
  assert.deepEqual(warns, [], '不该有「判据永远不会被检查」的 warn');
});

/* ==================== §B 判据匹配 ==================== */

test('M2.17-B1：女神信徒探索太阳神殿命中，换个地点不命中', () => {
  const hit = matchTaboos({ action: 'explore', locationId: 'sun_temple', cityId: 'byron', rank: 0, church: goddess });
  assert.equal(hit.length, 1);
  assert.equal(hit[0]!.tabooId, 'night_goddess_no_sun_temple');
  assert.deepEqual(hit[0]!.penalty, { mad: 3, cor: 1 });
  const miss = matchTaboos({ action: 'explore', locationId: 'bone_market', cityId: 'byron', rank: 0, church: goddess });
  assert.deepEqual(miss, [], '骨市不在判据里');
});

test('M2.17-B2：多字段是 AND —— action 或 cityId 任一不符就不命中', () => {
  const wrongAction = matchTaboos({ action: 'use', locationId: null, cityId: 'trier', rank: 0, church: goddess });
  assert.deepEqual(wrongAction, [], 'use 不该命中 explore 的判据');
  const rightAction = matchTaboos({ action: 'explore', locationId: 'intel_cafe', cityId: 'trier', rank: 0, church: goddess });
  assert.equal(rightAction.length, 1);
  assert.equal(rightAction[0]!.tabooId, 'night_goddess_no_rival_city');
});

test('M2.17-B3：rankAbove / rankBelow 是适用范围（豁免），不是违反判据', () => {
  const base = { action: 'ritual' as const, locationId: 'fog_chapel', cityId: 'backlund' };
  assert.equal(matchTaboos({ ...base, rank: 1, church: goddess }).length, 1, '守夜人（rank 1）受约束');
  assert.equal(matchTaboos({ ...base, rank: 2, church: goddess }).length, 0, '司铎（rank 2）已豁免');
});

test('M2.17-B4：纯声明的禁忌（五家占位）永远不命中', () => {
  const storm = churchOf('storm_lord');
  assert.deepEqual(
    matchTaboos({ action: 'explore', locationId: 'backlund', cityId: 'backlund', rank: 0, church: storm }),
    [],
  );
});

test('M2.17-B5：matchTaboos 是纯函数；罚则合并走 penaltyMultiplier', () => {
  const input = { action: 'explore' as const, locationId: 'sun_temple', cityId: 'byron', rank: 0, church: goddess };
  assert.deepEqual(matchTaboos(input), matchTaboos(input));
  const violations = matchTaboos(input);
  assert.deepEqual(mergeTabooPenalties(violations), { mad: 3, cor: 1 });
  const cfg = NUMERIC.church.taboo as unknown as { penaltyMultiplier: number };
  const original = cfg.penaltyMultiplier;
  cfg.penaltyMultiplier = 2;
  try {
    assert.deepEqual(mergeTabooPenalties(violations), { mad: 6, cor: 2 }, '倍率作用于合并后的总数');
  } finally {
    cfg.penaltyMultiplier = original;
  }
});

/* ==================== §C 检查点是真开关 ==================== */

test('M2.17-C1：checkAfter 是开关，取值域与 TabooActionSchema 一致', () => {
  // M2.18（F）加了 challenge / battle 两项 —— 这条断言跟着检查点的数量走
  assert.deepEqual([...NUMERIC.church.taboo.checkAfter], ['explore', 'use', 'ritual', 'challenge', 'battle']);
  for (const action of NUMERIC.church.taboo.checkAfter) {
    assert.ok(TabooActionSchema.safeParse(action).success, action + ' 必须是合法的动作类型');
    assert.equal(isTabooChecked(action as 'explore'), true);
  }
  assert.equal(isTabooChecked('donate'), false);
  assert.equal(isTabooChecked('play'), false);
});

test('M2.17-C2：把 explore 从 checkAfter 里删掉，探索之后就不再检查（改回来仍生效）', () => {
  const cfg = NUMERIC.church.taboo as unknown as { checkAfter: string[] };
  const original = [...cfg.checkAfter];
  try {
    cfg.checkAfter = ['use', 'ritual'];
    assert.equal(isTabooChecked('explore'), false);
  } finally {
    cfg.checkAfter = original;
  }
  assert.equal(isTabooChecked('explore'), true);
});

/* ==================== §D 技能树 ==================== */

test('M2.17-D1：教会技能表 12 条（女神 / 战神 / 风暴之主 / 蒸汽与机械之神各 3），跨表引用全部合法', () => {
  // M2.26：第一批加蒸汽 ⇒ 12；第二批加知识 ⇒ 15；第三批加母神 ⇒ 18
  assert.equal(content.churchAbilities.length, 18);
  const byChurch = new Map<string, number>();
  for (const ability of content.churchAbilities) {
    byChurch.set(ability.churchId, (byChurch.get(ability.churchId) ?? 0) + 1);
  }
  assert.deepEqual([...byChurch.entries()].sort(), [
    ['earth_mother', 3],
    ['god_of_knowledge', 3],
    ['god_of_steam', 3],
    ['god_of_war', 3],
    ['night_goddess', 3],
    ['storm_lord', 3],
  ]);
  assert.deepEqual(validateChurchAbilities(content.churchAbilities, content.churches), []);
});

test('M2.17-D2：解锁是算出来的 —— 档位不够就没有，够了才有', () => {
  const defs = content.churchAbilities;
  assert.deepEqual(unlockedChurchAbilities(0, 'night_goddess', defs), [], '信徒（0 档）没有技能');
  assert.equal(unlockedChurchAbilities(1, 'night_goddess', defs).length, 1, '1 档解锁第 1 条');
  assert.equal(unlockedChurchAbilities(3, 'night_goddess', defs).length, 3, '3 档三条全解锁');
  assert.equal(unlockedChurchAbilities(5, 'night_goddess', defs).length, 3, '没有第 4 条可解锁');
  assert.deepEqual(unlockedChurchAbilities(3, 'god_of_war', defs).map((a) => a.churchId), ['god_of_war', 'god_of_war', 'god_of_war']);
  assert.deepEqual(unlockedChurchAbilities(3, null, defs), [], '没入教就没有教会技能');
});

test('M2.17-D3：abilities.enabled 是整层开关', () => {
  const cfg = NUMERIC.church.abilities as unknown as { enabled: boolean };
  const original = cfg.enabled;
  try {
    cfg.enabled = false;
    assert.deepEqual(unlockedChurchAbilities(3, 'night_goddess', content.churchAbilities), []);
  } finally {
    cfg.enabled = original;
  }
  assert.equal(unlockedChurchAbilities(3, 'night_goddess', content.churchAbilities).length, 3);
});

test('M2.17-D4：两源合并 —— 途径能力与教会技能叠在同一个数字上', () => {
  const pathway = content.abilities.filter((ability) => ability.pathway === 'warrior');
  const warRank3 = unlockedChurchAbilities(3, 'god_of_war', content.churchAbilities);
  const merged = mergeAbilityEffects([...pathway, ...warRank3]);
  // M2.29 批次 A1：warrior_6（守护者）也 +20 ⇒ +10 +20 + 教会 +5 +5 +10 = 50
  // M2.39 批次 B：warrior_4（战阵师）再 +30 ⇒ +10 +20 +30 + 教会 +5 +5 +10 = 80
  // M2.43 批次 C：warrior_2（陷阵者）又 +40 ⇒ +10 +20 +30 +40 + 教会 +5 +5 +10 = 120
  assert.equal(
    merged.maxHpBonus,
    120,
    'warrior_8 的 +10 + warrior_6 的 +20 + warrior_4 的 +30 + warrior_2 的 +40 + 教会 rank1/2 各 +5 + rank3 的 +10',
  );
  // M2.29 批次 A2：warrior_5（武器大师）又 +4 ⇒ +2 +4 = 6
  assert.equal(merged.initiativeBonus, 6, 'warrior_8 的 +2 + warrior_5 的 +4（教会 rank 2 在 M2.18 换了字段，不再是先攻）');
  assert.equal(merged.hostilitySense, true, 'warrior_7 的敌意感知还在');
});

/* ==================== §E secular 画像 ==================== */

test('M2.17-E1：secular 与 steady 逐项相同（只差跳过教会分支）', () => {
  const steady = PERSONA_SPECS.find((spec) => spec.persona === 'steady')!;
  const secular = PERSONA_SPECS.find((spec) => spec.persona === 'secular')!;
  assert.deepEqual(secular.logins, steady.logins);
  assert.deepEqual(secular.actions, steady.actions);
  assert.deepEqual(secular.riskAppetite, steady.riskAppetite);
  assert.deepEqual(secular.patience, steady.patience);
  assert.deepEqual(secular.goalWeights, steady.goalWeights);
  assert.equal(personaName('secular'), '世俗者');
});

test('M2.17-E2：secular 能单独生成一批，且同 seed 同输出', () => {
  const profiles = buildProfiles({ players: 4, seed: 'm2-17-secular', personas: ['secular'] });
  assert.equal(profiles.length, 4);
  for (const profile of profiles) assert.equal(profile.persona, 'secular');
  assert.deepEqual(
    buildProfiles({ players: 4, seed: 'm2-17-secular', personas: ['secular'] }).map((p) => p.seed),
    profiles.map((p) => p.seed),
  );
});

/* ==================== §F 集成 ==================== */

async function prepare(pathway: 'seer' | 'warrior' | 'sleepless', cityId: string): Promise<{ h: Harness; id: string }> {
  const h = createHarness({ deterministicIds: true });
  const created = await h.createCharacter(DEFAULT_USER, '克莱恩', pathway);
  const state = h.repos.characters.findById(created.id)!;
  h.repos.characters.update({ ...state, currentCityId: cityId, updatedAt: h.now() });
  return { h, id: created.id };
}

async function say(h: Harness, text: string, userId = DEFAULT_USER): Promise<string> {
  const messages = await h.send({ rawText: text, scene: 'private', userId });
  return messages.map((message) => message.text).join('\n');
}

function eventsOf(h: Harness, id: string, type: string) {
  return h.repos.characters.eventsOf(id).filter((event) => event.type === type);
}

test('M2.17-F1：入教的女神信徒踏进太阳神殿 → 回执明说 + 落事件 + 扣 MAD', async () => {
  const { h, id } = await prepare('sleepless', 'byron');
  await say(h, '.加入教会 night_goddess');
  const before = h.repos.characters.findById(id)!;
  const text = await say(h, '.探索 太阳神殿');
  assert.match(text, /【教义 · 黑夜女神】/, '回执必须明说违反（B4）');
  assert.match(text, /不得向太阳低头/, '回执里要有那条禁忌的原文');
  const events = eventsOf(h, id, 'church_taboo_violation');
  assert.equal(events.length, 1);
  assert.deepEqual(events[0]!.payload, {
    churchId: 'night_goddess',
    tabooId: 'night_goddess_no_sun_temple',
    penalty: { mad: 3, cor: 1 },
  });
  assert.equal(events[0]!.seed, null, '教义判定不掷骰 —— seed 显式 null');
  const after = h.repos.characters.findById(id)!;
  assert.ok(after.mad - before.mad >= 3, 'MAD 至少 +3（探索本身也可能加，所以是 >=）');
  h.app.close();
});

test('M2.17-F2：没入教的玩家踏进同一个地方 → 不违反（教义只管自己人）', async () => {
  const { h, id } = await prepare('sleepless', 'byron');
  await say(h, '.探索 太阳神殿');
  assert.equal(eventsOf(h, id, 'church_taboo_violation').length, 0);
  h.app.close();
});

test('M2.17-F3：入教玩家去一个不在判据里的地点 → 不违反', async () => {
  const { h, id } = await prepare('sleepless', 'byron');
  await say(h, '.加入教会 night_goddess');
  await say(h, '.探索 骨市');
  assert.equal(eventsOf(h, id, 'church_taboo_violation').length, 0);
  h.app.close();
});

test('M2.17-F4：档位算得出来（currentRank 与贡献/序列双门槛一致）', async () => {
  const { h, id } = await prepare('sleepless', 'byron');
  await say(h, '.加入教会 night_goddess');
  const state = h.repos.characters.findById(id)!;
  const rank = currentRank({ churchContribution: state.churchContribution, sequence: state.sequence }, goddess);
  assert.equal(rank, 0);
  const threshold = NUMERIC.church.ranks.contributionThreshold[1] ?? 5;
  assert.equal(currentRank({ churchContribution: threshold, sequence: 9 }, goddess), 1);
  h.app.close();
});
