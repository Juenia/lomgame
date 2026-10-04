/**
 * M2.16 测试：玩家入教 + 等级贡献。
 *
 * ## 这一轮最该被测住的三件事
 *
 *   1. **入教范围是窄的，而窄不是故障**：只有 sleepless / warrior 两条途径的玩家
 *      入得了教；\`seer\`（占出生权重 80）走的是 M2.7.6 的引导路径 ——
 *      §B 用**端到端**把那条路走了一遍（被找上 → 做任务 → 拿配方 → 调制 → 入途径），
 *      并断言他**没有**教会归属。它不是「绕过」，是另一条路。
 *   2. **双门槛与双触发**：档位由「贡献 + 序列」算出来，而序列会在晋升之后变 ——
 *      只在捐款后检测的话，「贡献早就够了、序列后来才够」的人会一直卡在旧档上。
 *      §D 把两处触发点都测了。
 *   3. **捐献不掷骰**（铁律 6）：§E 直接断言事件 seed 为 null，
 *      并用「同 messageId 的探索掉落逐位相同」做端到端对照。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { NUMERIC } from '../src/config/numeric.ts';
import { CHURCHES_FILE, loadContent, loadChurches, validateChurches } from '../src/data/loader.ts';
import { ChurchIndex } from '../src/domain/church/index.ts';
import {
  canDonate,
  canJoin,
  checkRankUp,
  contributionOf,
  currentRank,
  donationCap,
  nextRankOf,
  rankNameOf,
} from '../src/domain/church/membership.ts';
import { CURRENCY_ITEM_ID } from '../src/domain/item/item.ts';
import { runDailyTick } from '../src/infra/tick.ts';
import { createHarness, DEFAULT_USER, type Harness } from './helpers/app.ts';

const content = loadContent();
const index = new ChurchIndex(content.churches, content.cities, content.locations);
const byId = (id: string) => index.byId(id)!;

/** 建一个「已入途径 + 落在指定城市 + 指定钱包」的角色 */
async function prepare(
  pathway: 'seer' | 'warrior' | 'sleepless',
  cityId: string,
  penny = 0,
): Promise<{ h: Harness; id: string }> {
  const h = createHarness({ deterministicIds: true });
  const created = await h.createCharacter(DEFAULT_USER, '克莱恩', pathway);
  const state = h.repos.characters.findById(created.id)!;
  h.repos.characters.update({ ...state, currentCityId: cityId, updatedAt: h.now() });
  if (penny > 0) h.repos.inventory.add(created.id, CURRENCY_ITEM_ID, penny, 'unbound', h.now());
  return { h, id: created.id };
}

async function say(h: Harness, text: string, userId = DEFAULT_USER, messageId?: string): Promise<string> {
  const messages = await h.send({ rawText: text, scene: 'private', userId, ...(messageId ? { messageId } : {}) });
  return messages.map((message) => message.text).join('\n');
}

function eventsOf(h: Harness, id: string, type: string) {
  return h.repos.characters.eventsOf(id).filter((event) => event.type === type);
}

/* ==================== §A 入教 ==================== */

test('M2.16-A：sleepless 玩家在 tingen / pritz / byron 都能入黑夜女神教会', async () => {
  for (const city of ['tingen', 'pritz', 'byron']) {
    const { h, id } = await prepare('sleepless', city);
    const text = await say(h, '.加入教会 night_goddess');
    assert.match(text, /【入教 · 黑夜女神】/, city + ' 该能入教');
    const state = h.repos.characters.findById(id)!;
    assert.equal(state.churchId, 'night_goddess');
    assert.equal(state.churchContribution, 0);

    const events = eventsOf(h, id, 'church_join');
    assert.equal(events.length, 1);
    assert.deepEqual(events[0]!.payload, { churchId: 'night_goddess', cityId: city });
    assert.equal(events[0]!.seed, null, '入教是确定性判定，seed 必须是 null');
    h.app.close();
  }
});

test('M2.16-A：warrior 玩家在 backlund / pritz / trier 都能入战神教会', async () => {
  for (const city of ['backlund', 'pritz', 'trier']) {
    const { h, id } = await prepare('warrior', city);
    const text = await say(h, '.加入教会 god_of_war');
    assert.match(text, /【入教 · 战神】/, city + ' 该能入教');
    assert.equal(h.repos.characters.findById(id)?.churchId, 'god_of_war');
    h.app.close();
  }
});

test('M2.16-A：五条判据各自给出具体原因（不是「不能入教」四个字）', async () => {
  // ① 跨城市：战神教会在廷根没有堂口
  const crossCity = await prepare('warrior', 'tingen');
  const t1 = await say(crossCity.h, '.加入教会 god_of_war');
  assert.match(t1, /廷根市没有堂口/);
  assert.equal(crossCity.h.repos.characters.findById(crossCity.id)?.churchId, null);
  crossCity.h.app.close();

  // ② 跨途径：seer 玩家入不了黑夜女神（她只收不眠者）
  const crossPathway = await prepare('seer', 'tingen');
  const t2 = await say(crossPathway.h, '.加入教会 night_goddess');
  assert.match(t2, /只收走不眠者途径的人，而你是愚者途径/);

  /*
   * ③ 途径未实现 —— **M2.76：这条判据在内容表上已经不可达**。
   *
   * 它原来是靠「找一家 pathway=null 的教会」来触发的，而 M2.19 → M2.26 → M2.76 一路
   * 把七家全部绑上了途径（22 条正途径全落地）⇒ 一家待定的都不剩。
   *
   * ⇒ 改成守卫**这件事本身**：如果哪天有人加了一家待定教会，这里会红，
   *   提醒他「canJoin 的这条分支要重新有一条真实用例」。
   *   这比留一条永远不触发的断言强 —— 后者看起来在守，其实什么都没守。
   */
  assert.ok(
    content.churches.every((church) => church.pathway !== null),
    '七家教会应当全部绑上途径（若新增待定教会，请为 canJoin 的「途径还没有开放」分支补一条真实用例）',
  );
  crossPathway.h.app.close();

  // ④ 未入途径：普通人
  const mortalHarness = createHarness({ deterministicIds: true });
  const mortal = await mortalHarness.createMortal(DEFAULT_USER, '还没上路的人');
  const t4 = await say(mortalHarness, '.加入教会 night_goddess');
  assert.match(t4, /还没有走上任何途径/);
  mortalHarness.app.close();

  // ⑤ 硬互斥：入了就不能再入
  const exclusivity = await prepare('sleepless', 'tingen');
  await say(exclusivity.h, '.加入教会 night_goddess');
  const t5 = await say(exclusivity.h, '.加入教会 night_goddess');
  assert.match(t5, /已经入了一家教会/);
  assert.equal(eventsOf(exclusivity.h, exclusivity.id, 'church_join').length, 1, '不许记第二条入教事件');

  // 未知 id
  const t6 = await say(exclusivity.h, '.加入教会 不存在的教会');
  assert.match(t6, /没有叫/);
  exclusivity.h.app.close();
  void mortal;
});

/* ==================== §B seer 的专属验收 ==================== */

test('M2.16-B：seer 玩家走的是引导路径 —— 走通之后没有教会归属', async () => {
  /*
   * 这条用例是 M2.16 任务书点名要的「专属验收项」，写法与普通入教一样重。
   *
   * 为什么要重试 userId：引导势力是按城市给的（tingen 的 primary 是教会 / 愚者），
   * 而「出生城市」由 userId 确定性派生 —— 所以只能筛一个落点合适的号，
   * 再靠 0.7 的 primary 概率命中 seer（试 8 次全不中的概率是 6.6e-5）。
   */
  /*
   * M2.85：原来「8 次重试等 seer 保底」的写法随引导玩法删除 ——
   * 途径现在由翻到的线索决定，测试直接插一张 seer 的纸（判定层的落点权重
   * 与内容表的双向对齐由 test/m2-7-6 守着，这里不必再掷骰）。
   */
  const h = createHarness({ deterministicIds: true });
  try {
    const userId = '860000';
    const mortal = await h.createMortal(userId, '找路的人');
    h.repos.characters.update({ ...mortal, currentCityId: 'tingen', updatedAt: h.now() });

    // 翻到一张愚者的纸（M2.85 起这是唯一入口）
    h.repos.clues.insert({
      id: 'clue-seer',
      characterId: mortal.id,
      pathway: 'seer',
      clueText: '一本没有封面的笔记本。',
      foundAt: h.now(),
      usedAt: null,
    });

    // 凑材料 → 调制 → 服用（走真实的入途径链路）
    const recipe = content.recipes.find((entry) => entry.pathway === 'seer' && entry.seq === 9)!;
    for (const need of [...recipe.main, ...recipe.aux]) {
      h.repos.inventory.add(mortal.id, need.itemId, need.qty * 4, 'unbound', h.now());
    }
    let brewed = false;
    for (let tryCount = 0; tryCount < 10 && !brewed; tryCount += 1) {
      h.advance(31_000);
      await h.send({ rawText: '.魔药 ' + recipe.id, userId });
      brewed = h.repos.inventory.list(mortal.id).some((slot) => slot.itemId.startsWith('potion_seer'));
      if (!brewed) h.repos.characters.update({ ...h.repos.characters.findById(mortal.id)!, mp: 100, cor: 0 });
    }
    assert.ok(brewed, '线索路必须能把配方变成魔药');
    const potion = h.repos.inventory.list(mortal.id).find((slot) => slot.itemId.startsWith('potion_seer'))!;

    h.advance(1000);
    const drunk = await h.send({ rawText: '.服用 ' + potion.itemId, userId });
    assert.match(drunk[0]!.text, /【入途径/, '走通了线索路就该入途径');

    const initiated = h.repos.characters.findById(mortal.id)!;
    assert.equal(initiated.pathwayStatus, 'initiated');
    assert.equal(initiated.pathway, 'seer');
    assert.equal(initiated.churchId, null, 'seer 玩家没有教会归属 —— 这是设计，不是遗漏');

    // 回执必须说清「没有你的教会」，而不是「你条件不够」
    const churchText = await say(h, '.教会', userId);
    assert.match(churchText, /当前城市没有与你途径对应的正神教会/);
    assert.match(churchText, /\.探索/);

    // 硬互斥的另一面：他也入不了任何一家（跨途径）
    const refused = await say(h, '.加入教会 night_goddess', userId);
    assert.match(refused, /只收走不眠者途径的人/);
  } finally {
    h.app.close();
  }
});

/* ==================== §C 捐献 ==================== */

test('M2.16-C：贡献 = floor(penny / 10)，零头不计', async () => {
  const { h, id } = await prepare('sleepless', 'tingen', 1000);
  await say(h, '.加入教会 night_goddess');
  const text = await say(h, '.教会 捐献 95');
  assert.match(text, /贡献 \+9/);
  assert.match(text, /零头 5 便士不计/);
  assert.equal(h.repos.characters.findById(id)?.churchContribution, 9);
  assert.equal(h.repos.inventory.count(id, CURRENCY_ITEM_ID), 905, '钱要真的扣掉');

  const event = eventsOf(h, id, 'church_contribute')[0]!;
  assert.deepEqual(event.payload, {
    churchId: 'night_goddess',
    penny: 95,
    contribution: 9,
    rankBefore: 0,
    rankAfter: 1,
    source: 'donate',
  });
  assert.equal(event.seed, null, '捐献不掷骰：seed 显式 null');
  h.app.close();
});

test('M2.16-C：每日一次 / 上界 50% / 钱不够 / 未入教 —— 四条拒绝路径', async () => {
  const { h, id } = await prepare('sleepless', 'tingen', 200);
  await say(h, '.加入教会 night_goddess');

  // 上界：当前 200，一次最多 100
  const overCap = await say(h, '.教会 捐献 150');
  assert.match(overCap, /一次最多捐献 100 便士/);
  assert.equal(h.repos.characters.findById(id)?.churchContribution, 0, '被拒的捐献不能加分');

  // 钱不够
  const broke = await say(h, '.教会 捐献 500');
  assert.match(broke, /你只有 200 便士|一次最多捐献/);
  assert.equal(h.repos.characters.findById(id)?.churchContribution, 0);

  // 成功一次
  await say(h, '.教会 捐献 100');
  assert.equal(h.repos.characters.findById(id)?.churchContribution, 10);

  // 冷却：24 小时内第二次被拒
  const again = await say(h, '.教会 捐献 100');
  assert.match(again, /今天已经捐过了/);
  // 跨过冷却就又能捐
  h.advance(NUMERIC.church.donation.cooldownMs + 1000);
  h.repos.inventory.add(id, CURRENCY_ITEM_ID, 100, 'unbound', h.now());
  const ok = await say(h, '.教会 捐献 100');
  assert.match(ok, /贡献 \+10/);

  // 未入教
  const stranger = await prepare('sleepless', 'tingen', 100);
  const t = await say(stranger.h, '.教会 捐献 10');
  assert.match(t, /你还没有入教/);
  stranger.h.app.close();
  h.app.close();
});

/* ==================== §D 档位：双门槛 + 双触发 ==================== */

test('M2.16-D：贡献够 + 序列够 → 捐款当场升档，并落 church_rank_up', async () => {
  const { h, id } = await prepare('sleepless', 'tingen', 1000);
  await say(h, '.加入教会 night_goddess');
  const text = await say(h, '.教会 捐献 60'); // 6 点 → 跨过第 2 档门槛 5
  assert.match(text, /你现在是守夜人/);

  const ups = eventsOf(h, id, 'church_rank_up');
  assert.equal(ups.length, 1);
  assert.deepEqual(ups[0]!.payload, {
    churchId: 'night_goddess',
    fromRank: 0,
    toRank: 1,
    source: 'donate',
  });
  assert.equal(ups[0]!.seed, null);
  h.app.close();
});

test('M2.16-D：只有贡献够（序列不够）→ 停在旧档，等每日结算', async () => {
  const { h, id } = await prepare('warrior', 'backlund', 100000);
  await say(h, '.加入教会 god_of_war');

  /*
   * 第 4 档要序列 8。先把序列压到 8、捐到第 4 档的贡献，再把他打回序列 9 ——
   * 模拟「贡献早就够了、当时序列不够」那种人。
   */
  h.repos.characters.update({ ...h.repos.characters.findById(id)!, sequence: 9 });
  await say(h, '.教会 捐献 2000'); // 200 点 → 贡献上到第 4 档，但序列 9 只到第 3 档
  const mid = h.repos.characters.findById(id)!;
  assert.equal(mid.churchContribution, 200);
  assert.equal(currentRank(mid, byId('god_of_war')), 2, '序列 9 只到第 3 档（索引 2）');
  assert.equal(eventsOf(h, id, 'church_rank_up').length, 1, '只该升到序列允许的那一档');

  // 序列升上来（这里直接改库，等价于玩家自己 .晋升 成功）
  h.repos.characters.update({ ...h.repos.characters.findById(id)!, sequence: 8 });
  assert.equal(currentRank(h.repos.characters.findById(id)!, byId('god_of_war')), 3, '双门槛都过了');

  // 第二处触发点：每日结算
  h.advance(86_400_000);
  const summary = runDailyTick(h.app.router.deps, h.now());
  const ups = eventsOf(h, id, 'church_rank_up');
  assert.equal(ups.length, 2, '每日结算必须把这一档认掉');
  assert.deepEqual(
    ups[1]!.payload,
    // from 是**上一次记到的档位**（序列 9 时升到的那一档），不是「贡献档」
    { churchId: 'god_of_war', fromRank: 2, toRank: 3, source: 'daily_tick' },
    '一次可以跨档（贡献早就囤够了），事件记 from → to',
  );
  assert.ok(
    // 战神第 4 档（索引 3）叫「主教」—— 七家的前两档叫法不同，第 4 档起才是共享的
    summary.notifications.some((note) => note.text.includes('主教')),
    '升档要私聊告诉本人：' + JSON.stringify(summary.notifications),
  );
  h.app.close();
});

test('M2.16-D：同一档不会重复记事件（每日结算幂等）', async () => {
  const { h, id } = await prepare('sleepless', 'tingen', 1000);
  await say(h, '.加入教会 night_goddess');
  await say(h, '.教会 捐献 60');
  assert.equal(eventsOf(h, id, 'church_rank_up').length, 1);

  h.advance(86_400_000);
  runDailyTick(h.app.router.deps, h.now());
  h.advance(86_400_000);
  runDailyTick(h.app.router.deps, h.now());
  assert.equal(eventsOf(h, id, 'church_rank_up').length, 1, '档位没变就不该再记');
  h.app.close();
});

test('M2.16-D：判定层边界（双门槛 / 最高档 / 下一档差额）', () => {
  const church = byId('night_goddess');
  const cfg = NUMERIC.church.ranks;

  // 贡献够但序列不够 → 取低的那一档
  assert.equal(currentRank({ churchContribution: 3125, sequence: 9 }, church), 2);
  assert.equal(currentRank({ churchContribution: 3125, sequence: 7 }, church), 5);
  assert.equal(currentRank({ churchContribution: 0, sequence: 9 }, church), 0);
  assert.equal(currentRank({ churchContribution: 4, sequence: 9 }, church), 0);

  // 已经最高档 → 没有下一档
  assert.equal(nextRankOf({ churchContribution: 99999, sequence: 7 }, church), null);
  // 6 点已经踩在第 2 档（索引 1）上，所以下一档是索引 2（门槛 25）
  const next = nextRankOf({ churchContribution: 6, sequence: 9 }, church)!;
  assert.equal(next.index, 2);
  assert.equal(next.contribution, cfg.contributionThreshold[2]);
  assert.equal(next.missingContribution, cfg.contributionThreshold[2]! - 6);
  assert.equal(next.sequenceOk, true);

  // 升档判定
  assert.equal(checkRankUp({ churchContribution: 5, sequence: 9 }, church, 0).canUp, true);
  assert.equal(checkRankUp({ churchContribution: 5, sequence: 9 }, church, 1).canUp, false);
  assert.equal(checkRankUp({ churchContribution: 4, sequence: 9 }, church, 0).blockedBy, 'contribution');
  assert.equal(checkRankUp({ churchContribution: 125, sequence: 9 }, church, 2).blockedBy, 'sequence');
  assert.equal(checkRankUp({ churchContribution: 99999, sequence: 7 }, church, 5).blockedBy, 'max');

  // 换算与上界
  assert.equal(contributionOf(0), 0);
  assert.equal(contributionOf(9), 0);
  assert.equal(contributionOf(10), 1);
  assert.equal(contributionOf(95), 9);
  assert.equal(donationCap(201), 100);
  assert.equal(canDonate({ churchId: 'night_goddess', penny: 201 }, church, 101).ok, false);
  assert.equal(canDonate({ churchId: 'night_goddess', penny: 201 }, church, 100).ok, true);
  assert.equal(canDonate({ churchId: 'other', penny: 201 }, church, 100).ok, false);

  // canJoin 的五条判据在纯函数层也各有一条正例 / 反例
  const base = { pathway: 'sleepless' as const, pathwayStatus: 'initiated', churchId: null };
  assert.equal(canJoin(base, church, { cityId: 'tingen' }).ok, true);
  assert.equal(canJoin(base, church, { cityId: 'trier' }).ok, false);
  assert.equal(canJoin({ ...base, pathwayStatus: 'mortal' }, church, { cityId: 'tingen' }).ok, false);
  assert.equal(canJoin({ ...base, churchId: 'x' }, church, { cityId: 'tingen' }).ok, false);
  assert.equal(canJoin(base, byId('storm_lord'), { cityId: 'backlund' }).ok, false);
  assert.equal(rankNameOf(church, 1), '守夜人');
});

/* ==================== §E 不掷骰（铁律 6） ==================== */

test('M2.16-E：捐献与入教都不消耗随机数 —— 同 messageId 的探索掉落逐位相同', async () => {
  const run = async (donate: boolean): Promise<string> => {
    const { h, id } = await prepare('sleepless', 'tingen', 1000);
    await say(h, '.加入教会 night_goddess');
    if (donate) await say(h, '.教会 捐献 100');
    h.advance(1000);
    const text = await say(h, '.探索 老码头', DEFAULT_USER, 'm216-probe');
    void id;
    h.app.close();
    return text;
  };
  const without = await run(false);
  const withDonate = await run(true);
  assert.equal(
    withDonate,
    without,
    '捐了一次钱不该让同 seed 的探索结果漂移 —— 捐献不掷骰',
  );
});

test('M2.16-E：domain_events 里的教会事件 seed 全是 null（不是空字符串）', async () => {
  const { h, id } = await prepare('sleepless', 'tingen', 1000);
  await say(h, '.加入教会 night_goddess');
  await say(h, '.教会 捐献 100');
  for (const type of ['church_join', 'church_contribute', 'church_rank_up']) {
    for (const event of eventsOf(h, id, type)) {
      assert.equal(event.seed, null, type + ' 的 seed 必须显式是 null');
      assert.notEqual(event.seed, '', type + ' 的 seed 不能是空字符串');
    }
  }
  // 直接查库：列里真的是 NULL，而不是 'undefined' / ''
  const raw = h.app.db
    .prepare(
      "SELECT COUNT(*) AS n FROM domain_events WHERE type LIKE 'church%' AND seed IS NOT NULL",
    )
    .get() as { n: number };
  assert.equal(raw.n, 0, '库里不许出现非 NULL 的教会事件 seed');
  h.app.close();
});

/* ==================== §F 反向断言（M2.15 的 contractionChance 手法） ==================== */

test('M2.16-F：NUMERIC.church 里不许出现 M2.17+ 的字段', () => {
  const church = NUMERIC.church as unknown as Record<string, unknown>;
  for (const forbidden of ['exitCooldownMs', 'membershipLimit', 'maxMembers', 'pvpBonus', 'dogmaFlags']) {
    assert.equal(church[forbidden], undefined, forbidden + ' 是 M2.17+ 的字段，本轮不许出现');
  }
  // donation 里也不许提前长东西
  const donation = church['donation'] as Record<string, unknown>;
  assert.deepEqual(
    Object.keys(donation).sort(),
    ['cooldownMs', 'maxShareOfHolding', 'pennyPerContribution'],
  );
});

test('M2.16-F：churches.yaml 里不许出现贡献阈值（阈值只能在 NUMERIC）', () => {
  const raw = readFileSync(CHURCHES_FILE, 'utf8');
  for (const forbidden of ['contributionThreshold', 'sequenceGate', 'pennyPerContribution']) {
    assert.ok(!raw.includes(forbidden), '内容表里出现了 ' + forbidden + ' —— 阈值是数值，不是内容');
  }
  // 但档位**名**必须在内容里（每家叫法不同）
  for (const church of content.churches) {
    assert.equal(church.ranks.length, NUMERIC.church.ranks.contributionThreshold.length);
  }
});

test('M2.16-F：ranks 档数与 NUMERIC 门槛数组不等长时，loader 报 error', () => {
  const broken = structuredClone(content.churches[0]!);
  broken.ranks = broken.ranks.slice(0, 3);
  const issues = validateChurches([broken], content.cities);
  assert.ok(
    issues.some((issue) => issue.level === 'error' && issue.message.includes('两边必须等长')),
    '档数对不上必须报错：' + JSON.stringify(issues),
  );
  const parsed = loadChurches();
  assert.deepEqual(parsed.issues.filter((i) => i.level === 'error'), []);
});

/* ==================== §G 档位 id 不是全局 id 空间 ==================== */

test('M2.16-G：rank[i].id 只在教会内可比（同一个 id 在不同教会是不同名字）', () => {
  const storm = byId('storm_lord');
  const mother = byId('earth_mother');
  assert.equal(storm.ranks[2]!.id, 'priest');
  assert.equal(mother.ranks[2]!.id, 'priest');
  assert.notEqual(storm.ranks[2]!.name, mother.ranks[2]!.name, '风暴叫司铎、母神叫司祭');
  // 所以跨教会的档位一律用索引说话（七家都是 6 档）
  for (const church of content.churches) {
    assert.equal(church.ranks.length, 6, church.id + ' 的档数必须与其它教会一致');
  }
});

/* ==================== §H 数据层 ==================== */

test('M2.16-H：迁移加了 church_id / church_contribution 两列，且改号读回一致', async () => {
  const { h, id } = await prepare('sleepless', 'tingen');
  const columns = h.app.db.prepare('PRAGMA table_info(characters)').all() as Array<{ name: string }>;
  const names = columns.map((column) => column.name);
  assert.ok(names.includes('church_id'));
  assert.ok(names.includes('church_contribution'));

  h.repos.characters.update({ ...h.repos.characters.findById(id)!, churchId: 'night_goddess', churchContribution: 42 });
  const readBack = h.repos.characters.findById(id)!;
  assert.equal(readBack.churchId, 'night_goddess');
  assert.equal(readBack.churchContribution, 42);
  h.app.close();
});
