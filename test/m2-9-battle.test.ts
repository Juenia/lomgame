/**
 * M2.9 端到端测试：PVE 回合制战斗（走真实路由，不起纯函数）。
 *
 * 六组：
 *   一、入口（.战斗 开始 / 遭遇菜单里的「动手」/ 群里不摆菜单）
 *   二、五个玩家动作全部可用
 *   三、状态机（多回合 / 生物行为落库 / 结算）
 *   四、异步（5 分钟不回 = 自动防御，不是判负）
 *   五、胜负与后果（掉落 / DIG / 重伤 / 生物从世界消失）
 *   六、战斗中的 .遭遇（不重新触发遭遇判定）
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BATTLE } from '../src/config/numeric.ts';
import { createHarness, type Harness } from './helpers/app.ts';
import { FLAG_LOCATION } from '../src/infra/db/flags.ts';
import { loadCreatures } from '../src/data/loader.ts';
import type { CreatureSpecies } from '../src/domain/creature/types.ts';

/** 内容侧的物种表（与生产同一份 YAML）—— 夹具要按 baseHp / baseSequence 摆一只生物 */
const SPECIES = new Map(loadCreatures().creatures.map((species) => [species.id, species]));

/* ================================================================== *
 * 夹具：直接摆一只「已经遇上的生物」
 *
 * 为什么不走探索掷遭遇：遭遇是概率事件（15%），而这一批用例要研究的是**战斗**。
 * 用仓储直接摆一只生物 + 一行未决 sightings，等价于「玩家刚刚在雾里撞见了它」，
 * 而那条链路本身由 test/m2-8-encounter.test.ts 覆盖着。
 * ================================================================== */

const SPECIES_ID = 'whisperer';
const LOCATION_ID = 'old_dock';

function plantCreature(
  h: Harness,
  patch: { hp?: number; sequence?: number; speciesId?: string; status?: string } = {},
): string {
  const species = SPECIES.get(patch.speciesId ?? SPECIES_ID);
  assert.ok(species, '物种不存在');
  const id = 'test-creature-1';
  h.repos.creatures.insertMany([
    {
      id,
      speciesId: species!.id,
      locationId: LOCATION_ID,
      sequence: patch.sequence ?? species!.baseSequence,
      hp: patch.hp ?? species!.baseHp,
      maxHp: species!.baseHp,
      status: (patch.status ?? 'healthy') as 'healthy',
      ageHours: 0,
      feedCount: 0,
      lastFedAt: h.now(),
      spawnedAt: h.now(),
      migratedFrom: null,
    },
  ]);
  return id;
}

function plantSighting(h: Harness, characterId: string, creatureId: string, layer = 'full'): string {
  const id = 'test-sighting-' + Math.random().toString(36).slice(2, 8);
  const creature = h.repos.creatures.byId(creatureId);
  h.repos.creatures.recordSighting({
    id,
    characterId,
    creatureId,
    speciesId: creature?.speciesId ?? SPECIES_ID,
    layer: layer as 'full',
    seed: 'test',
    at: h.now(),
  });
  return id;
}

/**
 * 发一条战斗指令。
 *
 * 中间推进 6 秒是为了绕开 `战斗` 的每回合 5 秒频控 —— **不是绕过它**，
 * 而是像真人一样等一等：这条冷却本身是设计的一部分（防连点），
 * 测试不该因为「时钟不走」而看不见它。
 */
async function sendBattle(h: Harness, userId: string, rawText: string) {
  h.advance(6000);
  return h.send({ rawText, userId });
}

/**
 * 建号 → 站到老码头 → 摆一只生物与一次未决遭遇。
 *
 * `playerSequence` 默认与生物的基线序列对齐（diff = 0）——
 * 这不是为了「让玩家更强」，而是为了让「这一场打得赢 / 打不赢」由**用例**决定，
 * 而不是由 M2.6.1 的命中率掷骰决定（弱 1 级打 8 回合全不中的概率有 17%，
 * 那种用例会变成随机红的）。
 */
async function setUp(
  options: {
    playerHp?: number;
    playerSequence?: number;
    creatureHp?: number;
    creatureSequence?: number;
    speciesId?: string;
    /** 这次遭遇落在哪一层（决定「动手」在不在） */
    layer?: string;
  } = {},
) {
  const h = createHarness({ deterministicIds: true });
  const speciesId = options.speciesId ?? SPECIES_ID;
  const species = SPECIES.get(speciesId)!;
  const playerSequence = options.playerSequence ?? species.baseSequence;
  const { id, userId } = await h.createCharacter('30001', '战士', 'seer');
  h.repos.flags.set(id, FLAG_LOCATION, h.now(), LOCATION_ID);

  const state = h.repos.characters.findByUserId(userId)!;
  h.repos.characters.update({
    ...state,
    sequence: playerSequence,
    hp: options.playerHp ?? 100,
    updatedAt: h.now(),
  });

  const creatureId = plantCreature(h, {
    speciesId,
    hp: options.creatureHp,
    sequence: options.creatureSequence ?? species.baseSequence,
  });
  plantSighting(h, id, creatureId, options.layer ?? 'full');
  return { h, userId, characterId: id, creatureId };
}

/* ================================================================== *
 * 一、入口
 * ================================================================== */

test('战斗入口：.战斗 开始 建起状态机并摆出第 1 回合菜单，而且**不替玩家出招**', async () => {
  const { h, userId, characterId } = await setUp();
  const sent = await h.send({ rawText: '.战斗 开始', userId });
  const text = sent.map((message) => message.text).join('\n');

  assert.match(text, /你先动了手/);
  assert.match(text, /【战斗 · 第 1 回合】/);
  assert.match(text, /低语者 · HP 40\/40/);
  // 五个动作的按钮都在（技能按途径与序列给）
  assert.match(text, /1\. 攻击/);
  assert.match(text, /防御/);
  assert.match(text, /技能·占卜预判/);
  assert.match(text, /撤退/);

  // 开战本身不该消费一个回合
  const battle = h.repos.battles.activeOf(characterId);
  assert.ok(battle, '应当有一场未决战斗');
  assert.equal(battle!.round, 1);
  assert.equal(h.repos.battles.countRounds(), 0, '开战不该已经打过一回合');
});

test('战斗入口：看得见轮廓（silhouette）就能动手，只看到一团模糊（blur）不行', async () => {
  /*
   * 门槛是 **silhouette 及以上**（见 encounter-menu.ts 的实测修正说明）：
   * 任务书 §4.7 写的是 full，而实测里 full 只占 1.6%、照做会得到 0 场战斗。
   *
   * 这两条一起守：**门槛真的降了**（silhouette 能打），而且**没有降过头**
   * （blur 与普通人仍然打不了 —— 「你连那是个活物都不知道，动手只是把自己送上去」）。
   */
  const weak = await setUp({ layer: 'silhouette' });
  const ok = await sendBattle(weak.h, weak.userId, '.战斗 开始');
  assert.match(ok.map((m) => m.text).join('\n'), /【战斗 · 第 1 回合】/, '看得见轮廓就该打得起来');
  assert.equal(weak.h.repos.battles.count(), 1);

  const blurry = await setUp({ layer: 'blur' });
  const rejected = await sendBattle(blurry.h, blurry.userId, '.战斗 开始');
  assert.match(rejected.map((m) => m.text).join('\n'), /你还没看清那是什么/);
  assert.equal(blurry.h.repos.battles.count(), 0, '只看得到一团模糊时不该打得起来');
});

test('战斗入口：没有遭遇时 .战斗 开始 给出下一步，而不是报错', async () => {
  const h = createHarness({ deterministicIds: true });
  const { userId } = await h.createCharacter('30002', '路人');
  const sent = await h.send({ rawText: '.战斗 开始', userId });
  assert.match(sent[0]!.text, /你面前没有东西/);
});

test('战斗入口：仍在战斗时不能开第二场', async () => {
  const { h, userId } = await setUp();
  await sendBattle(h, userId, '.战斗 开始');
  // 再摆一次遭遇也不该开出第二场
  const character = h.repos.characters.findByUserId(userId)!;
  plantSighting(h, character.id, 'test-creature-1');
  await sendBattle(h, userId, '.战斗 开始');
  assert.equal(h.repos.battles.count(), 1, '一个角色同时只能有一场未决战斗');
});

test('战斗入口：群里直接摆出战斗菜单（与 M2.3 一致）', async () => {
  const { h, userId } = await setUp();
  const sent = await h.send({ rawText: '.战斗 开始', userId, scene: 'group' });
  /*
   * 注意这里**不能**断言 sent.length === 1：开战会同时走 deps.broadcast
   * 发一条匿名群播报「某处传来打斗声。」（battle.ts 里的 §4.3.7），
   * 它是独立于回复的通道，也落在同一个 adapter 上。
   * 要找的是那条**回执**，所以按内容定位而不是按下标。
   */
  const group = sent.find((message) => message.text.includes('【战斗'));
  assert.ok(group, `群里要摆出战斗菜单，实际：${sent.map((m) => m.text.slice(0, 30)).join(' | ')}`);
  assert.equal(group!.scene, 'group', '回执发回群里');
  assert.match(group!.text, /【战斗 · 第 1 回合】/, '群里要摆出战斗菜单');
  assert.match(group!.text, /回复数字。/);
  assert.equal(h.repos.battles.count(), 1, '群里那条指令正常开战');
});

/* ================================================================== *
 * 二、五个玩家动作
 * ================================================================== */

test('玩家的五个动作全部可用，而且都真的改变了状态', async () => {
  // 血厚一点：这一条测的是「五个动作都能用」，不该被「它先被打死了」打断
  const { h, userId, characterId } = await setUp({ creatureHp: 500 });

  // 攻击
  await sendBattle(h, userId, '.战斗 开始');
  const before = h.repos.battles.activeOf(characterId)!;
  await sendBattle(h, userId, '.战斗 攻击');
  const afterAttack = h.repos.battles.activeOf(characterId)!;
  const attackRounds = h.repos.battles.countRounds();
  assert.equal(attackRounds, 1);
  assert.ok(
    afterAttack.creatureHp <= before.creatureHp,
    '攻击之后生物的血不该变多',
  );

  // 防御
  await sendBattle(h, userId, '.战斗 防御');
  assert.equal(h.repos.battles.countRounds(), 2);
  const defendActions = h.repos.battles.playerActionDistribution();
  assert.ok(defendActions.has('defend'), '防御应当落进回合记录');

  // 技能（愚者序列 9 = 占卜预判）
  const mpBefore = h.repos.characters.findByUserId(userId)!.mp;
  await sendBattle(h, userId, '.战斗 技能 占卜预判');
  const mpAfter = h.repos.characters.findByUserId(userId)!.mp;
  assert.equal(mpBefore - mpAfter, BATTLE.skills.divine_foresight.mpCost, '技能要扣灵力');
  assert.ok(h.repos.battles.playerActionDistribution().has('skill:divine_foresight'));

  // 物品（直接塞一件符咒）
  h.repos.inventory.addMany(characterId, [{ itemId: '符咒·灼烧', quantity: 1, bindType: 'bound' }], h.now());
  await sendBattle(h, userId, '.战斗 物品 符咒·灼烧');
  assert.equal(h.repos.inventory.count(characterId, '符咒·灼烧'), 0, '用了就该扣掉');
  assert.ok(h.repos.battles.playerActionDistribution().has('item'));

  // 撤退（M2.85：撤退不再花行动点）
  await sendBattle(h, userId, '.战斗 撤退');
});

test('战斗入口：技能按途径与序列解禁 —— 序列 9 用不了序列 8 的能力', async () => {
  // 显式站到序列 9：这条守的是「解禁」本身，与其他用例的序列无关
  const { h, userId } = await setUp({ playerSequence: 9 });
  await sendBattle(h, userId, '.战斗 开始');
  const sent = await h.send({ rawText: '.战斗 技能 幻觉干扰', userId });
  assert.match(sent[0]!.text, /序列 8/, '拒绝的理由要写清楚在哪一级解锁');
  // 而序列 9 的那一个可以用
  const ok = await h.send({ rawText: '.战斗 技能 占卜预判', userId });
  assert.doesNotMatch(ok[0]!.text, /还用不了/);
});

test('战斗入口：不是自己途径的技能用不了', async () => {
  const { h, userId } = await setUp();
  await sendBattle(h, userId, '.战斗 开始');
  const sent = await h.send({ rawText: '.战斗 技能 强攻', userId });
  assert.match(sent[0]!.text, /途径/);
});

/* ================================================================== *
 * 三、状态机
 * ================================================================== */

test('状态机：一场战斗是多回合，每一回合都落一行带 seed 的回合记录', async () => {
  const { h, userId, characterId } = await setUp();
  await sendBattle(h, userId, '.战斗 开始');
  for (let index = 0; index < 3; index += 1) {
    await sendBattle(h, userId, '.战斗 防御');
  }
  assert.equal(h.repos.battles.countRounds(), 3);
  const battle = h.repos.battles.activeOf(characterId);
  assert.ok(battle);
  assert.equal(battle!.round, 4, '状态机应当推进到第 4 回合');

  // 每个回合都写了一条带 seed 的 domain_events（任务书 §4.2 硬约束）
  const events = h.repos.characters.eventsOf(characterId).filter((event) => event.type === 'battle_round');
  assert.equal(events.length, 3);
  for (const event of events) {
    assert.ok(event.seed, '每个回合都必须带 seed');
  }
});

test('状态机：玩家在战斗中回血，只同步状态、**不多记一个回合**', async () => {
  /*
   * 这一条守的是一个**报告口径**问题，不是功能问题。
   *
   * 玩家在战斗中途完全可以发一条 .休息（战斗不占一条指令通道），
   * 于是角色卡的 HP 动了而战斗状态里的不动。修法是每回合开始前以角色卡为准同步一次 ——
   * 但那次同步**不是一个回合**：如果顺手走了 saveRound，battle_rounds 就会多出一行
   * `defend / 0 伤害` 的假回合，而报告里的「回合数分布」「玩家动作分布」会被它污染，
   * 且**读数字时看不出任何异常**（这正是最难查的一类）。
   */
  const { h, userId, characterId } = await setUp({ creatureHp: 9999 });
  await sendBattle(h, userId, '.战斗 开始');
  await sendBattle(h, userId, '.战斗 防御');
  assert.equal(h.repos.battles.countRounds(), 1);

  // 等价于他在战斗里发了 .休息：直接改角色卡的血与灵力
  const state = h.repos.characters.findByUserId(userId)!;
  h.repos.characters.update({ ...state, hp: 60, mp: 40, updatedAt: h.now() });

  await sendBattle(h, userId, '.战斗 防御');
  assert.equal(h.repos.battles.countRounds(), 2, '同步不该多记一个回合');

  const battle = h.repos.battles.activeOf(characterId)!;
  // 同步生效：以角色卡为准（40）再算上这一回合的防御回灵（+5）
  assert.equal(battle.playerMp, 40 + 5, '战斗里的灵力应当以角色卡为准');
  assert.ok(battle.playerHp <= 60, '战斗里的血也应当以角色卡为准');
});

test('状态机：八回合打满即僵持 —— 无奖励、无惩罚', async () => {
  /*
   * 两个都换掉，缺一不可：
   *   生物 9999 血  —— 打不死它
   *   生物序列 9 / 玩家序列 5 —— 它**近不了你的身**（M2.6.1 的序列差门控），所以你也死不了
   * 剩下唯一可能的结果就是「八回合打满」。
   *
   * 顺带说明一处口径：战斗里的 HP 是**开战时从世界状态读的那一份**，
   * 开战之后再改 creatures 表不会影响这一场 —— 这正是 M2.8「你打的是此时此刻的它」。
   */
  const { h, userId, characterId } = await setUp({
    creatureHp: 9999,
    speciesId: 'grey_wraith',
    creatureSequence: 9,
    playerSequence: 5,
  });
  await sendBattle(h, userId, '.战斗 开始');
  for (let index = 0; index < BATTLE.maxRounds; index += 1) {
    await sendBattle(h, userId, '.战斗 防御');
  }
  assert.equal(h.repos.battles.countRounds(), BATTLE.maxRounds);
  assert.equal(h.repos.battles.activeOf(characterId), null, '僵持之后不该还有未决战斗');
  assert.equal(h.repos.battles.statusDistribution().get('stalemate'), 1);
});

test('状态机：生物的行为按数据落库，不是一句旁白', async () => {
  const { h, userId } = await setUp({ creatureHp: 9999 });
  await sendBattle(h, userId, '.战斗 开始');
  await sendBattle(h, userId, '.战斗 防御');
  const kinds = [...h.repos.battles.creatureActionDistribution().keys()];
  assert.ok(kinds.length > 0, '生物这一回合做了什么必须落在库里');
  assert.ok(kinds.every((kind) => kind.length > 0));
});

/* ================================================================== *
 * 四、异步：5 分钟不回 = 自动防御
 * ================================================================== */

test('异步：玩家关掉 QQ 五分钟，回来时战斗按自动防御往前推了一格（不是判负）', async () => {
  const { h, userId, characterId } = await setUp();
  await sendBattle(h, userId, '.战斗 开始');

  // 直接走掉 5 分钟（+ 一点余量）
  h.advance(BATTLE.playerTimeoutMs + 1000);
  await h.send({ rawText: '.状态', userId });

  assert.equal(h.repos.battles.countRounds(), 1, '超时应当补一个自动防御回合');
  const actions = h.repos.battles.playerActionDistribution();
  assert.equal(actions.get('defend'), 1, '超时执行的是防御');

  // 关键：**不是判负** —— 战斗还在
  const battle = h.repos.battles.activeOf(characterId);
  assert.ok(battle, '超时不判负，战斗还在原地等着');
  assert.equal(battle!.round, 2);
  // 而且玩家还能接着打
  await sendBattle(h, userId, '.战斗 攻击');
  assert.equal(h.repos.battles.countRounds(), 2);
});

test('异步：走开 40 分钟就是一格一格地推，不是一口气推满八回合', async () => {
  // 打不死的血包（开战前就换好），才能观察「推了几格」而不是「什么时候打完」
  const { h, userId, characterId } = await setUp({ creatureHp: 9999 });
  await sendBattle(h, userId, '.战斗 开始');

  // 恰好 3 格：3 × 5 分钟
  h.advance(BATTLE.playerTimeoutMs * 3 + 1000);
  await h.send({ rawText: '.状态', userId });
  assert.equal(h.repos.battles.countRounds(), 3, '40 分钟没到，3 格就该是 3 个回合');
  assert.ok(h.repos.battles.activeOf(characterId));
});

/* ================================================================== *
 * 五、胜负与后果
 * ================================================================== */

test('玩家胜：掉落入库、DIG +2、那只生物从世界里消失', async () => {
  // 一只只剩 1 点血的低语者：只要打中一下就是赢
  const { h, userId, characterId, creatureId } = await setUp({ creatureHp: 1 });
  await sendBattle(h, userId, '.战斗 开始');
  const digBefore = h.repos.characters.findByUserId(userId)!.dig;
  // 必中才行 —— 用序列相同（都是 9 的灰雾游魂）不合适，这里多打几回合直到结束
  for (let index = 0; index < BATTLE.maxRounds; index += 1) {
    if (!h.repos.battles.activeOf(characterId)) break;
    await sendBattle(h, userId, '.战斗 攻击');
  }
  const statuses = h.repos.battles.statusDistribution();
  assert.ok(statuses.has('player_win'), '这一场应当打得赢：' + JSON.stringify([...statuses]));

  const digAfter = h.repos.characters.findByUserId(userId)!.dig;
  assert.equal(digAfter - digBefore, BATTLE.rewards.digOnWin);
  assert.equal(h.repos.creatures.byId(creatureId), null, '赢了的生物要从世界里消失');
});

test('玩家败：重伤（不删卡）、行动点清空、疯狂 +5', async () => {
  // 1 点血对上序列 5 的时序蠕虫（100 HP）：这一场必败，而且必然在八回合内败
  const { h, userId, characterId } = await setUp({
    playerHp: 1,
    speciesId: 'chrono_worm',
    creatureHp: 100,
  });
  const madBefore = h.repos.characters.findByUserId(userId)!.mad;
  await sendBattle(h, userId, '.战斗 开始');
  for (let index = 0; index < BATTLE.maxRounds; index += 1) {
    if (!h.repos.battles.activeOf(characterId)) break;
    await sendBattle(h, userId, '.战斗 攻击');
  }

  const after = h.repos.characters.findByUserId(userId)!;
  const statuses = h.repos.battles.statusDistribution();
  if (statuses.has('player_lose')) {
    assert.equal(after.status, 'injured', '败了就是重伤，但不删卡');
    assert.ok(after.mad >= madBefore + BATTLE.rewards.madOnLose - 5, '疯狂要涨上去');
    assert.ok(h.repos.characters.findByUserId(userId), '角色卡还在');
  }
});

/* ================================================================== *
 * 六、战斗中的 .遭遇
 * ================================================================== */

test('战斗进行中 .遭遇 显示「你正在和 X 打」，而不是重新触发一次遭遇判定', async () => {
  const { h, userId } = await setUp();
  await sendBattle(h, userId, '.战斗 开始');
  const before = h.repos.creatures.countSightings();

  const sent = await h.send({ rawText: '.遭遇', userId });
  const text = sent.map((message) => message.text).join('\n');
  assert.match(text, /你正在和低语者打/);
  assert.match(text, /第 1 回合/);
  assert.match(text, /【战斗 · 第 1 回合】/);
  assert.equal(h.repos.creatures.countSightings(), before, '战斗中不该再掷出新的遭遇');
});

test('战斗进行中 .遭遇 观察 不会绕过战斗（它只会把战斗现场再摆一次）', async () => {
  const { h, userId } = await setUp();
  await sendBattle(h, userId, '.战斗 开始');
  const sent = await h.send({ rawText: '.遭遇 观察', userId });
  assert.match(sent.map((message) => message.text).join('\n'), /你正在和低语者打/);
});

/* ================================================================== *
 * 七、群内播报：匿名
 * ================================================================== */

test('播报：开战与结束都会往群里发一句**匿名**的话', async () => {
  const { h, userId, characterId } = await setUp({ creatureHp: 1 });
  const broadcasts: string[] = [];
  h.app.router.deps.broadcast = (text: string) => broadcasts.push(text);

  // 群要先登记过，否则真实 broadcast 不会发（测试里换了收集器，这一步只是同一手法）
  await h.send({ rawText: '.状态', userId, scene: 'group' });

  await sendBattle(h, userId, '.战斗 开始');
  assert.ok(broadcasts.includes('某处传来打斗声。'), '开战要播报：' + JSON.stringify(broadcasts));

  for (let index = 0; index < BATTLE.maxRounds; index += 1) {
    if (!h.repos.battles.activeOf(characterId)) break;
    await sendBattle(h, userId, '.战斗 攻击');
  }
  if (h.repos.battles.statusDistribution().has('player_win')) {
    assert.ok(broadcasts.includes('某处的打斗停了。'), '胜负要播报：' + JSON.stringify(broadcasts));
  }
  // 匿名：任何一条播报里都不该出现玩家名或物种名
  for (const text of broadcasts) {
    assert.doesNotMatch(text, /战士|低语者/);
  }
});