/**
 * M2.13 **前置四项**的单测（与主任务「封印物」的 test/m2-13.test.ts 分开）。
 *
 * 四项各守一条：
 *   前置 1 —— 长链路两段口径：门槛是常数、判定函数是纯函数（脚本只是它的搬运工）
 *   前置 2 —— README 的 essence 可达性那一节存在（文档断言，防后人删掉）
 *   前置 3 —— 感知分层的判定当场落库（`creature_sighting_roll` 带双方序列）
 *   前置 4 —— **完整指令路径的 DOT 保护**：DIG 满 / 当日扮演到顶就不发 `.扮演`，
 *             以及 PVP 等待期的四档落点
 *
 * ⚠️ 这一份里**没有任何一条**是在放宽异常判定：`NO_CHANGE_STREAK` 反而被冻结断言钉住
 * （这是 M2.11 交付说明里写下的落点：改虚拟玩家的行为，不改阈值）。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { decide, makeContext, playIsPointless, PLAYER_MODEL } from '../src/vplayer/decide.ts';
import { buildWorld } from '../src/vplayer/cli.ts';
import { NO_CHANGE_STREAK } from '../src/vplayer/anomaly.ts';
import { loadCreatures } from '../src/data/loader.ts';
import { createHarness, type Harness } from './helpers/app.ts';
import type { PlayerProfile, PlayerSnapshot } from '../src/vplayer/types.ts';

const WORLD = buildWorld();
const { creatures: SPECIES } = loadCreatures();
const BY_ID = new Map(SPECIES.map((species) => [species.id, species]));

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
    persona: 'steady',
    goal: 'promote',
    pathway: 'seer',
    gender: 'male',
    loginTimesPerDay: 3,
    actionsPerLogin: 8,
    riskAppetite: 0.5,
    patience: 1,
    seed: 'seed-1',
    fleetSize: 200,
    ...overrides,
  };
}

/** 一场挂在身上的 PVP（`yourTurn` 决定是不是「等待期」） */
function pvpBattle(yourTurn: boolean): NonNullable<PlayerSnapshot['activeBattle']> {
  return {
    battleId: 'b1',
    round: 3,
    speciesId: 'pvp',
    speciesName: '另一位玩家',
    creatureHp: 80,
    creatureMaxHp: 100,
    creatureSequence: 9,
    creatureBerserk: false,
    playerHp: 80,
    playerMp: 60,
    playerStatuses: [],
    creaturePlayingDead: false,
    isPvp: true,
    opponentName: '另一位玩家',
    yourTurn,
    isChallenger: true,
  };
}

/* ================================================================== *
 * 前置 4：完整指令路径的 DIG 保护
 * ================================================================== */

test('前置 4：DIG 满 / 当日扮演到顶 → playIsPointless 为真（两种计数都算）', () => {
  // 正常状态：还能扮演
  assert.equal(playIsPointless(makeContext(profileOf(), snapshotOf({ dig: 60 }))), false);
  // 服务端消化度到顶
  assert.equal(playIsPointless(makeContext(profileOf(), snapshotOf({ dig: 100 }))), true);
  // 当日扮演次数（服务端流水）到顶
  assert.equal(
    playIsPointless(
      makeContext(profileOf(), snapshotOf({ dig: 60, dailyCounters: { play: PLAYER_MODEL.maxPlaysPerDay } })),
    ),
    true,
  );
  // 当日扮演次数（这次跑批自己数出来的）到顶
  assert.equal(
    playIsPointless(
      makeContext(profileOf(), snapshotOf({ dig: 60 }), { playsToday: PLAYER_MODEL.maxPlaysPerDay }),
    ),
    true,
  );
  // 差一点就不算满 —— 边界要准，否则「30 次」会变成「29 次就罢工」
  assert.equal(
    playIsPointless(
      makeContext(profileOf(), snapshotOf({ dig: 99.9, dailyCounters: { play: PLAYER_MODEL.maxPlaysPerDay - 1 } }), {
        playsToday: PLAYER_MODEL.maxPlaysPerDay - 1,
      }),
    ),
    false,
  );
});

test('前置 4：消化度满了之后，完整指令路径**任何一条链**都不再发 .扮演', () => {
  /*
   * 这一条是这一轮的核心断言。它覆盖的是 M2.9 漏掉的那半张网：
   *   菜单路径 —— `menuScore` 里 `if (dig >= 100) return 0`（M2.9 已加，本轮不动）
   *   完整指令路径 —— promoteChain 一处 + casualChain 三处（本轮补上）
   *
   * 「任何一条链」靠**枚举目标**来覆盖：goal 决定走哪条链，patience=1 保证不漂移。
   */
  for (const goal of ['promote', 'explore', 'social', 'casual'] as const) {
    for (const persona of ['steady', 'aggressive', 'chaotic', 'light', 'perfectionist'] as const) {
      for (let step = 0; step < 12; step += 1) {
        const ctx = makeContext(
          profileOf({ goal, persona, patience: 1, seed: 's' + step }),
          snapshotOf({
            dig: 100,
            dailyCounters: { play: PLAYER_MODEL.maxPlaysPerDay },
            // 不给任何「更有意义的事」留退路，逼它落到兜底分支上
            mp: 0,
          }),
          { step, day: 2, login: 1 },
        );
        const decision = decide(ctx, WORLD);
        assert.ok(
          !decision.command.startsWith('.扮演'),
          'DIG 满时仍然发了扮演：goal=' + goal + ' persona=' + persona + ' step=' + step + ' → ' + decision.command,
        );
      }
    }
  }
});

test('前置 4：PVP 等待期不空转 —— 四档落点按顺序生效', () => {
  const waiting = snapshotOf({ activeBattle: pvpBattle(false), dig: 100, hp: 100 });

  // 1) 未决遭遇优先
  assert.equal(
    decide(makeContext(profileOf(), { ...waiting, pendingSighting: true }), WORLD).command,
    '.遭遇 观察',
  );

  // 2) 背包里有能用的消耗品（且状态不满）→ 用一件
  assert.equal(
    decide(
      makeContext(profileOf(), {
        ...waiting,
        hp: 70,
        inventory: [{ itemId: '安神药剂', quantity: 1, bindType: 'bound' }],
      }),
      WORLD,
    ).command,
    '.使用 安神药剂',
  );

  // 3) HP 低于 50 → 休息
  assert.equal(
    decide(makeContext(profileOf(), { ...waiting, hp: 40 }), WORLD).command,
    '.休息',
  );

  /*
   * 4) 三档都没有 → **不接管，继续走正常的目标链**。
   *
   * 这一条是 200×30 逼出来的（两版都错在同一个方向）：
   *   第一版一律 `.状态`    → 20×3 的货币 / 通缉 / 袭击三项同时归零（把玩家挤出社交）；
   *   第二版改成 busywork   → 社交回来了，但**晋升进度腰斩**（序列 7 从 33 人掉到 15 人、
   *                          advantage 从 30 次掉到 12 次）—— 等待期占掉了当天的动作额度。
   *
   * 两版都漏了同一件事：**等待期该做的不是「另一个动作」，是「别的动作照旧」。**
   * 而「空转」是在 `.扮演` 的发出点上被挡住的（playIsPointless），不在这一层。
   *
   * 所以断言写成「**与不在等待期时拿到同一个决策**」—— 这把设计意图直接钉住了。
   */
  const normal = snapshotOf({ dig: 0, hp: 100, });
  assert.equal(
    decide(makeContext(profileOf(), { ...waiting, dig: 0 }), WORLD).command,
    decide(makeContext(profileOf(), normal), WORLD).command,
    '没有「必须要做的事」时，等待期与平常应当完全一样',
  );
});

test('前置 4：等待期**不会发「还需要参数」的符咒**（那类回执既不改状态、也不算拒绝）', () => {
  /*
   * 这一条来自 200×30 的实测：第一版让「背包里有能用的消耗品」那一档把
   * charm_teleport 也算了进去，而 .使用 传送符 不带地点时服务端回的是
   * 「要去哪？用法：……」—— 那句话**不在 isRejected 的词表里**，
   * 于是 noChangeStreak 一路涨到 10。实测 P1 一共 59 条，**全部**来自这一条指令。
   *
   * 教训：「凭空多发一条指令」与「这条指令会不会被算成拒绝」是两件事。
   */
  const base = {
    activeBattle: pvpBattle(false),
    hp: 60,
    partyId: 'p1',
    mp: 0,
    dig: 100,
  };
  const withCharms = decide(
    makeContext(
      profileOf(),
      snapshotOf({
        ...base,
        inventory: [
          { itemId: 'charm_teleport', quantity: 1, bindType: 'unbound' },
          { itemId: '符咒·灼烧', quantity: 1, bindType: 'bound' },
        ],
      }),
    ),
    WORLD,
  );
  // ⚠️ 断言的是「**不用它**」，不是「不碰它」——
  //    挂一笔交易把它卖掉是合理行为（闲置的一次性牌换成钱），也在实测里出现过。
  assert.ok(
    !withCharms.command.startsWith('.使用 charm_'),
    '传送符需要地点参数，等待期不该拿它凑数：' + withCharms.command,
  );
  assert.ok(
    !withCharms.command.startsWith('.使用 符咒'),
    '战斗专用符咒平时用不上：' + withCharms.command,
  );

  // 真正的消耗品仍然照用（这一档本身不能被削弱掉）
  const withPotion = decide(
    makeContext(
      profileOf(),
      snapshotOf({
        ...base,
        inventory: [{ itemId: '安神药剂', quantity: 1, bindType: 'bound' }],
      }),
    ),
    WORLD,
  );
  assert.equal(withPotion.command, '.使用 安神药剂');
});

test('前置 4：轮到自己的时候仍然正常出招（等待期分支不能吃掉正常战斗）', () => {
  const decision = decide(
    makeContext(profileOf(), snapshotOf({ activeBattle: pvpBattle(true) }), { menuPath: false }),
    WORLD,
  );
  assert.ok(decision.command.startsWith('.战斗 '), '轮到自己时应当出招，实际：' + decision.command);
});

test('前置 4：**没有放宽任何异常阈值**（NO_CHANGE_STREAK 冻结）', () => {
  /*
   * M2.11 的交付说明里写下了正确的落点：「DIG 满了就别再扮演这条保护要覆盖完整指令路径，
   * 而不是放宽 noChangeStreak」。这一条断言就是那句话的机器版本 ——
   * 本轮所有 P1 的下降都必须来自虚拟玩家的行为改变。
   */
  assert.equal(NO_CHANGE_STREAK, 10);
});

/* ================================================================== *
 * 前置 2：README 的 essence 可达性（文档断言）
 * ================================================================== */

test('前置 2：README 有 essence 可达性（M2.13 修订）一节，且写明了序列 7→6 那一轮的检查项', () => {
  const readme = readFileSync('README.md', 'utf8');
  assert.ok(readme.includes('感知分层的可达性（M2.13 修订）'), 'README 缺 M2.13 修订那一节');
  assert.ok(readme.includes('生物序列 ≥ 玩家序列 + 3'), '缺 essence 的判据写法');
  assert.ok(readme.includes('玩家必须在序列 6 以下'), '缺「要触发 essence，玩家必须在序列 6 以下」');
  assert.ok(readme.includes('总是触发'), '缺「序列 6 只能遇到灰雾游魂 → essence 总是触发」这条检查项');
  // 旧版那一句「advantage 不可达」必须已经被订正（保留为历史，但不能再是当前结论）
  assert.ok(readme.includes('历史：M2.9 那一版为什么把两层都记成「不可达」'), '缺历史订正');
});

test('前置 1：长链路两段口径写进了 README 与 M2.12 交付说明', () => {
  const readme = readFileSync('README.md', 'utf8');
  assert.ok(readme.includes('长链路验收：两段各自判定（M2.13 前置 1）'), 'README 缺两段口径');
  const delivery = readFileSync('docs/M2.12-交付说明.md', 'utf8');
  assert.ok(delivery.includes('长链路验收：**M2.13 起拆成两段**'), 'M2.12 交付说明缺口径修正');
  assert.ok(delivery.includes('≥ 25 人'), 'M2.12 交付说明缺 8→7 的门槛');
});

/* ================================================================== *
 * 前置 3：感知分层判定当场落库
 * ================================================================== */

const USER = '41301';
const COOLDOWN_MS = 11_000;

function joined(messages: ReadonlyArray<{ text: string }>): string {
  return messages.map((message) => message.text).join('\n');
}

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

test('前置 3：一次遭遇命中会留下 creature_sighting_roll，且带着**判定当时**的双方序列', async () => {
  const h = createHarness({ deterministicIds: true });
  await h.createCharacter(USER, '前置三号');
  const locationId = 'old_dock';
  let found: Record<string, unknown> | null = null;
  for (let attempt = 1; attempt <= 60 && !found; attempt += 1) {
    refreshForExplore(h, USER, locationId);
    placeCreature(h, 'whisperer', locationId);
    h.advance(COOLDOWN_MS);
    await h.send({ rawText: '.探索 老码头', userId: USER });
    const rows = h.app.db
      .prepare("SELECT payload FROM domain_events WHERE type = 'creature_sighting_roll' ORDER BY created_at DESC LIMIT 1")
      .all() as Array<{ payload: string }>;
    if (rows.length > 0) found = JSON.parse(rows[0]!.payload) as Record<string, unknown>;
  }
  assert.ok(found, '六十次探索都没命中遭遇（遭遇链路本身可能坏了）');
  assert.equal(typeof found!.playerSeq, 'number', '缺玩家序列');
  assert.equal(typeof found!.creatureSeq, 'number', '缺生物序列');
  assert.equal(found!.delta, (found!.creatureSeq as number) - (found!.playerSeq as number), 'delta 与两侧序列不一致');
  assert.equal(found!.speciesId, 'whisperer');
  assert.ok(
    ['blur', 'silhouette', 'full', 'advantage', 'essence'].includes(String(found!.layer)),
    '层次不在五层里：' + String(found!.layer),
  );
  h.app.db.close();
});

test('前置 3：既有的 creature_sighting（处置那一条）没被动过 —— 两种事件各答一个问题', async () => {
  const h = createHarness({ deterministicIds: true });
  await h.createCharacter(USER, '前置三号');
  const locationId = 'old_dock';
  let sawRoll = false;
  for (let attempt = 1; attempt <= 60 && !sawRoll; attempt += 1) {
    refreshForExplore(h, USER, locationId);
    placeCreature(h, 'whisperer', locationId);
    h.advance(COOLDOWN_MS);
    const replies = await h.send({ rawText: '.探索 老码头', userId: USER });
    found: {
      const rows = h.app.db
        .prepare("SELECT payload FROM domain_events WHERE type = 'creature_sighting_roll' LIMIT 1")
        .all() as Array<{ payload: string }>;
      if (rows.length === 0) break found;
      sawRoll = true;
      // 遭遇命中会改摆遭遇菜单 → 处置一次，落一条 creature_sighting
      const menu = joined(replies);
      if (/遭遇/.test(menu)) {
        await h.send({ rawText: '.遭遇 撤退', userId: USER });
      }
    }
  }
  assert.ok(sawRoll, '这一条依赖上一条的遭遇链路');
  const dispose = h.app.db
    .prepare("SELECT payload FROM domain_events WHERE type = 'creature_sighting' LIMIT 1")
    .all() as Array<{ payload: string }>;
  assert.ok(dispose.length > 0, '处置事件没写出来');
  const payload = JSON.parse(dispose[0]!.payload) as Record<string, unknown>;
  // 既有的形状：creatureId / speciesId / layer / action / harvest —— 一个字段都不能少
  for (const key of ['creatureId', 'speciesId', 'layer', 'action', 'harvest']) {
    assert.ok(key in payload, 'creature_sighting 少了 ' + key);
  }
  h.app.db.close();
});
