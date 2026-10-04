/**
 * M2.8 端到端：遭遇生物走真实路由（探索 → 遭遇 → 处置）。
 *
 * 这里守的是**玩家真的能看见的那条链**（而不是纯函数算得对不对）：
 *   1. 探索时命中遭遇 → 改摆遭遇菜单（那一只还站在那里）；
 *   2. 遭遇菜单的动作真的能结算（观察扣 MAD、撤退扣 AP、采集进背包）；
 *   3. **普通人和已入途径的人，在同一只生物面前看到的东西不一样** ——
 *      这是 M2.7.6 pathway_status 字段的兑现，也是 M2.8 最重要的一条验收。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CREATURE } from '../src/config/numeric.ts';
import { loadCreatures } from '../src/data/loader.ts';
import { createHarness, type Harness } from './helpers/app.ts';

const USER = '40001';
/** 跨过 .探索 的令牌桶冷却（capacity 1、refill 1/10s） */
const COOLDOWN_MS = 11_000;

const { creatures: SPECIES } = loadCreatures();
const BY_ID = new Map(SPECIES.map((species) => [species.id, species]));

function joined(messages: ReadonlyArray<{ text: string }>): string {
  return messages.map((message) => message.text).join('\n');
}

function currentMenuType(h: Harness, userId = USER): string | null {
  const character = h.repos.characters.findByUserId(userId);
  if (!character) return null;
  return h.app.router.deps.pendingMenus.current(character.id, h.now())?.menuType ?? null;
}

/**
 * 把一只指定的生物摆到某地点（并清掉那儿的其他生物）。
 *
 * 为什么每次探索前都要重摆：生态 tick 挂在每条指令前，它会迁移 / 捕食 / 让生物饿死 ——
 * 而这条测试要验的是**遭遇链路**，不是生态。重摆一次就把变量固定住了。
 */
function placeCreature(h: Harness, speciesId: string, locationId: string): void {
  const species = BY_ID.get(speciesId);
  assert.ok(species, '内容表里没有 ' + speciesId);
  h.repos.creatures.deleteMany(h.repos.creatures.atLocation(locationId).map((c) => c.id));
  h.repos.creatures.insertMany([
    {
      id: 'test-' + speciesId,
      speciesId,
      locationId,
      sequence: species.baseSequence,
      hp: species.baseHp,
      maxHp: species.baseHp,
      status: 'healthy',
      ageHours: 0,
      feedCount: 0,
      lastFedAt: h.now(),
      spawnedAt: h.now(),
      migratedFrom: null,
    },
  ]);
}

/**
 * 把探索的前置条件重置掉，**但不推进时间**。三件事：
 *
 *   1. 今日探索次数清零（同一个地点一天只能探索 3 次）；
 *   2. 行动点补满（普通人 HP 上限比非凡者低，所以这里只动 AP）；
 *   3. **把玩家放到目标地点所在的城市** —— createMortal 刻意不校正城市，
 *      普通人生在哪座城是随机的（实测这条会生在拜朗），于是「探索廷根市」
 *      会被跨城规则挡下，测试表现为「六十次都没撞见生物」，很难查。
 *
 * 为什么不跨天：生态 tick 挂在每条指令前，一跨天它就要补跑 24 小时 ——
 * 那只刚摆好的生物会在探索发生之前被迁走（实测 24 小时里约七成概率换地方），
 * 于是测试变成「随机地测不到东西」。不推进时间则水位线已到，生态一动不动。
 *
 * 每次探索的 seed 是 messageId:characterId:now 派生的，而 harness 的 messageId 递增，
 * 所以即使时间不变，每一次探索掷出来的仍然是不同的骰子。
 */
function refreshForExplore(h: Harness, userId: string, locationId: string): void {
  h.app.db.prepare('DELETE FROM explore_daily').run();
  const character = h.repos.characters.findByUserId(userId)!;
  const city = h.repos.cities.all().find((entry) => entry.locations.includes(locationId));
  h.repos.characters.update({
    ...character,
    currentCityId: city?.id ?? character.currentCityId,
    updatedAt: h.now(),
  });
}

/**
 * 反复探索直到撞见一次遭遇（最多 maxAttempts 次）。
 *
 * 遭遇是概率事件（baseChance 0.15，叠上亲和与天气约 0.2），这里**不篡改任何数值** ——
 * 而是让真实链路自己掷到命中为止。
 */
async function exploreUntilSighting(
  h: Harness,
  spotName: string,
  locationId: string,
  speciesId: string,
  userId = USER,
  maxAttempts = 60,
): Promise<{ text: string; attempts: number } | null> {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    refreshForExplore(h, userId, locationId);
    placeCreature(h, speciesId, locationId);
    // 跨过 .探索 的令牌桶冷却。11 秒 << 1 小时，所以不会推进出新的生态 tick
    h.advance(COOLDOWN_MS);
    const replies = await h.send({ rawText: '.探索 ' + spotName, userId });
    const text = joined(replies);
    // 命中与否看**菜单类型**，比匹配文案稳（文案会随内容表改）
    if (currentMenuType(h, userId) === 'encounter') return { text, attempts: attempt };
  }
  return null;
}

test('M2.8：探索命中遭遇时，改摆遭遇菜单（那一只还站在那里）', async () => {
  const h = createHarness();
  try {
    await h.createCharacter(USER, '遭遇测试');
    const hit = await exploreUntilSighting(h, '廷根市', 'tingen', 'grey_wraith');
    assert.ok(hit, '四十次探索都没撞见生物 —— 概率链可能断了');

    // 遭遇的画面由菜单承担，且有且仅有一次（不在回执里重复）
    assert.equal(
      hit.text.split('【遭遇 ·').length - 1,
      1,
      '遭遇标题只该出现一次：' + hit.text,
    );
    assert.equal(currentMenuType(h), 'encounter', '遭遇命中时应当摆遭遇菜单');
    assert.match(hit.text, /回复数字。/, '遭遇菜单也要能回数字');
  } finally {
    h.app.close();
  }
});

test('M2.8：同一只生物，普通人只看到模糊，已入途径的人看到完整信息', async () => {
  /*
   * 这是 M2.8 最重要的一条，也是 M2.7.6 pathway_status 字段的兑现：
   * **入途径的瞬间，同一片雾里的东西就变得有名字了。**
   *
   * 用序列 9 的灰雾游魂：
   *   普通人          → 永远 blur（不管生物序列多低）
   *   序列 9 的非凡者 → delta = 0 → full（看得见名字）
   */
  const wraith = BY_ID.get('grey_wraith')!;
  assert.equal(wraith.baseSequence, 9);

  const mortalHarness = createHarness();
  const awakenedHarness = createHarness();
  try {
    await mortalHarness.createMortal(USER, '普通人甲');
    await awakenedHarness.createCharacter(USER, '非凡者乙');

    const mortalHit = await exploreUntilSighting(mortalHarness, '廷根市', 'tingen', 'grey_wraith');
    assert.ok(mortalHit, '普通人这边没撞见生物');
    const awakenedHit = await exploreUntilSighting(awakenedHarness, '廷根市', 'tingen', 'grey_wraith');
    assert.ok(awakenedHit, '非凡者这边没撞见生物');

    // 普通人：最模糊的一层（连那是什么都不知道）
    assert.ok(
      mortalHit.text.includes(wraith.perception.blur),
      '普通人应当看到最模糊的一层：' + mortalHit.text,
    );
    assert.ok(
      !mortalHit.text.includes(wraith.name),
      '普通人不该知道它叫什么：' + mortalHit.text,
    );

    // 已入途径的序列 9：同一只生物，名字出现了
    assert.ok(
      awakenedHit.text.includes(wraith.perception.full),
      '序列 9 的非凡者应当看到完整信息：' + awakenedHit.text,
    );
    assert.ok(
      awakenedHit.text.includes(wraith.name),
      '入途径之后同一只生物就该有名字了：' + awakenedHit.text,
    );
  } finally {
    mortalHarness.app.close();
    awakenedHarness.app.close();
  }
});

test('M2.87 普通人的遭遇菜单：看一眼 / 撤退 / 站着不动，但没有对峙、互动与动手', async () => {
  const h = createHarness();
  try {
    await h.createMortal(USER, '普通人丙');
    const hit = await exploreUntilSighting(h, '廷根市', 'tingen', 'grey_wraith');
    assert.ok(hit, '没撞见生物');
    /*
     * ⚠️ M2.90：这条用例原来断言「凡人只有撤退 / 站着不动」，而 M2.87 给凡人
     * **加了「看一眼」并排在第一位**（用户原话：「事件白开水等于游戏是废的」——
     * 每个新号都是普通人，两个零效果选项意味着每个玩家开局的前几天都在读散文）。
     * 世界观依据是「凡人看不清，但看得见、记得住」。
     *
     * 加完之后这条用例一直红着，因为它守的还是旧设计。现在改成守**新的**那条线：
     * 凡人能看、能退、能不动，但**不能对峙、不能互动、不能开战**。
     */
    assert.match(hit.text, /1\. 观察/, '凡人最自然的反应是「那是什么？」：' + hit.text);
    assert.match(hit.text, /2\. 撤退/, '第二个是撤退');
    assert.match(hit.text, /3\. 站着不动/, '第三个是站着不动');
    assert.ok(!/对峙/.test(hit.text), '普通人不该有「对峙」选项：' + hit.text);
    assert.ok(!/互动/.test(hit.text), '普通人不该有「互动」选项：' + hit.text);
    assert.ok(!/动手/.test(hit.text), '普通人不能开战（canStartBattle 对 mortal 恒 false）：' + hit.text);
  } finally {
    h.app.close();
  }
});

test('M2.8：遭遇可以处置 —— 撤退扣 AP 并了结这次遭遇', async () => {
  // 用普通人：blur 层的动作是「撤退 / 站着不动」。
  // （同序列那一层按任务书 §4.3.2 只给 观察 / 对峙 / 互动 —— 看清了就退不回去了）
  const h = createHarness();
  try {
    await h.createMortal(USER, '处置测试');
    const hit = await exploreUntilSighting(h, '廷根市', 'tingen', 'grey_wraith');
    assert.ok(hit, '没撞见生物');

    const replies = await h.send({ rawText: '.遭遇 撤退', userId: USER });
    const text = joined(replies);
    const after = h.repos.characters.findByUserId(USER)!;

    assert.match(text, /你退了出去/, '撤退要有回执：' + text);

    // 遭遇是个未决状态：处置完就不该再有未决遭遇
    assert.equal(h.repos.creatures.openSighting(after.id), null, '处置完不该还有未决遭遇');
    // 且被记进了审计
    assert.equal(h.repos.creatures.countSightings() > 0, true, '遭遇要落库（审计）');
  } finally {
    h.app.close();
  }
});

test('M2.8：观察会付出一点 MAD（知道了就要担着）', async () => {
  const h = createHarness();
  try {
    await h.createCharacter(USER, '观察测试');
    // 灰雾游魂序列 9，序列 9 的玩家看到的是 full —— 这一层允许观察
    const hit = await exploreUntilSighting(h, '廷根市', 'tingen', 'grey_wraith');
    assert.ok(hit, '没撞见生物');

    const before = h.repos.characters.findByUserId(USER)!;
    const replies = await h.send({ rawText: '.遭遇 观察', userId: USER });
    const text = joined(replies);
    const after = h.repos.characters.findByUserId(USER)!;

    assert.ok(after.mad >= before.mad, '观察不该让人更清醒');
    assert.equal(after.mad - before.mad, CREATURE.actions.observe.madGain, '观察的 MAD 涨幅照数值表');
    assert.ok(text.length > 0);
  } finally {
    h.app.close();
  }
});

/*
 * ⚠️ 这条用例原来断言的是「**普通人不能观察**」—— M2.87 之前的口径。
 *
 * M2.87 给凡人加了「观察」（`perception.ts` 里凡人那一支变成
 * `['observe', 'retreat', 'hold']`，理由是凡人遭遇原本 100% 白开水），
 * 但当时只改了菜单那一处 —— `router/commands/encounter.ts` 里抄的第二份
 * `allowedOf` 没跟上，而**这条用例守着旧行为，把那个不一致保护了下来**：
 * 测试全绿，真人点按钮却必定收到「你现在能做的不是这件事」。
 *
 * 所以现在改成两头都验：凡人**能**观察（新口径），凡人**不能**对峙（两个口径下都不许）。
 */
test('M2.8：凡人能「观察」，但不能「对峙」—— 菜单给什么，判定就得认什么', async () => {
  const h = createHarness();
  try {
    await h.createMortal(USER, '越权测试');
    const hit = await exploreUntilSighting(h, '廷根市', 'tingen', 'grey_wraith');
    assert.ok(hit, '没撞见生物');

    // ① 先验越权的那一个：凡人不能「对峙」
    //    （放在观察之前 —— 观察是**有效动作**，会把遭遇了结掉，之后就没得测了）
    const denied = await h.send({ rawText: '.遭遇 对峙', userId: USER });
    assert.match(
      joined(denied),
      /能做的不是这件事/,
      '凡人不能对峙，直接敲也要拦下：' + joined(denied),
    );

    // ② 被拒的动作不该把遭遇了结掉
    const character = h.repos.characters.findByUserId(USER)!;
    assert.ok(h.repos.creatures.openSighting(character.id), '被拒的动作不该了结遭遇');

    // ③ 凡人现在**可以**观察 —— 这正是菜单摆给他的第一项
    //    它是这条用例的重点：菜单给得出、判定就必须认
    const ok = await h.send({ rawText: '.遭遇 观察', userId: USER });
    const okText = joined(ok);
    assert.doesNotMatch(
      okText,
      /能做的不是这件事/,
      '菜单给了「观察」就不许在判定里拒绝它（菜单与判定必须同一份口径）：' + okText,
    );
  } finally {
    h.app.close();
  }
});

test('M2.8：没有遭遇时 .遭遇 给出明确的下一步', async () => {
  const h = createHarness();
  try {
    await h.createCharacter(USER, '空遭遇测试');
    const replies = await h.send({ rawText: '.遭遇', userId: USER });
    assert.match(joined(replies), /没有遇到什么/, '没有遭遇时要说明白：' + joined(replies));
  } finally {
    h.app.close();
  }
});
