/**
 * M2.4 公共事件流：单测。
 *
 * 分四组：
 *   一、生成器是纯函数（同 seed 同输出 / 不读玩家状态 / 频率与时段闸门）
 *   二、仓储（幂等落库、有效期、分组计数）
 *   三、链路（世界 tick → 落库 → 群播报 → 私聊回数字 → 明细走私聊）
 *   四、分片（世界 seed 全局一个 → 4 片看到同一串事件）
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { NUMERIC } from '../src/config/numeric.ts';
import { dayIndexOf, dayStartOf, hourStartOf, worldClock } from '../src/domain/world/clock.ts';
import {
  dayPlanFor,
  generateWorldEvents,
  isEventLive,
  worldEventBody,
  worldEventHeadline,
  type WorldEvent,
} from '../src/domain/world/events.ts';
import { worldModifiers, type WeatherState } from '../src/domain/world/weather.ts';
import { worldEventMenu } from '../src/domain/menu/world-event.ts';
import { parseCommand } from '../src/router/index.ts';
import { WorldEventRepo } from '../src/infra/db/world-events.ts';
import { migrate, openDatabase } from '../src/infra/db/sqlite.ts';
import { planShards, shardArgs } from '../scripts/vplayer-shard.ts';
import { worldConsistencyOf } from '../src/vplayer/merge.ts';
import { SHARD_SCHEMA, worldEventEvidenceOf, type ShardJson } from '../src/vplayer/shard-json.ts';
import { createHarness, GROUP_ID, DEFAULT_USER } from './helpers/app.ts';

/* ---------------- 测试夹具 ---------------- */

/** 东八区 20:00（非安静时段），小时起点对齐 */
const DAY = 20_000;
const AT = dayStartOf(DAY) + 20 * 60 * 60 * 1000;

const PLACES = [
  { id: 'loc_old_dock', name: '老码头', danger: 3, minSeq: 9, maxSeq: 8, lootCount: 4 },
  { id: 'loc_church', name: '圣塞琳娜教堂', danger: 2, minSeq: 9, maxSeq: 8, lootCount: 3 },
  { id: 'loc_market', name: '下城区集市', danger: 1, minSeq: 9, maxSeq: 9, lootCount: 2 },
  { id: 'loc_graveyard', name: '公墓', danger: 4, minSeq: 9, maxSeq: 7, lootCount: 5 },
];

function weatherState(
  locationId: string,
  weather: WeatherState['weather'],
  since: number,
): WeatherState {
  return {
    locationId,
    weather,
    since,
    until: since + NUMERIC.world.weather.durationMs,
    pendingWeather: null,
    pendingAt: null,
  };
}

function snapshotOf(overrides: Record<string, unknown> = {}, at = AT) {
  const clock = worldClock(at, 'world');
  return {
    clock,
    weather: 'clear' as const,
    modifiers: worldModifiers({ clock, weather: 'clear' }),
    locations: PLACES,
    weatherStates: PLACES.map((place) => weatherState(place.id, 'clear', at)),
    ...overrides,
  };
}

function eventIds(events: readonly WorldEvent[]): string[] {
  return events.map((event) => event.id);
}

/** 保证「这一小时一定有事件」的夹具：让老码头此刻起血月（环境事件是天气驱动的，最可控） */
function snapshotWithBloodMoon(at = AT) {
  return snapshotOf(
    { weatherStates: PLACES.map((place) => weatherState(place.id, 'blood_moon', at)) },
    at,
  );
}

/* ================= 一、生成器是纯函数 ================= */

test('M2.4 生成器：判定层零 IO —— 源码里没有仓储 / 适配器 / 时钟 / 文件', () => {
  const source = readFileSync('src/domain/world/events.ts', 'utf8');
  const imports = source
    .split('\n')
    .filter((line) => line.startsWith('import '))
    .join('\n');
  for (const forbidden of ['infra/', 'adapter/', 'node:', 'sqlite']) {
    assert.equal(
      imports.includes(forbidden),
      false,
      `事件生成器不许依赖 ${forbidden}（硬约束：判定层纯函数、无 IO）`,
    );
  }
  assert.equal(
    /Date\.now\(/.test(source),
    false,
    '不许读墙上时间：时间一律由 now 参数注入',
  );
  assert.equal(
    /Math\.random\(/.test(source),
    false,
    '不许用 Math.random：随机一律由 seed 派生',
  );
});

test('M2.4 生成器：同 seed 同时刻 → 输出逐字节一致', () => {
  const first = generateWorldEvents(snapshotWithBloodMoon(), AT, 'world');
  const second = generateWorldEvents(snapshotWithBloodMoon(), AT, 'world');
  assert.equal(JSON.stringify(first), JSON.stringify(second), '同 seed 同输出是硬约束');
  assert.ok(first.length > 0, '夹具本身要有事件，否则这条测试什么都没验');

  // 换 seed 必须换结果 —— 用自然生成的一天来验（环境事件由天气驱动、与 seed 无关；
  // 传闻与发现才是 seed 派生的那一半，换 seed 就必须换说法）
  const natural = (seed: string): string => {
    const out: WorldEvent[] = [];
    for (let hour = 0; hour < 24; hour += 1) {
      const at = dayStartOf(DAY) + hour * 3_600_000;
      out.push(...generateWorldEvents(snapshotOf({}, at), at, seed));
    }
    return JSON.stringify(out);
  };
  assert.notEqual(natural('world'), natural('other-world'), '换 seed 必须换结果');
});

test('M2.4 生成器：不读玩家状态（改天气倍率/已探索次数，输出一个字节都不变）', () => {
  const neutral = generateWorldEvents(snapshotOf(), AT, 'world');
  // 这些字段都是「玩家视角的世界」：菜单要用，但事件生成器一个都不该读
  const polluted = generateWorldEvents(
    snapshotOf({
      weather: 'blood_moon',
      modifiers: { ...worldModifiers({ clock: worldClock(AT, 'world'), weather: 'blood_moon' }), playMad: 999 },
      exploreUsedToday: 7,
      locations: PLACES.map((place) => ({ ...place, usedToday: 3, weather: 'spirit_creep' as const })),
    }),
    AT,
    'world',
  );
  assert.equal(
    JSON.stringify(neutral),
    JSON.stringify(polluted),
    '生成器一旦读了玩家状态，4 个分片必然算出 4 串不同的事件',
  );
});

test('M2.4 生成器：环境事件只在「名单里的天气刚开始」的那一个小时生成', () => {
  for (const weather of NUMERIC.world.events.environmentWeathers) {
    const started = generateWorldEvents(
      snapshotOf({ weatherStates: [weatherState('loc_old_dock', weather as WeatherState['weather'], AT)] }),
      AT,
      'world',
    ).filter((event) => event.type === 'environment');
    assert.equal(started.length, 1, `${weather} 刚要开始时必须播一条`);
    assert.equal(worldEventHeadline(started[0]!), '【世界 · 老码头】');

    // 同一次天气的第二个小时：since 还在上一格，不该再播一次
    const later = generateWorldEvents(
      snapshotOf({
        weatherStates: [weatherState('loc_old_dock', weather as WeatherState['weather'], AT - 3_600_000)],
      }),
      AT,
      'world',
    ).filter((event) => event.type === 'environment');
    assert.equal(later.length, 0, `${weather} 已经在上一小时开始过，不能重复播`);
  }
});

test('M2.4 生成器：普通天气不触发环境事件；每小时最多 3 条', () => {
  const common = generateWorldEvents(
    snapshotOf({
      weatherStates: [
        weatherState('loc_old_dock', 'fog', AT),
        weatherState('loc_church', 'storm', AT),
        weatherState('loc_market', 'clear', AT),
      ],
    }),
    AT,
    'world',
  ).filter((event) => event.type === 'environment');
  assert.equal(common.length, 0, '雾/雷暴/晴不是环境事件');

  // 11 个地点同时起血月 = 11 条候选，必须被闸门截到 3 条
  const many = Array.from({ length: 11 }, (_, index) => ({
    id: `loc_${index}`,
    name: `地点${index}`,
    danger: 1,
    minSeq: 9,
    maxSeq: 9,
    lootCount: 1,
  }));
  const capped = generateWorldEvents(
    snapshotOf({
      locations: many,
      weatherStates: many.map((place) => weatherState(place.id, 'blood_moon', AT)),
    }),
    AT,
    'world',
  );
  assert.equal(capped.length, NUMERIC.world.events.maxPerHour, '每小时最多 3 条（任务书 §3）');
  assert.ok(
    capped.every((event) => event.type === 'environment'),
    '截断按优先级来：环境事件不能被传闻挤掉',
  );
});

test('M2.4 生成器：传闻每天 1—3 条，且不落在安静时段（0—5 点）', () => {
  const active = new Set(
    Array.from({ length: 24 }, (_, hour) => hour).filter(
      (hour) => hour < NUMERIC.world.events.quietFromHour || hour >= NUMERIC.world.events.quietToHour,
    ),
  );
  for (let day = DAY; day < DAY + 10; day += 1) {
    let rumors = 0;
    for (let hour = 0; hour < 24; hour += 1) {
      const at = dayStartOf(day) + hour * 3_600_000;
      const events = generateWorldEvents(snapshotOf({}, at), at, 'world');
      if (!active.has(hour)) {
        assert.equal(events.length, 0, `第 ${hour} 点属于安静时段，世界不该说话`);
      }
      rumors += events.filter((event) => event.type === 'rumor').length;
    }
    assert.ok(
      rumors >= NUMERIC.world.events.rumorMinPerDay && rumors <= NUMERIC.world.events.rumorMaxPerDay,
      `第 ${day} 天传闻 ${rumors} 条，应在 1—3 条之间`,
    );
  }
});

test('M2.4 生成器：传闻保底 —— 环境事件挤满一小时时，传闻仍然播得出去', () => {
  // 找一天里第一个传闻排期小时（排期只由 (seed, day) 决定，与天气无关）
  let found: { day: number; hour: number } | null = null;
  for (let day = DAY; day < DAY + 30 && !found; day += 1) {
    const plan = dayPlanFor('world', day, { locationCount: PLACES.length, foggy: false });
    const hour = [...plan.rumorHours.keys()].sort((a, b) => a - b)[0];
    if (hour !== undefined) found = { day, hour };
  }
  assert.ok(found, '30 天里总该有传闻排期');

  // 这一小时同时有 11 条环境事件候选（远超每小时上限）
  const many = Array.from({ length: 11 }, (_, index) => ({
    id: `loc_${index}`,
    name: `地点${index}`,
    danger: 1,
    minSeq: 9,
    maxSeq: 9,
    lootCount: 1,
  }));
  const at = dayStartOf(found.day) + found.hour * 3_600_000;
  const events = generateWorldEvents(
    snapshotOf(
      {
        locations: many,
        weatherStates: many.map((place) => weatherState(place.id, 'blood_moon', at)),
      },
      at,
    ),
    at,
    'world',
  );
  assert.equal(events.length, NUMERIC.world.events.maxPerHour, '每小时上限照旧');
  assert.ok(
    events.some((event) => event.type === 'rumor'),
    '传闻不能被环境事件挤没：每天 1—3 条是任务书口径，与每小时 3 条同时成立',
  );
});

test('M2.4 生成器：事件结构完整 —— id/可见性/有效期/选项都是完整指令', () => {
  const events: WorldEvent[] = [];
  for (let day = DAY; day < DAY + 7; day += 1) {
    for (let hour = 0; hour < 24; hour += 1) {
      const at = dayStartOf(day) + hour * 3_600_000;
      events.push(...generateWorldEvents(snapshotOf({}, at), at, 'world'));
    }
  }
  // 每天至少 1 条传闻（rumorMinPerDay），7 天至少 7 条
  assert.ok(events.length >= 7 * NUMERIC.world.events.rumorMinPerDay, `7 天只有 ${events.length} 条事件`);
  assert.equal(new Set(eventIds(events)).size, events.length, 'id 不能重复');

  const known = new Set(['探索', '占卜', '今日']);
  for (const event of events) {
    assert.ok(event.id.length > 0);
    assert.ok(['environment', 'discovery', 'rumor'].includes(event.type), `${event.type} 本轮不该出现`);
    assert.ok(
      event.visibility === (event.type === 'rumor' ? 'anonymous' : 'public'),
      `${event.type} 的可见性不对：${event.visibility}`,
    );
    assert.equal(event.createdAt, hourStartOf(event.createdAt), 'createdAt 必须落在整点');
    assert.equal(event.expiresAt, event.createdAt + NUMERIC.world.events.ttlMs);
    assert.ok(event.text.includes('\n'), '第一行是抬头、后面是正文');

    const options = event.options ?? [];
    assert.ok(options.length >= 2 && options.length <= NUMERIC.world.events.maxOptions);
    assert.deepEqual(
      options.map((option) => option.key),
      options.map((_, index) => String(index + 1)),
      '选项编号必须是 1 起的连续数字（M2.3 的按键约定）',
    );
    for (const option of options) {
      const parsed = parseCommand('.' + option.command);
      assert.ok(parsed, `选项必须是完整指令：${option.command}`);
      assert.ok(known.has(parsed.name), `选项指向了不存在的指令：${option.command}`);
      assert.equal(option.command.startsWith('.'), false, '选项里的指令不带前导点号');
    }
  }
});

test('M2.4 生成器：faction 本轮仍是占位，一条都不生成', () => {
  const types = new Set<string>();
  for (let day = DAY; day < DAY + 14; day += 1) {
    for (let hour = 0; hour < 24; hour += 1) {
      const at = dayStartOf(day) + hour * 3_600_000;
      for (const event of generateWorldEvents(snapshotOf({}, at), at, 'world')) types.add(event.type);
    }
  }
  // M2.6 留的势力接入点：M2.14 只填了 calamity，faction 留 M2.15
  assert.equal(types.has('faction'), false, 'faction 仍占位，留 M2.15');
  // M2.14：calamity 已接入（不再是「恒返回 [] 的占位」）。它出现与否取决于 seed，
  // 所以不在这里断言 —— 灾厄自己的契约由 test/m2-14.test.ts 守。
});

test('M2.4 生成器：菜单适配 —— 抬头/正文/选项/回复数字，格式与任务书 §4 一致', () => {
  const events = generateWorldEvents(
    snapshotOf({ weatherStates: [weatherState('loc_old_dock', 'greyfog_tide', AT)] }),
    AT,
    'world',
  );
  const event = events.find((candidate) => candidate.type === 'environment');
  assert.ok(event, '灰雾潮开始时该有一条环境事件');
  const menu = worldEventMenu(event);
  assert.equal(menu.title, '【世界 · 老码头】');
  assert.ok(worldEventBody(event).length > 0);
  assert.equal(menu.options.length, 3);
  assert.equal(menu.options[0]!.command, '探索 老码头');
  assert.equal(menu.allowFreeform, false, '世界事件不给「自己写一个行为」');
});

/* ================= 二、仓储 ================= */

test('M2.4 仓储：同一 id 只落一条（补跑重放不会重复播报）', () => {
  const db = openDatabase(':memory:');
  migrate(db);
  try {
    const repo = new WorldEventRepo(db);
    const events = generateWorldEvents(snapshotWithBloodMoon(), AT, 'world');
    assert.ok(events.length > 0);
    assert.equal(repo.insertMany(events), events.length, '第一次全部写入');
    assert.equal(repo.insertMany(events), 0, '第二次（补跑重放）一条都不重复写');
    assert.equal(repo.count(), events.length);
    assert.equal(repo.all().length, events.length);

    // 有效期过滤
    const later = AT + NUMERIC.world.events.ttlMs + 1;
    assert.equal(repo.live(later).length, 0, '过了 TTL 就不是「有效事件」了');
    assert.equal(repo.latestLive(later), null);
    assert.equal(repo.latestLive(AT)?.id, repo.live(AT)[0]?.id, '最新的一条 = live 列表的第一条');
    assert.equal(isEventLive(events[0]!, later), false);
    assert.equal(repo.countSince(AT), events.length);
  } finally {
    db.close();
  }
});

test('M2.4 仓储：按类型与可见性分组计数', () => {
  const db = openDatabase(':memory:');
  migrate(db);
  try {
    const repo = new WorldEventRepo(db);
    const events: WorldEvent[] = [];
    for (let day = DAY; day < DAY + 7; day += 1) {
      for (let hour = 0; hour < 24; hour += 1) {
        const at = dayStartOf(day) + hour * 3_600_000;
        events.push(...generateWorldEvents(snapshotOf({}, at), at, 'world'));
      }
    }
    repo.insertMany(events);
    const byType = repo.countByType();
    const byVisibility = repo.countByVisibility();
    const sum = (record: Record<string, number>): number =>
      Object.values(record).reduce((total, value) => total + value, 0);
    assert.equal(sum(byType), events.length);
    assert.equal(sum(byVisibility), events.length);
    assert.ok((byType.rumor ?? 0) >= NUMERIC.world.events.rumorMinPerDay);
    assert.equal(
      byVisibility.anonymous ?? 0,
      byType.rumor ?? 0,
      '匿名事件就是传闻那一类',
    );
  } finally {
    db.close();
  }
});

/* ================= 三、链路：落库 → 群播报 → 回数字 ================= */

/**
 * 把世界推进到「有事件的那一小时」：跨 30 个小时，必然跨过若干排期小时。
 *
 * 注意 `h.send()` 会 take 掉适配器里攒下的全部出站消息（包括世界播报），
 * 所以想看播报就必须把它返回的那一份收集起来 —— adapter.sent 那时已经空了。
 */
async function advanceIntoEvents(
  h: ReturnType<typeof createHarness>,
  options: { userId?: string; at?: (hour: number) => number } = {},
): Promise<Array<{ scene: string; targetId: string; text: string }>> {
  const userId = options.userId ?? DEFAULT_USER;
  const collected: Array<{ scene: string; targetId: string; text: string }> = [];
  const send = async (): Promise<void> => {
    const replies = await h.send({ rawText: '.帮助', scene: 'group', groupId: GROUP_ID, userId });
    collected.push(...replies);
  };
  const base = h.now();
  // 先让这个群「存在」，否则世界播报没有收件人（真实运行里群早就登记过了）
  await send();
  for (let hour = 0; hour < 30; hour += 1) {
    const target = options.at ? options.at(hour) : base + hour * 3_600_000;
    h.advance(target - h.now());
    await send();
  }
  return collected;
}

test('M2.4 链路：世界主动说话 —— 事件落库，并按可见性进群播报', async () => {
  const h = createHarness();
  try {
    await h.createCharacter(DEFAULT_USER, '看客');
    const replies = await advanceIntoEvents(h);

    const events = h.repos.worldEvents.all();
    assert.ok(events.length > 0, '跑过 30 个小时之后世界该说过话了');

    /*
     * 群播报：抬头 + 正文（M2.86 起**不再带数字菜单**）。
     *
     * ⚠️ 判据改过。原来这里断言「播报必须带『回复数字。』与编号选项」——
     * 那正是实机 bug 的形状：多条推送各挂一张菜单，后者覆盖前者，
     * 玩家回数字只能对上最后一条（详见 src/infra/world-tick.ts 的说明）。
     *
     * 现在群播报只播报，交互靠**底部按钮**（按钮的 data 是完整指令，
     * 平台回传后走普通路由，不依赖待答菜单，所以多条互不干扰）。
     * 这里断言的是「不再出现编号菜单」+「正文齐整」。
     */
    const broadcasts = replies
      .filter((message) => message.scene === 'group')
      .map((message) => message.text)
      .filter((text) => text.includes('【世界 ·'));
    assert.ok(broadcasts.length > 0, '群里必须看得到世界在动');
    for (const text of broadcasts) {
      assert.doesNotMatch(text, /回复数字。/, 'M2.86：群播报不再挂数字菜单');
      assert.doesNotMatch(text, /\n1\. /, 'M2.86：不再有编号选项（改由按钮承担）');
      assert.ok(text.includes('【世界 ·'), '抬头还在');
    }
    // 每小时的播报条数不超过闸门
    assert.ok(
      broadcasts.length <= events.length,
      '播报不应多于落库（faction 不播，其余一条一播）',
    );
  } finally {
    h.app.close();
  }
});

test('M2.4 链路：私聊回数字参与世界事件；群里回数字不接（M2.3 一致）', async () => {
  const h = createHarness();
  try {
    await h.createCharacter(DEFAULT_USER, '参与者');
    await advanceIntoEvents(h);
    const event = h.repos.worldEvents.latestLive(h.now());
    assert.ok(event, '需要一个还有效的世界事件');
    const firstOption = event.options?.[0];
    assert.ok(firstOption, '事件必须带选项');

    /*
     * 群里回数字：这个人**有待命菜单**时接住（与私聊同义）。
     * 原来的判据「群里回数字不接」（任务书 §4）已经作废 ——
     * 没有待命菜单的人在群里打「1」仍然一声不响，那条由 m2-3 的用例守着。
     */
    const inGroup = await h.send({ rawText: '1', scene: 'group', groupId: GROUP_ID, userId: DEFAULT_USER });
    assert.equal(inGroup.length, 1, '群里有待命菜单时数字要被接住');
    assert.equal(inGroup[0]?.scene, 'group', '回执发回群里');

    /*
     * 群里那一次同样会执行世界事件的第一条选项，并在其后开一张「下一步」菜单。
     * 清掉它，下面私聊那条才会重新落到**世界事件菜单**上 —— 本用例要测的正是它。
     */
    h.app.router.deps.pendingMenus.clear(h.repos.characters.findByUserId(DEFAULT_USER)!.id);

    // 私聊回数字：命中世界事件的第一条选项，并按完整指令执行
    const replies = await h.send({ rawText: '1', userId: DEFAULT_USER });
    const text = replies.map((reply) => reply.text).join('\n');
    assert.ok(text.length > 0, '私聊回数字必须有回执');
    assert.ok(
      !text.includes('菜单已过期'),
      `不该落到「菜单已过期」：${text.slice(0, 120)}`,
    );
    // 第一条选项是「去某地看看」= .探索。
    // M2.7 起不能用「AP 减 1」当证据了：世界事件的地点是从**全部 36 个地点**里抽的，
    // 它可能在别的城市，于是这条探索会被城市校验合理地挡回（AP 一点没扣）。
    // 真正要证明的是「回数字 = 发出那条指令」，所以改看审计：
    // 最后一条记录必须是探索，而且 input 要还原得出「按了第 1 项」。
    assert.equal(firstOption.command.startsWith('探索'), true);
    const audit = h.app.db
      .prepare('SELECT command, input FROM audit_logs ORDER BY id DESC LIMIT 1')
      .get() as { command: string; input: string };
    assert.equal(audit.command, '探索', `回数字必须执行成对应指令，实际是 ${audit.command}`);
    assert.ok(audit.input.includes('菜单#1'), `审计要还原出「按了哪一项」：${audit.input}`);
  } finally {
    h.app.close();
  }
});

test('M2.4 链路：个人菜单优先于世界事件菜单（M2.3 的行为不被抢走）', async () => {
  const h = createHarness();
  try {
    await h.createCharacter(DEFAULT_USER, '优先者');
    await advanceIntoEvents(h);
    assert.ok(h.repos.worldEvents.latestLive(h.now()), '前提：此刻确实有有效的世界事件');

    const characterId = h.repos.characters.findByUserId(DEFAULT_USER)!.id;
    const menus = h.app.router.deps.pendingMenus;

    /*
     * 夹具用群聊 .帮助 推进世界，而群聊现在也会附加「下一步」菜单 ——
     * 先把那张清掉，才能测「没有个人菜单时兜底到世界事件」。
     */
    menus.clear(characterId);
    // 没有个人菜单时：兜底到世界事件
    assert.equal(menus.current(characterId, h.now()), null, '前提：此刻个人菜单是空的');
    assert.ok(menus.worldEventMenuAt(h.now()), '有有效世界事件时该能拿到「房间里那张」');
    const fallback = menus.pick(characterId, '1', h.now());
    assert.equal(fallback.ok && fallback.menuType, 'world_event', '没有个人菜单时数字落到世界事件');

    // 挂一张确定性的个人菜单：回数字必须走它，而不是世界事件
    menus.open(
      characterId,
      'today',
      {
        title: '【今日】',
        context: ['测试用菜单'],
        options: [{ key: '1', label: '看状态', command: '状态' }],
        allowFreeform: true,
      },
      h.now(),
    );
    const picked = menus.pick(characterId, '1', h.now());
    assert.equal(picked.ok, true);
    assert.equal(
      picked.ok && picked.menuType,
      'today',
      '有个人菜单时必须走个人菜单（世界事件只在没有个人菜单时兜底）',
    );
    assert.equal(picked.ok && picked.kind === 'option' && picked.option.command, '状态');
  } finally {
    h.app.close();
  }
});

test('M2.4 链路：播报是群里的摘要，明细在私聊（不往群里倒结果）', async () => {
  const h = createHarness();
  try {
    await h.createCharacter(DEFAULT_USER, '明细者');
    await advanceIntoEvents(h);
    const event = h.repos.worldEvents.latestLive(h.now());
    assert.ok(event);

    h.adapter.take();
    const replies = await h.send({ rawText: '2', userId: DEFAULT_USER });
    const group = replies.filter((reply) => reply.scene === 'group');
    const priv = replies.filter((reply) => reply.scene === 'private');
    assert.ok(priv.length > 0, '私聊必须有明细');
    assert.equal(group.length, 0, '私聊回数字不该往群里发东西');
  } finally {
    h.app.close();
  }
});

/* ================= 四、分片：世界 seed 全局一个 ================= */

test('M2.4 分片：4 片的世界 seed 完全相同，只有玩家行为 seed 按片派生', () => {
  const plans = planShards({
    shards: 4,
    players: 200,
    days: 14,
    seed: 'vplayer-m24',
    worldSeed: 'world:m24',
    out: 'data/vplayer-shards',
  });
  assert.equal(plans.length, 4);
  assert.deepEqual(
    plans.map((plan) => plan.seed),
    ['vplayer-m24:shard:0', 'vplayer-m24:shard:1', 'vplayer-m24:shard:2', 'vplayer-m24:shard:3'],
    '玩家行为 seed 按片派生',
  );
  assert.deepEqual(
    plans.map((plan) => plan.worldSeed),
    ['world:m24', 'world:m24', 'world:m24', 'world:m24'],
    '世界 seed 全局一个，不随分片派生（M2.4 前置项）',
  );

  // CLI 参数里必须显式带上世界 seed：不靠「碰巧继承到同样的 shell 环境」
  for (const plan of plans) {
    const args = shardArgs(plan);
    assert.equal(args[args.indexOf('--world-seed') + 1], 'world:m24');
  }
  // 不给 --world-seed 时回落到 'world'（与服务端 loadConfig 的默认值同一口径）
  const fallback = planShards({ shards: 2, players: 10, days: 1, seed: 's', out: 'o' });
  assert.deepEqual(fallback.map((plan) => plan.worldSeed), ['world', 'world']);
});

test('M2.4 分片实测：4 片用不同节奏推进同样的小时 → 世界事件逐条一致', async () => {
  // 4 个独立 harness = 4 个独立进程 / 独立 SQLite 的等价物。
  // 「不同节奏」= 每片在自己的小时格子里挑不同分钟发指令 ——
  // 这正是分片跑的真实情形（每片的玩家不同、动作时刻不同），
  // 而世界事件只由 (世界 seed, 小时) 决定，所以 4 片必须看到同一串。
  const harnesses = [0, 1, 2, 3].map(() => createHarness());
  try {
    // 4 片覆盖**同一批小时**（分片跑的真实情形：同一个 baseEpoch、同一天数），
    // 但各自在小时格里的落点不同（第 0 片整点、第 3 片整点后 3 分钟）——
    // 世界事件只由 (世界 seed, 小时) 决定，所以这 4 串必须一模一样。
    const bases = harnesses.map((h) => h.now());
    for (let shard = 0; shard < harnesses.length; shard += 1) {
      const h = harnesses[shard]!;
      await h.createCharacter(`2000${shard}`, `分片${shard}`);
      await advanceIntoEvents(h, {
        userId: `2000${shard}`,
        at: (hour) => bases[shard]! + hour * 3_600_000 + shard * 60_000,
      });
    }

    const sequences = harnesses.map((h) => h.repos.worldEvents.all().map((event) => event.id));
    assert.ok(sequences[0]!.length > 0, '至少要有一条事件，否则这条测试什么都没验');
    for (let shard = 1; shard < sequences.length; shard += 1) {
      assert.deepEqual(
        sequences[shard],
        sequences[0],
        `第 ${shard} 片看到的世界事件与第 0 片不同 —— 世界 seed 没全局化，或生成器读了玩家状态`,
      );
    }
  } finally {
    for (const h of harnesses) h.app.close();
  }
});

test('M2.4 分片：合并脚本按世界 seed + 事件摘要判定一致性（不一致必须报出来）', () => {
  const base = (index: number, worldSeed: string, ids: string[]): ShardJson =>
    ({
      schema: SHARD_SCHEMA,
      shard: index,
      shards: 2,
      seed: `s:shard:${index}`,
      worldSeed,
      worldEvents: worldEventEvidenceOf(ids.map((id) => ({ id }) as WorldEvent)),
      players: 1,
      days: 1,
      baseEpoch: 0,
      startedAt: '2026-01-01T00:00:00.000Z',
      costMs: 1,
      stage: 'M2.4',
      analysis: {} as ShardJson['analysis'],
      coverage: {} as ShardJson['coverage'],
      anomalies: [],
      profileSummary: [],
      cards: [],
      values: { dig: [], mad: [], cor: [], hp: [] },
      personaPlayers: {},
      lostControl: 0,
      characters: 0,
      rejectedActions: 0,
      thresholds: { minCommandCount: 1, minPromotions: 1 },
      // M2.7：这条用例只关心世界事件的合并口径，地理统计给空值即可
      geo: {
        birthCities: {},
        travelsStarted: 0,
        travelsArrived: 0,
        travelsOngoing: 0,
        travelEvents: {},
        travelChoices: {},
        travelPenny: 0,
      },
    }) as ShardJson;

  const agreed = worldConsistencyOf([
    base(0, 'world', ['rumor:1:0', 'rumor:1:1']),
    base(1, 'world', ['rumor:1:0', 'rumor:1:1']),
  ]);
  assert.equal(agreed.worldSeedAgreed, true);
  assert.equal(agreed.idsAgreed, true);
  assert.equal(agreed.digestAgreed, true);
  assert.equal(agreed.identical, true);
  assert.deepEqual(agreed.sharedIds, ['rumor:1:0', 'rumor:1:1']);

  // 世界 seed 被分片派生 → 不一致
  const drifted = worldConsistencyOf([
    base(0, 'world', ['rumor:1:0']),
    base(1, 'world:shard:1', ['rumor:1:0', 'rumor:1:1']),
  ]);
  assert.equal(drifted.worldSeedAgreed, false);
  assert.equal(drifted.identical, false);
  assert.deepEqual(drifted.diffSample, ['rumor:1:1']);
});

/* ================================================================== *
 * M2.86：群的登记（世界播报的送达范围）
 * ================================================================== */

test('M2.86：群里**闲聊**也要登记这个群（否则世界播报推不到它）', async () => {
  /*
   * 用户实测：「主动推送不是所有群都会推送，他只推送了一个群」。
   *
   * 根因：群登记原来写在 `if (!parsed) return []` **之后** —— 而群里有人闲聊时
   * （不是指令、不是数字、不在待命状态）那条消息在解析阶段就被丢掉了，
   * 登记根本执行不到。于是群列表里只留得下「有人跟机器人玩过」的群。
   *
   * 「见过这个群」的判据本来就该是**收到过它的消息**，与那条消息是不是指令无关。
   * 这条用例守住的就是这件事 —— 下次谁再把登记挪到解析之后，它会红。
   */
  const h = createHarness();
  try {
    await h.createCharacter(DEFAULT_USER, '看客');
    const world = h.app.router.deps.world;
    const before = world.groups().length;

    // 一条与机器人完全无关的闲聊
    await h.send({ rawText: '今天天气不错', scene: 'group', groupId: GROUP_ID, userId: DEFAULT_USER });

    assert.ok(
      world.groups().includes(GROUP_ID),
      '闲聊之后这个群必须被登记（世界播报要推给它）',
    );
    assert.equal(world.groups().length, before + 1, '而且只多出这一个群');

    // 再闲聊一次：不该重复登记
    await h.send({ rawText: '你们聊什么呢', scene: 'group', groupId: GROUP_ID, userId: DEFAULT_USER });
    assert.equal(world.groups().length, before + 1, '同一个群不会重复登记');
  } finally {
    h.app.close();
  }
});
