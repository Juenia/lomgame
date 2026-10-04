/**
 * M2.11 前置 3：「等待中」的 UX 补丁（走真实路由）。
 *
 * 这一批用例钉的是**回执里说了什么**，不是数值 —— 本轮的补丁一个数值都没有动。
 *
 * 三条口径（任务书 §3.2）：
 *   1. 战斗中的 .今日 / .状态 / .战斗 要说清「打到第几回合 / 双方还剩多少 /
 *      他多久没动了 / 超时会发生什么」；
 *   2. 等待期里做了一件不改变状态的事（.扮演 而 DIG 已满、.占卜 而次数用完）
 *      要**当场告诉他**没收益，并把他引回战斗；
 *   3. 轮到自己时**不给**这一块 —— 那时候该给的是出招菜单，不是安慰。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PVP, TIMING } from '../src/config/numeric.ts';
import { DIVINATION_COUNTER_KEY, divinationDailyLimit } from '../src/domain/divination/divination.ts';
import { dateKey } from '../src/infra/date.ts';
import { createHarness, type Harness } from './helpers/app.ts';

/** 建两个玩家（都在廷根城中心 —— 同地点是发起条件之一） */
async function setUp() {
  const h = createHarness({ deterministicIds: true });
  const a = await h.createCharacter('41001', '甲挑战者', 'seer');
  const b = await h.createCharacter('41002', '乙应战者', 'warrior');
  return { h, a, b };
}

/** 发一条指令并推进时钟（绕开频控，不绕过指令本身） */
async function send(h: Harness, userId: string, rawText: string, scene: 'private' | 'group' = 'private') {
  h.advance(11000);
  return h.send({ rawText, userId, scene });
}

const textOf = (messages: Array<{ text: string }>): string => messages.map((m) => m.text).join('\n');

/* ================================================================== *
 * 一、等待块本身
 * ================================================================== */

test('等待中：.战斗 给出一整块状态（回合数 / 双方数值 / 他多久没动 / 超时说明）', async () => {
  const { h, a } = await setUp();
  await send(h, a.userId, '.挑战 乙应战者 发起');
  const first = await send(h, a.userId, '.战斗 攻击');
  const text = textOf(first);

  assert.match(text, /【战斗 · 第 1 回合 · 等 乙应战者 出招】/, '标题要写明回合数与在等谁');
  assert.match(text, /乙应战者 · HP \d+\/100/, '对手那一行要有血量');
  assert.match(text, /你 · HP \d+\/100 · MP \d+\/100 · MAD \d+/, '自己那一行要有 HP / MP / MAD');
  assert.match(text, /他还没动（不到 1 分钟）/, '要说出「他多久没动了」');
  assert.match(text, /系统会替他防御/, '要说出超时会发生什么');
  assert.equal(h.repos.battles.countRounds(), 0, '等待不是回合 —— 一个回合都没结算');
});

test('等待中：等了三分钟，那句话就变成「他已经 3 分钟没动了」', async () => {
  const { h, a } = await setUp();
  await send(h, a.userId, '.挑战 乙应战者 发起');
  await send(h, a.userId, '.战斗 攻击');
  // 3 分钟 < 5 分钟超时：战斗不会被推进，等待还在继续
  // （上一次「他动了」的时刻就是发起者出招那一刻 —— lastRoundAt 从那时起没变过）
  h.advance(3 * 60 * 1000);
  const again = await h.send({ rawText: '.战斗', userId: a.userId, scene: 'private' });
  assert.match(textOf(again), /他已经 3 分钟没动了/);
});

test('等待中：发起者看到「你出了手」，被挑战的应战者看到「他还没出手」', async () => {
  const { h, a, b } = await setUp();
  await send(h, a.userId, '.挑战 乙应战者 发起');
  // 回合权在发起者手上：此时应战者才是等待方
  const forOpponent = textOf(await send(h, b.userId, '.战斗'));
  assert.match(forOpponent, /【战斗 · 第 1 回合 · 等 甲挑战者 出招】/);
  assert.match(forOpponent, /他还没出手 —— 等他出招，你们这一回合才会一起结算。/);

  // 发起者出招之后，两人互换：现在等的是他
  const afterMove = textOf(await send(h, a.userId, '.战斗 攻击'));
  assert.match(afterMove, /你出了手 —— 但他还没动，等他回应。/);
});

test('轮到自己时**不给**等待块 —— 那时候该给的是出招菜单', async () => {
  const { h, a } = await setUp();
  await send(h, a.userId, '.挑战 乙应战者 发起');
  const mine = textOf(await send(h, a.userId, '.战斗'));
  assert.match(mine, /【战斗 · 第 1 回合】/, '轮到自己要摆出这一回合的那一屏');
  assert.doesNotMatch(mine, /系统会替他防御/, '轮到自己时不该出现等待提示');
});

test('没在战斗的人看不到等待块（.状态 / .今日 一个字都不多）', async () => {
  const { h, a } = await setUp();
  assert.doesNotMatch(textOf(await send(h, a.userId, '.状态')), /等 .* 出招/);
  assert.doesNotMatch(textOf(await send(h, a.userId, '.今日')), /系统会替他防御/);
});

/* ================================================================== *
 * 二、.今日 / .状态 里的等待块
 * ================================================================== */

test('等待中：.状态 在状态卡后面接上等待块', async () => {
  const { h, a } = await setUp();
  await send(h, a.userId, '.挑战 乙应战者 发起');
  await send(h, a.userId, '.战斗 攻击');
  const text = textOf(await send(h, a.userId, '.状态'));
  // M2.45：状态卡不再自带【角色名】那一行（名字进了消息头），改认「HP 行」
  // M2.45 第四版：三条核心数值进了**表格**
  // M2.45 第十版：核心数值走紧凑文字行（`**生命**　▰…`）
  const statusLine = text.indexOf('**生命**');
  assert.ok(statusLine >= 0, '状态卡还在');
  assert.match(text, /【战斗 · 第 1 回合 · 等 乙应战者 出招】/, '等待块跟在后面');
  assert.ok(
    statusLine < text.indexOf('【战斗 ·'),
    '顺序也要对：先是他自己什么样，再是这一场什么样',
  );
});

test('等待中：.今日 的菜单后面接上等待块', async () => {
  const { h, a } = await setUp();
  await send(h, a.userId, '.挑战 乙应战者 发起');
  await send(h, a.userId, '.战斗 攻击');
  const text = textOf(await send(h, a.userId, '.今日'));
  assert.match(text, /回复数字/, '菜单还在');
  assert.match(text, /【战斗 · 第 1 回合 · 等 乙应战者 出招】/);
});

test('等待中：群里发 .今日，与私聊一致 —— 等待提示也进群', async () => {
  const { h, a } = await setUp();
  await send(h, a.userId, '.挑战 乙应战者 发起');
  await send(h, a.userId, '.战斗 攻击');
  const sent = await send(h, a.userId, '.今日', 'group');
  // 群聊与私聊合并成同一条路：群里拿到的是完整今日菜单
  assert.equal(sent.length, 1, '一条完整回执');
  const group = sent[0]!;
  assert.equal(group.scene, 'group');
  assert.match(group.text, /【今日/, '群里给完整今日菜单');
  assert.match(group.text, /回复数字。/);
  /*
   * M2.11 记下的那条边界（「等待提示只在私聊路径上出现」）随 §3.6 一起消失了：
   * 当时是 groupText 摘要 + detailToPrivate:false 把 privateText 整条丢掉，
   * 现在群里发的就是 privateText —— 等待提示自然跟着进来。
   */
});

/* ================================================================== *
 * 三、等待期里的无效指令（M2.10 的 2 条 P1 就是从这条路上来的）
 * ================================================================== */

test('等待中 + 消化度已满：.扮演 明说没有收益，并把人引回战斗', async () => {
  const { h, a } = await setUp();
  const before = h.repos.characters.findByUserId(a.userId)!;
  h.repos.characters.update({ ...before, dig: 100, updatedAt: h.now() });

  await send(h, a.userId, '.挑战 乙应战者 发起');
  await send(h, a.userId, '.战斗 攻击');
  const text = textOf(await send(h, a.userId, '.扮演 在书店里替人占卜今天的运势'));

  assert.match(text, /你的消化度已经满了，扮演不再有收益。/);
  assert.match(text, /（你在等 乙应战者 出招。他还没动（不到 1 分钟）。）/);
  assert.equal(h.repos.characters.findByUserId(a.userId)!.dig, 100, '扮演确实没有改变消化度');
});

test('等待中但消化度没满：.扮演 照常结算，不出现那两句', async () => {
  const { h, a } = await setUp();
  await send(h, a.userId, '.挑战 乙应战者 发起');
  await send(h, a.userId, '.战斗 攻击');
  const text = textOf(await send(h, a.userId, '.扮演 在书店里替人占卜今天的运势'));
  assert.doesNotMatch(text, /扮演不再有收益/);
  assert.doesNotMatch(text, /你在等 乙应战者 出招/);
});

test('等待中 + 占卜次数用完：回执后面接一句「你在等谁」', async () => {
  const { h, a } = await setUp();
  const character = h.repos.characters.findByUserId(a.userId)!;
  const date = dateKey(h.now());
  const limit = divinationDailyLimit({});
  for (let index = 0; index < limit; index += 1) {
    h.repos.dailyCounters.increment(character.id, date, DIVINATION_COUNTER_KEY);
  }

  await send(h, a.userId, '.挑战 乙应战者 发起');
  await send(h, a.userId, '.战斗 攻击');
  const text = textOf(await send(h, a.userId, '.占卜 我该不该去老码头'));
  assert.match(text, /今天的占卜已经用完了/);
  assert.match(text, /（你在等 乙应战者 出招。/);
});

test('占卜次数用完、但没在战斗中：只报次数，不加战斗的话', async () => {
  const { h, a } = await setUp();
  const character = h.repos.characters.findByUserId(a.userId)!;
  const date = dateKey(h.now());
  for (let index = 0; index < divinationDailyLimit({}); index += 1) {
    h.repos.dailyCounters.increment(character.id, date, DIVINATION_COUNTER_KEY);
  }
  const text = textOf(await send(h, a.userId, '.占卜 我该不该去老码头'));
  assert.match(text, /今天的占卜已经用完了/);
  assert.doesNotMatch(text, /你在等/);
});

/* ================================================================== *
 * 五、方向 B：应战者在接受之前，先看清对面（M2.11 前置 2）
 * ================================================================== */

test('方向 B：挑战通知里写清发起者的状态，并给出三个选项', async () => {
  const { h, a, b } = await setUp();
  // 让他带着伤、掉着灵力来 —— 这三样都要被如实写出来
  const challenger = h.repos.characters.findByUserId(a.userId)!;
  h.repos.characters.update({ ...challenger, hp: 78, mp: 45, updatedAt: h.now() });

  const sent = await send(h, a.userId, '.挑战 乙应战者 发起');
  const notice = sent.find((message) => message.targetId === b.userId);
  assert.ok(notice, '应战者必须收到私聊');
  assert.match(notice!.text, /【挑战 · 来自 @甲挑战者】/);
  assert.match(notice!.text, /你看到：HP 78\/100 · MP 45\/100 · 序列 9 · 带着伤（HP 只有 78）/);
  assert.match(notice!.text, /1\. 接受（他先出招，你看完再选）/);
  assert.match(notice!.text, /2\. 拒绝（这一场没有输赢，他会知道）/);
  assert.match(notice!.text, /3\. 认输（自己判负 · 对方不通缉）/);
  /*
   * 按钮通道（官方机器人）拿到的选项与这份文本同源（openWith 一次性返回两者），
   * 那一层由 test/m2-7-interactive.test.ts 守着；这里不重复断言 ——
   * 默认的 MemoryAdapter 模拟的是 OneBot（纯文本降级），interactive 本来就是空的。
   */
});

test('方向 B：没有伤的人写「没有伤」，还没入途径的人写「还没有途径」', async () => {
  const { h, a, b } = await setUp();
  const sent = await send(h, a.userId, '.挑战 乙应战者 发起');
  const notice = sent.find((message) => message.targetId === b.userId)!;
  assert.match(notice.text, /HP 100\/100 · MP 100\/100 · 序列 9 · 没有伤/);
});

test('方向 B：回 1 接受 —— 战斗照打，发起者收到通知', async () => {
  const { h, a, b } = await setUp();
  await send(h, a.userId, '.挑战 乙应战者 发起');
  const replied = await send(h, b.userId, '1');
  assert.match(textOf(replied), /你接下了 @甲挑战者 的挑战/);
  const back = replied.find((message) => message.targetId === a.userId);
  assert.match(back!.text, /接下了你的挑战/);
  assert.ok(h.repos.battles.activeOf(a.id), '这一场还在');
  const accepted = h.app.db
    .prepare("SELECT COUNT(*) AS n FROM domain_events WHERE type = 'pvp_challenge_accepted'")
    .get() as { n: number };
  assert.equal(Number(accepted.n), 1, '接受要留痕；报告靠它统计');
});

test('方向 B：回 2 拒绝 —— 这一场没有输赢地结束，两边都不掉血', async () => {
  const { h, a, b } = await setUp();
  const before = {
    a: h.repos.characters.findByUserId(a.userId)!,
    b: h.repos.characters.findByUserId(b.userId)!,
  };
  await send(h, a.userId, '.挑战 乙应战者 发起');
  const replied = await send(h, b.userId, '2');

  assert.match(textOf(replied), /你拒绝了 @甲挑战者 的挑战/);
  assert.match(textOf(replied), /没有输赢/);
  const back = replied.find((message) => message.targetId === a.userId);
  assert.match(back!.text, /拒绝了你的挑战/, '拒绝要让他知道（菜单上是这么写的）');

  assert.equal(h.repos.battles.activeOf(a.id), null, '这一场不再挂着');
  assert.equal(h.repos.battles.statusDistribution().get('creature_fled'), 1, '没有输赢地收尾');
  const after = {
    a: h.repos.characters.findByUserId(a.userId)!,
    b: h.repos.characters.findByUserId(b.userId)!,
  };
  assert.equal(after.a.hp, before.a.hp, '发起者不掉血');
  assert.equal(after.b.hp, before.b.hp, '应战者不掉血');
  assert.equal(
    Number((h.app.db.prepare('SELECT COUNT(*) AS n FROM wanted_states').get() as { n: number }).n),
    0,
    '拒绝不产生通缉',
  );
});

test('方向 B：回 3 认输 —— 自己判负，对方不通缉', async () => {
  const { h, a, b } = await setUp();
  await send(h, a.userId, '.挑战 乙应战者 发起');
  const replied = await send(h, b.userId, '3');
  assert.match(textOf(replied), /你举起手 —— 你不打了/);
  // 从发起者视角：应战者认输 = 发起者胜
  assert.equal(h.repos.battles.statusDistribution().get('player_win'), 1);
  const loser = h.repos.characters.findByUserId(b.userId)!;
  void loser;
  assert.equal(
    Number((h.app.db.prepare('SELECT COUNT(*) AS n FROM wanted_states').get() as { n: number }).n),
    0,
    '自己认的输不算重伤 —— 对方不通缉',
  );
});

test('方向 B：等对方出招的那段时间里，认输也必须能用（M2.10 里会被「还没轮到你」挡住）', async () => {
  const { h, a, b } = await setUp();
  await send(h, a.userId, '.挑战 乙应战者 发起');
  // 发起者先出招 → 回合权在应战者身上；此时**轮到应战者**，他随时能认输
  await send(h, a.userId, '.战斗 攻击');
  // 反过来：让应战者先出招，回合权回到发起者 —— 这时候发起者才是「等待方」
  await send(h, b.userId, '.战斗 防御');
  // 现在轮到发起者出招，应战者处于等待态：他发 .战斗 认输 不该被挡
  const surrender = await send(h, b.userId, '.战斗 认输');
  assert.match(textOf(surrender), /你举起手 —— 你不打了/);
  assert.equal(h.repos.battles.activeOf(a.id), null, '认输之后这一场就结束了');
});

/* ================================================================== *
 * 六、数值冻结（前置 3 是回执层的改动，不许碰任何数）
 * ================================================================== */

test('等待提示没有动任何数值：超时、回合上限、认输相关的一个都没有变', async () => {
  /*
   * M2.12 前置 1 把 PVP 超时从 5 分钟改成了 30 分钟（依据见 NUMERIC.timing）。
   * 所以这里断言的是「它与 timing 是同一个数」——具体值由 test/m2-12.test.ts 的冻结断言守。
   * 这一条要保留的原意没变：**M2.11 的等待提示没有动过任何数值**。
   */
  assert.equal(PVP.playerTimeoutMs, TIMING.pvpTurnTimeoutMs, '超时从 timing 读');
  assert.equal(PVP.wantedLevelOnWin, 3, '胜者仍然吃 3 级通缉');
});
