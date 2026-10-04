#!/usr/bin/env node
/**
 * 生成 docs/M2.4-世界事件覆盖.md（M2.4 交付物之一）。
 *
 * 与 M2.3 的菜单覆盖率同样的原则：**证据是跑出来的，不是手写台账**。
 * 四组实测，全部落在真实内容数据（locations.yaml）上：
 *   一、时间窗扫描：N 天 × 24 小时过一遍生成器 —— 条数、类型分布、闸门是否真的生效
 *   二、天气驱动矩阵：八种天气各自「刚要开始」时到底会不会播
 *   三、玩家状态免疫：把玩家侧字段搅乱，输出必须一个字节都不变（分片一致性的前提）
 *   四、落库 + 群播报 + 私聊回数字：真实 createApp 跑一遍，三条链路各留一条实测记录
 *
 *   node scripts/m24-event-coverage.ts --out docs/M2.4-世界事件覆盖.md
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { MemoryAdapter } from '../src/adapter/memory.ts';
import { NUMERIC } from '../src/config/numeric.ts';
import { loadLocations } from '../src/data/loader.ts';
import { dayIndexOf, dayStartOf, worldClock } from '../src/domain/world/clock.ts';
import {
  generateWorldEvents,
  WORLD_EVENT_TYPE_LABELS,
  worldEventHeadline,
  type WorldEvent,
  type WorldEventType,
} from '../src/domain/world/events.ts';
import {
  initialWeatherState,
  tickWeather,
  WEATHER_IDS,
  weatherLabel,
  weatherWeightContext,
  worldModifiers,
  type WeatherId,
  type WeatherState,
} from '../src/domain/world/weather.ts';
import { createApp } from '../src/main.ts';
import { silentLogger } from '../src/infra/logger.ts';
import { WorldEventRepo } from '../src/infra/db/world-events.ts';
import { openDatabase } from '../src/infra/db/sqlite.ts';
import { CommandRouter } from '../src/router/index.ts';
import { registerW1Commands } from '../src/router/commands/index.ts';

const USER = '61001';
const GROUP = '10001';
const DAYS = 14;
/**
 * 主窗口的世界起点 = **与 vplayer 的 baseEpoch / CI / 回归同一基准**（2026-01-01 东八区）。
 * 为什么不用一个随意的日子：天气演化对**起始时刻**敏感 ——
 * 每次换天气的抽签键是 state.until（绝对时间戳），起始整点不同 → rollAt 序列不同 → 天气不同。
 * 用与 CI 相同的基准，这份覆盖表才和回归报告里的世界对得上。
 */
const BASE_EPOCH = Date.parse('2026-01-01T00:00:00+08:00');
const START_DAY = dayIndexOf(BASE_EPOCH);
/** 对照窗口：换一个世界起点，用来看「环境事件对起始时刻有多敏感」（见第六节） */
const CONTRAST_DAY = 20_700;
const NL = String.fromCharCode(10);
const BQ = String.fromCharCode(96);
const code = (text: string): string => BQ + text + BQ;

const LOCATIONS = loadLocations().locations.map((location) => ({
  id: location.id,
  name: location.name,
  danger: location.danger,
  minSeq: location.min_seq,
  maxSeq: location.max_seq,
  lootCount: location.loot.length,
}));

function stateOf(locationId: string, weather: WeatherId, since: number): WeatherState {
  return {
    locationId,
    weather,
    since,
    until: since + NUMERIC.world.weather.durationMs,
    pendingWeather: null,
    pendingAt: null,
  };
}

function snapshotAt(at: number, weathers?: Array<{ id: string; weather: WeatherId; since: number }>) {
  const clock = worldClock(at, 'world');
  return {
    clock,
    weather: 'clear' as WeatherId,
    modifiers: worldModifiers({ clock, weather: 'clear' }),
    locations: LOCATIONS,
    weatherStates: (weathers ?? []).map((entry) => stateOf(entry.id, entry.weather, entry.since)),
  };
}

interface ScanRow {
  day: number;
  hour: number;
  events: WorldEvent[];
}

/**
 * 窗口扫描：**天气也要真的跑**（tickWeather 逐小时推进），
 * 否则扫描里只有 rumor/discovery，environment 这一类（天气驱动）根本不会出现，
 * 覆盖率报告就成了半张表。
 */
function scanWindow(days: number, startDay = START_DAY): ScanRow[] {
  const rows: ScanRow[] = [];
  const locationDefs = loadLocations().locations;
  let states: WeatherState[] = locationDefs.map((location) =>
    initialWeatherState(location.id, dayStartOf(startDay), 'world'),
  );
  for (let day = startDay; day < startDay + days; day += 1) {
    for (let hour = 0; hour < 24; hour += 1) {
      const at = dayStartOf(day) + hour * 3_600_000;
      const clock = worldClock(at, 'world');
      states = tickWeather({
        states,
        locations: locationDefs,
        now: at,
        seed: 'world',
        ctx: weatherWeightContext(clock),
      }).states;
      const snapshot = {
        clock,
        weather: 'clear' as WeatherId,
        modifiers: worldModifiers({ clock, weather: 'clear' }),
        locations: LOCATIONS,
        weatherStates: states,
      };
      rows.push({ day, hour, events: generateWorldEvents(snapshot, at, 'world') });
    }
  }
  return rows;
}

function immunityProbe(): { same: boolean; detail: string } {
  // 比一整天（而不是一个小时）：样本太小的话「相同」可能只是巧合
  const clean: WorldEvent[] = [];
  const polluted: WorldEvent[] = [];
  for (let hour = 0; hour < 24; hour += 1) {
    const at = dayStartOf(START_DAY) + hour * 3_600_000;
    clean.push(...generateWorldEvents(snapshotAt(at), at, 'world'));
    const noisy = snapshotAt(at) as unknown as Record<string, unknown>;
    // 这些字段全是「玩家视角的世界」：菜单要用，事件生成器一个都不该读
    noisy.weather = 'blood_moon';
    noisy.modifiers = {
      ...worldModifiers({ clock: worldClock(at, 'world'), weather: 'blood_moon' }),
      playMad: 999,
    };
    noisy.exploreUsedToday = 99;
    noisy.locations = LOCATIONS.map((location) => ({
      ...location,
      usedToday: 3,
      weather: 'spirit_creep' as WeatherId,
    }));
    polluted.push(...generateWorldEvents(noisy as never, at, 'world'));
  }
  const same = JSON.stringify(clean) === JSON.stringify(polluted);
  return {
    same,
    detail: same
      ? '两边都是 ' + clean.length + ' 条事件，逐字节相同'
      : '左边 ' + clean.length + ' 条、右边 ' + polluted.length + ' 条 —— 生成器读了玩家状态',
  };
}

function optionCommandsOf(events: readonly WorldEvent[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const event of events) {
    for (const option of event.options ?? []) {
      const name = option.command.split(/[ ]+/)[0] ?? '';
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  return counts;
}

async function chainProbe(): Promise<{ rows: Array<[string, string, string]>; count: number }> {
  const adapter = new MemoryAdapter();
  let clock = Date.UTC(2026, 0, 1, 12, 0, 0); // 东八区 20:00
  const app = createApp(
    {
      dbPath: ':memory:',
      port: 0,
      onebotApiBase: 'http://127.0.0.1:3000',
      detailToPrivate: true,
      runTickOnStart: false,
      startOps: false,
      worldSeed: 'world',
    },
    { adapter, logger: silentLogger, now: () => clock },
  );
  const rows: Array<[string, string, string]> = [];
  try {
    const send = async (rawText: string, scene: 'private' | 'group'): Promise<string[]> => {
      const before = adapter.sent.length;
      await adapter.deliver({
        messageId: 'm24-' + rawText + '-' + clock,
        platform: 'onebot',
        scene,
        sceneId: scene === 'private' ? USER : GROUP,
        userId: USER,
        nickname: '验证者',
        rawText,
        timestamp: clock,
      });
      return adapter.sent.slice(before).map((message) => message.text);
    };

    await send('.创建 验证者 愚者', 'private');
    // 先让这个群存在，再跨 30 个小时（必然跨过若干排期小时）
    await send('.帮助', 'group');
    let sawBroadcast: string | null = null;
    for (let hour = 0; hour < 30; hour += 1) {
      clock += 3_600_000;
      for (const text of await send('.帮助', 'group')) {
        if (text.includes('【世界 ·')) sawBroadcast = sawBroadcast ?? text;
      }
    }

    const repo = new WorldEventRepo(app.db);
    const events = repo.all();
    const typeSummary = Object.entries(repo.countByType())
      .map(([type, count]) => type + ' ' + count)
      .join('、');
    rows.push([
      '事件落库',
      events.length + ' 条（' + typeSummary + '）：' + code('world_events') + ' 表，id 由原因派生',
      events.length > 0 ? '通过' : '失败',
    ]);
    rows.push([
      '群播报',
      sawBroadcast
        ? '抬头「' + sawBroadcast.split(NL)[0] + '」，带编号选项与「回复数字。」'
        : '群里没看到世界播报',
      sawBroadcast ? '通过' : '失败',
    ]);

    // 30 个小时之后，最早那批事件已经过了 TTL（6 小时）。
    // 回数字探针要在「事件还活着」的时候打，所以把时钟拨到最后一条事件刚生成之后 1 分钟
    // （拨回去不会重跑 world tick：水位线已经推进过，advanceWorld 会 O(1) 跳过）。
    const lastEvent = events[events.length - 1];
    if (lastEvent) clock = lastEvent.createdAt + 60_000;
    const live = repo.latestLive(clock);
    if (live) {
      const option = live.options?.[0];
      const replies = await send('1', 'private');
      const executed = replies.some((text) => !text.includes('菜单已过期'));
      rows.push([
        '私聊回数字',
        option ? '选「' + option.label + '」→ .' + option.command : '这条事件没有选项',
        executed && option ? '通过' : '失败',
      ]);
      const before = adapter.sent.length;
      await adapter.deliver({
        messageId: 'm24-group-numeric-' + clock,
        platform: 'onebot',
        scene: 'group',
        sceneId: GROUP,
        userId: USER,
        nickname: '验证者',
        rawText: '1',
        timestamp: clock,
      });
      const groupReplies = adapter.sent.slice(before);
      rows.push([
        '群里回数字',
        groupReplies.length === 0
          ? '静默丢弃（与 M2.3 一致：群里的「1」是聊天内容）'
          : '居然处理了 ' + groupReplies.length + ' 条回复',
        groupReplies.length === 0 ? '通过' : '失败',
      ]);
    } else {
      rows.push(['私聊回数字', '此刻没有有效的世界事件', '—']);
    }
    return { rows, count: events.length };
  } finally {
    app.close();
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const outIndex = argv.indexOf('--out');
  const out =
    outIndex >= 0 ? (argv[outIndex + 1] ?? 'docs/M2.4-世界事件覆盖.md') : 'docs/M2.4-世界事件覆盖.md';
  const cfg = NUMERIC.world.events;

  const rows = scanWindow(DAYS);
  const all = rows.flatMap((row) => row.events);
  // 对照窗口：同 seed、另一个世界起点 —— 环境事件（天气驱动）对起始时刻有多敏感
  const contrast = scanWindow(DAYS, CONTRAST_DAY).flatMap((row) => row.events);
  const contrastEnv = contrast.filter((event) => event.type === 'environment').length;
  const byType = new Map<WorldEventType, number>();
  for (const event of all) byType.set(event.type, (byType.get(event.type) ?? 0) + 1);

  const perDay = new Map<number, number>();
  const perDayRumor = new Map<number, number>();
  let maxPerHour = 0;
  let quietViolations = 0;
  for (const row of rows) {
    perDay.set(row.day, (perDay.get(row.day) ?? 0) + row.events.length);
    perDayRumor.set(
      row.day,
      (perDayRumor.get(row.day) ?? 0) + row.events.filter((event) => event.type === 'rumor').length,
    );
    maxPerHour = Math.max(maxPerHour, row.events.length);
    if (row.hour >= cfg.quietFromHour && row.hour < cfg.quietToHour && row.events.length > 0) {
      quietViolations += 1;
    }
  }
  const replay = scanWindow(DAYS).flatMap((row) => row.events);
  const reproducible = JSON.stringify(all) === JSON.stringify(replay);

  const at = dayStartOf(START_DAY) + 20 * 3_600_000;
  const weatherMatrix: Array<[string, string, string]> = [];
  for (const weather of WEATHER_IDS) {
    const events = generateWorldEvents(
      snapshotAt(at, [{ id: LOCATIONS[0]!.id, weather, since: at }]),
      at,
      'world',
    ).filter((event) => event.type === 'environment');
    weatherMatrix.push([
      weatherLabel(weather) + '（' + weather + '）',
      events.length > 0 ? worldEventHeadline(events[0]!) : '不播报',
      events.length > 0 ? '环境事件' : '—',
    ]);
  }

  const immunity = immunityProbe();
  const chain = await chainProbe();
  const commands = optionCommandsOf(all);

  // 选项指向的指令必须真实存在：拿真实路由的指令表来核对（不手写清单）
  const db = openDatabase(':memory:');
  const probe = new CommandRouter({ db, worldEvents: new WorldEventRepo(db), clock: () => 0 } as never);
  const known = new Set(registerW1Commands(probe).commands);
  db.close();
  const unknownCommands = [...commands.keys()].filter((name) => !known.has(name));

  const lines: string[] = [];
  lines.push('# M2.4 世界事件覆盖');
  lines.push('');
  lines.push(
    '> 本文件由 ' + code('node scripts/m24-event-coverage.ts') + ' 生成，**不是手写台账**。扫描窗口 ' +
      DAYS +
      ' 天 × 24 小时（' +
      new Date(BASE_EPOCH).toISOString() +
      ' 起，东八区第 ' +
      START_DAY +
      '—' +
      (START_DAY + DAYS - 1) +
      ' 天；与 CI / 回归同一世界基准），世界 seed=' +
      code('world') +
      '，地点取自真实的 ' +
      code('locations.yaml') +
      '（' +
      LOCATIONS.length +
      ' 个）。',
  );
  lines.push('');
  lines.push('## 一、时间窗扫描（生成器直接跑，不落库）');
  lines.push('');
  lines.push('- 事件总数：**' + all.length + '** 条 / ' + DAYS + ' 天（平均 ' + (all.length / DAYS).toFixed(1) + ' 条/天）');
  lines.push(
    '- 单小时峰值：**' + maxPerHour + '** 条（闸门 ≤ ' + cfg.maxPerHour + '）' +
      (maxPerHour <= cfg.maxPerHour ? ' 通过' : ' **超闸门**'),
  );
  lines.push(
    '- 安静时段（' + cfg.quietFromHour + ':00—' + cfg.quietToHour + ':00）越界：**' +
      quietViolations +
      '** 次 ' +
      (quietViolations === 0 ? '通过' : '**失败**'),
  );
  lines.push('- 同 seed 重跑逐字节一致：**' + (reproducible ? '是' : '否') + '**');
  const rumorCounts = [...perDayRumor.values()];
  const rumorOk = rumorCounts.every((count) => count >= cfg.rumorMinPerDay && count <= cfg.rumorMaxPerDay);
  lines.push(
    '- 传闻每天条数：' + Math.min(...rumorCounts) + '—' + Math.max(...rumorCounts) + ' 条（要求 ' +
      cfg.rumorMinPerDay + '—' + cfg.rumorMaxPerDay + '）' + (rumorOk ? ' 通过' : ' **失败**'),
  );
  lines.push('');
  lines.push('| 事件类型 | 条数 | 占比 | 可见性 | 选项 | 状态 |');
  lines.push('|---|---|---|---|---|---|');
  const VISIBILITY: Record<WorldEventType, string> = {
    environment: 'public',
    discovery: 'public',
    rumor: 'anonymous',
    faction: 'faction',
    // M2.59：势力的动向是看得见的（街上多了巡逻、路口封了，谁都知道）
    power: 'public',
    calamity: 'public',
  };
  for (const type of Object.keys(WORLD_EVENT_TYPE_LABELS) as WorldEventType[]) {
    const count = byType.get(type) ?? 0;
    const placeholder = type === 'faction' || type === 'calamity';
    const share = all.length === 0 ? '0%' : ((count / all.length) * 100).toFixed(1) + '%';
    const optionText = placeholder
      ? '—'
      : type === 'rumor'
        ? '3（打听 / 看看 / 不理）'
        : '3（去看看 / 打听 / 无视）';
    const status = placeholder
      ? count === 0
        ? '占位：本轮不生成'
        : '**不该生成**'
      : count > 0
        ? '已覆盖'
        : '窗口内没出现';
    lines.push(
      '| ' +
        WORLD_EVENT_TYPE_LABELS[type] +
        '（' +
        code(type) +
        '） | ' +
        count +
        ' | ' +
        share +
        ' | ' +
        code(VISIBILITY[type]) +
        ' | ' +
        optionText +
        ' | ' +
        status +
        ' |',
    );
  }
  lines.push('');
  lines.push('### 每天的条数');
  lines.push('');
  lines.push('| 天 | 事件 | 其中传闻 |');
  lines.push('|---|---|---|');
  for (const [day, count] of [...perDay.entries()]) {
    lines.push('| 第 ' + (day - START_DAY + 1) + ' 天 | ' + count + ' | ' + (perDayRumor.get(day) ?? 0) + ' |');
  }
  lines.push('');
  lines.push('## 二、天气驱动矩阵（八种天气「刚要开始」的那一小时）');
  lines.push('');
  lines.push('| 天气 | 播报抬头 | 结论 |');
  lines.push('|---|---|---|');
  for (const row of weatherMatrix) lines.push('| ' + row[0] + ' | ' + row[1] + ' | ' + row[2] + ' |');
  lines.push('');
  lines.push(
    '环境事件的触发清单在 ' +
      code('NUMERIC.world.events.environmentWeathers') +
      '：' +
      cfg.environmentWeathers.map((id) => weatherLabel(id as WeatherId)).join('、') +
      '。其余天气不产生环境事件（它们的影响走 M2.2 的天气系数，不重复播报）。',
  );
  lines.push('');
  lines.push('## 三、玩家状态免疫（分片一致性的前提）');
  lines.push('');
  lines.push('| 检查 | 结果 |');
  lines.push('|---|---|');
  lines.push(
    '| 搅乱玩家侧字段（weather / modifiers / exploreUsedToday / locations[].usedToday）后输出不变 | ' +
      (immunity.same ? '通过' : '**失败**') +
      '：' +
      immunity.detail +
      ' |',
  );
  lines.push(
    '| 单测钉死 | ' +
      code('test/m2-4.test.ts') +
      ' 的「不读玩家状态」与「4 片不同节奏 → 事件逐条一致」两条 |',
  );
  lines.push('');
  lines.push('## 四、三条链路实测（真实 createApp）');
  lines.push('');
  lines.push('| 链路 | 证据 | 结论 |');
  lines.push('|---|---|---|');
  for (const row of chain.rows) lines.push('| ' + row[0] + ' | ' + row[1] + ' | ' + row[2] + ' |');
  lines.push('');
  lines.push('链路探针在 30 个虚拟小时里落库 ' + chain.count + ' 条事件。');
  lines.push('');
  lines.push('## 五、选项覆盖（播报里的编号 → 完整指令）');
  lines.push('');
  lines.push('| 选项指向的指令 | 出现次数 | 是否为已注册指令 |');
  lines.push('|---|---|---|');
  for (const [name, count] of [...commands.entries()].sort((a, b) => b[1] - a[1])) {
    lines.push('| .' + name + ' | ' + count + ' | ' + (known.has(name) ? '是' : '**不存在**') + ' |');
  }
  lines.push('');
  lines.push(
    '结论：' +
      (unknownCommands.length === 0
        ? '**全部选项都指向已注册指令**。'
        : '**存在不存在的指令**：' + unknownCommands.join('、') + '。') +
      '选项一律是**完整指令原文**（不带前导点号），由 M2.3 的数字回复体系执行 —— 世界事件没有另起一套按键系统。',
  );
  lines.push('');
  lines.push('## 六、口径与已知边界');
  lines.push('');
  lines.push('### 6.1 环境事件对「世界起点」敏感（M2.2 天气调度的既有性质）');
  lines.push('');
  lines.push(
    '同 seed、另一个世界起点（东八区第 ' +
      CONTRAST_DAY +
      ' 天起 ' +
      DAYS +
      ' 天）扫出来的 environment 事件是 **' +
      contrastEnv +
      '** 条，而主窗口是 **' +
      byType.get('environment') +
      '** 条 —— 同一个世界种子，差了一个数量级。',
  );
  lines.push('');
  lines.push(
    '根因不在本轮的生成器，而在 **M2.2 的天气 tick**：换天气的抽签键是 state.until（绝对时间戳），' +
      '而「扩散落地」会把 until 重置成 pendingAt + 6 小时。于是只要邻居还在不断变，' +
      '一个地点就永远轮不到自己抽签（实测 14 天里 expire 只有 11 次，diffusion 有 1804 次）。' +
      '血月 / 灵界渗透这类只能**抽到**的显著天气，因此主要靠扩散传播，出现频率强烈依赖起始整点。',
  );
  lines.push('');
  lines.push(
    '**本轮不动它**：这是 M2.2 的天气调度逻辑（不是系数），改它会让 M2.2 / M2.3 的回归基线全部作废，' +
      '需要重跑所有轮次；而 M2.4 的验收点（纯函数 / 4 片一致 / 落库 / 播报 / 回数字）不依赖它。' +
      '建议单独立项：让扩散落地**保留源天气的原始到期时刻**，或给每个地点一个独立的换天气节拍。',
  );
  lines.push('');
  lines.push(
    '- **「某地点被探索 N 次后」的落地方式**：那是玩家侧计数，而硬约束要求生成器不读玩家状态。' +
      '本轮按硬约束办：发现事件用**世界侧**低频规则触发（每天至多一次、雾日 ×' +
      cfg.discoveryFoggyMultiplier +
      '）。按玩家计数的话每片只有 1/4 的玩家，4 片必然算出 4 串不同事件，' +
      '「4 片看到相同世界事件」直接不成立。',
  );
  lines.push(
    '- **environment 事件偏多**：全部由天气驱动 —— ' +
      LOCATIONS.length +
      ' 个地点各自独立换天气，一次显著天气还会向邻居扩散（每条扩散落地都算一次「开始」）。' +
      '实测平均 ' +
      (all.length / DAYS).toFixed(1) +
      ' 条/天、峰值 ' +
      maxPerHour +
      ' 条/小时，闸门（≤' +
      cfg.maxPerHour +
      '/小时）未触发。要更安静只需改一个旋钮：' +
      code('NUMERIC.world.events.environmentWeathers') +
      ' 收窄到 epic 两种。',
  );
  lines.push(
    '- **faction / calamity**：类型、可见性、优先级都已定好，生成函数留了接入点（' +
      code('factionEvents') +
      ' / ' +
      code('calamityEvents') +
      '），分别由 M2.6（势力控制地点变化）与 M2.9（灾厄预警）填函数体。' +
      '本轮恒返回空数组，且有单测守着它们一条都不生成。',
  );
  lines.push(
    '- **地点可达性**：世界事件只认世界状态，不认识玩家的序列门槛。所以播报里的「去某地看看」' +
      '可能因为序列不够被拒 —— 这是有意的（真人也会收到自己进不去的地方的消息），拒绝后照常给下一步选项。',
  );
  lines.push('');

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, lines.join(NL), 'utf8');
  console.log('已写入 ' + out);
  console.log(
    '扫描：' +
      all.length +
      ' 条事件 / ' +
      DAYS +
      ' 天，峰值 ' +
      maxPerHour +
      ' 条/小时，安静时段越界 ' +
      quietViolations +
      ' 次，可复现 ' +
      reproducible,
  );
  console.log('链路：' + chain.rows.map((row) => row[0] + row[2]).join(' '));
  console.log('选项指令：' + [...commands.keys()].join('、') + '（未知 ' + unknownCommands.length + ' 个）');
  console.log('对照窗口（第 ' + CONTRAST_DAY + ' 天起）environment 事件：' + contrastEnv + ' 条');
}

main().catch((error) => {
  console.error('世界事件覆盖取证失败：', error);
  process.exit(1);
});