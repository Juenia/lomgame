/**
 * M2.10 端到端测试：PVP 战斗（走真实路由）。
 *
 * 覆盖任务书 §4.10 的验收项：发起条件、双方各自计时、跨城市拒绝、僵持扣 AP、
 * 认输不通缉、匿名播报、胜负后果。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BATTLE, PVP } from '../src/config/numeric.ts';
import { createHarness, type Harness } from './helpers/app.ts';

/** 建两个玩家（都在廷根城中心 —— 同地点是发起条件之一） */
async function setUp() {
  const h = createHarness({ deterministicIds: true });
  const a = await h.createCharacter('40001', '甲挑战者', 'seer');
  const b = await h.createCharacter('40002', '乙应战者', 'warrior');
  return { h, a, b };
}

/** 发一条指令并推进时钟（绕开 .挑战 / .战斗 的频控，不绕过它们本身） */
async function send(h: Harness, userId: string, rawText: string, scene: 'private' | 'group' = 'private') {
  h.advance(11000);
  return h.send({ rawText, userId, scene });
}

const isPvpBattle = (h: Harness, id: string) => h.repos.battles.activeOf(id);

/* ================================================================== *
 * 一、发起
 * ================================================================== */

test('PVP：.挑战 摆出菜单，发起后创建战斗并私聊通知对方', async () => {
  const { h, a, b } = await setUp();
  const menu = await send(h, a.userId, '.挑战 乙应战者');
  const menuText = menu.map((m) => m.text).join('\n');
  assert.match(menuText, /【挑战 · 你 → @乙应战者】/);
  assert.match(menuText, /1\. 发起挑战/);
  assert.match(menuText, /2\. 说句话/);
  assert.match(menuText, /3\. 转身离开/);

  const started = await send(h, a.userId, '.挑战 乙应战者 发起');
  const text = started.map((m) => m.text).join('\n');
  assert.match(text, /你先动了手/);

  // 对手收到私聊（群里匿名、私聊知情）
  const notice = started.find((message) => message.targetId === b.userId);
  assert.ok(notice, '对手必须收到一条私聊通知');
  assert.match(notice!.text, /甲挑战者\s*→ 你/);
  assert.match(notice!.text, /发起了挑战/);

  const battle = isPvpBattle(h, a.id);
  assert.ok(battle, '应当有一场未决的 PVP');
  assert.equal(battle!.isPvp, true);
  assert.equal(battle!.characterId, a.id);
  assert.equal(battle!.opponentCharacterId, b.id);
  assert.equal(battle!.creatureId, '', 'PVP 没有生物实例');
});

test('PVP：跨地点明确拒绝（M2.7 的移动不能白做）', async () => {
  const { h, a, b } = await setUp();
  // 把应战者挪到另一个地点
  h.repos.flags.set(b.id, 'loc', h.now(), 'graveyard_path');
  const sent = await send(h, a.userId, '.挑战 乙应战者 发起');
  assert.match(sent[0]!.text, /你们不在同一个地方/);
  assert.equal(h.repos.battles.count(), 0, '被拒时不该落库');
});

test('PVP：对方在战斗中 / 自己是重伤，都不能发起', async () => {
  const { h, a, b } = await setUp();
  const state = h.repos.characters.findByUserId(a.userId)!;
  h.repos.characters.update({ ...state, status: 'injured', updatedAt: h.now() });
  const hurt = await send(h, a.userId, '.挑战 乙应战者 发起');
  assert.match(hurt[0]!.text, /重伤/);

  // 恢复之后，把对方设成「正在战斗中」
  h.repos.characters.update({ ...state, status: 'active', updatedAt: h.now() });
  const battle = h.repos.battles;
  battle.create({
    ...(await (async () => {
      const { createPvpBattleState } = await import('../src/domain/battle/index.ts');
      return createPvpBattleState({
        id: 'other-battle',
        challenger: h.repos.characters.findByUserId(b.userId)!,
        opponent: h.repos.characters.findByUserId(a.userId)!,
        world: {
          locationId: 'tingen_center',
          locationName: '廷根中心',
          night: false,
          danger: 1,
          weatherHitPenalty: 0,
          weatherLabel: '晴',
        },
        now: h.now(),
      });
    })()),
    id: 'other-battle',
  });
  const busy = await send(h, a.userId, '.挑战 乙应战者 发起');
  assert.match(busy[0]!.text, /正在打/);
});

/* ================================================================== *
 * 二、异步回合
 * ================================================================== */

test('PVP：两人各出一个动作才结算（先出招的人先亮牌）', async () => {
  const { h, a, b } = await setUp();
  await send(h, a.userId, '.挑战 乙应战者 发起');

  // 发起者先出招 → 只记下动作，**不结算**
  const first = await send(h, a.userId, '.战斗 攻击');
  const firstText = first.map((m) => m.text).join('\n');
  assert.match(firstText, /等他回应/);
  assert.equal(h.repos.battles.countRounds(), 0, '一个人出招不算一个回合');

  const pending = h.repos.battles.activeOf(a.id)!;
  assert.equal(pending.turnOf, 'opponent', '回合权应当交给对方');
  assert.ok(pending.pendingAction, '动作应当被暂存');

  // 还没有轮到他 —— 他再出招会被挡
  const twice = await send(h, a.userId, '.战斗 攻击');
  assert.match(twice[0]!.text, /还没轮到你/);

  // 应战者出招 → 这一回合结算
  const second = await send(h, b.userId, '.战斗 攻击');
  const secondText = second.map((m) => m.text).join('\n');
  assert.match(secondText, /这一回合：你出/);
  assert.equal(h.repos.battles.countRounds(), 1, '两个人各出一个动作 = 一个回合');

  const after = h.repos.battles.activeOf(a.id)!;
  assert.equal(after.turnOf, 'challenger', '结算之后回到发起者');
  assert.equal(after.pendingAction, null, '暂存的动作要被清空');
});

test('PVP：每回合落一条带 seed 的 domain_events（与 PVE 同一口径）', async () => {
  const { h, a, b } = await setUp();
  await send(h, a.userId, '.挑战 乙应战者 发起');
  await send(h, a.userId, '.战斗 攻击');
  await send(h, b.userId, '.战斗 防御');

  const events = h.repos.characters.eventsOf(a.id).filter((event) => event.type === 'pvp_round');
  assert.equal(events.length, 1);
  for (const event of events) assert.ok(event.seed, '每个回合都必须带 seed');

  // 发起那一刻也留了痕（对手那一侧也有一条）
  const challenged = h.repos.characters.eventsOf(b.id).filter((event) => event.type === 'pvp_challenged');
  assert.equal(challenged.length, 1, '被挑战的人的事件流里必须能查到这件事');
});

/* ================================================================== *
 * 三、超时：双方各自计时
 * ================================================================== */

test('PVP：轮到谁谁超时 —— 系统替那一方防御，战斗往前走一格（不判负）', async () => {
  const { h, a, b } = await setUp();
  await send(h, a.userId, '.挑战 乙应战者 发起');
  await send(h, a.userId, '.战斗 攻击'); // 发起者出招，轮到应战者

  // 应战者挂机 5 分钟
  h.advance(PVP.playerTimeoutMs + 1000);
  await send(h, a.userId, '.状态');

  // 系统替**应战者**防御 → 这一回合结算了
  assert.equal(h.repos.battles.countRounds(), 1, '谁超时就替谁防御，一格也不能少');
  const after = h.repos.battles.activeOf(a.id);
  assert.ok(after, '超时不判负，这一场还在');
  assert.equal(after!.status, 'active');
});

test('PVP：两个人都挂机也不会僵在原地（每次轮到谁就推一格）', async () => {
  const { h, a } = await setUp();
  await send(h, a.userId, '.挑战 乙应战者 发起');
  // 谁都没出招 —— 发起者先手，他超时 → 系统替他防御 → 轮到应战者
  h.advance(PVP.playerTimeoutMs + 1000);
  await send(h, a.userId, '.状态');
  const battle = h.repos.battles.activeOf(a.id)!;
  assert.equal(battle.turnOf, 'opponent', '一格之后回合权交出去了');
  assert.ok(battle.pendingAction, '发起者的自动防御被记下了');
});

/* ================================================================== *
 * 四、认输与僵持
 * ================================================================== */

test('PVP：认输立即结束、自己判负、**对方不通缉**', async () => {
  const { h, a, b } = await setUp();
  await send(h, a.userId, '.挑战 乙应战者 发起');
  const sent = await send(h, a.userId, '.战斗 认输');
  assert.match(sent.map((m) => m.text).join('\n'), /你举起手/);

  assert.equal(h.repos.battles.activeOf(a.id), null, '认输之后不该还有未决战斗');
  assert.equal(h.repos.battles.statusDistribution().get('player_lose'), 1, '发起者认输 = 发起者败');
  // 认输不通缉：一条通缉令都不该签发
  const wanted = h.repos.characters.eventsOf(a.id).filter((event) => event.type === 'wanted_issued');
  assert.equal(wanted.length, 0, '对方是自己认的输，不该吃通缉');
  // 败者：重伤要等 HP 归零才置位 —— 认输时血量没掉光（M2.85 起不再清空行动点）
  const afterA = h.repos.characters.findByUserId(a.userId)!;
  assert.equal(afterA.status, 'active', '认输不是被打倒，血量没归零就不算重伤');
});

test('PVP：8 回合打满 = 僵持（M2.85 起不再各扣 1 行动点）', async () => {
  const { h, a, b } = await setUp();
  await send(h, a.userId, '.挑战 乙应战者 发起');

  // 双方都一直防御，打满 8 回合
  for (let round = 0; round < BATTLE.maxRounds; round += 1) {
    if (!h.repos.battles.activeOf(a.id)) break;
    await send(h, a.userId, '.战斗 防御');
    if (!h.repos.battles.activeOf(a.id)) break;
    await send(h, b.userId, '.战斗 防御');
  }

  const status = h.repos.battles.statusDistribution();
  assert.ok(status.has('stalemate'), '一直防御应当打成僵持：' + JSON.stringify([...status]));
});

/* ================================================================== *
 * 五、胜负后果
 * ================================================================== */

test('PVP：胜者 DIG +2 并吃 3 级通缉，败者重伤不删卡', async () => {
  const { h, a, b } = await setUp();
  await send(h, a.userId, '.挑战 乙应战者 发起');

  // 把应战者打到只剩 1 点血 —— 让这一场必然分出胜负
  const opponentBattle = h.repos.battles.activeOf(a.id)!;
  const wounded: typeof opponentBattle = { ...opponentBattle, creatureHp: 1 };
  h.repos.battles.syncState(wounded);

  const digBefore = h.repos.characters.findByUserId(a.userId)!.dig;
  for (let round = 0; round < BATTLE.maxRounds; round += 1) {
    if (!h.repos.battles.activeOf(a.id)) break;
    await send(h, a.userId, '.战斗 攻击');
    if (!h.repos.battles.activeOf(a.id)) break;
    await send(h, b.userId, '.战斗 攻击');
  }

  const status = h.repos.battles.statusDistribution();
  assert.ok(status.has('player_win') || status.has('player_lose'), '这一场应当分出胜负：' + JSON.stringify([...status]));

  if (status.has('player_win')) {
    const winner = h.repos.characters.findByUserId(a.userId)!;
    const loser = h.repos.characters.findByUserId(b.userId)!;
    assert.equal(winner.dig - digBefore, BATTLE.rewards.digOnWin, '胜者 DIG +2');
    assert.equal(loser.status, 'injured', '败者重伤');
    assert.ok(h.repos.characters.findByUserId(b.userId), '败者不删卡');
    const wanted = h.repos.characters.eventsOf(a.id).filter((event) => event.type === 'wanted_issued');
    assert.equal(wanted.length, 1, '胜者吃一条通缉');
    assert.equal((wanted[0]!.payload as { level: number }).level, PVP.wantedLevelOnWin, '3 级');
  }
});

test('PVP：掉落败者 20% 非绑定物品，但至少给他留 1 件', async () => {
  const { h, a, b } = await setUp();
  // 给应战者 5 件非绑定物品
  h.repos.inventory.addMany(
    b.id,
    [1, 2, 3, 4, 5].map((index) => ({ itemId: '辅助材料·圣盐', quantity: index, bindType: 'unbound' as const })),
    h.now(),
  );
  const total = h.repos.inventory.count(b.id, '辅助材料·圣盐');
  assert.ok(total >= 5);

  await send(h, a.userId, '.挑战 乙应战者 发起');
  const battle = h.repos.battles.activeOf(a.id)!;
  h.repos.battles.syncState({ ...battle, creatureHp: 1 });

  for (let round = 0; round < BATTLE.maxRounds; round += 1) {
    if (!h.repos.battles.activeOf(a.id)) break;
    await send(h, a.userId, '.战斗 攻击');
    if (!h.repos.battles.activeOf(a.id)) break;
    await send(h, b.userId, '.战斗 攻击');
  }

  if (h.repos.battles.statusDistribution().has('player_win')) {
    const winnerHas = h.repos.inventory.count(a.id, '辅助材料·圣盐');
    const loserHas = h.repos.inventory.count(b.id, '辅助材料·圣盐');
    assert.ok(winnerHas > 0, '胜者应当拿到东西');
    assert.ok(loserHas >= PVP.lootKeepMinItems, '败者至少留 1 件（不能被抢光）');
    assert.equal(winnerHas + loserHas, total, '转移不改变总数');
  }
});

/* ================================================================== *
 * 六、播报与菜单
 * ================================================================== */

test('PVP：群里只说「有人打起来了」，不点名', async () => {
  const { h, a } = await setUp();
  const broadcasts: string[] = [];
  h.app.router.deps.broadcast = (text: string) => broadcasts.push(text);
  await send(h, a.userId, '.状态', 'group');
  await send(h, a.userId, '.挑战 乙应战者 发起');
  assert.ok(broadcasts.includes('某处有人打起来了。'), JSON.stringify(broadcasts));
  for (const text of broadcasts) {
    assert.doesNotMatch(text, /甲挑战者|乙应战者/, '群里不该点名');
  }
});

test('PVP：战斗菜单里有「认输」（PVE 里没有）', async () => {
  const { h, a } = await setUp();
  await send(h, a.userId, '.挑战 乙应战者 发起');
  const view = await send(h, a.userId, '.战斗');
  const text = view.map((m) => m.text).join('\n');
  assert.match(text, /认输/);
  assert.match(text, /@乙应战者/, '顶部显示对手昵称而不是物种名');
});
