/**
 * W7 虚拟玩家实例测试的单测（与 CLI 的真实 HTTP 长跑互补）
 *
 * 覆盖三类东西：
 *   1) 可复现：画像 / 扮演文本 / 决策都是 (seed, 快照) 的纯函数
 *   2) 检查器口径：越界要跟着能力上限走、卡死不算被拒的指令、地点按 id 匹配
 *   3) 长链路规则：promote 链每一步的优先级（建号 → 材料 → 调制 → 服用 → 晋升）
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildProfiles, PERSONA_SPECS } from '../src/vplayer/profiles.ts';
import { PLAYER_MODEL, makeContext, playTextAt, decide } from '../src/vplayer/decide.ts';
import { buildWorld } from '../src/vplayer/cli.ts';
import { analyzeCardReachability, computeCoverage, commandNameOf } from '../src/vplayer/coverage.ts';
import { checkSnapshotConsistency, NO_CHANGE_STREAK } from '../src/vplayer/anomaly.ts';
import { readStatCaps, signatureOf } from '../src/vplayer/session.ts';
import { createGroupChatLog, PARTY_ANNOUNCE_TTL_MS, PARTY_GONE_PATTERN } from '../src/vplayer/http.ts';
import { createSeededRng, seedFrom } from '../src/domain/rng.ts';
import { NUMERIC } from '../src/config/numeric.ts';
import { createHarness } from './helpers/app.ts';
import type { PlayerProfile, PlayerSnapshot } from '../src/vplayer/types.ts';

const WORLD = buildWorld();

function snapshotOf(overrides: Partial<PlayerSnapshot> = {}): PlayerSnapshot {
  return {
    exists: true,
    characterId: 'c1',
    name: '测试者',
    sequence: 9,
    hp: 100,
    mp: 100,
    mad: 0,
    cor: 0,
    dig: 0,
    dp: 0,
    status: 'active',
    promotionFails: 0,
    inventory: [],
    flags: new Set<string>(),
    pendingTradeCount: 0,
    dailyCounters: {},
    exploreCounts: {},
    // M2.69：次数（daily_limit 是上限，默认 1）；空表 = 今天什么都没出过
    triggeredToday: new Map<string, number>(),
    partyId: null,
    partySize: 1,
    isPartyLeader: false,
    ritualPreparing: false,
    ritualRunning: false,
    ritualLocationId: null,
    // M2.6：通缉 / 位置 / 信誉
    wantedLevel: 0,
    wantedFactionId: null,
    currentLocationId: null,
    reputation: 0,
    ...overrides,
  };
}

function profileOf(overrides: Partial<PlayerProfile> = {}): PlayerProfile {
  return {
    id: 1,
    userId: '700001',
    name: '测试者1',
    persona: 'aggressive',
    goal: 'promote',
    pathway: 'seer',
    gender: 'male',
    loginTimesPerDay: 3,
    actionsPerLogin: 8,
    riskAppetite: 0.8,
    patience: 1,
    seed: 'seed-1',
    fleetSize: 200,
    ...overrides,
  };
}

test('画像：同一 seed 输出完全一致，画像与目标都是可复现的', () => {
  const a = buildProfiles({ players: 50, seed: 'w7-unit' });
  const b = buildProfiles({ players: 50, seed: 'w7-unit' });
  assert.deepEqual(a, b);
  const c = buildProfiles({ players: 50, seed: 'w7-unit-2' });
  assert.notDeepEqual(a, c);

  for (const profile of a) {
    assert.equal(profile.fleetSize, 50);
    assert.ok(profile.loginTimesPerDay >= 1);
    assert.ok(profile.actionsPerLogin >= 2);
    assert.ok(profile.userId.startsWith('7000'));
  }
  // 五种画像都要出现在样本里（否则某些边界根本没人压）
  const personas = new Set(a.map((p) => p.persona));
  for (const spec of PERSONA_SPECS) assert.ok(personas.has(spec.persona), spec.persona);
});

test('扮演文本：每个契合标签用满每日上限再换下一个，用完后转沾边组合', () => {
  const cap = NUMERIC.playScore.tagDailyCap;
  const tags = ['占卜', '预兆', '命运', '历史', '幻觉', '幕后'];
  // 前 cap 次都押同一个标签
  for (let i = 0; i < cap; i += 1) assert.match(playTextAt('seer', i), new RegExp(tags[0]!));
  for (let i = cap; i < cap * 2; i += 1) assert.match(playTextAt('seer', i), new RegExp(tags[1]!));
  // 契合标签用完之后改用两个沾边标签（0.5 + 0.5 = 1.0）
  const afterCore = playTextAt('seer', cap * tags.length);
  assert.match(afterCore, /观察|推算|仪式|低语|赌/);
  // 文本里不能出现违背途径的词
  for (let i = 0; i < 60; i += 1) {
    const text = playTextAt('seer', i);
    for (const bad of ['蛮力', '正面冲锋', '暴怒']) assert.ok(!text.includes(bad), text);
  }
});

test('promote 链：未建号先建号，有魔药先服用，消化度不足用扮演推', () => {
  const profile = profileOf();
  const world = WORLD;
  const recipe = world.recipes.find((r) => r.pathway === 'seer' && r.seq === 9)!;

  const fresh = decide(makeContext(profile, snapshotOf({ exists: false })), world);
  // M2.7：出生城市是派生的，而每座城市只传承两条途径 ——
  // 「用哪条途径建号」因此取决于这位玩家落在哪座城市，不再写死愚者。
  // M2.7.6：建号不再带途径 —— 第一步只发姓名（性别由随后的数字回复决定）
  assert.match(fresh.command, /^\.创建 测试者1$/);

  const withPotion = decide(
    makeContext(profile, snapshotOf({ inventory: [{ itemId: recipe.productItemId, quantity: 1, bindType: 'unbound' }] })),
    world,
  );
  assert.match(withPotion.command, /^\.服用 /);

  // 消化度远低于门槛、材料齐全 → 先调制（+6 消化度比扮演快）
  const brewReady = decide(
    makeContext(
      profile,
      snapshotOf({
        dig: 10,
        flags: new Set([`ability_seer_9`]),
        inventory: [
          { itemId: recipe.main[0]!.itemId, quantity: 3, bindType: 'unbound' },
          { itemId: recipe.aux[0]!.itemId, quantity: 1, bindType: 'bound' },
        ],
      }),
    ),
    world,
  );
  assert.match(brewReady.command, /^\.魔药 /);
});

test('promote 链：消化度达标 + 材料齐 → 晋升；已到序列 8 → 不再刷晋升', () => {
  const profile = profileOf();
  const world = WORLD;
  const recipe = world.recipes.find((r) => r.pathway === 'seer' && r.seq === 9)!;
  const main = recipe.main[0]!;
  const enough = main.qty * NUMERIC.promotion.mainMaterialMultiplier;

  const promote = decide(
    makeContext(
      profile,
      snapshotOf({
        dig: NUMERIC.promotion.digThreshold + PLAYER_MODEL.digBuffer.aggressive!,
        flags: new Set(['ability_seer_9']),
        inventory: [{ itemId: main.itemId, quantity: enough, bindType: 'unbound' }],
      }),
    ),
    world,
  );
  assert.equal(promote.command, '.晋升');

  const promoted = decide(
    makeContext(profile, snapshotOf({ sequence: 8, dig: 80, })),
    world,
  );
  assert.ok(!promoted.command.startsWith('.晋升'), promoted.command);
});

test('异常检查：越界要跟着能力上限走，不能把战士序列 8 的 HP 105 误报成 P0', () => {
  const harness = createHarness();
  try {
    const db = harness.app.db;
    const snapshot = snapshotOf({ hp: 105 });
    const where = { playerId: 1, day: 1, virtualNow: 0, command: '.休息' };

    const withoutCaps = checkSnapshotConsistency(db, snapshot, where);
    assert.ok(withoutCaps.some((a) => a.code === 'STAT_OUT_OF_RANGE' && a.level === 'P0'));

    const withCaps = checkSnapshotConsistency(db, snapshot, where, { hp: [0, 110] });
    assert.equal(withCaps.filter((a) => a.code === 'STAT_OUT_OF_RANGE').length, 0);
  } finally {
    harness.app.close();
  }
});

test('能力上限：解锁战士序列 8 之后 HP 上限按 abilities 表抬高', async () => {
  const harness = createHarness();
  try {
    const character = await harness.createCharacter('710001', '战士甲', 'warrior');
    const caps0 = readStatCaps(harness.app.db, character.id, 'warrior');
    assert.deepEqual(caps0, {});

    harness.repos.flags.setMany(character.id, ['ability_warrior_8'], harness.now());
    const caps1 = readStatCaps(harness.app.db, character.id, 'warrior');
    assert.deepEqual(caps1.hp, [0, 110]);
  } finally {
    harness.app.close();
  }
});

test('快照签名：交易冻结（数量变化但栏位数不变）也算状态变化', () => {
  const before = snapshotOf({ inventory: [{ itemId: '主材料·灰雾结晶', quantity: 2, bindType: 'unbound' }] });
  const after = snapshotOf({ inventory: [{ itemId: '主材料·灰雾结晶', quantity: 1, bindType: 'unbound' }] });
  assert.equal(before.inventory.length, after.inventory.length);
  assert.notEqual(signatureOf(before), signatureOf(after));

  const withTrade = snapshotOf({ pendingTradeCount: 1 });
  assert.notEqual(signatureOf(snapshotOf()), signatureOf(withTrade));
  assert.ok(NO_CHANGE_STREAK >= 10);
});

test('覆盖率：地点按 id 取数，卡片可达性按真实抽卡路径判定', () => {
  const reachability = analyzeCardReachability(
    [
      { id: 'daily_x', locations: [], type: 'daily' },
      // 随机卡带 location 限制，且没进任何地点的 events：探索抽不到、扮演不带地点也抽不到
      { id: 'random_gated', locations: ['老码头'], type: 'random' },
      { id: 'random_free', locations: [], type: 'random' },
    ],
    WORLD.locations,
  );
  const gated = reachability.find((entry) => entry.cardId === 'random_gated')!;
  assert.equal(gated.reachable, false);
  assert.equal(reachability.find((entry) => entry.cardId === 'random_free')!.reachable, true);
  assert.equal(reachability.find((entry) => entry.cardId === 'daily_x')!.reachable, true);

  const harness = createHarness();
  try {
    const report = computeCoverage(
      [],
      harness.app.db,
      {
        commands: ['扮演'],
        cards: ['random_gated'],
        locations: WORLD.locations.map((location) => ({ id: location.id, name: location.name })),
        recipes: WORLD.recipes.map((recipe) => recipe.id),
        lostControlTexts: [],
      },
      {
        minCommandCount: 1,
        unreachableCards: ['random_gated'],
        unreachableReasons: { random_gated: '限定了地点但没进 events' },
      },
    );
    // 地点键是中文名，取数用 id —— 本轮没探索，计数必须全是 0 而不是 undefined
    assert.ok(report.locations.every((item) => item.count === 0 && item.pass === false));
    assert.equal(report.contentGaps.length, 1);
    assert.equal(report.contentGaps[0]!.key, 'random_gated');
    assert.ok(report.cards.every((item) => item.pass), '抽不到的卡不该算失败项');
  } finally {
    harness.app.close();
  }
});

test('指令名解析：去掉点号与参数，供覆盖率统计使用', () => {
  assert.equal(commandNameOf('.扮演 我在占卜'), '扮演');
  assert.equal(commandNameOf('。探索 老码头'), '探索');
  assert.equal(commandNameOf('.状态'), '状态');
});

test('决策可复现：同 profile + 同快照 → 同一条指令', () => {
  const profile = profileOf({ seed: seedFrom(['vplayer', 'unit', 7]) });
  const snapshot = snapshotOf({ dig: 30, mad: 40, cor: 20, inventory: [] });
  const ctx = makeContext(profile, snapshot, { day: 3, login: 1, step: 4 });
  const first = decide(ctx, WORLD);
  const second = decide(makeContext(profile, snapshot, { day: 3, login: 1, step: 4 }), WORLD);
  assert.deepEqual(first, second);

  // 同 seed 的 rng 也一致（决策用到的随机源全部由 seed 派生）
  const rngA = createSeededRng(profile.seed);
  const rngB = createSeededRng(profile.seed);
  assert.deepEqual([rngA.next(), rngA.next()], [rngB.next(), rngB.next()]);
});

test('失控处理（M2.1 起这条分支第一次真的跑到）：有圣盐先净化，用不了就退到休息', () => {
  const profile = profileOf({ persona: 'steady' });
  const lost = snapshotOf({ status: 'lost_control', mad: 60, cor: 50 });

  // 有圣盐 → 净化
  const withSalt = decide(
    makeContext(profile, { ...lost, inventory: [{ itemId: '辅助材料·圣盐', quantity: 1, bindType: 'bound' }] }),
    WORLD,
  );
  assert.match(withSalt.command, /^\.净化$/);

  // 没圣盐 → 直接休息，不能一直撞「净化材料不足」
  const noSalt = decide(makeContext(profile, lost), WORLD);
  assert.match(noSalt.command, /^\.休息$/);

  // 上一次净化被系统拒绝 → 也退到休息
  const rejected = decide(
    makeContext(
      profile,
      { ...lost, inventory: [{ itemId: '辅助材料·圣盐', quantity: 1, bindType: 'bound' }] },
      { lastRejected: '净化' },
    ),
    WORLD,
  );
  assert.match(rejected.command, /^\.休息$/);

  // 净化与休息今天都用过了 → 照常玩（真人也会先玩完这一天）
  const bothUsed = decide(makeContext(profile, { ...lost, dailyCounters: { purify: 1, rest: 1 } }), WORLD);
  assert.doesNotMatch(bothUsed.command, /^\.(净化|休息)$/);

  // 混乱型依旧不恢复：它就是要留在失控里压边界（M2.1 的 lost_* 可见性全靠这一档）
  const chaotic = decide(makeContext(profileOf({ persona: 'chaotic' }), lost), WORLD);
  assert.doesNotMatch(chaotic.command, /^\.(净化|休息)$/);
});

test('方案 C：群里读到组队公告就加入，而不是瞎猜 QQ', async () => {
  const chat = createGroupChatLog();
  chat.ingest(
    [
      { path: 'send_group_msg', targetId: '10001', text: '【稳健者0】创建了队伍 307798。', at: 0 },
      { path: 'send_group_msg', targetId: '10001', text: '【激进者1】加入了【稳健者0】的队伍。', at: 0 },
    ],
    1000,
  );
  assert.deepEqual(chat.openParties(1000), ['307798'], '只认带队号的公告');
  // 队号大小写无关（服务端 .队伍 加入 会 toUpperCase）
  chat.ingest([{ path: 'send_group_msg', targetId: '10001', text: '【混乱者2】创建了队伍 9b6381。', at: 0 }], 2000);
  assert.deepEqual(chat.openParties(2000), ['9B6381', '307798'], '最近公告的排前面');
  // TTL 过期就不再尝试加入（解散公告不带队号，只能靠时效淘汰）
  assert.deepEqual(chat.openParties(2000 + PARTY_ANNOUNCE_TTL_MS + 1), []);
  assert.equal(chat.size(), 0);
});

test('方案 C：有公告时决策会去打 .队伍 加入 <队号>，没公告时不会', () => {
  const world = WORLD;
  const profile = profileOf({ goal: 'social', persona: 'steady' });
  const base = snapshotOf({ partyId: null, partySize: 1 });
  const sweep = (knownParties: string[]): string[] =>
    Array.from({ length: 40 }, (_, step) =>
      decide(makeContext(profile, base, { day: 2, login: 0, step, knownParties }), world).command,
    );

  const withChat = sweep(['307798']);
  assert.ok(
    withChat.some((cmd) => cmd === '.队伍 加入 307798'),
    '读到公告就应该直接加入（实际：' + withChat.slice(0, 6).join(' / ') + '）',
  );
  assert.equal(sweep([]).some((cmd) => cmd === '.队伍 加入 307798'), false, '没公告就不该凭空出现队号');
});
test('方案 C：加入失败的队会被划掉，不再反复重试（否则一次小轮就打 200 次死队）', () => {
  const chat = createGroupChatLog();
  chat.ingest([{ path: 'send_group_msg', targetId: '10001', text: '【稳健者0】创建了队伍 03A805。', at: 0 }], 0);
  assert.deepEqual(chat.openParties(0), ['03A805']);
  chat.close('03a805'); // 大小写无关
  assert.deepEqual(chat.openParties(0), []);
  assert.equal(chat.size(), 0);

  // 服务端「这个队没了」的三种话术都要认得；「你已经在一个队伍里」不算（那是我方状态）
  for (const text of ['这个队伍已经解散了。', '队伍已满（上限 4 人）。', '找不到这个队伍：03A805']) {
    assert.ok(PARTY_GONE_PATTERN.test(text), text + ' 应该判定为队没了');
  }
  assert.equal(PARTY_GONE_PATTERN.test('你已经在一个队伍里。'), false);
});
