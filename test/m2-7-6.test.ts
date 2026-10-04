/**
 * M2.7.6：普通人阶段与途径获得。
 *
 * 这一份守的是**这一轮的验收标准**（任务书 §七 + 补充 §5.3；M2.85 修订）：
 *   1. .创建 姓名 建出普通人（无途径、无序列、有性别）；旧流程被明确拒绝；
 *   2. 普通人有独立事件池，探索修正如配置；
 *   3. 配方线索 5% 概率触发（M2.85 起是**唯一**的入途径入口）；
 *   4. 线索保底：满 cluePityDays 天且手上无线索时，探索必出；
 *   5. .线索 回执三态；线索 → 调制 → 服用 能入途径。
 *
 * 判定层的部分直接调纯函数（不起服务）；链路部分走真实指令与真实结算。
 * M2.85：势力引导（.引导 / 邀约 / 每日保底掷骰）的测试随玩法一并删除。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { INITIATION, MORTAL_EVENTS, NUMERIC } from '../src/config/numeric.ts';
import { loadCards } from '../src/cards/loader.ts';
import { loadCities, loadFactions, loadLocations, loadRecipes } from '../src/data/loader.ts';
import { potionProductId } from '../src/domain/potion/recipe.ts';
import {
  isMortalCard,
  mortalCapsFor,
  mortalDayOf,
  mortalExploreModifiers,
  resolveInitiation,
} from '../src/domain/initiation/index.ts';
import type { InitiationWorld } from '../src/domain/initiation/index.ts';
import { buildNextMenu } from '../src/domain/menu/next-menu.ts';
import { buildTodayMenu } from '../src/domain/menu/today-menu.ts';
import { pathwayKit } from '../src/domain/menu/play-menu.ts';
import type { MenuCharacter, WorldSnapshot } from '../src/domain/menu/types.ts';
import type { WorldClock } from '../src/domain/world/clock.ts';
import { worldModifiers } from '../src/domain/world/weather.ts';
import { createHarness } from './helpers/app.ts';

const { factions } = loadFactions();
const { locations } = loadLocations();
const locationsById = new Map(locations.map((location) => [location.id, location]));
const BY_ID = new Map(factions.map((faction) => [faction.id, faction]));
const DAY = 86_400_000;

function scriptedRng(values: number[]): { next(): number } {
  let index = 0;
  return { next: () => values[index++] ?? 0 };
}

/* ================================================================== *
 * 一、天数
 * ================================================================== */

test('普通人天数：创建当天是第 1 天，跨一天加一', () => {
  assert.equal(mortalDayOf(0, 0), 1);
  assert.equal(mortalDayOf(0, DAY - 1), 1);
  assert.equal(mortalDayOf(0, DAY), 2);
  assert.equal(mortalDayOf(DAY * 5, DAY * 5), 1, '相对天数，与绝对时间无关');
});

/* ================================================================== *
 * 二、普通人事件池与探索修正
 * ================================================================== */

test('普通人事件池：numeric 的清单与 src/cards/mortal 一一对应', () => {
  const mortalCards = loadCards().cards.filter((card) => isMortalCard(card.id));
  assert.equal(mortalCards.length, MORTAL_EVENTS.pool.length, '池子里的每一张都必须真的存在');
  assert.ok(mortalCards.length >= 10 && mortalCards.length <= 15, '任务书 §5.5 要求 10—15 张');
  for (const card of mortalCards) {
    assert.ok(
      card.trigger.cond.includes('pathway:mortal'),
      `${card.id} 必须写 cond: pathway:mortal（否则它会漏到非凡者头上）`,
    );
    assert.ok(card.texts.group, `${card.id} 缺群聊播报`);
  }
});

test('普通人的属性上限：MAD/COR 低于失控闸门（保护期是结构性成立的）', () => {
  const mortal = { pathwayStatus: 'mortal' as const };
  const caps = mortalCapsFor(mortal);
  assert.deepEqual(caps.hp, [0, INITIATION.mortalCaps.hp]);
  assert.deepEqual(caps.mp, [0, INITIATION.mortalCaps.mp]);
  assert.deepEqual(caps.mad, [0, INITIATION.mortalCaps.mad]);
  assert.deepEqual(caps.cor, [0, INITIATION.mortalCaps.cor]);
  assert.ok(
    INITIATION.mortalCaps.mad < NUMERIC.lossOfControl.madThreshold &&
      INITIATION.mortalCaps.cor < NUMERIC.lossOfControl.corThreshold,
    'MAD/COR 上限必须低于失控闸门 —— 否则普通人会失控，保护期就不成立',
  );
  assert.deepEqual(mortalCapsFor({ pathwayStatus: 'initiated' }), {}, '已入途径的人不受普通人上限约束');
});

test('探索修正：普通人危险 ×1.3、掉落 ×0.4；已入途径是中性值', () => {
  assert.deepEqual(mortalExploreModifiers({ pathwayStatus: 'mortal' }), {
    dangerMultiplier: INITIATION.mortalExplore.dangerMultiplier,
    dropMultiplier: INITIATION.mortalExplore.dropMultiplier,
  });
  assert.deepEqual(mortalExploreModifiers({ pathwayStatus: 'initiated' }), {
    dangerMultiplier: 1,
    dropMultiplier: 1,
  });
});

/* ================================================================== *
 * 三、判定层：线索 / 入途径
 * ================================================================== */

function worldOf(overrides: Partial<InitiationWorld> = {}): InitiationWorld {
  return {
    factions: [BY_ID.get('church_tingen')!],
    openClues: [],
    bornAt: 0,
    ...overrides,
  };
}

const MORTAL_STATE = {
  id: 'c1',
  userId: 'u1',
  name: '克莱恩',
  pathway: null,
  sequence: null,
  pathwayStatus: 'mortal' as const,
  gender: 'male' as const,
  hp: 100,
  mp: 50,
  mad: 0,
  cor: 0,
  dig: 0,
  dp: 0,
  status: 'active' as const,
  promotionFails: 0,
  createdAt: 0,
  updatedAt: 0,
};

test('线索：5% 概率翻到；满 cluePityDays 天且手上无线索时必出', () => {
  const world = worldOf({ factions: factions.filter((faction) => faction.cityId === 'tingen') });

  // 5%：抽样落在概率之外 → 没有线索
  const miss = resolveInitiation({
    state: MORTAL_STATE,
    action: { kind: 'explore', locationId: 'candle_bookstore', now: 5_000 },
    world,
    rng: scriptedRng([0.5]),
    seed: 's4',
  });
  assert.equal(miss.kind, 'none');
  assert.equal(miss.clue, null);

  // 5%：抽样命中 → 出线索，途径落在本城传承的途径里
  const hit = resolveInitiation({
    state: MORTAL_STATE,
    action: { kind: 'explore', locationId: 'candle_bookstore', now: 5_000 },
    world,
    rng: scriptedRng([0.01, 0.0]),
    seed: 's5',
  });
  assert.equal(hit.kind, 'clue');
  assert.ok(['seer', 'sleepless'].includes(hit.clue!.pathway), '线索只可能是本城传承的途径');
  assert.match(hit.clue!.clueText, /主材料/);

  // 保底：满 cluePityDays 天（MORTAL_STATE.createdAt = 0）→ 抽样再差也必出
  const pity = resolveInitiation({
    state: MORTAL_STATE,
    action: { kind: 'explore', locationId: 'candle_bookstore', now: INITIATION.cluePityDays * DAY },
    world,
    rng: scriptedRng([0.99]),
    seed: 's6',
  });
  assert.equal(pity.kind, 'clue', '满保底天数后，探索必定翻到线索');
  assert.equal(pity.rolls.cluePity, 1, '保底触发必须留在抽样记录里（能复现）');

  // 保底不叠加：手上已经有线索就不再翻第二张
  const already = resolveInitiation({
    state: MORTAL_STATE,
    action: { kind: 'explore', locationId: 'candle_bookstore', now: INITIATION.cluePityDays * DAY },
    world: worldOf({
      openClues: [{ id: 'x', characterId: 'c1', pathway: 'seer', clueText: 'x', foundAt: 0, usedAt: null }],
    }),
    rng: scriptedRng([0.0]),
    seed: 's7',
  });
  assert.equal(already.kind, 'none', '手上有线索时，5% 与保底都不触发');
});

test('入途径那一刻：喝下序列 9 的那一瓶，回执要有仪式感', () => {
  const result = resolveInitiation({
    state: MORTAL_STATE,
    action: { kind: 'drink', pathway: 'seer', now: 9000 },
    world: worldOf(),
    rng: scriptedRng([0.5]),
    seed: 's8',
  });
  assert.equal(result.kind, 'initiated');
  assert.deepEqual(result.initiation, { pathway: 'seer', sequence: 9, title: '占卜家' });
  const text = result.lines.join('\n');
  assert.match(text, /【入途径 · 愚者】/);
  assert.match(text, /世界变了/);
  assert.match(text, /愚者序列 9 · 占卜家/);
});

/* ================================================================== *
 * 四、端到端：唯一的线索路
 * ================================================================== */

test('端到端 · 线索路：满保底天数探索必出线索 → .线索 报产地 → 调制 → 服用 → 入途径', async () => {
  const h = createHarness();
  try {
    const userId = '810001';
    const mortal = await h.createMortal(userId, '自己找的人');
    assert.equal(mortal.pathwayStatus, 'mortal');

    // 出生城市里序列 9 能进的一个地点（探索只认脚下这座城市）
    const deps = h.app.router.deps;
    const character = deps.characters.findById(mortal.id)!;
    const spot = deps.locations
      .all()
      .find(
        (entry) =>
          deps.geo.cityOfLocation(entry.id)?.id === character.currentCityId &&
          (entry.min_seq ?? 0) <= 9,
      );
    assert.ok(spot, '出生城市必须至少有一个普通人进得去的地点');

    /*
     * 第 1 天探索：5% —— **可能翻到，也可能翻不到**（这条用例不能假设它一定不中，
     * 否则每 20 次跑批就会红一次）。翻到了就直接往下走；没翻到就推进到保底天数再探，必出。
     */
    await h.send({ rawText: `.探索 ${spot.name}`, userId });
    const firstDayClues = h.repos.clues.unusedOf(mortal.id).length;
    assert.ok(firstDayClues <= 1, '一次探索最多翻到一张线索');
    if (firstDayClues === 0) {
      h.advance(DAY * INITIATION.cluePityDays);
      await h.send({ rawText: `.探索 ${spot.name}`, userId });
      assert.equal(
        h.repos.clues.unusedOf(mortal.id).length,
        1,
        '满 cluePityDays 天后探索必定翻到一张（保底是承诺，不是期望）',
      );
    }

    // .线索 要能回答「中间怎么走」：这张纸是什么途径的、主材料去哪里找
    const listed = await h.send({ rawText: '.线索', userId });
    assert.match(listed[0]!.text, /【你手上的线索】1 张/);

    // 凑齐材料 → 调制 → 服用 → 入途径（途径以翻到的那张为准）
    const cluePathway = h.repos.clues.unusedOf(mortal.id)[0]!.pathway;
    const { recipes } = loadRecipes();
    const recipe = recipes.find((entry) => entry.pathway === cluePathway && entry.seq === 9)!;
    for (const need of [...recipe.main, ...recipe.aux]) {
      h.repos.inventory.add(mortal.id, need.itemId, need.qty, 'unbound', h.now());
    }
    /*
     * 调制有失败概率（base_success ≈ 0.75），所以要能重试；
     * 重试之间必须**跨过 .魔药 的频控**（令牌桶：3 个令牌 + 每 30 秒补一个）——
     * 用 advance(1000) 的话八次里只有两次真发得出去，
     * 于是这个用例会有约 6% 的概率偶发失败（M2.7.6 那轮就撞上过一次）。
     */
    let brewed = false;
    for (let attempt = 0; attempt < 8 && !brewed; attempt += 1) {
      h.advance(31_000);
      await h.send({ rawText: `.魔药 ${recipe.id}`, userId });
      brewed = h.repos.inventory.count(mortal.id, potionProductId(recipe)) > 0;
      if (!brewed) {
        for (const need of [...recipe.main, ...recipe.aux]) {
          h.repos.inventory.add(mortal.id, need.itemId, need.qty, 'unbound', h.now());
        }
        h.repos.characters.update({ ...h.repos.characters.findById(mortal.id)!, mp: 100, cor: 0 });
      }
    }
    assert.ok(brewed, '凑齐材料后必须能调出序列 9 魔药');

    h.advance(1000);
    const drunk = await h.send({ rawText: `.服用 ${potionProductId(recipe)}`, userId });
    assert.match(drunk[0]!.text, /【入途径/, '入途径的回执要有仪式感');
    const initiated = h.repos.characters.findById(mortal.id)!;
    assert.equal(initiated.pathwayStatus, 'initiated');
    assert.equal(initiated.pathway, cluePathway);
    assert.equal(initiated.sequence, 9);
    assert.equal(h.repos.clues.unusedOf(mortal.id).length, 0, '入途径之后线索被用掉');
  } finally {
    h.app.close();
  }
});

/* ================================================================== *
 * 五、普通人做不了的事
 * ================================================================== */

test('普通人不能扮演 / 晋升 / 占卜 —— 而且拒绝文案不点破「途径」这回事', async () => {
  const h = createHarness();
  try {
    const userId = '810003';
    await h.createMortal(userId, '白纸');
    const play = await h.send({ rawText: '.扮演 我在书店里替人占卜', userId });
    assert.match(play[0]!.text, /说不清|模仿/);
    // 拒绝的正文不能点破「途径」这回事（菜单标题那句「还没有途径」不算 ——
    // 它说的是「这个格子是空的」，而不是「途径是什么」）
    const reason = play[0]!.text.split('\n')[0]!;
    assert.equal(reason.includes('途径'), false, '普通人还不知道「途径」是什么，系统不该替他说破');
    h.advance(11_000);
    assert.match((await h.send({ rawText: '.晋升', userId }))[0]!.text, /没有序列/);
    h.advance(11_000);
    assert.match((await h.send({ rawText: '.占卜 今天会出事吗', userId }))[0]!.text, /没有.*能用来占卜/);
  } finally {
    h.app.close();
  }
});

test('.线索：三态回执 —— 没线索时报保底，有线索时列主材料与产地，入途径后指回主线', async () => {
  const h = createHarness();
  try {
    const userId = '810004';
    const mortal = await h.createMortal(userId, '等消息的人');

    // 态一：手上什么都没有 → 告诉他去探索、保底还有几天
    const nothing = await h.send({ rawText: '.线索', userId });
    assert.match(nothing[0]!.text, /一张都没有/);
    assert.match(nothing[0]!.text, /5%/);
    assert.match(nothing[0]!.text, /保底已经到了|还有 \d+ 天/);

    // 态二：插一张 seer 线索 → 列出途径、主材料、产地反查
    h.repos.clues.insert({
      id: 'clue-x',
      characterId: mortal.id,
      pathway: 'seer',
      clueText: '一本没有封面的笔记本。',
      foundAt: h.now(),
      usedAt: null,
    });
    const listed = await h.send({ rawText: '.线索', userId });
    assert.match(listed[0]!.text, /【你手上的线索】1 张/);
    assert.match(listed[0]!.text, /愚者/);
    const { recipes } = loadRecipes();
    const main = recipes.find((entry) => entry.pathway === 'seer' && entry.seq === 9)!.main[0]!.itemId;
    assert.ok(listed[0]!.text.includes(main), '回执要写出主材料名（玩家拿着它去 .探索 / 查背包）');
    assert.match(listed[0]!.text, /有产出的地点|碰碰运气/, '产地反查两种结果都是合法回执');

    // 态三：已经入途径 → 那张纸的故事结束了，指回主线
    h.repos.characters.update({
      ...h.repos.characters.findById(mortal.id)!,
      pathway: 'seer',
      sequence: 9,
      pathwayStatus: 'initiated',
    });
    const done = await h.send({ rawText: '.线索', userId });
    assert.match(done[0]!.text, /故事结束了/);
    assert.match(done[0]!.text, /晋升/);
  } finally {
    h.app.close();
  }
});

test('普通人视角：下一步菜单与 .今日 里没有扮演 / 魔药 / 晋升，只有他真能做的事', () => {
  const clock: WorldClock = {
    now: Date.UTC(2026, 8, 21, 12, 0, 0),
    dayIndex: 20_000,
    hour: 12,
    timeOfDay: 'day',
    season: 'autumn',
    moonPhase: 3,
    fullMoon: false,
    foggy: false,
    nextFogDay: 20_002,
  };
  const world: WorldSnapshot = {
    clock,
    weather: 'clear',
    modifiers: worldModifiers({ clock, weather: 'clear' }),
  };
  const state: MenuCharacter = {
    ...MORTAL_STATE,
    inventory: [],
    dailyCounters: {},
  };

  /* 下一步 */
  const next = buildNextMenu({ state, world, after: '探索' });
  const nextCommands = next.options.map((option) => option.command).join(' | ');
  for (const forbidden of ['扮演', '魔药', '晋升', '仪式', '占卜']) {
    assert.equal(
      nextCommands.includes(forbidden),
      false,
      '普通人菜单里不该出现「' + forbidden + '」——那是个点了只会被拒绝的选项',
    );
  }
  assert.match(nextCommands, /线索/, '普通人菜单必须给出 .线索（他唯一的找路入口）');
  assert.match(next.title, /还没有途径/);

  /* .今日 */
  const today = buildTodayMenu(state, world, undefined, []);
  const todayCommands = today.options.map((option) => option.command).join(' | ');
  assert.equal(todayCommands.includes('扮演'), false);
  assert.match(todayCommands, /线索/);
  assert.match(today.title, /还没有途径/);

  /* 对照：入了途径之后仍然是老那套（这一条守着「没有把非凡者菜单一起改坏」） */
  const initiated: MenuCharacter = { ...state, pathway: 'seer', sequence: 9, pathwayStatus: 'initiated' };
  const kit = pathwayKit('seer');
  const initiatedNext = buildNextMenu({ state: initiated, world, pathway: kit, after: '扮演' });
  assert.match(initiatedNext.options.map((option) => option.command).join(' | '), /扮演/);
  assert.match(initiatedNext.title, /愚者/);
});

/* ================================================================== *
 * 六、内容表：本城势力与途径落点
 * ================================================================== */

test('本地势力内容表：每座能出生的城市都有本地势力，途径落点两向对齐', () => {
  const { cities } = loadCities();
  const birthCities = cities.filter((city) => city.birth_weight > 0);
  for (const city of birthCities) {
    const own = factions.filter((faction) => faction.cityId === city.id);
    assert.ok(own.length >= 1, `${city.id} 至少要有一家本地势力（线索的途径落点来自它）`);
    /*
     * ⚠️ **两个方向都必须守（M2.26 第二批补）。**
     *
     * 势力传承的途径 ⊆ 本城开放的途径，**以及**反过来：
     * 本城开放的每条途径，都要有一家势力传承它。少了任何一半，
     * `city.pathways` 与 `factions.yaml` 不同步时这条守卫**一声不响**，
     * 而那条途径在本城的期望**就是 0**（配方线索只认本城势力名单）。
     * M2.26 第一批的 perfect 与第二批的 reader 都是这样 0 的，
     * 而且两次都被读成了「期望低 / 抽样运气」（见 docs/架构铁律.md K18）。
     */
    const inherited = new Set(own.map((faction) => faction.pathway));
    for (const pathway of city.pathways) {
      assert.ok(
        inherited.has(pathway),
        `${city.id} 开放了 ${pathway} 途径，却没有一家本城势力传承它 —— 这条途径在这里的期望是 0，不是「低」`,
      );
    }
    for (const faction of own) {
      assert.ok(city.pathways.includes(faction.pathway), `${faction.id} 传承的途径必须在本城开放`);
    }
  }
});

test('本地势力内容表：城市开放的每条途径都能翻到线索（不存在拿不到的途径）', () => {
  /*
   * M2.19：接入 sailor（水手）之后，普利兹港多了一家传这条途径的势力（引水人协会）——
   * 这条断言就是「新途径有没有落点」的守卫：少了它，水手在城里根本翻不到配方。
   *
   * ⚠️ M2.26 第二批：右边那份期望值**原来手抄着四条途径的名字**（K16 的形状）——
   * 现在右边改成从**城市开放的途径**派生（权威清单只有一份），
   * 于是两个方向都守住了：上一条守「每条开放的途径都有势力」，这一条守「势力不传承没开放的途径」。
   */
  const covered = new Set<string>();
  for (const faction of factions) covered.add(faction.pathway);

  const opened = new Set<string>();
  for (const city of loadCities().cities) for (const pathway of city.pathways) opened.add(pathway);

  assert.deepEqual([...covered].sort(), [...opened].sort(), '本地势力覆盖的途径必须与城市开放的途径一一对应');
});
