/**
 * M2.164：**NPC 真的会死，而且只有神能让他回来**。
 *
 * 用户拍板的两条：
 *   「NPC 死亡是真的死亡（永久，不刷新）」
 *   「神明可以复活（邪神也可以）」
 *
 * 这一条守五件事：
 *   ① 死亡档位是显式表（越界抛，而不是静默归档）
 *   ② 名册居民**真的站在世界上**（不播种的话，名册只是一份数据）
 *   ③ 死讯玩家查得到（`.世界 死者`）—— 否则死亡只是一条会过期的播报
 *   ④ 有关系的死者会被神找回来（端到端：跑世界 tick）
 *   ⑤ **没关系的死者不会被找回来** —— 这一条是反向自检：
 *      少了它，「复活」可能实际上是个随机刷新器，而 ④ 照样是绿的
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHarness } from './helpers/app.ts';
import { runDailyTick } from '../src/infra/tick.ts';
import { advanceWorld } from '../src/infra/world-tick.ts';
import {
  REVIVE_NEEDS,
  affinityAfterReturn,
  boundToSeat,
  canRevive,
  darkAfterReturn,
  deathChanceOf,
  deathTierOf,
  humanOf,
  meritOfKill,
  returnFormOf,
  reviveLineOf,
} from '../src/domain/world/npc-life.ts';

process.env.TEMP = process.env.TEMP ?? 'data/tmp';
const HOUR = 3_600_000;

test('M2.164 死亡档位：越界抛、神不会被一次阴谋弄死、凡人比天使危险得多', () => {
  // 显式表：没预料到的序列直接抛，而不是静默归到某一支
  assert.throws(() => deathTierOf(10));
  assert.throws(() => deathTierOf(-1));
  assert.equal(deathTierOf(0), 'god');
  assert.equal(deathTierOf(9), 'mortal');
  // 神：任何一条路都是 0（要动祂得走神战那条线）
  assert.equal(deathChanceOf(0, 'scheme'), 0);
  assert.equal(deathChanceOf(0, 'murder'), 0);
  // 凡人显著高于天使（同一种死法）
  assert.ok(deathChanceOf(9, 'scheme') > deathChanceOf(2, 'scheme') * 5);
  // 复活门槛：凡人不需要资源；天使要情报 4 / 财力 4
  assert.deepEqual(REVIVE_NEEDS['mortal'], { intel: 0, wealth: 0 });
  assert.equal(REVIVE_NEEDS['angel']['intel'], 4);
  // 功绩：弄死越强的人越算数
  assert.ok(meritOfKill(1) > meritOfKill(9));
  assert.equal(meritOfKill(0), 20);
});

test('M2.164 关系判定：教会 / 途径 / 被他蛊惑过 —— 三条路以外都不算', () => {
  const base = { npcChurch: '', npcPathway: '', throneChurches: ['night_goddess'], thronePathway: 'sleepless' };
  assert.equal(boundToSeat({ ...base, npcChurch: 'night_goddess' }), true, '同教会应当算');
  assert.equal(boundToSeat({ ...base, npcPathway: 'sleepless' }), true, '同途径应当算');
  assert.equal(boundToSeat({ ...base, npcTempter: 'sleepless' }), true, '被他蛊惑过的人应当算');
  assert.equal(boundToSeat(base), false, '毫无关系的人不该被算');
  assert.equal(boundToSeat({ ...base, npcChurch: 'storm_lord' }), false, '别的教会不算');
  // 门槛：资源只判够不够（不扣减），且死不满 24 小时不给开门
  const poor = { intel: 0, wealth: 0, churches: [], factions: [], artifacts: [], reach: [], angels: 0 };
  assert.equal(canRevive({ sequence: 9, resources: poor, hoursSinceDeath: 48 }).ok, true, '凡人不需要资源');
  assert.equal(canRevive({ sequence: 1, resources: poor, hoursSinceDeath: 48 }).ok, false, '天使要资源');
  assert.equal(canRevive({ sequence: 9, resources: poor, hoursSinceDeath: 2 }).ok, false, '刚死就复活太廉价');
});

test('M2.164 居民站在世界上：日 tick 把名册安置到地点', () => {
  const h = createHarness();
  try {
    const deps = h.app.router.deps;
    runDailyTick(deps, h.now());
    const withHome = deps.npcCast.filter((n) => n.location !== '');
    const placed = withHome.filter((n) => deps.npcProgress.of(n.id) !== null);
    assert.ok(placed.length >= 100, '名册居民没有被安置到世界：只有 ' + placed.length + ' 位');
    // 安置的位置就是他自己的常驻地点（不是随机的别处）
    const sample = placed[0]!;
    assert.equal(deps.npcProgress.of(sample.id)?.locationId, sample.location);
    // 晋升轨道那 41 位照旧（两张表都要在）
    assert.ok(deps.npcProgress.all().some((p) => p.npcId === 'klein_moretti') === false, '已是神的人不该被算进演化');
  } finally {
    h.app.close();
  }
});

test('M2.164 死讯可查：.世界 死者 读得到死因与谁的手笔', async () => {
  const h = createHarness();
  try {
    const deps = h.app.router.deps;
    await h.createCharacter('u-life', '测试者');
    const at = h.now();
    deps.npcLife.kill({
      npcId: 'cast_tingen_sergeant',
      kind: 'scheme',
      note: '巡警班长·哈维·科尔死了 —— 死在别人的局里。',
      killer: 'klein_moretti',
      at,
    });
    const sent = await h.send({ rawText: '.世界 死者', userId: 'u-life' });
    const text = sent.map((m) => m.text).join('\n');
    assert.ok(text.includes('死者'), '没有这个入口：' + text.slice(0, 120));
    assert.ok(text.includes('巡警班长·哈维·科尔'), '死者名单里没有他：' + text.slice(0, 300));
    assert.ok(text.includes('死在别人的局里'), '没写死因');
    assert.ok(text.includes('克莱恩·莫雷蒂'), '没写谁的手笔（名字要走 roster，不能显示 id）');
    assert.ok(!text.includes('cast_tingen_sergeant'), '回执里出现了内部 id');
  } finally {
    h.app.close();
  }
});

test('M2.164 神明让死者回来：与他有关系的死者会被找回来（端到端）', () => {
  const h = createHarness();
  try {
    const deps = h.app.router.deps;
    let now = h.now();
    // 黑夜女神的修女：神座 sleepless 的 resources.churches 里有 night_goddess —— 有关系
    deps.npcLife.kill({
      npcId: 'cast_tingen_sister',
      kind: 'scheme',
      note: '修女·玛尔塔·贝恩死了 —— 死在别人的局里。',
      killer: 'klein_moretti',
      at: now,
    });
    for (let i = 0; i < 3000; i += 1) {
      now += HOUR;
      advanceWorld(deps, now);
    }
    const life = deps.npcLife.of('cast_tingen_sister');
    assert.equal(life?.alive, true, '3000 小时里她一次都没被找回来 —— 复活那条线断了');
    assert.ok((life?.revivals ?? 0) >= 1, 'revivals 没有累加');
    // 播报必须匿名：玩家该读到「有人回来了」，而不是「黑夜女神复活了某某」
    const events = deps.worldEvents.all().filter((e) => e.id.startsWith('npc-revive-'));
    assert.ok(events.length >= 1, '没有世界播报');
    assert.ok(events.every((e) => e.type === 'rumor'), '复活播报必须是匿名的（rumor）');
    assert.ok(events.every((e) => !e.text.includes('黑夜女神')), '播报里漏了是哪位神动的手：' + events[0]!.text);
  } finally {
    h.app.close();
  }
});

test('M2.164 反向自检：**没关系**的死者不会被找回来（复活不是刷新器）', () => {
  const h = createHarness();
  try {
    const deps = h.app.router.deps;
    let now = h.now();
    // 后台管事·老佩里：没有教会、没有途径、没有势力 —— 与任何神座都不沾边
    const npc = deps.npcCast.find((n) => n.id === 'cast_backlund_stagehand')!;
    assert.equal(npc.church, '');
    assert.equal(npc.pathway, '');
    deps.npcLife.kill({ npcId: npc.id, kind: 'calamity', note: npc.name + '死了。', killer: '', at: now });
    for (let i = 0; i < 3000; i += 1) {
      now += HOUR;
      advanceWorld(deps, now);
    }
    const life = deps.npcLife.of(npc.id);
    assert.equal(life?.alive, false, '他与任何神都没关系，却被找回来了 —— 复活变成了随机刷新');
    assert.equal(life?.revivals, 0);
  } finally {
    h.app.close();
  }
});

test('M2.164 回来的还是他吗：形态先定死不掷骰的那三条', () => {
  // ① 邪神拉回来的一律是 thrall —— 没有第二种可能（用户那一问的答案）
  assert.equal(returnFormOf({ dark: true, revivals: 0, sequence: 9, roll: 0 }), 'thrall');
  assert.equal(returnFormOf({ dark: true, revivals: 3, sequence: 3, roll: 0.99 }), 'thrall');
  assert.equal(humanOf('thrall'), false, 'thrall 不算人');
  // ② 正神 + 第一次：一半原样，一半缺一块
  assert.equal(returnFormOf({ dark: false, revivals: 0, sequence: 9, roll: 0.1 }), 'same');
  assert.equal(returnFormOf({ dark: false, revivals: 0, sequence: 9, roll: 0.9 }), 'changed');
  // ③ 第二次起必然缺一块（「原样」那一次机会已经用掉了）
  assert.equal(returnFormOf({ dark: false, revivals: 1, sequence: 9, roll: 0.1 }), 'changed');
  // ④ 天使与神那一档：壳回来了、人没回来（但那仍是一具活着的人身）
  assert.equal(returnFormOf({ dark: false, revivals: 0, sequence: 1, roll: 0.1 }), 'vessel');
  assert.equal(humanOf('vessel'), true, 'vessel 是活着的人，只是不是他');
  // 关系下场：缺一块 = 好感减半；换壳 = 清零；不是人 = 转负
  assert.equal(affinityAfterReturn(60, 'same'), 60);
  assert.equal(affinityAfterReturn(60, 'changed'), 30);
  assert.equal(affinityAfterReturn(60, 'vessel'), 0);
  assert.equal(affinityAfterReturn(60, 'thrall'), -60);
  assert.ok(affinityAfterReturn(-10, 'thrall') <= -30, '本来就讨厌你的人，回来之后只会更糟');
  // 性情：回来的不是原来的人 → 算黑暗向（他会替把他拉回来的那位做事）
  assert.equal(darkAfterReturn('same'), false);
  assert.equal(darkAfterReturn('changed'), true);
  assert.equal(darkAfterReturn('thrall'), true);
  // 文案：四种形态四种说法（全都写成「某某回来了」等于把这件事藏起来）
  assert.ok(reviveLineOf('甲', 'same', '').includes('还是他'));
  assert.ok(reviveLineOf('甲', 'changed', '').includes('缺了一块'));
  assert.ok(reviveLineOf('甲', 'vessel', '').includes('未必是他'));
  assert.ok(reviveLineOf('甲', 'thrall', '').includes('不是人'));
});

test('M2.164 死者名单要写清「回来的是谁」（不是人那一条尤其不能省）', async () => {
  const h = createHarness();
  try {
    const deps = h.app.router.deps;
    await h.createCharacter('u-thrall', '测试者');
    const at = h.now();
    deps.npcLife.kill({ npcId: 'cast_beldan_widow', kind: 'murder', note: '寡妇·克拉拉·诺斯死了。', killer: 'klein_moretti', at });
    deps.npcLife.revive('cast_beldan_widow', at + 1000, 'thrall', false);
    const sent = await h.send({ rawText: '.世界 死者', userId: 'u-thrall' });
    const text = sent.map((m) => m.text).join(String.fromCharCode(10));
    assert.ok(text.includes('克拉拉'), '名单里没有她：' + text.slice(0, 200));
    assert.ok(text.includes('不是人') || text.includes('不再是人'), '没写清回来的是什么东西：' + text.slice(0, 400));
  } finally {
    h.app.close();
  }
});
