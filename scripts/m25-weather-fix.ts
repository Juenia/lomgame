#!/usr/bin/env node
/**
 * 生成 docs/M2.5-天气修复说明.md（M2.5 前置项交付物）。
 *
 * 对照数据是**跑出来的**，不是抄的：脚本里保留了「修前」的 tick 逻辑
 * （tickWeatherLegacy，与 M2.2 原实现逐行一致，只差扩散落地那一行），
 * 同一窗口跑两遍，把差异摆在同一张表上。
 *
 *   node scripts/m25-weather-fix.ts --out docs/M2.5-天气修复说明.md
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { NUMERIC } from '../src/config/numeric.ts';
import { loadLocations } from '../src/data/loader.ts';
import { dayStartOf, worldClock } from '../src/domain/world/clock.ts';
import {
  initialWeatherState,
  isEpicWeather,
  neighborsOf,
  normalizeWeather,
  rollWeatherAt,
  tickWeather,
  weatherWeightContext,
  type WeatherId,
  type WeatherState,
  type WeatherTickOutput,
} from '../src/domain/world/weather.ts';
import { generateWorldEvents } from '../src/domain/world/events.ts';
import type { LocationDef } from '../src/domain/explore/location.ts';

const DAYS = 14;
const NL = String.fromCharCode(10);
const BQ = String.fromCharCode(96);
const code = (text: string): string => BQ + text + BQ;
const ENV_WEATHERS = new Set<string>(NUMERIC.world.events.environmentWeathers);
const LOCATION_DEFS = loadLocations().locations;

function tickWeatherLegacy(input: {
  states: readonly WeatherState[];
  locations: readonly LocationDef[];
  now: number;
  seed: string;
  ctx: ReturnType<typeof weatherWeightContext>;
}): WeatherTickOutput {
  const cfg = NUMERIC.world.weather;
  const byId = new Map(input.locations.map((location) => [location.id, location]));
  const next = new Map<string, WeatherState>();
  const changes: WeatherTickOutput['changes'] = [];
  const broadcasts: WeatherTickOutput['broadcasts'] = [];
  const forecasts: WeatherTickOutput['forecasts'] = [];
  for (const raw of input.states) {
    const state: WeatherState = { ...raw, weather: normalizeWeather(raw.weather) };
    if (!byId.has(state.locationId)) continue;
    if (state.pendingWeather && state.pendingAt !== null && input.now >= state.pendingAt) {
      const arrived = normalizeWeather(state.pendingWeather);
      if (arrived !== state.weather) {
        const change = {
          locationId: state.locationId,
          from: state.weather,
          to: arrived,
          at: state.pendingAt,
          reason: 'diffusion' as const,
        };
        changes.push(change);
        if (isEpicWeather(arrived)) broadcasts.push(change);
        state.weather = arrived;
        state.since = state.pendingAt;
        state.until = state.pendingAt + cfg.durationMs;
      }
      state.pendingWeather = null;
      state.pendingAt = null;
    }
    let advanced = 0;
    while (input.now >= state.until && advanced < 8) {
      const picked = rollWeatherAt({
        seed: input.seed,
        locationId: state.locationId,
        rollAt: state.until,
        ctx: input.ctx,
        previous: state.weather,
      });
      const change = {
        locationId: state.locationId,
        from: state.weather,
        to: picked,
        at: state.until,
        reason: 'expire' as const,
      };
      changes.push(change);
      if (isEpicWeather(picked)) broadcasts.push(change);
      state.weather = picked;
      state.since = state.until;
      state.until = state.since + cfg.durationMs;
      advanced += 1;
    }
    next.set(state.locationId, state);
  }
  for (const change of changes) {
    const source = next.get(change.locationId);
    if (!source) continue;
    const arriveAt = change.at + cfg.diffusionDelayMs;
    if (arriveAt >= source.until) continue;
    for (const neighborId of neighborsOf(change.locationId, input.locations)) {
      const neighbor = next.get(neighborId);
      if (!neighbor) continue;
      if (neighbor.weather === change.to) continue;
      if (neighbor.pendingWeather === change.to && neighbor.pendingAt === arriveAt) continue;
      neighbor.pendingWeather = change.to;
      neighbor.pendingAt = arriveAt;
    }
  }
  return { states: [...next.values()], changes, broadcasts, forecasts };
}

interface WindowStats {
  expire: number;
  diffusion: number;
  envWeather: number;
  envEvents: number;
  totalEvents: number;
  perWeather: Record<string, number>;
}

const SNAPSHOT_LOCATIONS = LOCATION_DEFS.map((l) => ({
  id: l.id,
  name: l.name,
  danger: l.danger,
  minSeq: l.min_seq,
  maxSeq: l.max_seq,
  lootCount: l.loot.length,
}));

function runWindow(startDay: number, days: number, legacy: boolean): WindowStats {
  const startMs = dayStartOf(startDay);
  let states: WeatherState[] = LOCATION_DEFS.map((location) =>
    initialWeatherState(location.id, startMs, 'world'),
  );
  let expire = 0;
  let diffusion = 0;
  let envWeather = 0;
  let envEvents = 0;
  let totalEvents = 0;
  const perWeather: Record<string, number> = {};
  for (let hour = 0; hour < days * 24; hour += 1) {
    const at = startMs + hour * 3600000;
    const clock = worldClock(at, 'world');
    const ctx = weatherWeightContext(clock);
    const out = legacy
      ? tickWeatherLegacy({ states, locations: LOCATION_DEFS, now: at, seed: 'world', ctx })
      : tickWeather({ states, locations: LOCATION_DEFS, now: at, seed: 'world', ctx });
    states = out.states;
    for (const change of out.changes) {
      if (change.reason === 'expire') expire += 1;
      else diffusion += 1;
      if (ENV_WEATHERS.has(change.to)) {
        envWeather += 1;
        perWeather[change.to] = (perWeather[change.to] ?? 0) + 1;
      }
    }
    const snapshot = {
      clock,
      weather: 'clear' as WeatherId,
      modifiers: {
        exploreDangerMultiplier: 1,
        dropMultiplier: 1,
        playMad: 0,
        playDigMultiplier: 1,
        potionSuccessBonus: 0,
        lossOfControlMultiplier: 1,
        eventPool: [],
      },
      locations: SNAPSHOT_LOCATIONS,
      weatherStates: states,
    };
    const events = generateWorldEvents(snapshot, at, 'world');
    totalEvents += events.length;
    envEvents += events.filter((event) => event.type === 'environment').length;
  }
  return { expire, diffusion, envWeather, envEvents, totalEvents, perWeather };
}

const STARTS: Array<[string, number]> = [
  ['2026-01-01（与 CI / 回归同基准）', Math.floor(Date.parse('2026-01-01T00:00:00+08:00') / 86400000)],
  ['2025-06-15', Math.floor(Date.parse('2025-06-15T00:00:00+08:00') / 86400000)],
  ['2025-03-01', Math.floor(Date.parse('2025-03-01T00:00:00+08:00') / 86400000)],
];

function main(): void {
  const argv = process.argv.slice(2);
  const index = argv.indexOf('--out');
  const out = index >= 0 ? (argv[index + 1] ?? 'docs/M2.5-天气修复说明.md') : 'docs/M2.5-天气修复说明.md';

  const baselineDay = STARTS[0]![1];
  const before = runWindow(baselineDay, DAYS, true);
  const after = runWindow(baselineDay, DAYS, false);
  const locationCount = LOCATION_DEFS.length;
  const daysPerLocation = DAYS * locationCount;

  const sweep = STARTS.map(([label, day]) => {
    const legacy = runWindow(day, DAYS, true);
    const fixed = runWindow(day, DAYS, false);
    return { label, day, legacy, fixed };
  });

  const fixedValues = sweep.map((row) => row.fixed.envWeather);
  const legacyValues = sweep.map((row) => row.legacy.envWeather);
  const spread = (values: number[]): number => {
    const max = Math.max(...values);
    const min = Math.min(...values);
    return max === 0 ? 0 : (max - min) / max;
  };
  const fixedSpread = spread(fixedValues);
  const legacySpread = spread(legacyValues);

  const lines: string[] = [];
  lines.push('# M2.5 天气修复说明');
  lines.push('');
  lines.push(
    '> 本文件由 ' + code('node scripts/m25-weather-fix.ts') + ' 生成。窗口 ' + DAYS + ' 天 × 24 小时，' +
      locationCount + ' 个真实地点，世界 seed=' + code('world') + '。',
  );
  lines.push('');
  lines.push('## 一、问题：扩散把「换天气的节拍」一起搬走了');
  lines.push('');
  lines.push('M2.2 的天气 tick 里，扩散落地时会把本地的到期时刻重置成一整轮：');
  lines.push('');
  lines.push('```ts');
  lines.push('state.weather = arrived;');
  lines.push('state.since   = state.pendingAt;');
  lines.push('state.until   = state.pendingAt + cfg.durationMs;   // ← 问题在这一行');
  lines.push('```');
  lines.push('');
  lines.push(
    '而「本地该不该换天气」的唯一判据就是 ' + code('input.now >= state.until') + '。' +
      '于是只要邻居还在变，本地的 until 就被一路推后 —— **永远轮不到自己抽签**。' +
      '血月 / 灵界渗透这类只能**抽到**的显著天气因此几乎全靠扩散传播，' +
      '出现频率强烈依赖「世界从哪个整点开始跑」。',
  );
  lines.push('');
  lines.push('## 二、修法：扩散只改内容，不改节拍');
  lines.push('');
  lines.push('采纳任务书建议的方案 A（改动最小、不动表结构、语义也最对）：');
  lines.push('');
  lines.push('```ts');
  lines.push('state.weather = arrived;');
  lines.push('state.since   = state.pendingAt;');
  lines.push('// until 保持不变：天气飘过来只是「内容变了」，不该把邻居的钟也一起拨');
  lines.push('if (state.until <= input.now) state.until = input.now + cfg.durationMs;');
  lines.push('```');
  lines.push('');
  lines.push(
    '那行例外是必要的：如果落地时本地**已经过期**（本来就该换天气了），' +
      '不把它推到「落地后一整轮」的话，同一个 tick 的第 2 步会立刻把刚到的天气抽掉，扩散等于白做。' +
      '判据用 ' + code('input.now') + '（tick 时刻，补跑时同样是确定性的）而不是墙上时间 —— 重放必须得到同一结果。',
  );
  lines.push('');
  lines.push('**天气系数一个都没动**（八种天气的影响表、durationMs、diffusionDelayMs、forecastLeadMs 全是原值）。');
  lines.push('改的只是「扩散落地时要不要重置 until」这一行调度逻辑。');
  lines.push('');
  lines.push('## 三、验收 1：抽签次数回到正常量级');
  lines.push('');
  lines.push('| 指标（' + DAYS + ' 天 × ' + locationCount + ' 地点） | 修前 | 修后 | 说明 |');
  lines.push('|---|---|---|---|');
  lines.push('| 自己换天气（expire） | ' + before.expire + ' | **' + after.expire + '** | 正常量级 = 每地点每天 ' + (after.expire / daysPerLocation).toFixed(2) + ' 次（理论值 ' + (24 / (NUMERIC.world.weather.durationMs / 3600000)).toFixed(2) + ' 次 = 每 ' + (NUMERIC.world.weather.durationMs / 3600000) + ' 小时一轮） |');
  lines.push('| 扩散落地（diffusion） | ' + before.diffusion + ' | ' + after.diffusion + ' | 邻居搬过来的次数 |');
  lines.push('| 显著天气变化（血月/灵界渗透/灰雾潮） | ' + before.envWeather + ' | **' + after.envWeather + '** | 只能靠抽签产生的那些 |');
  lines.push('| 世界事件总数（含截断与安静时段） | ' + before.totalEvents + ' | ' + after.totalEvents + ' | 其中 environment ' + before.envEvents + ' → ' + after.envEvents + ' |');
  lines.push('');
  lines.push('验收线「每地点每天至少 1 次 expire」：修后 ' + (after.expire / daysPerLocation).toFixed(2) + ' 次/地点·天 ' + (after.expire / daysPerLocation >= 1 ? '通过' : '**不通过**') + '。');
  lines.push('');
  lines.push('## 四、验收 2：显著天气不再依赖起始整点');
  lines.push('');
  lines.push('同 seed、三个不同的世界起点，各扫 ' + DAYS + ' 天：');
  lines.push('');
  lines.push('| 起点 | 修前显著天气 | 修后显著天气 | 修前 expire | 修后 expire |');
  lines.push('|---|---|---|---|---|');
  for (const row of sweep) {
    lines.push('| ' + row.label + ' | ' + row.legacy.envWeather + ' | **' + row.fixed.envWeather + '** | ' + row.legacy.expire + ' | ' + row.fixed.expire + ' |');
  }
  lines.push('');
  lines.push(
    '- 修前极差（最大-最小）/最大 = **' + (legacySpread * 100).toFixed(0) + '%** —— 同一颗世界种子，换个起点就差这么多，' +
      '这正是「血月出现频率不稳定」的量化形态。',
  );
  lines.push('- 修后极差 = **' + (fixedSpread * 100).toFixed(0) + '%** ' + (fixedSpread < 0.3 ? '（< 30%，通过）' : '（**≥ 30%，不通过**）'));
  lines.push('');
  lines.push('逐种显著天气（修后，三个起点）：');
  lines.push('');
  const kinds = [...ENV_WEATHERS];
  lines.push('| 起点 | ' + kinds.join(' | ') + ' |');
  lines.push('|---|' + kinds.map(() => '---').join('|') + '|');
  for (const row of sweep) {
    lines.push('| ' + row.label + ' | ' + kinds.map((k) => row.fixed.perWeather[k] ?? 0).join(' | ') + ' |');
  }
  lines.push('');
  lines.push('## 五、影响面：哪些数字会变');
  lines.push('');
  lines.push('天气序列变了 → 天气系数作用到玩家身上的分布变了 → **M2.2 / M2.3 / M2.4 的回归数字会变**。');
  lines.push('这是任务书明确的必要成本，不是回归。具体会动的东西：');
  lines.push('');
  lines.push('| 会变 | 不会变 |');
  lines.push('|---|---|');
  lines.push('| 每个地点每小时的天气（因此探索危险 / 掉落 / 扮演 MAD / 魔药成功率 / 失控倍率的时间分布） | 天气系数表本身（八种天气的六个维度、durationMs、diffusionDelayMs） |');
  lines.push('| 世界事件里 environment 的条数与内容 | 事件生成规则、每小时 ≤ 3 条闸门、传闻排期 |');
  lines.push('| 长链路回归里依赖天气的覆盖率与分布（DIG/MAD/COR 分位、失控率） | 失控闸门、暴露概率、晋升惩罚、tick 恢复量 |');
  lines.push('');
  lines.push('重跑基线见 ' + code('docs/M2.5-交付说明.md') + ' 的「基线重跑」一节。');
  lines.push('');
  lines.push('## 六、复现');
  lines.push('');
  lines.push('```bash');
  lines.push('node scripts/m25-weather-fix.ts --out docs/M2.5-天气修复说明.md');
  lines.push('npm test -- test/weather.test.ts test/world-tick.test.ts   # 天气与 tick 的单测');
  lines.push('```');
  lines.push('');

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, lines.join(NL), 'utf8');
  console.log('已写入 ' + out);
  console.log('expire：修前 ' + before.expire + ' → 修后 ' + after.expire + '（每地点每天 ' + (after.expire / daysPerLocation).toFixed(2) + ' 次）');
  console.log('显著天气极差：修前 ' + (legacySpread * 100).toFixed(0) + '% → 修后 ' + (fixedSpread * 100).toFixed(0) + '%');
  console.log('修后三起点显著天气：' + fixedValues.join(' / '));
}

main();