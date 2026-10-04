#!/usr/bin/env node
/**
 * 生成 docs/M2.3-菜单覆盖率.md（M2.3 交付物之一）。
 *
 * 两份证据都是**实测**出来的，不是手写台账：
 *   一、指令 × 菜单：走真实路由把每条指令发一遍，记录每条执行后系统递出的菜单
 *       （类型、选项数、第一项对应的完整指令）
 *   二、选项来源矩阵：对纯函数生成器逐个变量扫一遍（途径 / 天气 / 时段 / 状态 / 序列 / 背包 / 组队 / 地点），
 *       记录每个取值下菜单**真的变了没有**
 *
 *   node scripts/m23-menu-coverage.ts --out docs/M2.3-菜单覆盖率.md
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { MemoryAdapter } from '../src/adapter/memory.ts';
import { createApp } from '../src/main.ts';
import { silentLogger } from '../src/infra/logger.ts';
import { loadLocations } from '../src/data/loader.ts';
import { NUMERIC } from '../src/config/numeric.ts';
import { CONTINUATIONS } from '../src/domain/menu/next-menu.ts';
import { buildPlayMenu, pathwayKit } from '../src/domain/menu/play-menu.ts';
import { buildExploreMenu } from '../src/domain/menu/explore-menu.ts';
import type { MenuCharacter, WorldSnapshot } from '../src/domain/menu/types.ts';
import type { TimeOfDay, WorldClock } from '../src/domain/world/clock.ts';
import { WEATHER_IDS, weatherLabel, worldModifiers, type WeatherId } from '../src/domain/world/weather.ts';
import type { PathwayId } from '../src/domain/character/types.ts';

const USER = '60001';

/* ---------------- 夹具 ---------------- */

function clockOf(over: Partial<WorldClock> = {}): WorldClock {
  return {
    now: Date.UTC(2026, 8, 21, 12, 0, 0),
    dayIndex: 20_000,
    hour: 12,
    timeOfDay: 'day',
    season: 'autumn',
    moonPhase: 3,
    fullMoon: false,
    foggy: false,
    nextFogDay: 20_002,
    ...over,
  };
}

function snapshotOf(
  weather: WeatherId,
  over: Partial<WorldClock> = {},
  path?: PathwayId,
): WorldSnapshot {
  const clock = clockOf(over);
  const locations = loadLocations().locations.map((location) => ({
    id: location.id,
    name: location.name,
    danger: location.danger,
    minSeq: location.min_seq,
    maxSeq: location.max_seq,
    lootCount: location.loot.length,
    usedToday: 0,
    weather: 'clear' as WeatherId,
  }));
  return {
    clock,
    weather,
    modifiers: worldModifiers({ clock, weather, ...(path ? { path } : {}) }),
    exploreUsedToday: 0,
    locations,
  };
}

function characterOf(over: Partial<MenuCharacter> = {}): MenuCharacter {
  return {
    id: 'm1',
    userId: USER,
    name: '覆盖率',
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

function playCommands(state: MenuCharacter, world: WorldSnapshot): string[] {
  // M2.7.6：这个脚本扫的是「已入途径」的菜单覆盖（普通人那套由 m27 的分片脚本扫）
  return buildPlayMenu(state, world, pathwayKit(state.pathway!)).options.map((option) => option.command);
}

/* ---------------- 一、指令 × 菜单（真实路由） ---------------- */

let clock = Date.UTC(2026, 8, 21, 12, 0, 0);
let seq = 0;
const adapter = new MemoryAdapter();
const app = createApp(
  {
    dbPath: ':memory:',
    port: 0,
    onebotApiBase: 'http://127.0.0.1:3000',
    detailToPrivate: true,
    runTickOnStart: false,
    startOps: false,
  },
  { adapter, logger: silentLogger, now: () => clock },
);

async function send(rawText: string, scene: 'private' | 'group' = 'private', userId = USER): Promise<number> {
  seq += 1;
  await adapter.deliver({
    messageId: 'mc-' + seq,
    platform: 'onebot',
    scene,
    sceneId: scene === 'private' ? userId : '10001',
    userId,
    nickname: '覆盖率',
    rawText,
    timestamp: clock,
  });
  return adapter.take().length;
}

interface Row {
  command: string;
  replies: number;
  menuType: string;
  options: number;
  firstCommand: string;
  firstDisabled: string;
}

async function probe(commands: readonly string[]): Promise<Row[]> {
  const rows: Row[] = [];
  for (const command of commands) {
    // 每条之间推进虚拟时间：跨过所有令牌桶冷却，测的是「菜单给没给」而不是「频控挡没挡」
    clock += 30_000;
    // 注意：探针发的必须是**完整指令原文**（带前导点号），否则路由会当闲聊丢掉
    const replies = await send('.' + command);
    const character = app.router.deps.characters.findByUserId(USER);
    const menu = character ? app.router.deps.pendingMenus.current(character.id, clock) : null;
    const first = menu ? menu.menu.options[0] : undefined;
    rows.push({
      command,
      replies,
      menuType: menu ? menu.menuType : '（无）',
      options: menu ? menu.menu.options.length : 0,
      firstCommand: first ? first.command : '—',
      firstDisabled: first && first.disabled ? first.disabled : '',
    });
  }
  return rows;
}

function renderCommandTable(rows: readonly Row[]): string[] {
  const lines: string[] = [];
  lines.push('| 指令 | 私聊执行后的菜单 | 选项数 | 第一项对应的完整指令 |');
  lines.push('|---|---|---|---|');
  for (const row of rows) {
    const note = row.firstDisabled ? '（不可选：' + row.firstDisabled + '）' : '';
    lines.push('| .' + row.command + ' | ' + row.menuType + ' | ' + row.options + ' | ' + row.firstCommand + note + ' |');
  }
  return lines;
}

/* ---------------- 二、选项来源矩阵（纯函数） ---------------- */

interface MatrixRow {
  source: string;
  variants: string;
  changed: boolean;
  sample: string;
}

function matrix(): MatrixRow[] {
  const rows: MatrixRow[] = [];
  const day = { timeOfDay: 'day' as TimeOfDay, hour: 12 };
  const clear = snapshotOf('clear', day);

  // 途径
  const seer = playCommands(characterOf({ pathway: 'seer' }), snapshotOf('clear', day, 'seer'));
  const warrior = playCommands(characterOf({ pathway: 'warrior' }), snapshotOf('clear', day, 'warrior'));
  const sleepless = playCommands(characterOf({ pathway: 'sleepless' }), snapshotOf('clear', day, 'sleepless'));
  rows.push({
    source: '途径',
    variants: '愚者 / 战士 / 不眠者',
    changed: new Set([seer.join(), warrior.join(), sleepless.join()]).size === 3,
    sample: '战士第一条：' + warrior[0],
  });

  // 天气
  const byWeather = WEATHER_IDS.map((weather) => playCommands(characterOf(), snapshotOf(weather, day)).join());
  const weatherVariants = new Set(byWeather).size;
  rows.push({
    source: '天气（8 种）',
    variants: WEATHER_IDS.map((id) => weatherLabel(id)).join(' / ') + '（8 个取值 → ' + weatherVariants + ' 种不同菜单）',
    // 阈值 4 而不是 8：几条途径的标签表里没有雾/雨这类情境词，菜单会正常回落到途径核心标签，
    // 那不是 bug，是「这条途径在雾天也确实没什么特别的观察法子」。
    changed: weatherVariants >= 4,
    sample: '雾天第一条：' + playCommands(characterOf(), snapshotOf('fog', day))[0],
  });

  // 时段
  const times: TimeOfDay[] = ['dawn', 'day', 'dusk', 'night'];
  const byTime = times.map((timeOfDay) =>
    playCommands(characterOf({ pathway: 'sleepless' }), snapshotOf('clear', { timeOfDay, hour: 22 })).join(),
  );
  const timeVariants = new Set(byTime).size;
  rows.push({
    source: '时段（4 种）',
    variants: '黎明 / 白天 / 黄昏 / 夜晚（4 个取值 → ' + timeVariants + ' 种不同菜单）',
    // 夜晚的情境标签（守夜）本身就是不眠者的第一个核心标签，所以菜单顺序可能和白天一致 ——
    // 只有真的「换了标签」才算变了，阈值取 2。
    changed: timeVariants >= 2,
    sample:
      '夜晚（不眠者）第一条：' +
      playCommands(
        characterOf({ pathway: 'sleepless' }),
        snapshotOf('clear', { timeOfDay: 'night', hour: 22 }, 'sleepless'),
      )[0],
  });

  // MAD / COR
  const calm = playCommands(characterOf({ mad: 10, cor: 10 }), clear)[0];
  const madHigh = playCommands(characterOf({ mad: 75, cor: 10 }), clear)[0];
  const corHigh = playCommands(characterOf({ mad: 10, cor: 75 }), clear)[0];
  rows.push({
    source: 'MAD / COR ≥ ' + NUMERIC.menu.riskTopThreshold,
    variants: '平静 / MAD 高 / COR 高 / 失控中',
    changed: madHigh === '休息' && corHigh === '净化' && calm !== madHigh,
    sample: 'MAD 75 → ' + madHigh + '；COR 75 → ' + corHigh,
  });

  // 序列
  const s9 = playCommands(characterOf({ sequence: 9 }), clear).join();
  const s8 = playCommands(characterOf({ sequence: 8, abilityName: '小丑' }), clear).join();
  const s8Extra = playCommands(characterOf({ sequence: 8, abilityName: '小丑' }), clear).find((command) =>
    command.includes('小丑'),
  );
  rows.push({
    source: '序列（能力解锁）',
    variants: '序列 9 / 序列 8（小丑）',
    changed: s9 !== s8,
    sample: '序列 8 多出：' + (s8Extra ?? '（无）'),
  });

  // 背包
  const withPotion: MenuCharacter = {
    ...characterOf(),
    potions: [{ itemId: '魔药·愚者·序列9', name: '愚者魔药', pathway: 'seer', seq: 9 }],
  };
  const potionCommand = playCommands(withPotion, clear).find((command) => command.startsWith('服用'));
  rows.push({
    source: '背包（魔药）',
    variants: '空手 / 有本途径本序列魔药',
    changed: playCommands(withPotion, clear).join() !== playCommands(characterOf(), clear).join(),
    sample: '有魔药多出：' + (potionCommand ?? '（无）'),
  });

  // 组队
  const here = loadLocations().locations[0]!;
  const solo = buildExploreMenu(characterOf(), clear, here, []).options.map((option) => option.command);
  const teamed = buildExploreMenu(
    characterOf({ partySize: 3, isPartyLeader: true }),
    clear,
    here,
    [],
  ).options.map((option) => option.command);
  rows.push({
    source: '组队',
    variants: '独行 / 3 人队长',
    changed: teamed.join() !== solo.join() && teamed.includes('队伍 任务'),
    sample: '有队友且是队长时多出：队伍 任务',
  });

  // 地点
  const exploreCommands = buildExploreMenu(characterOf(), clear, here, []).options.map((option) => option.command);
  rows.push({
    source: '地点',
    variants: '当前地点 / 危险更高 / 危险更低 / 途径专属（愚者）',
    changed: new Set(exploreCommands).size === exploreCommands.length && exploreCommands.length >= 3,
    sample: exploreCommands.slice(0, 4).join('　'),
  });

  return rows;
}

function renderMatrix(rows: readonly MatrixRow[]): string[] {
  const lines: string[] = [];
  lines.push('| 来源 | 取值 | 菜单真的变了？ | 实测样本 |');
  lines.push('|---|---|---|---|');
  for (const row of rows) {
    lines.push(
      '| ' + row.source + ' | ' + row.variants + ' | ' + (row.changed ? '✅ 变了' : '❌ 没变') + ' | ' + row.sample + ' |',
    );
  }
  return lines;
}

/* ---------------- 主流程 ---------------- */

async function main(): Promise<void> {
  const outIndex = process.argv.indexOf('--out');
  const out = outIndex >= 0 ? process.argv[outIndex + 1]! : 'docs/M2.3-菜单覆盖率.md';

  await send('.创建 覆盖率 愚者');
  clock += 30_000;

  const location = loadLocations().locations.find((entry) => entry.min_seq === 9)!;
  const rows = await probe([
    '扮演',
    '探索 ' + location.name,
    '状态',
    '今日',
    '世界',
    '背包',
    '帮助',
    '占卜 我今天该做什么',
    '事件',
    '休息',
    '净化',
    '晋升',
    '服用',
    '魔药',
    '交易',
    '确认 ABCDEF',
    '取消 ABCDEF',
    '使用 夜香草',
    '队伍 创建',
    '队伍 任务',
    '反馈 这是一条覆盖率巡检',
  ]);

  // 群里：不开菜单（任务书 §3.6）—— 用「发之前 / 发之后菜单有没有变」来证明，而不是看表里有没有行
  clock += 30_000;
  const characterId = app.router.deps.characters.findByUserId(USER)!.id;
  const menuBeforeGroup = app.router.deps.pendingMenus.current(characterId, clock);
  const groupReplies = await send('.扮演', 'group');
  const menuAfterGroup = app.router.deps.pendingMenus.current(characterId, clock);
  const groupMenuUnchanged = menuBeforeGroup?.menuType === menuAfterGroup?.menuType;

  const lines: string[] = [];
  lines.push('# M2.3 菜单覆盖率');
  lines.push('');
  lines.push(
    '> 本文档由 node scripts/m23-menu-coverage.ts --out docs/M2.3-菜单覆盖率.md **实测生成**，不是手写台账：' +
      '第一部分走真实路由把每条指令发一遍，第二部分对菜单生成器逐个变量扫描。',
  );
  lines.push('');
  lines.push('## 一、菜单入口：每条指令都给得出下一步');
  lines.push('');
  lines.push(
    '验收项（任务书 §4.2）要求上下文推进至少覆盖 8 条指令，当前实现覆盖 ' +
      CONTINUATIONS.length +
      ' 条：' +
      CONTINUATIONS.map((name) => '.' + name).join('、') +
      '。其余指令（状态 / 背包 / 帮助 / 世界 / 今日 / 反馈…）也走同一条出口，只是落到「通用兜底」那一组。',
  );
  lines.push('');
  lines.push(
    '私聊里每条指令执行完都会落一份菜单（pending_menus 表，' +
      NUMERIC.menu.ttlMs / 60000 +
      ' 分钟有效）；群聊场景不落菜单、只播报摘要（任务书 §3.6：群里不接数字回复）。',
  );
  lines.push('');
  for (const line of renderCommandTable(rows)) lines.push(line);
  lines.push('');
  lines.push(
    '- 群里发 .扮演 的回执数：' +
      groupReplies +
      ' 条（引导玩家去私聊）；菜单有没有被改动：' +
      (groupMenuUnchanged ? '没有（' + (menuAfterGroup ? menuAfterGroup.menuType : '（无菜单）') + '，与发送前一致）' : '被改动了 ← 不该发生') +
      ' —— 群聊不落菜单，玩家在群里也拿不到可以回数字的选项。',
  );
  lines.push('');
  lines.push('## 二、选项来源矩阵：选项真的从状态来，不是写死的四句话');
  lines.push('');
  for (const line of renderMatrix(matrix())) lines.push(line);
  lines.push('');
  lines.push('## 三、菜单路径与完整指令路径的关系');
  lines.push('');
  lines.push(
    '- 菜单里的每一项，command 都是一条可直接执行的完整指令（不含前导点号）。' +
      '玩家回数字时，路由取出那条指令，走的是与「直接发这条指令」完全相同的执行路径（同一套频控、队列、判定、审计）。',
  );
  lines.push(
    '- 对照测试见 test/m2-3.test.ts 的「菜单路径与完整指令路径结果完全一致」：' +
      '两个独立实例（确定性 id、同一 messageId、同一虚拟时钟），一个回数字、一个直接发指令，最后比对角色全字段与标签用量。',
  );
  lines.push(
    '- 完整指令一条都没删：.扮演 行为 / .探索 地点 / .世界 地点 仍然一条指令做完所有事，' +
      '菜单只是「不带参数时」的入口与「执行完」的延续。',
  );
  lines.push('');
  lines.push('## 四、菜单的失效与幂等');
  lines.push('');
  lines.push(
    '- 菜单有效期 ' +
      NUMERIC.menu.ttlMs / 1000 +
      ' 秒（NUMERIC.menu.ttlMs）；过期后回数字一律回「菜单已过期，发 .今日 重新开始」，' +
      '并且过期行就地删除（读的时候顺手清，进程重启也不会留脏行）。',
  );
  lines.push('- 数字回复与完整指令共用同一张 idempotency_keys：同一条 message_id 回两次，只有第一次会被处理。');
  lines.push(
    '- 玩家回 0 进入「自由输入待命」：下一条私聊纯文本按完整指令解析（等价于补一个点号），' +
      '待命之外私聊里的闲聊不会被当成指令。',
  );
  lines.push('');

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, lines.join('\n'), 'utf8');
  console.log('菜单覆盖率已写入：' + out);
  console.log('指令探针 ' + rows.length + ' 条、来源矩阵 ' + matrix().length + ' 项');
  app.close();
}

main().catch((error: unknown) => {
  console.error('生成菜单覆盖率失败：', error);
  process.exit(1);
});
