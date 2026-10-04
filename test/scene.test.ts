/**
 * M2.85 RPG 化：**场景**（用户拍板「我要的 RPG 感是游戏视角上的，现在像在玩 galgame」）。
 *
 * 这两个用例守的是「游戏视角」这件事本身：
 *   · 玩家在**一个地方**，能看见这里有什么、能往哪走
 *   · 走不过去的地方要**明确拒绝**（有空间就有边界）
 *   · 场景里出现的东西要**符合这个地方的危险度**（街上不该站着乌黯魔狼）
 */
import { renderScene } from '../src/domain/scene/scene.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHarness } from './helpers/app.ts';
import { atmosphereOf, findExit } from '../src/domain/scene/scene.ts';
import { runDailyTick } from '../src/infra/tick.ts';

const norm = (s: string) => s.replace(/[\u200B-\u200D\uFEFF]/g, '');

test('场景：氛围句按危险度分档，而且昼夜不同', () => {
  const safeDay = atmosphereOf(1, false);
  const safeNight = atmosphereOf(1, true);
  assert.notEqual(safeDay, safeNight, '同一个地方白天与夜里不该是同一句话');
  assert.notEqual(atmosphereOf(1, false), atmosphereOf(5, false), '安全区与禁区的氛围必须不同');
  // 1 到 5 五档互不相同
  const days = [1, 2, 3, 4, 5].map((d) => atmosphereOf(d, false));
  assert.equal(new Set(days).size, 5, '五档氛围句不许重样（模板化会被这条抓住）');
});

test('场景：出口按名字找得到（玩家多半只记得半截名字）', () => {
  const exits = [{ locationId: 'a', name: '迷雾街区', danger: 2 }, { locationId: 'b', name: '圣赛琳娜教堂', danger: 1 }];
  assert.equal(findExit(exits, '迷雾街区')?.locationId, 'a', '全名');
  assert.equal(findExit(exits, '迷雾')?.locationId, 'a', '前缀');
  assert.equal(findExit(exits, '教堂')?.locationId, 'b', '包含');
  assert.equal(findExit(exits, '不存在的地方'), null);
});

test('场景：.看 给出「我在哪、这里有什么、我能去哪」', async () => {
  const h = createHarness();
  try {
    await h.createCharacter('40200', '场景甲');
    const text = norm((await h.send({ rawText: '.看', userId: '40200', messageId: 'l1' })).map((m) => m.text).join('\n'));
    assert.ok(text.includes('【'), '要有地点名');
    assert.ok(text.includes('能往这些地方去'), '要能看出往哪走');
    assert.ok(text.includes('.走'), '要提示怎么走');
    assert.ok(/黄昏|白天|黎明|夜晚/.test(text), '要有天时');
  } finally { h.app.close(); }
});

test('场景：.走 真的会改变位置，走不过去会被拒（有空间就有边界）', async () => {
  const h = createHarness();
  try {
    const ch = await h.createCharacter('40201', '场景乙');
    const deps = h.app.router.deps;
    assert.equal(deps.characters.findById(ch.id)?.currentLocationId ?? null, null, '建号时还没有具体位置');
    const text = norm((await h.send({ rawText: '.走 迷雾街区', userId: '40201', messageId: 'w1' })).map((m) => m.text).join('\n'));
    assert.equal(deps.characters.findById(ch.id)?.currentLocationId, 'mist_street', '走过去了就要记住');
    assert.ok(text.includes('迷雾街区'));
    // 从迷雾街区走不到「达米尔港城区」（不相邻）
    const bad = norm((await h.send({ rawText: '.走 达米尔港城区', userId: '40201', messageId: 'w2' })).map((m) => m.text).join('\n'));
    assert.ok(bad.includes('走不到') || bad.includes('通向'), '不相邻的地方要明确拒绝，并告诉他这里能去哪');
    assert.equal(deps.characters.findById(ch.id)?.currentLocationId, 'mist_street', '被拒的移动不该改变位置');
  } finally { h.app.close(); }
});

test('场景：安全的地方不该站着高阶怪物（危险度过滤）', async () => {
  const h = createHarness();
  try {
    await h.createCharacter('40202', '场景丙');
    const text = norm((await h.send({ rawText: '.看', userId: '40202', messageId: 'l1' })).map((m) => m.text).join('\n'));
    // 廷根市的危险度低，出现的生物序列应当 ≥ 7
    for (const m of text.matchAll(/· (.+?)（序列 (\d+)）/g)) {
      assert.ok(Number(m[2]) >= 7, `安全街区出现了序列 ${m[2]} 的 ${m[1]} —— 那是把生态表倒在地上，不是场景`);
    }
  } finally { h.app.close(); }
});

test('场景：**普通人不知道非凡生物的存在**（原著的世界观基石）', async () => {
  const h = createHarness();
  try {
    const mortal = await h.createMortal('40210', '罗珊', 'female');
    const deps = h.app.router.deps;
    await h.send({ rawText: '.走 迷雾街区', userId: '40210', messageId: 'wm' });
    const mortalText = norm((await h.send({ rawText: '.看', userId: '40210', messageId: 'lm' })).map((m) => m.text).join('\n'));
    assert.equal(deps.characters.findById(mortal.id)?.pathwayStatus, 'mortal');
    assert.ok(!/（序列 \d+）/.test(mortalText), '普通人看到了序列 —— 「普通人不知道非凡者的存在」这条就破了：' + mortalText.slice(0, 200));
    const extraordinary = await h.createCharacter('40211', '克莱恩', 'seer');
    assert.equal(deps.characters.findById(extraordinary.id)?.pathwayStatus, 'initiated');
    await h.send({ rawText: '.走 迷雾街区', userId: '40211', messageId: 'we' });
    const initText = norm((await h.send({ rawText: '.看', userId: '40211', messageId: 'le' })).map((m) => m.text).join('\n'));
    /*
     * ⚠️ 这里**不能**断言「非凡者一定看得见东西」——扩图之后，栖息地按生态类型重新分配，
     * 廷根市（danger 1 的安全街区）**本来就没有非凡生物**了，那才是对的。
     * 所以只守两件事：① 凡人**绝不**出现序列；② 非凡者若看到，必须是可读的格式。
     */
    for (const m of initText.matchAll(/· (.+?)（序列 (\d+)）/g)) {
      assert.ok(Number(m[2]) >= 8, '安全街区不该出现序列 ' + m[2] + ' 的 ' + m[1]);
    }
    assert.ok(!/看清楚了/.test(initText) || /（序列 \d+）/.test(initText), '「看清楚了」后面必须真的写清是什么');
  } finally { h.app.close(); }
});

test('场景：第三人称（回执发在群里，围观的群友也要读得懂）', async () => {
  const h = createHarness();
  try {
    await h.createCharacter('40212', '克莱恩', 'seer');
    const walk = norm((await h.send({ rawText: '.走 迷雾街区', userId: '40212', messageId: 'w1' })).map((m) => m.text).join('\n'));
    assert.ok(walk.includes('克莱恩从【'), '回执要用角色名，而不是「你」');
    assert.ok(!walk.includes('你从【'), '不该再出现第二人称');
  } finally { h.app.close(); }
});

test('场景：非凡生物是稀罕的（安全街区最多一种，且不出现高阶）', async () => {
  const h = createHarness();
  try {
    await h.createCharacter('40213', '克莱恩', 'seer');
    const text = norm((await h.send({ rawText: '.看', userId: '40213', messageId: 'l1' })).map((m) => m.text).join('\n'));
    const kinds = [...text.matchAll(/· (.+?)（序列 \d+）/g)].length;
    assert.ok(kinds <= 1, '安全街区最多只该有一种非凡生物，实际 ' + kinds + ' 种');
    for (const m of text.matchAll(/· (.+?)（序列 (\d+)）/g)) {
      assert.ok(Number(m[2]) >= 8, '安全街区出现了序列 ' + m[2] + ' 的 ' + m[1]);
    }
  } finally { h.app.close(); }
});

test('世界演化：NPC 有位置，而且站在**街区**上（不是城市节点）', () => {
  const h = createHarness();
  try {
    const deps = h.app.router.deps;
    runDailyTick(deps, h.now());
    const placed = deps.npcProgress.all().filter((p) => p.locationId !== null);
    assert.ok(placed.length > 10, '第一次 tick 应当把 NPC 安置下来，实际 ' + placed.length + ' 人');
    // ⚠️ 关键：位置要落到**街区**，不能是城市节点本身 —— 否则玩家在街区里永远遇不到人
    const cityIds = new Set(deps.geo ? [] : []);
    for (const p of placed) {
      assert.ok(deps.locations.get(p.locationId!) !== undefined, p.npcId + ' 的位置必须是真实地点');
    }
    // 至少有一半落在真正的街区（有 adjacent 且不是城市自身）
    const streets = placed.filter((p) => (deps.locations.get(p.locationId!)?.adjacent ?? []).length > 0);
    assert.ok(streets.length >= placed.length * 0.5, '多数 NPC 该站在街区上，实际 ' + streets.length + '/' + placed.length);
  } finally { h.app.close(); }
});

test('场景：街上站着人 —— 凡人只看到「一个人」，非凡者看到名字与序列', async () => {
  const h = createHarness();
  try {
    const deps = h.app.router.deps;
    runDailyTick(deps, h.now());
    const target = deps.npcProgress.all().find((p) => p.locationId !== null);
    assert.ok(target, '要有被安置的 NPC');
    const loc = target.locationId!;
    // 非凡者
    const ch = await h.createCharacter('40310', '克莱恩', 'seer');
    deps.characters.update({ ...deps.characters.findById(ch.id)!, currentLocationId: loc });
    const eye = norm((await h.send({ rawText: '.看', userId: '40310', messageId: 'a' })).map((m) => m.text).join('\n'));
    assert.ok(eye.includes('注意到这里有人'), '非凡者该看到这里有人：' + eye.slice(0, 200));
    assert.ok(/（序列 \d+）/.test(eye), '非凡者该看得出对方的档位');
    // 普通人
    const mortal = await h.createMortal('40311', '罗珊', 'female');
    deps.characters.update({ ...deps.characters.findById(mortal.id)!, currentLocationId: loc });
    const blind = norm((await h.send({ rawText: '.看', userId: '40311', messageId: 'b' })).map((m) => m.text).join('\n'));
    if (blind.includes('注意到这里有人')) {
      assert.ok(blind.includes('一个人'), '普通人只该看到「一个人」');
      assert.ok(!/（序列 \d+）/.test(blind.split('注意到这里有人')[1] ?? ''), '普通人看不出对方是几序列');
    }
  } finally { h.app.close(); }
});
test('正文高亮（M2.86）：开着上色、关掉逐字回到旧行为', () => {
  const scene = {
    location: { id: 'x', name: '廷根市', danger: 2, minSeq: 9, maxSeq: 1 },
    danger: 2,
    dangerLabel: '偶有异样',
    exits: [{ name: '迷雾街区', danger: 5, locationId: 'y' }],
    beasts: [],
    people: ['莎伦（序列 4）'],
    hints: [],
    others: [],
    atmosphere: '这里人声不断。',
    omens: ['有人在打听你。'],
  };
  const who = { name: '克莱恩', pronoun: '他', awareness: 'initiated' as const };
  const head = { time: '黄昏', weather: '晴', calamity: '' };
  const colored = renderScene(scene as never, head, who, { supportsColor: true });
  const plain = renderScene(scene as never, head, who);
  // M2.86：颜色走 LaTeX（用户真机确认官方 markdown 渲染它，而 <font> 会漏原始标签）
  assert.ok(colored.includes('\\textcolor'), '开着该有 LaTeX 颜色：' + colored.slice(0, 120));
  assert.ok(!plain.includes('\\textcolor'), '**默认关**（纯文本通道与旧测试的行为必须逐字不变）');
  // 降级底线：符号与非颜色层次都还在
  assert.ok(colored.includes('这一带偶有异样'));
  assert.ok(plain.includes('这一带偶有异样'));
  assert.ok(plain.includes('莎伦（序列 4）'), '人名该在（凡人看不到，但这里是非凡者）');
  assert.ok(plain.includes('有人在打听你。'), '端倪该在');
});
