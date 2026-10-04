/**
 * M2.3 任务一 + 任务二：菜单生成器是纯函数（不读库、不掷骰、不看墙上时间）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NUMERIC } from '../src/config/numeric.ts';
import { loadLocations } from '../src/data/loader.ts';
import { buildExploreMenu } from '../src/domain/menu/explore-menu.ts';
import { buildNextMenu, CONTINUATIONS } from '../src/domain/menu/next-menu.ts';
import { buildPlayMenu, matchLabel, pathwayKit } from '../src/domain/menu/play-menu.ts';
import { loadTagPhrases } from '../src/data/loader.ts';
import { installTagPhrases, phraseOf } from '../src/domain/menu/phrases.ts';

/*
 * M2.56：**必须先注入内容层的表**，否则下面的「必须含标签词」校验会变成恒真 ——
 * phraseOf 在没有表时走兜底句，而兜底句天生自带标签词 —— 测试过了，
 * 但 YAML 里那 135 条一条都没被检查到。这正是「测试看起来很严、实际在测空」。
 */
installTagPhrases(loadTagPhrases().table);
import { FREEFORM_LABEL, renderMenu } from '../src/domain/menu/render.ts';
import { FREEFORM_KEY, type Menu, type MenuCharacter, type WorldSnapshot } from '../src/domain/menu/types.ts';
import type { WorldClock } from '../src/domain/world/clock.ts';
import { worldModifiers, type WeatherId } from '../src/domain/world/weather.ts';

/* ---------------- 测试夹具 ---------------- */

function clockOf(over: Partial<WorldClock> = {}): WorldClock {
  return {
    now: Date.UTC(2026, 8, 21, 22, 0, 0),
    dayIndex: 20_000,
    hour: 22,
    timeOfDay: 'night',
    season: 'autumn',
    moonPhase: 3,
    fullMoon: false,
    foggy: false,
    nextFogDay: 20_002,
    ...over,
  };
}

function snapshotOf(
  weather: WeatherId = 'clear',
  over: Partial<WorldClock> = {},
  extra: Partial<WorldSnapshot> = {},
  pathway?: 'seer' | 'warrior' | 'sleepless',
): WorldSnapshot {
  const clock = clockOf(over);
  // 与命令层同一条路：worldViewFor(deps, now, locationId, character.pathway) → worldModifiers({clock, weather, path})
  return { clock, weather, modifiers: worldModifiers({ clock, weather, ...(pathway ? { path: pathway } : {}) }), ...extra };
}

function characterOf(over: Partial<MenuCharacter> = {}): MenuCharacter {
  return {
    id: 'c1',
    userId: '20001',
    name: '测试者',
    pathway: 'seer', pathwayStatus: 'initiated', gender: 'male',
    sequence: 9,
    hp: 100,
    mp: 100,
    mad: 10,
    cor: 5,
    dig: 20,
    dp: 0,
    status: 'active',
    promotionFails: 0,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

function commandsOf(menu: Menu): string[] {
  return menu.options.map((option) => option.command);
}

/** 菜单契约：编号连续、命令是完整指令、自由输入恒为 0 */
function assertContract(menu: Menu): void {
  assert.ok(menu.title.length > 0, '标题不能为空');
  assert.ok(menu.options.length > 0, '至少要有一个选项');
  menu.options.forEach((option, index) => {
    assert.equal(option.key, String(index + 1), `选项编号必须从 1 连续排到 N（第 ${index + 1} 个是 ${option.key}）`);
    assert.ok(option.command.length > 0, '每个选项都必须能直接执行（command 不能为空）');
    assert.ok(!/^[.。．]/.test(option.command), `command 是完整指令原文，不带前导点号：${option.command}`);
    assert.notEqual(option.key, FREEFORM_KEY, '0 号位永远留给「自己写一个行为」');
  });
}

/* ---------------- 任务一：扮演菜单 ---------------- */

test('扮演菜单：是纯函数（同输入同输出），且满足菜单契约', () => {
  const state = characterOf();
  const world = snapshotOf('fog', { timeOfDay: 'night', hour: 22 });
  const kit = pathwayKit('seer');
  const first = buildPlayMenu(state, world, kit);
  const second = buildPlayMenu(state, world, kit);
  assert.deepEqual(first, second, '同样的输入必须给出同样的菜单（可复现的前提）');
  assertContract(first);
  assert.equal(first.allowFreeform, true, '扮演菜单必须带 0. 自己写一个行为');

  const text = renderMenu(first);
  assert.ok(text.includes(`${FREEFORM_KEY}. ${FREEFORM_LABEL}`), '渲染结果里要有自由输入项');
  assert.ok(text.includes('回复数字。'), '渲染结果末尾要有「回复数字。」');
});

test('扮演菜单：选项从途径生成 —— 愚者与战士不是同一张表', () => {
  const world = snapshotOf('clear', { timeOfDay: 'day', hour: 12 });
  const seer = buildPlayMenu(characterOf({ pathway: 'seer' }), world, pathwayKit('seer'));
  const warrior = buildPlayMenu(characterOf({ pathway: 'warrior' }), world, pathwayKit('warrior'));
  assert.notDeepEqual(commandsOf(seer), commandsOf(warrior), '两条途径的扮演选项必须不同');
  assert.ok(seer.title.includes('愚者') && warrior.title.includes('战士'));
  // 愚者的选项应当落在它的契合标签上
  assert.ok(
    seer.options.some((option) => /占卜|命运|历史|预兆/.test(option.label)),
    `愚者菜单里应当出现占卜类选项：${seer.options.map((o) => o.label).join(' / ')}`,
  );
  assert.ok(
    warrior.options.some((option) => /战斗|冲锋|守护|勇气|荣耀/.test(option.label)),
    `战士菜单里应当出现战斗类选项：${warrior.options.map((o) => o.label).join(' / ')}`,
  );
});

test('扮演菜单：天气与时段在这里变现（雾天多观察、夜晚多潜行）', () => {
  const day = { timeOfDay: 'day' as const, hour: 12, foggy: false };
  const clearDay = buildPlayMenu(
    characterOf({ pathway: 'seer' }),
    snapshotOf('clear', day),
    pathwayKit('seer'),
  );
  const fogDay = buildPlayMenu(
    characterOf({ pathway: 'seer' }),
    snapshotOf('fog', day),
    pathwayKit('seer'),
  );
  assert.notDeepEqual(commandsOf(clearDay), commandsOf(fogDay), '换天气必须换选项');
  assert.ok(
    fogDay.options[0]!.command.includes('观察'),
    `雾天的第一条应当是「观察」：${fogDay.options[0]!.command}`,
  );
  assert.ok(fogDay.context.join(' ').includes('雾'), '菜单首屏必须带世界状态（.世界 覆盖率不再靠注入）');

  const nightSleepless = buildPlayMenu(
    characterOf({ pathway: 'sleepless' }),
    snapshotOf('clear', { timeOfDay: 'night', hour: 22 }, {}, 'sleepless'),
    pathwayKit('sleepless'),
  );
  assert.ok(
    nightSleepless.options[0]!.command.includes('守夜'),
    `不眠者夜里第一条应当是「守夜」：${nightSleepless.options[0]!.command}`,
  );
  assert.ok(
    nightSleepless.context.join(' ').includes('消化 ×1.20'),
    `不眠者的夜晚消化加成要写在首屏：${nightSleepless.context.join(' / ')}`,
  );
});

test('扮演菜单：MAD/COR ≥ 70 时把休息与净化置顶', () => {
  const world = snapshotOf('clear', { timeOfDay: 'day', hour: 12 });
  const calm = buildPlayMenu(characterOf({ mad: 69, cor: 69 }), world, pathwayKit('seer'));
  assert.ok(!/休息|净化/.test(calm.options[0]!.command), '没到线不该置顶恢复项');

  const risky = buildPlayMenu(characterOf({ mad: 70, cor: 5 }), world, pathwayKit('seer'));
  assert.equal(risky.options[0]!.command, '休息');
  const dirty = buildPlayMenu(characterOf({ mad: 5, cor: 71 }), world, pathwayKit('seer'));
  assert.equal(dirty.options[0]!.command, '净化');
  const lost = buildPlayMenu(characterOf({ status: 'lost_control' }), world, pathwayKit('seer'));
  assert.equal(lost.options[0]!.command, '净化');
});

test('扮演菜单：状态驱动补充项（序列 8 解锁、背包有魔药）', () => {
  const world = snapshotOf('clear', { timeOfDay: 'day', hour: 12 });
  const base = buildPlayMenu(characterOf({ sequence: 9 }), world, pathwayKit('seer'));
  const unlocked = buildPlayMenu(
    characterOf({ sequence: 8, abilityName: '小丑' }),
    world,
    pathwayKit('seer'),
  );
  assert.ok(
    unlocked.options.some((option) => option.command.includes('小丑')),
    '序列 8 + 能力名应当解锁一条专属选项',
  );
  assert.ok(!base.options.some((option) => option.command.includes('小丑')), '序列 9 不该看到它');

  const withPotion = buildPlayMenu(
    characterOf({ potions: [{ itemId: '魔药·愚者·序列9', name: '愚者魔药', pathway: 'seer', seq: 9 }] }),
    world,
    pathwayKit('seer'),
  );
  assert.ok(
    withPotion.options.some((option) => option.command === '服用 魔药·愚者·序列9'),
    '背包里有本途径魔药就该多一个「服用」',
  );
});

test('扮演菜单：匹配度只给高/中/低，不给精确分数', () => {
  assert.equal(matchLabel(1.2), '高');
  assert.equal(matchLabel(1), '高');
  assert.equal(matchLabel(0.5), '中');
  assert.equal(matchLabel(0.2), '低');
  assert.equal(matchLabel(0), '无');
  const menu = buildPlayMenu(characterOf(), snapshotOf(), pathwayKit('seer'));
  for (const option of menu.options) {
    assert.ok(option.preview !== undefined, '每个选项都应当有预览');
    assert.ok(!/\d+\.\d+\s*分/.test(option.preview ?? ''), '预览里不能出现精确匹配分');
  }
});

test('标签文案表：七个途径都在，且 135 条文案一条 error 都没有', () => {
  /*
   * 这一条守的是**内容表本身**。上面那条遍历的是 phraseOf 的输出，只要表里
   * 有 error（比如某句漏了标签词），loader 会把它剔掉 —— 那条遍历就再也看不到它，
   * 反而永远绿。所以必须单独把 issues 摆出来看。
   */
  const bundle = loadTagPhrases();
  const errors = bundle.issues.filter((issue) => issue.level === 'error');
  assert.deepEqual(errors, [], '文案表有 error：' + JSON.stringify(errors.slice(0, 3)));
  assert.equal(Object.keys(bundle.table).length, 7, '七个途径一个都不能少');
  const total = Object.values(bundle.table).reduce((n, tags) => n + Object.keys(tags).length, 0);
  assert.ok(total >= 100, '文案条数不对：' + total);
});

test('扮演菜单：每一条文案都必须包含它自己的标签词（否则玩家选了也不涨消化度）', () => {
  // 判定层是「关键词包含匹配」：文案里没有标签词 = 菜单在骗人。
  // 这条测试是内容层新增标签时的安全网：忘了写文案会走兜底句，兜底句自带标签词。
  for (const kit of [pathwayKit('seer'), pathwayKit('warrior'), pathwayKit('sleepless')]) {
    for (const tag of [...kit.tags.core, ...kit.tags.secondary]) {
      const phrase = phraseOf(kit.id, tag);
      assert.ok(phrase.includes(tag), `${kit.label} 的「${tag}」文案里必须出现标签词：${phrase}`);
    }
  }
  /*
   * 这里要**先把注入撤掉**才测得准：装表的时候「不存在的标签」当然也取不到，
   * 但那验证不了兜底句本身。
   */
  installTagPhrases({});
  assert.equal(phraseOf('seer', '不存在的标签'), '以「不存在的标签」的方式行事', '没写文案的标签走兜底句');
  installTagPhrases(loadTagPhrases().table);
});

/* ---------------- 任务一：探索菜单 ---------------- */

test('探索菜单：危险倍率分解与今日次数写在首屏', () => {
  const location = loadLocations().locations[0]!;
  const world = snapshotOf('fog', { timeOfDay: 'night', hour: 22, foggy: false }, { exploreUsedToday: 1 });
  const menu = buildExploreMenu(characterOf(), world, location, []);
  assertContract(menu);
  const head = menu.context.join(' ');
  // 夜晚 ×1.1 × 雾 ×1.1 = ×1.21
  assert.ok(head.includes('危险 +21%'), `首屏要写危险倍率：${head}`);
  assert.ok(head.includes('夜晚 +10%') && head.includes('雾 +10%'), `倍率要拆开写清楚：${head}`);
  /*
   * ⚠️ 断言在 M2.85 跟着机制改过：原来是 `今日 1/3 次`。
   *
   * 用户把「每日 3 次」的**硬上限**改成了软上限（越刷越亏，但不禁止），
   * 所以菜单里不再写「/3」—— 那会让人以为还有次数限制。
   * 现在写的是「今日已探 N 次」，只报事实、不报配额。
   */
  assert.ok(head.includes('今日已探 1 次'), `要写今日次数：${head}`);
  // M2.85：原来这里还断言首屏写「AP 5」—— 随行动值一并删除
  assert.ok(menu.title.includes(location.name), '标题要带地点名');
});

test('探索菜单：选项必须是真的不同（不是同一地点的三种说法）', () => {
  const locations = loadLocations().locations;
  const base = locations.find((entry) => entry.min_seq === 9 && entry.max_seq === 0)!;
  const world = snapshotOf('clear', { timeOfDay: 'day', hour: 12 }, {
    exploreUsedToday: 0,
    locations: locations.map((entry) => ({
      id: entry.id,
      name: entry.name,
      danger: entry.danger,
      minSeq: entry.min_seq,
      maxSeq: entry.max_seq,
      lootCount: entry.loot.length,
      usedToday: 0,
      weather: 'clear' as WeatherId,
    })),
  });
  const menu = buildExploreMenu(characterOf(), world, base, []);
  const commands = commandsOf(menu);
  assert.equal(new Set(commands).size, commands.length, `探索选项的指令不能重复：${commands.join(' / ')}`);
  assert.ok(commands[0]!.includes(base.name), '第一条永远是当前地点');
  const others = commands.slice(1).filter((command) => command.startsWith('探索 '));
  assert.ok(others.length >= 1, `至少要给一个「换个地方」的真实选项：${commands.join(' / ')}`);
});

test('探索菜单：不可选时给出原因（今日已满 / 灵性不足 —— M2.85：行动点门槛已下线）', () => {
  const location = loadLocations().locations[0]!;
  const full = snapshotOf('clear', { timeOfDay: 'day', hour: 12 }, {
    exploreUsedToday: NUMERIC.explore.dailyCapPerLocation,
  });
  const menu = buildExploreMenu(characterOf(), full, location, []);
  /*
   * ⚠️ 这条断言在 M2.86 **反了过来**。
   *
   * 原来断言「到 3 次就 disabled『今天这里已经待满了』」。
   * 用户拍板把每日次数改成**软上限**（越刷越亏，但不禁止）之后，
   * 再禁用就是「换个说法继续拦」—— 所以现在断言的是**不被禁用**、
   * 而且把「越刷越亏」明说出来，让玩家自己决定值不值得再探一次。
   *
   * （机制变了、断言不跟着变的话，它会一直绿着，而绿的是**已经不存在的行为**。）
   */
  assert.equal(menu.options[0]!.disabled, undefined, '软上限不该禁用：' + String(menu.options[0]!.disabled));
  assert.ok(
    (menu.options[0]!.preview ?? '').includes('收益已衰减'),
    '到软上限之后要说清越刷越亏：' + String(menu.options[0]!.preview),
  );

  /* M2.85：原来这里还有一段「tired」（行动点耗尽 → disabled『行动点不足』）——
     探索不再有行动点门槛，这段判据随行动值一并删除。 */

  // 愚者的专属项要灵性
  const drained = buildExploreMenu(
    characterOf({ mp: 0 }),
    snapshotOf('clear', { timeOfDay: 'day', hour: 12 }, { exploreUsedToday: 0 }),
    location,
    [],
  );
  const seerAction = drained.options.find((option) => option.command.startsWith('占卜 '));
  assert.ok(seerAction, '愚者的探索菜单里应当有一条占卜选项（门途径「穿墙」位）');
  assert.equal(seerAction.disabled, '灵性不足');
});

test('探索菜单：有队友且是队长时多一条协作选项', () => {
  const location = loadLocations().locations[0]!;
  const world = snapshotOf('clear', { timeOfDay: 'day', hour: 12 }, { exploreUsedToday: 0 });
  const solo = buildExploreMenu(characterOf(), world, location, []);
  assert.ok(!commandsOf(solo).includes('队伍 任务'));
  const teamed = buildExploreMenu(
    characterOf({ partySize: 3, isPartyLeader: true }),
    world,
    location,
    [],
  );
  assert.ok(commandsOf(teamed).includes('队伍 任务'), '有队友多「协作」');
});

/* ---------------- 任务二：上下文推进 ---------------- */

test('上下文推进：覆盖任务书点名的 8 条指令，且每条都给得出 3—4 个选项', () => {
  const required = ['扮演', '探索', '魔药', '服用', '晋升', '休息', '净化', '确认'];
  for (const name of required) {
    assert.ok((CONTINUATIONS as readonly string[]).includes(name), `${name} 必须接上「下一步」出口`);
  }
  const locations = loadLocations().locations;
  const world = snapshotOf('fog', { timeOfDay: 'night', hour: 22 }, {
    locations: locations.map((entry) => ({
      id: entry.id,
      name: entry.name,
      danger: entry.danger,
      minSeq: entry.min_seq,
      maxSeq: entry.max_seq,
      lootCount: entry.loot.length,
      usedToday: 0,
      weather: 'clear' as WeatherId,
    })),
  });
  for (const after of [...CONTINUATIONS, '状态', '世界', '背包']) {
    const menu = buildNextMenu({
      state: characterOf({ potions: [{ itemId: '魔药·愚者·序列9', name: '愚者魔药', pathway: 'seer', seq: 9 }] }),
      world,
      pathway: pathwayKit('seer'),
      after,
      command: `${after} 示例`,
      notes: ['DIG 52.0 → 53.2（+1.2）'],
    });
    assertContract(menu);
    assert.ok(
      menu.options.length >= 3 && menu.options.length <= NUMERIC.menu.nextOptionCount,
      `「${after}」之后应当给 3—${NUMERIC.menu.nextOptionCount} 个选项，实际 ${menu.options.length}`,
    );
    assert.ok(menu.context.some((line) => line.includes('DIG')), '下一步菜单首屏要带状态与世界');
  }
});

test('M2.123：重伤时「下一步」先给休息与就医 —— 不论有没有途径', () => {
  const world = snapshotOf('clear', { timeOfDay: 'day', hour: 12 }, { exploreUsedToday: 0 });

  // 有途径的人：重伤一样先给这两个，不许被「按 after 猜」的分支顶掉
  const initiated = buildNextMenu({
    state: characterOf({ status: 'injured' }),
    world,
    pathway: pathwayKit('seer'),
    after: '探索',
  });
  assert.deepEqual(initiated.options.slice(0, 2).map((o) => o.command), ['休息', '就医']);

  // 普通人（还没有途径）也走同一条 —— 判据在菜单入口，不在各条命令里
  const mortal = buildNextMenu({ state: characterOf({ status: 'injured' }), world, after: '探索' });
  assert.deepEqual(mortal.options.slice(0, 2).map((o) => o.command), ['休息', '就医']);

  // 连「刚打完架」也一样：那条分支本来会推「查看状态 / 今日」
  const afterBattle = buildNextMenu({
    state: characterOf({ status: 'injured' }),
    world,
    pathway: pathwayKit('seer'),
    after: '战斗',
  });
  assert.equal(afterBattle.options[0]!.command, '休息', '重伤时「战斗」之后的下一步也该是休息');
});

test('上下文推进：按状态推荐（失控先恢复、有魔药先喝、高风险先压）', () => {
  const world = snapshotOf('clear', { timeOfDay: 'day', hour: 12 }, { exploreUsedToday: 0 });
  const lost = buildNextMenu({
    state: characterOf({ status: 'lost_control', inventory: [{ itemId: '辅助材料·圣盐', quantity: 2 }] }),
    world,
    pathway: pathwayKit('seer'),
    after: '扮演',
  });
  assert.equal(lost.options[0]!.command, '净化', '失控时第一条永远是恢复');

  const brewed = buildNextMenu({
    state: characterOf({ potions: [{ itemId: '魔药·愚者·序列9', name: '愚者魔药', pathway: 'seer', seq: 9 }] }),
    world,
    pathway: pathwayKit('seer'),
    after: '魔药',
  });
  assert.equal(brewed.options[0]!.command, '服用 魔药·愚者·序列9', '刚调完药，下一步就是喝掉');

  const risky = buildNextMenu({
    state: characterOf({ mad: 80 }),
    world,
    pathway: pathwayKit('seer'),
    after: '探索',
  });
  assert.equal(risky.options[0]!.command, '休息', 'MAD 到线先休息');
});
