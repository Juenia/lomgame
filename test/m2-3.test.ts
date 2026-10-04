/**
 * M2.3 端到端：选项驱动 + 数字回复 + 上下文推进。
 *
 * ⚠️ 入口是 `.今日`，不是 `.扮演`。
 *
 * `.扮演`（`router/commands/play.ts` 那个 handler）**在 M2.121 被撤掉了**：
 * 「今天该做什么」现在由 `today-menu.ts` 统一给，而它内部仍然调同一个
 * `buildPlayMenu`（见 today-menu.ts:187 与那里 203 行的说明）。
 *
 * 所以这条用例验的东西一个字没变 —— 菜单、数字回复、上下文推进 ——
 * 变的只是**从哪个指令进这个菜单**。断言跟着入口改，不要跟着旧名字改回去。
 *
 * 这里全部走真实路由（router.handle），不直接调纯函数 ——
 * 验的是「玩家看到菜单、回数字、系统真的把那件事做了」这条链。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NUMERIC } from '../src/config/numeric.ts';
import type { CharacterState } from '../src/domain/character/types.ts';
import { MENU_EXPIRED_TEXT } from '../src/router/menu.ts';
import { createHarness, type Harness } from './helpers/app.ts';

const USER = '30001';
/** 跨过令牌桶冷却（capacity 1、refill 1/10s） */
const COOLDOWN_MS = 11_000;

function joined(messages: ReadonlyArray<{ text: string }>): string {
  return messages.map((message) => message.text).join('\n');
}

function currentMenu(h: Harness): { menuType: string; menu: { options: Array<{ key: string; command: string; label: string }> } } {
  const character = h.repos.characters.findByUserId(USER);
  assert.ok(character, '角色必须存在');
  const current = h.app.router.deps.pendingMenus.current(character.id, h.now());
  assert.ok(current, '必须有待处理菜单');
  return current;
}

function statsOf(character: CharacterState): Record<string, number> {
  return {
    dig: character.dig,
    mad: character.mad,
    cor: character.cor,
    hp: character.hp,
    mp: character.mp,
    dp: character.dp,
  };
}

test('M2.3：私聊 .今日 = 打开菜单（不改状态），回数字才真的执行', async () => {
  const h = createHarness();
  try {
    await h.createCharacter(USER, '菜单测试');
    const before = h.repos.characters.findByUserId(USER)!;

    const opened = await h.send({ rawText: '.今日', userId: USER });
    const text = joined(opened);
    assert.match(text, /【今日 · 愚者 · 序列 9】/, `菜单标题要对：${text.split('\n')[0]}`);
    assert.ok(text.includes('0. 自己写一个行为'), '必须带 0. 自己写一个行为');
    assert.match(text, /回复数字。/);
    assert.match(text, /(黎明|白天|黄昏|夜晚)/, '菜单首屏要带时段（世界状态天然可见）');

    assert.deepEqual(
      statsOf(h.repos.characters.findByUserId(USER)!),
      statsOf(before),
      '打开菜单不该改动任何状态',
    );
    assert.equal(currentMenu(h).menuType, 'today');

    // 回数字 → 执行菜单里那一条完整指令
    h.advance(COOLDOWN_MS);
    const option = currentMenu(h).menu.options[0]!;
    const replies = await h.send({ rawText: '1', userId: USER });
    assert.ok(replies.length > 0, '数字回复必须有回执');
    const after = h.repos.characters.findByUserId(USER)!;
    /*
     * 第 1 项是「探索 北大陆」——**不保证涨 dig**（探索的产出依地点与掷骰），
     * 所以这里不能断言某个具体数值。要验的是「数字回复真的执行了那条 command」，
     * 而执行过的可靠证据是**经验或日程计数动了**（两者都由指令执行写入）。
     */
    const moved =
      after.dig !== before.dig ||
      after.mad !== before.mad ||
      after.hp !== before.hp ||
      h.repos.characters.findByUserId(USER)!.exp !== before.exp;
    assert.ok(moved, `选了第 1 项（${option.command}）之后状态应当有变化`);
    assert.equal(currentMenu(h).menuType, 'result', '执行完要接上「下一步」菜单');
  } finally {
    h.app.close();
  }
});

test('M2.3 幂等：同一条 message_id 的数字回复只处理一次', async () => {
  const h = createHarness();
  try {
    await h.createCharacter(USER, '幂等测试');
    await h.send({ rawText: '.今日', userId: USER });
    h.advance(COOLDOWN_MS);

    const first = await h.send({ rawText: '1', userId: USER, messageId: 'm23-dup' });
    assert.ok(first.length > 0, '第一次必须处理');
    const afterFirst = statsOf(h.repos.characters.findByUserId(USER)!);

    h.advance(COOLDOWN_MS);
    const second = await h.send({ rawText: '1', userId: USER, messageId: 'm23-dup' });
    assert.equal(second.length, 0, '重复推送必须静默丢弃');
    assert.deepEqual(
      statsOf(h.repos.characters.findByUserId(USER)!),
      afterFirst,
      '同一条消息处理两次 = 数值被动了两遍',
    );
  } finally {
    h.app.close();
  }
});

test('M2.3 过期：菜单 5 分钟后失效，回数字提示重新开始', async () => {
  const h = createHarness();
  try {
    await h.createCharacter(USER, '过期测试');
    await h.send({ rawText: '.今日', userId: USER });
    const before = statsOf(h.repos.characters.findByUserId(USER)!);

    h.advance(NUMERIC.menu.ttlMs + 1000);
    // M2.4 起数字回复有**两张菜单源**：个人菜单（本条要测的）与世界事件菜单（兜底）。
    // 这条用例测的是「个人菜单过期」，所以先把房间里那张清掉，
    // 否则世界播报会把这个 "1" 接走，测到的就不是过期话术了。
    h.app.router.deps.worldEvents.clear();
    const replies = await h.send({ rawText: '1', userId: USER });
    assert.ok(joined(replies).includes(MENU_EXPIRED_TEXT), `过期话术要对：${joined(replies)}`);
    assert.deepEqual(statsOf(h.repos.characters.findByUserId(USER)!), before, '过期菜单绝不能被执行');
    assert.equal(
      h.app.router.deps.pendingMenus.current(h.repos.characters.findByUserId(USER)!.id, h.now()),
      null,
      '过期行必须就地清掉',
    );

    // .今日 是重新开始的入口
    h.advance(COOLDOWN_MS);
    const again = await h.send({ rawText: '.今日', userId: USER });
    assert.match(joined(again), /回复数字。/, '.今日 必须把菜单重新递到玩家手里');
    assert.equal(currentMenu(h).menuType, 'today');
  } finally {
    h.app.close();
  }
});

test('M2.3 对照：菜单路径与完整指令路径结果完全一致', async () => {
  // 判定 seed = messageId:characterId:now，所以两条路要用同一个 messageId，
  // 且角色 id 必须确定性派生（deterministicIds）—— 否则对照的不是同一件事。
  const viaMenu = createHarness({ deterministicIds: true });
  const direct = createHarness({ deterministicIds: true });
  try {
    await viaMenu.createCharacter(USER, '对照者');
    await direct.createCharacter(USER, '对照者');
    assert.equal(
      viaMenu.repos.characters.findByUserId(USER)!.id,
      direct.repos.characters.findByUserId(USER)!.id,
      '确定性 id 必须一致，否则对照测试没有意义',
    );

    // 菜单路径：拿菜单 → 记下第 1 项对应的完整指令
    await viaMenu.send({ rawText: '.今日', userId: USER, messageId: 'm23-open' });
    const option = currentMenu(viaMenu).menu.options[0]!;

    viaMenu.advance(COOLDOWN_MS);
    direct.advance(COOLDOWN_MS);
    const viaMenuReplies = await viaMenu.send({ rawText: '1', userId: USER, messageId: 'm23-cmp' });
    const directReplies = await direct.send({
      rawText: `.${option.command}`,
      userId: USER,
      messageId: 'm23-cmp',
    });
    assert.ok(viaMenuReplies.length > 0 && directReplies.length > 0);

    assert.deepEqual(
      statsOf(viaMenu.repos.characters.findByUserId(USER)!),
      statsOf(direct.repos.characters.findByUserId(USER)!),
      `菜单选 1（${option.command}）与直接发 .${option.command} 必须得到同一份状态`,
    );
    assert.equal(
      viaMenu.repos.tagUsage.distinctCount(viaMenu.repos.characters.findByUserId(USER)!.id, dateKeyOf(viaMenu)),
      direct.repos.tagUsage.distinctCount(direct.repos.characters.findByUserId(USER)!.id, dateKeyOf(direct)),
      '标签用量也必须一致',
    );
  } finally {
    viaMenu.app.close();
    direct.app.close();
  }
});

function dateKeyOf(h: Harness): string {
  return new Date(h.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

test('M2.3 群聊：与私聊同一套 —— 群里也摆菜单、也接数字回复', async () => {
  const h = createHarness();
  try {
    await h.createCharacter(USER, '群测试');
    // 群里 .扮演 直接摆出菜单（不再引导去私聊）
    const opened = await h.send({ rawText: '.今日', userId: USER, scene: 'group' });
    assert.equal(opened.length, 1, '群聊一条完整回执');
    assert.equal(opened[0]?.scene, 'group');
    assert.match(joined(opened), /回复数字。/, `群里要直接给菜单：${joined(opened)}`);

    // 群里回数字 = 选菜单项（这个人确实有待命菜单）
    const numeric = await h.send({ rawText: '1', userId: USER, scene: 'group' });
    assert.equal(numeric.length, 1, '群里的"1"要接住 —— 他正在玩');
    assert.equal(numeric[0]?.scene, 'group', '回执发回群里');

    // 但**没在玩的人**打的数字一声不响 —— 这才是原骚扰顾虑的正确解法
    const stranger = await h.send({ rawText: '1', userId: 'stranger-openid', scene: 'group' });
    assert.equal(stranger.length, 0, '没有待命菜单的人在群里打"1"不该有任何响应');

    // 群里的纯文本同样不接：自由输入只在「回了 0 之后」才生效
    const stray = await h.send({ rawText: '扮演 我摊开牌占卜', userId: USER, scene: 'group' });
    assert.equal(stray.length, 0, '没进过 freeform 待命时，纯文本不是指令');
  } finally {
    h.app.close();
  }
});

test('M2.3 .今日：摘要天然带世界状态（.世界 覆盖率不再靠注入）', async () => {
  const h = createHarness();
  try {
    await h.createCharacter(USER, '今日测试');
    const replies = await h.send({ rawText: '.今日', userId: USER });
    const text = joined(replies);
    assert.match(text, /【今日 · 愚者 · 序列 9】/);
    assert.match(text, /(晴|雾|雨|雷暴|灰雾潮|血月|静默|灵界渗透)/, `今日摘要必须带天气：${text.split('\n').slice(0, 3).join(' / ')}`);
    assert.match(text, /(黎明|白天|黄昏|夜晚)/, '今日摘要必须带时段');
    assert.match(text, /DIG/, '今日摘要必须带角色数值');
    assert.match(text, /回复数字。/);
    assert.equal(currentMenu(h).menuType, 'today');
  } finally {
    h.app.close();
  }
});

test('M2.3 上下文推进：每条指令执行完都接上「下一步」出口（含任务书点名的 8 条）', async () => {
  const h = createHarness();
  try {
    await h.createCharacter(USER, '推进测试');
    // M2.7：地点按城市过滤之后，不能再用「all() 的第一个 min_seq=9 地点」——
    // all() 按 id 排序，第一个是 backlund，而它属于贝克兰德城，廷根的玩家过不去。
    // 夹具固定用老码头（廷根都会区、min_seq 9）。
    const spot = h.repos.locations.get('old_dock')!;

    /*
     * M2.8：遭遇是概率事件，命中时探索会**改摆遭遇菜单**（那是 M2.8 的新行为，
     * 由 test/m2-8-encounter.test.ts 守着）。这一条测的是「每条指令都接上下一步」，
     * 所以每次探索前先让老码头没有生物，把那份随机性去掉 ——
     * 否则这条测试会变成「十几分之一概率随机红」，而红的原因与被测的东西无关。
     */
    const clearCreatures = (): void => {
      h.repos.creatures.deleteMany(h.repos.creatures.atLocation(spot.id).map((c) => c.id));
    };

    const cases: Array<{ raw: string; expected: string }> = [
      { raw: '.扮演 我摊开牌占卜一件还没发生的事', expected: 'result' },
      { raw: `.探索 ${spot.name}`, expected: 'explore' },
      { raw: '.状态', expected: 'result' },
      { raw: '.休息', expected: 'result' },
      { raw: '.世界', expected: 'world' },
      { raw: '.今日', expected: 'today' },
    ];
    for (const entry of cases) {
      h.advance(COOLDOWN_MS);
      clearCreatures();
      const replies = await h.send({ rawText: entry.raw, userId: USER });
      assert.ok(replies.length > 0, `${entry.raw} 必须有回执`);
      const text = joined(replies);
      assert.match(text, /【下一步|【探索 · |【世界 · |【今日 · /, `${entry.raw} 之后必须给下一步选项：${text.slice(-120)}`);
      assert.equal(currentMenu(h).menuType, entry.expected, `${entry.raw} 的菜单类型`);
      const menu = currentMenu(h).menu;
      assert.ok(menu.options.length >= 1, `${entry.raw} 的下一步菜单不能是空的`);
    }
  } finally {
    h.app.close();
  }
});

test('M2.3 探索菜单：危险倍率写清楚、选项真的不同、途径有专属位', async () => {
  const h = createHarness();
  try {
    await h.createCharacter(USER, '探索测试');
    // M2.7：地点按城市过滤之后，不能再用「all() 的第一个 min_seq=9 地点」——
    // all() 按 id 排序，第一个是 backlund，而它属于贝克兰德城，廷根的玩家过不去。
    // 夹具固定用老码头（廷根都会区、min_seq 9）。
    const spot = h.repos.locations.get('old_dock')!;
    /*
     * M2.8：这一条测的是**探索菜单**，所以先让老码头没有生物。
     * 遭遇命中时会改摆遭遇菜单（M2.8 的新行为，由 test/m2-8-encounter.test.ts 守着），
     * 而那是另一件事 —— 混在一起会让这条测试变成「有时候随机红」。
     */
    h.repos.creatures.deleteMany(h.repos.creatures.atLocation(spot.id).map((c) => c.id));
    const replies = await h.send({ rawText: `.探索 ${spot.name}`, userId: USER });
    const text = joined(replies);
    assert.match(text, new RegExp(`【探索 · ${spot.name}`), '探索完要给这个地点的探索菜单');
    assert.match(text, /危险 [+\-]\d+%/, `菜单要写危险倍率：${text.split('\n').slice(-12).join(' / ')}`);
    /*
     * ⚠️ M2.90：菜单文案改成了「今日去过 N 处」+ 每个选项「今日已探 N 次」
     *（原来的「今日 N/3 次」是硬上限时代的写法）。判据跟着现在这条走 ——
     * 它要守的是「菜单里看得见今天的次数」，不是某一种措辞。
     */
    assert.match(text, /今日已探 \d+ 次|今日去过 \d+ 处/, '菜单要写今日次数');
    // M2.85：原来这里还断言 `/AP \d/`（菜单要写行动点）—— 随行动值一并删除；

    const options = currentMenu(h).menu.options;
    const commands = options.map((option) => option.command);
    assert.ok(commands[0]!.startsWith(`探索 ${spot.name}`), '第一项是当前地点');
    assert.ok(
      commands.some((command) => command.startsWith('占卜 ')),
      `愚者的探索菜单要有一条途径专属动作（门途径「穿墙」位）：${commands.join(' / ')}`,
    );
    assert.equal(new Set(commands).size, commands.length, '选项指令不能重复（重复就是装饰）');
  } finally {
    h.app.close();
  }
});

test('M2.3 自由输入：回 0 之后的纯文本按完整指令解析，待命之外不受影响', async () => {
  const h = createHarness();
  try {
    await h.createCharacter(USER, '自由测试');
    await h.send({ rawText: '.今日', userId: USER });
    const ask = await h.send({ rawText: '0', userId: USER });
    assert.match(joined(ask), /直接写出来/, `回 0 要追问：${joined(ask)}`);

    h.advance(COOLDOWN_MS);
    const before = h.repos.characters.findByUserId(USER)!;
    await h.send({ rawText: '扮演 我摊开牌占卜一件还没发生的事', userId: USER });
    const after = h.repos.characters.findByUserId(USER)!;
    assert.ok(after.dig > before.dig, '自由输入必须真的执行（不用带点号）');

    // 待命已经用掉了：下一条闲聊不该被当成指令
    h.advance(COOLDOWN_MS);
    const stray = await h.send({ rawText: '今天天气不错', userId: USER });
    assert.equal(stray.length, 0, '没有自由输入待命时，私聊闲聊不能被当成指令');
  } finally {
    h.app.close();
  }
});

test('M2.3 完整指令不删：带参数的 .扮演 / .探索 / .世界 仍然一条指令做完', async () => {
  const h = createHarness();
  try {
    await h.createCharacter(USER, '完整指令');
    // M2.7：地点按城市过滤之后，不能再用「all() 的第一个 min_seq=9 地点」——
    // all() 按 id 排序，第一个是 backlund，而它属于贝克兰德城，廷根的玩家过不去。
    // 夹具固定用老码头（廷根都会区、min_seq 9）。
    const spot = h.repos.locations.get('old_dock')!;
    const before = h.repos.characters.findByUserId(USER)!;

    const played = await h.send({ rawText: '.扮演 我摊开牌占卜一件还没发生的事', userId: USER });
    assert.ok(played.length > 0);
    assert.ok(h.repos.characters.findByUserId(USER)!.dig > before.dig, '.扮演 行为 必须直接生效');

    h.advance(COOLDOWN_MS);
    const explored = await h.send({ rawText: `.探索 ${spot.name}`, userId: USER });
    assert.ok(joined(explored).includes(spot.name), '.探索 地点 必须直接生效');
    assert.equal(
      h.repos.exploreDaily.countOf(before.id, dateKeyOf(h), spot.id),
      1,
      '探索次数必须真的记上（不是只回了一段菜单）',
    );

    h.advance(5000);
    const world = await h.send({ rawText: '.世界 廷根市', userId: USER });
    assert.match(joined(world), /【廷根市】/, '.世界 地点 必须直接给详情');
  } finally {
    h.app.close();
  }
});
