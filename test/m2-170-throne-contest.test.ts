/**
 * M2.170：**神位争夺** —— 用户口径：「神位得竞争本来就是残酷的」。
 *
 * 这一条守四件事：
 *   ① **四道闸**都对：位置得空着、序列得到 1、**推下去过至少一位神**、没人在上面
 *   ② 7 天是公开且脆弱的：每天被神性啃（序列 1 = 6/天，7 天 42 点）
 *   ③ 撑到最后 ⇒ **神座 seat 变成玩家的名字**（全项目唯一一处玩家能坐上序列 0）
 *   ④ 撑不住 ⇒ 位置继续空着（被打断的人不算数）
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  THRONE_CLASH_MAX_EXTENSIONS,
  THRONE_RITE_DAYS,
  THRONE_RITE_MAD_PER_DAY,
  canClaimThrone,
  daysLeftOf,
  riteDaysFor,
  riteStrain,
  settleOrExtend,
  strainMultiplier,
} from '../src/domain/world/throne-contest.ts';
import { createHarness } from './helpers/app.ts';
import { runDailyTick } from '../src/infra/tick.ts';
import { advanceWorld } from '../src/infra/world-tick.ts';

process.env.TEMP = process.env.TEMP ?? 'data/tmp';
const DAY = 86_400_000;

test('M2.170 四道闸：位置空着 · 序列到 1 · **推下去过至少一位神** · 没人在上面', () => {
  const base = { sequence: 1, firstCredits: 1, seatState: 'vacant' as const, claimantId: '', me: 'me' };
  assert.equal(canClaimThrone(base).ok, true);
  // ① 位置还有人 ⇒ 轮不到你（先去把祂推下来）
  assert.equal(canClaimThrone({ ...base, seatState: 'occupied' }).ok, false);
  assert.ok(canClaimThrone({ ...base, seatState: 'sealed' }).reason!.includes('封住'));
  // ② 序列不够
  assert.equal(canClaimThrone({ ...base, sequence: 3 }).ok, false);
  // ③ **没有首功 ⇒ 那个位置不认旁观的人**（这是 M2.169 那本账的用处）
  const noCredit = canClaimThrone({ ...base, firstCredits: 0 });
  assert.equal(noCredit.ok, false);
  assert.ok(noCredit.reason!.includes('旁观'), '理由要说清为什么轮不到他');
  /*
   * ④ 别人已经在上面了 ⇒ **不拒绝**（M2.170 续改了这条语义）：
   * 第一版写的是「轮不到你，你只能去打断他」；现在回答是「你上去就是**抢**」——
   * 两个人同时在灰雾之上争同一个位置（对撞）。
   *
   * ⚠️ 这条断言原来钉的是旧行为（ok === false）—— 它当场变红，
   * 正是判据该有的作用：改了语义就有人提醒你回头看。
   */
  const taken = canClaimThrone({ ...base, claimantId: 'someone' });
  assert.equal(taken.ok, true, '有人在上面不等于你上不去 —— 那叫抢');
  assert.equal(taken.clash, true, '要标出「这一步是对撞」');
  // 自己在上面不算冲突（重复调用要幂等）
  assert.equal(canClaimThrone({ ...base, claimantId: 'me' }).ok, true);
});

test('M2.170 那 7 天是公开且脆弱的', () => {
  assert.equal(THRONE_RITE_DAYS, 7);
  assert.equal(aaStrain(1), THRONE_RITE_MAD_PER_DAY);
  assert.equal(aaStrain(0), THRONE_RITE_MAD_PER_DAY + 4, '已经站上去的人被啃得更狠');
  assert.equal(aaStrain(5), 0, '没到序列 1 的人不会去坐那个位置');
  // 7 天下来 42 点理智 —— 原本高的人撑得住，边缘的人会在最后一天失控
  assert.equal(THRONE_RITE_DAYS * aaStrain(1), 42);
  assert.ok(42 > 30, '这个数字必须够重 —— 否则「残酷」只是一句话');
  const contest = { pathway: 'sun', status: 'rite' as const, claimantId: 'x', rivals: [], extensions: 0, startedAt: 0, endsAt: 7 * DAY, brokenBy: '', note: '' };
  assert.equal(daysLeftOf(contest, 0), 7);
  assert.equal(daysLeftOf(contest, 6 * DAY), 1);
  assert.equal(daysLeftOf(contest, 100 * DAY), 0, '过期了就是 0，不能是负数');
});
function aaStrain(sequence: number): number {
  return riteStrain(sequence);
}

test('M2.170 端到端：撑过 7 天 ⇒ **神座上写的是玩家的名字**', async () => {
  const h = createHarness();
  try {
    const deps = h.app.router.deps;
    let now = h.now();
    await h.createCharacter('u-god', '登位的人');
    const character = deps.characters.findByUserId('u-god')!;
    // 够格：序列 1 + 推下去过一位神（M2.169 那本账）
    deps.characters.update({ ...character, sequence: 1, updatedAt: now });
    deps.divineSchemes!.create({
      id: 'dscheme:for-throne', schemer: 'assassin', target: 'sun', goal: 'fall',
      stage: 'fall', progress: 4, exposed: 0, allies: [], startedAt: now, dueAt: now, outcome: 'done',
    });
    deps.divineMeddling!.record({
      characterId: character.id, schemeId: 'dscheme:for-throne', side: 'aid',
      success: true, exposed: false, score: 9, at: now,
    });
    assert.equal(deps.divineMeddling!.firstCreditCaused(character.id), 1);
    // 那个位置空了（阴谋做成之后由 world-tick 写的；这里直接造出那个局面）
    deps.divineThroneState!.recordFall({ pathway: 'sun', seat: '永恒烈阳', at: now, by: 'test', note: '倒下了。' });
    // ① 看得见：位置空着、而他能登位
    const see = await h.send({ rawText: '.王座', userId: 'u-god' });
    const text = see.map((m) => m.text).join('\n');
    assert.ok(text.includes('【王座】'));
    assert.ok(text.includes('空着'), '要报出空着的位置');
    assert.ok(text.includes('登位'), '要告诉他可以登位');
    // ② 登位：7 天，公开
    const claim = await h.send({ rawText: '.王座 登位 1', userId: 'u-god' });
    const claimText = claim.map((m) => m.text).join('\n');
    assert.ok(claimText.includes('灰雾之上'));
    assert.ok(claimText.includes('7 天'), '要写清他要在上面待多久');
    assert.ok(claimText.includes('杀人'), '要写清别人能上来打断他 —— 残酷的地方不能藏起来');
    assert.ok(deps.throneContests!.byClaimant(character.id) !== null, '仪式没开起来');
    assert.ok(deps.worldEvents.all().some((e) => e.id.startsWith('throne-claim-')), '登位该是公开的');
    // ③ 每天被啃（日 tick）
    const before = deps.characters.findById(character.id)!.mad;
    runDailyTick(deps, now);
    assert.equal(deps.characters.findById(character.id)!.mad, before + THRONE_RITE_MAD_PER_DAY, '日 tick 没有侵蚀他');
    // ④ 撑到最后 ⇒ 上位
    now += 8 * DAY;
    advanceWorld(deps, now);
    const seat = deps.divineThroneState!.of('sun')!;
    assert.equal(seat.state, 'occupied', '撑到最后却没坐上 —— 那 7 天就白熬了');
    assert.equal(seat.seat, '登位的人', '神座上该写玩家的名字，实际：' + seat.seat);
    assert.ok(deps.worldEvents.all().some((e) => e.id.startsWith('throne-settled-')), '玩家成神没有播报');
  } finally {
    h.app.close();
  }
});

test('M2.170 端到端：撑不住 ⇒ 位置继续空着（**被打断的人不算数**）', async () => {
  const h = createHarness();
  try {
    const deps = h.app.router.deps;
    let now = h.now();
    await h.createCharacter('u-die', '没撑住的人');
    const character = deps.characters.findByUserId('u-die')!;
    deps.characters.update({ ...character, sequence: 1, updatedAt: now });
    deps.divineSchemes!.create({
      id: 'dscheme:d', schemer: 'assassin', target: 'reader', goal: 'fall',
      stage: 'fall', progress: 4, exposed: 0, allies: [], startedAt: now, dueAt: now, outcome: 'done',
    });
    deps.divineMeddling!.record({
      characterId: character.id, schemeId: 'dscheme:d', side: 'aid', success: true, exposed: false, score: 9, at: now,
    });
    deps.divineThroneState!.recordFall({ pathway: 'reader', seat: '知识与智慧之神', at: now, by: 'test', note: '倒下了。' });
    await h.send({ rawText: '.王座 登位 1', userId: 'u-die' });
    assert.ok(deps.throneContests!.byClaimant(character.id) !== null);
    // 他在仪式里被打死了（这是「残酷」的唯一硬落点）
    const fresh = deps.characters.findById(character.id)!;
    deps.characters.update({ ...fresh, hp: 0, updatedAt: now });
    now += DAY;
    advanceWorld(deps, now);
    assert.equal(deps.throneContests!.byClaimant(character.id), null, '死了还在仪式里');
    assert.equal(deps.divineThroneState!.of('reader')!.state, 'vacant', '位置该继续空着');
    assert.ok(deps.worldEvents.all().some((e) => e.id.startsWith('throne-lapse-')), '仪式断了该有痕迹');
  } finally {
    h.app.close();
  }
});

test('M2.170 对撞：两个人同时争 ⇒ **到期不作数**、侵蚀加倍、拖满两败俱伤', async () => {
  // ① 时间表：人越多越久（那个位置只有一份）
  assert.equal(riteDaysFor(1), THRONE_RITE_DAYS);
  assert.equal(riteDaysFor(2), THRONE_RITE_DAYS + 5);
  assert.equal(riteDaysFor(3), THRONE_RITE_DAYS + 10);
  // ② 侵蚀加倍（神性只有一份，两个人在抢）
  assert.equal(strainMultiplier(1), 1);
  assert.equal(strainMultiplier(2), 2);
  assert.equal(riteStrain(1, 1), 6);
  assert.equal(riteStrain(1, 2), 12, '对撞时每天 12 点 —— 争神位的人可能先变成怪物');
  assert.equal(riteStrain(5, 2), 0, '没到序列 1 的人本来就上不去');
  // ③ 到期判定：一个人 ⇒ 落地；两个人 ⇒ 往后拖；拖满 ⇒ 两败俱伤
  const solo = { pathway: 'sun', status: 'rite' as const, claimantId: 'a', rivals: [], extensions: 0, startedAt: 0, endsAt: 0, brokenBy: '', note: '' };
  assert.equal(settleOrExtend({ contest: solo, now: 100 }).kind, 'settle');
  const clash = { ...solo, rivals: ['b'] };
  assert.equal(settleOrExtend({ contest: clash, now: 100 }).kind, 'extend');
  const tired = { ...clash, extensions: THRONE_CLASH_MAX_EXTENSIONS };
  const stale = settleOrExtend({ contest: tired, now: 100 });
  assert.equal(stale.kind, 'stalemate', '拖满之后谁都不算数');
  assert.ok(stale.note.includes('继续空着'));
  // ④ 判定：有人在上面时**不拒绝**，而是告诉他「你上去就是抢」
  const gate = canClaimThrone({ sequence: 1, firstCredits: 1, seatState: 'vacant', claimantId: 'someone', me: 'me' });
  assert.equal(gate.ok, true, '有人在上面不等于你上不去 —— 那叫抢');
  assert.equal(gate.clash, true);
  assert.equal(canClaimThrone({ sequence: 1, firstCredits: 1, seatState: 'vacant', claimantId: '', me: 'me' }).clash, undefined);

  // ⑤ 端到端：两个玩家撞在同一个位置上，而那个位置只坐得下一个
  const h = createHarness();
  try {
    const deps = h.app.router.deps;
    let now = h.now();
    await h.createCharacter('u-1', '甲');
    await h.createCharacter('u-2', '乙');
    const NAMES: Array<[string, string]> = [['u-1', '甲'], ['u-2', '乙']];
    for (const [userId, name] of NAMES) {
      const c = deps.characters.findByUserId(userId)!;
      deps.characters.update({ ...c, sequence: 1, updatedAt: now });
      deps.divineSchemes!.create({
        id: 'd:' + userId, schemer: 'assassin', target: 'sun', goal: 'fall',
        stage: 'fall', progress: 4, exposed: 0, allies: [], startedAt: now, dueAt: now, outcome: 'done',
      });
      deps.divineMeddling!.record({
        characterId: c.id, schemeId: 'd:' + userId, side: 'aid', success: true, exposed: false, score: 9, at: now,
      });
    }
    deps.divineThroneState!.recordFall({ pathway: 'sun', seat: '永恒烈阳', at: now, by: 't', note: '倒下了。' });
    // 甲先登位
    await h.send({ rawText: '.王座 登位 1', userId: 'u-1' });
    const solo = deps.throneContests!.of('sun')!;
    assert.deepEqual(solo.rivals, []);
    // 乙再登位 ⇒ 会被告知那是「抢」
    const blocked = await h.send({ rawText: '.王座 登位 1', userId: 'u-2' });
    assert.ok(blocked.map((m) => m.text).join('\n').includes('抢'), '要告诉他这一步叫抢');
    // 乙抢登 ⇒ 对撞成立，时间表变长
    const clashSent = await h.send({ rawText: '.王座 抢登 1', userId: 'u-2' });
    const clashText = clashSent.map((m) => m.text).join('\n');
    assert.ok(clashText.includes('【王座 · 抢登】'));
    assert.ok(clashText.includes('谁都不算数'), '残酷的地方要写清楚');
    const after = deps.throneContests!.of('sun')!;
    assert.equal(after.rivals.length, 1, '乙没有加入对撞');
    assert.ok(
      after.endsAt - after.startedAt >= riteDaysFor(2) * DAY - 1000,
      '对撞之后时间表该变长（两个人一起往上坐，谁也坐不实）',
    );
    /*
     * 对撞时**两边都要被啃**（实测抓到过一次只啃第一个人的 bug：
     * 12 天之后甲的理智 100、乙的 0 —— 那等于后来者白捡）。
     */
    const beforeMad = NAMES.map(([userId]) => deps.characters.findByUserId(userId)!.mad);
    runDailyTick(deps, now);
    const afterMad = NAMES.map(([userId]) => deps.characters.findByUserId(userId)!.mad);
    assert.ok(afterMad[0]! > beforeMad[0]!, '先上去的那个人该被啃');
    assert.ok(afterMad[1]! > beforeMad[1]!, '后来的那个人也该被啃 —— 否则对撞只惩罚先到的人');
    // 到期了 —— 但还有人在争 ⇒ **不落地**
    now += riteDaysFor(2) * DAY + DAY;
    advanceWorld(deps, now);
    assert.equal(deps.divineThroneState!.of('sun')!.state, 'vacant', '还有人争的时候不该有人上位');
    assert.ok(deps.throneContests!.of('sun')!.extensions >= 1, '该往后拖');
  } finally {
    h.app.close();
  }
});
