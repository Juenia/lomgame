/**
 * 地区天气（M2.2 硬约束：判定层纯函数 —— 时间与随机都由调用方注入）
 *
 * 八种天气、每个地点独立一份；所有系数读 `config/numeric.ts` 的 `world.weather.effects`
 * （唯一出处：探索危险 / 掉落 / 扮演 / 魔药 / 失控 / 事件池）。
 *
 * 三条设计约定：
 *   1. **按 tick 键抽**：某地某次换天气用 `seed = weather:{worldSeed}:{locationId}:{rollAt}`
 *      派生随机流。因此「下一刻会是什么天气」在任意时刻都能纯函数地算出来 ——
 *      极罕见天气的 2 小时预告不需要额外状态。
 *   2. **扩散是排期**：A 换天气 → 邻居 N 记下 pending（到的时刻 = A 换天气时刻 + 2 小时），
 *      到点由下一次 tick 落地。若 A 那次天气在落地前就过期了，则不扩散（不搬运过期天气）。
 *   3. **普通日卡池不受影响**：天气只把 `eventPool` 里的卡**加进**探索候选池，
 *      这些卡自己的 cond / 地点限制照旧；没这个天气时它们一张都不进池。
 */
import { NUMERIC } from '../../config/numeric.ts';
import { createSeededRng, seedFrom } from '../rng.ts';
import { weightedPick } from '../random.ts';
import type { PathwayId, Rng } from '../character/types.ts';
import type { LocationDef } from '../explore/location.ts';
import {
  TIME_OF_DAY_LABELS,
  type Season,
  type TimeOfDay,
  type WorldClock,
} from './clock.ts';

export type WeatherTier = 'common' | 'uncommon' | 'rare' | 'epic';

export interface WeatherEffectRow {
  label: string;
  tier: WeatherTier;
  weight: number;
  timeBias: Partial<Record<TimeOfDay, number>>;
  seasonBias: Partial<Record<Season, number>>;
  /** 世界状态乘子：fullMoon（月圆）/ foggy（雾日） */
  worldBias: Partial<Record<'fullMoon' | 'foggy', number>>;
  exploreDanger: number;
  drop: number;
  playMad: number;
  playDig: number;
  potionSuccess: number;
  lossOfControl: number;
  eventPool: readonly string[];
}

export type WeatherId = keyof typeof NUMERIC.world.weather.effects;

export const WEATHER_IDS = Object.keys(NUMERIC.world.weather.effects) as WeatherId[];

export function weatherTable(): Record<WeatherId, WeatherEffectRow> {
  return NUMERIC.world.weather.effects as unknown as Record<WeatherId, WeatherEffectRow>;
}

export function weatherRow(id: WeatherId): WeatherEffectRow {
  return weatherTable()[id];
}

export function weatherLabel(id: WeatherId): string {
  return weatherRow(id).label;
}

export function isKnownWeather(id: string): id is WeatherId {
  return Object.prototype.hasOwnProperty.call(NUMERIC.world.weather.effects, id);
}

export function normalizeWeather(id: string | null | undefined): WeatherId {
  return id && isKnownWeather(id) ? id : 'clear';
}

/** 显著天气（血月 / 灵界渗透）：变化要全群播报，且提前 2 小时预告 */
export function isEpicWeather(id: WeatherId): boolean {
  return weatherRow(id).tier === 'epic';
}

/** 天气生成权重的上下文（时段 / 季节 / 世界状态） */
export interface WeatherWeightContext {
  timeOfDay: TimeOfDay;
  season: Season;
  fullMoon: boolean;
  foggy: boolean;
}

export function weatherWeightContext(clock: WorldClock): WeatherWeightContext {
  return {
    timeOfDay: clock.timeOfDay,
    season: clock.season,
    fullMoon: clock.fullMoon,
    foggy: clock.foggy,
  };
}

/** 某天气在给定上下文里的生成权重（基础权重 × 时段 × 季节 × 世界状态） */
export function weatherWeight(id: WeatherId, ctx: WeatherWeightContext): number {
  const row = weatherRow(id);
  const time = row.timeBias[ctx.timeOfDay] ?? 1;
  const season = row.seasonBias[ctx.season] ?? 1;
  const world =
    (ctx.fullMoon ? (row.worldBias.fullMoon ?? 1) : 1) * (ctx.foggy ? (row.worldBias.foggy ?? 1) : 1);
  return Math.max(0, row.weight * time * season * world);
}

/** 按上下文权重抽一种天气 */
export function rollWeather(ctx: WeatherWeightContext, rng: Rng): WeatherId {
  const picked = weightedPick(WEATHER_IDS, (id) => weatherWeight(id, ctx), rng);
  return picked ?? 'clear';
}

/**
 * 这一轮天气持续多久。
 *
 * ⚠️ 原来这里是 `since + cfg.durationMs` —— **一个常量**。配合冷启动时所有地点
 * 从**同一个整点**开始，58 个地点就永远同步换天气：整点一到全服一起变，
 * 像定时任务而不像天气。
 *
 * 挂在它下游的东西会跟着齐发。最明显的是环境播报：它的判据是
 * 「这个地点当前天气的 `since` 落在本小时」（见 domain/world/events.ts），
 * 于是血月/灵界渗透/灰雾潮会在同一刻被几个地点一起抽中，**一个整点刷出三条**，
 * 而整个白天其余时间一条都没有。扩散（+2 小时）同理，全服一起落地。
 *
 * 现在时长在一个区间里抖：同一 (seed, 地点, 起点) 永远同一个结果
 * （补跑重放必须一致），但每个地点、每一轮都不一样 —— 走几轮之后就再也不会对齐。
 */
export function weatherDurationAt(seed: string, locationId: string, since: number): number {
  const cfg = NUMERIC.world.weather;
  const jitter = cfg.durationJitter;
  if (!(jitter > 0)) return cfg.durationMs;
  const rng = createSeededRng(seedFrom(['weather-duration', seed, locationId, since]));
  // 因子落在 [1-jitter, 1+jitter]：0.5 ⇒ 基准 6 小时变成 3—9 小时
  const factor = 1 - jitter + rng.next() * jitter * 2;
  return Math.max(1, Math.round(cfg.durationMs * factor));
}

/**
 * 按 tick 键抽天气：同一 (seed, locationId, rollAt) 永远同一个结果。
 * 这是「预告」与「真实换天气」共用同一个答案的关键。
 */
export function rollWeatherAt(input: {
  seed: string;
  locationId: string;
  rollAt: number;
  ctx: WeatherWeightContext;
  /** 上一轮的天气：抽到同一种就重抽一次，避免原地不动 */
  previous?: WeatherId;
}): WeatherId {
  const rng = createSeededRng(seedFrom(['weather', input.seed, input.locationId, input.rollAt]));
  const first = rollWeather(input.ctx, rng);
  if (input.previous === undefined || first !== input.previous) return first;
  // 同一种天气连续两次：再抽一次（仍然是确定性的：同一个 seed 同一个结果）
  return rollWeather(input.ctx, rng);
}

/* ---------------- 落库形态 ---------------- */

export interface WeatherState {
  locationId: string;
  weather: WeatherId;
  /** 本次天气的生效时刻 */
  since: number;
  /** 本次天气的过期时刻 */
  until: number;
  /** 从邻居扩散过来的天气（2 小时后落地） */
  pendingWeather: WeatherId | null;
  pendingAt: number | null;
}

export interface WeatherChange {
  locationId: string;
  from: WeatherId;
  to: WeatherId;
  at: number;
  reason: 'expire' | 'diffusion';
}

export interface WeatherTickOutput {
  states: WeatherState[];
  changes: WeatherChange[];
  /** 需要全群播报的显著天气（血月 / 灵界渗透）开始 */
  broadcasts: WeatherChange[];
  /** 极罕见天气的提前预告（提前 2 小时，还没生效） */
  forecasts: Array<{ locationId: string; weather: WeatherId; at: number }>;
}

/**
 * 这个地点的冷启动相位：**铺满一整天**，由 (seed, 地点) 确定性派生。
 *
 * 为什么不等于基准时长：那样 58 个地点的到期时刻会全挤在一个基准时长里
 * （实测就是全挤在 6 小时内）。把世界当成一个微型地球 —— 凌晨三点也该有地方
 * 在换天气，而不是夜里死寂、白天扎堆。
 *
 * 抽成独立函数是因为**打散脚本也要用它**：只改节拍（until）不改相位的话，
 * 现有世界仍然挤在旧窗口里，铺不满一天。
 */
export function weatherPhaseAt(seed: string, locationId: string): number {
  const rng = createSeededRng(seedFrom(['weather-phase', seed, locationId]));
  return Math.max(1, Math.round(rng.next() * NUMERIC.world.weather.phaseSpanMs));
}

/**
 * 冷启动：地点从「晴」开始（不广播、不扩散）。
 *
 * **相位也要错开**：原来所有地点都是 `now + durationMs`，所以它们从第一秒起就
 * 完全同步，之后每一轮都同步（步长也一样）。现在每个地点从自己的相位起步 ——
 * 相位由 (seed, 地点) 确定性派生，58 个地点摊在一个基准时长里，
 * 于是「每小时都有几个地点在换天气」，而不是整点全服一起变。
 */
export function initialWeatherState(locationId: string, now: number, seed: string): WeatherState {
  const phase = weatherPhaseAt(seed, locationId);
  return {
    locationId,
    weather: 'clear',
    since: now,
    until: now + phase,
    pendingWeather: null,
    pendingAt: null,
  };
}

export function findWeather(
  states: readonly WeatherState[],
  locationId: string,
): WeatherState | null {
  return states.find((state) => state.locationId === locationId) ?? null;
}

/** 地点名 → 邻居 id 列表（locations.yaml 的 adjacent；单向声明也认，双向取并集） */
export function neighborsOf(locationId: string, locations: readonly LocationDef[]): string[] {
  const out = new Set<string>();
  for (const location of locations) {
    if (location.id === locationId) {
      for (const id of location.adjacent) out.add(id);
      continue;
    }
    if (location.adjacent.includes(locationId)) out.add(location.id);
  }
  return [...out];
}

/**
 * 一次天气推进（轻 tick 调用）：
 *   1. 到点的扩散先落地
 *   2. 过期地点换新天气（按 tick 键抽，补跑时逐次推进）
 *   3. 换过天气的地点给邻居排一条 2 小时后的扩散
 *   4. 收集显著天气播报与极罕见天气预告
 */
export function tickWeather(input: {
  states: readonly WeatherState[];
  locations: readonly LocationDef[];
  now: number;
  seed: string;
  ctx: WeatherWeightContext;
  /** tick 键的粒度：补跑时用 tick 时刻而不是 now，保证重放一致 */
  rollAtFor?: (until: number) => number;
  /** 补跑保护：单个地点一次最多推进几次换天气 */
  maxAdvance?: number;
}): WeatherTickOutput {
  const cfg = NUMERIC.world.weather;
  const byId = new Map(input.locations.map((location) => [location.id, location]));
  const next = new Map<string, WeatherState>();
  const changes: WeatherChange[] = [];
  const broadcasts: WeatherChange[] = [];
  const forecasts: Array<{ locationId: string; weather: WeatherId; at: number }> = [];
  const rollAtFor = input.rollAtFor ?? ((until: number) => until);
  const maxAdvance = input.maxAdvance ?? 8;

  for (const raw of input.states) {
    const state: WeatherState = { ...raw, weather: normalizeWeather(raw.weather) };
    if (!byId.has(state.locationId)) continue;

    // 1) 扩散落地
    if (state.pendingWeather && state.pendingAt !== null && input.now >= state.pendingAt) {
      const arrived = normalizeWeather(state.pendingWeather);
      if (arrived !== state.weather) {
        const change: WeatherChange = {
          locationId: state.locationId,
          from: state.weather,
          to: arrived,
          at: state.pendingAt,
          reason: 'diffusion',
        };
        changes.push(change);
        if (isEpicWeather(arrived)) broadcasts.push(change);
        state.weather = arrived;
        state.since = state.pendingAt;
        /**
         * M2.5 修复（M2.2 既有缺陷）：**扩散只改天气内容，不改本地换天气的节拍**。
         *
         * 原来这里写的是 state.until = state.pendingAt + durationMs —— 每接一次邻居的天气，
         * 本地到期时刻就被往后推一整轮。后果是：只要邻居还在变，本地就永远轮不到自己抽签
         * （实测 14 天里 expire 只有 11 次、diffusion 有 1804 次），血月 / 灵界渗透这类
         * **只能抽到**的显著天气于是几乎全靠扩散传播，出现频率强烈依赖起始整点。
         *
         * 保留本地 until 之后，本地照常每 durationMs 自己抽一次 ——
         * 语义上也更对：天气飘过来只是「内容变了」，不该把邻居的钟也一起拨。
         *
         * 唯一的例外：本地在落地时**已经过期**（说明它本来就该换天气了）。
         * 这时把 until 推到「落地后一整轮」，否则第 2 步会立刻把刚到的天气抽掉，扩散等于白做。
         * 判据用 input.now（tick 时刻，补跑时同样是确定性的），不用墙上时间 —— 重放必须同结果。
         */
        if (state.until <= input.now) {
          state.until = input.now + weatherDurationAt(input.seed, state.locationId, input.now);
        }
      }
      state.pendingWeather = null;
      state.pendingAt = null;
    }

    // 2) 过期换天气（补跑时可能连推多次）
    let advanced = 0;
    while (input.now >= state.until && advanced < maxAdvance) {
      const rollAt = rollAtFor(state.until);
      const ctxAt = input.ctx;
      const picked = rollWeatherAt({
        seed: input.seed,
        locationId: state.locationId,
        rollAt,
        ctx: ctxAt,
        previous: state.weather,
      });
      const change: WeatherChange = {
        locationId: state.locationId,
        from: state.weather,
        to: picked,
        at: state.until,
        reason: 'expire',
      };
      changes.push(change);
      if (isEpicWeather(picked)) broadcasts.push(change);
      state.weather = picked;
      state.since = state.until;
      // 每一轮各自抖一次：这是「不再对齐」的来源（同一地点两次也可能不同长）
      state.until = state.since + weatherDurationAt(input.seed, state.locationId, state.since);
      advanced += 1;
    }

    next.set(state.locationId, state);
  }

  // 3) 给邻居排扩散：只搬运「到达时仍然有效」的天气
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

  // 4) 极罕见天气预告：离换天气不到 2 小时，且下一刻真的是 epic
  const HOUR_MS = 60 * 60 * 1000;
  for (const state of next.values()) {
    const leadStart = state.until - cfg.forecastLeadMs;
    if (input.now < leadStart) continue;
    /*
     * ⚠️ 只在**刚跨进预告窗口**的那一小时报一次。
     *
     * 原来只要在窗口内就报（每个 tick 报一次），两个后果：
     *   · 同一条天气被预告两遍；
     *   · 玩家很可能只在窗口的最后一小时才第一次看到它 —— 提前 2 小时的预告
     *     变成「咸鱼市场将在约 3 分钟后出现血月，做好准备」，而 3 分钟根本来不及
     *     赶过去。那句话已经没有用了，只剩下干扰。
     *
     * 按小时刻度比较（两边都是整点，时区不影响「是不是同一个小时」）：
     * 这样每次换天气只预告一次，提前量稳定落在 1—2 小时。
     */
    if (Math.floor(leadStart / HOUR_MS) !== Math.floor(input.now / HOUR_MS)) continue;
    const upcoming = rollWeatherAt({
      seed: input.seed,
      locationId: state.locationId,
      rollAt: rollAtFor(state.until),
      ctx: input.ctx,
      previous: state.weather,
    });
    if (!isEpicWeather(upcoming)) continue;
    if (state.pendingWeather === upcoming) continue;
    forecasts.push({ locationId: state.locationId, weather: upcoming, at: state.until });
  }

  return { states: [...next.values()], changes, broadcasts, forecasts };
}

/* ---------------- 影响聚合（命令层读这一份） ---------------- */

export interface WorldModifiers {
  /** 探索危险倍率：时段 × 雾日 × 天气 */
  exploreDangerMultiplier: number;
  /** 掉落（额外掉落判定）倍率 */
  dropMultiplier: number;
  /** 每次 .扮演 的 MAD 增量 */
  playMad: number;
  /** 扮演消化倍率 */
  playDigMultiplier: number;
  /** 调制成功率增量（绝对百分点） */
  potionSuccessBonus: number;
  /** 失控概率倍率 */
  lossOfControlMultiplier: number;
  /** 该天气注入探索候选池的事件卡 id */
  eventPool: readonly string[];
}

export function worldModifiers(input: {
  clock: WorldClock;
  weather: WeatherId;
  path?: PathwayId;
}): WorldModifiers {
  const cfg = NUMERIC.world.timeOfDay;
  const row = weatherRow(input.weather);
  const night = input.clock.timeOfDay === 'night';
  const sleepless = input.path === 'sleepless';

  const danger =
    (cfg.exploreDangerMultiplier[input.clock.timeOfDay] ?? 1) *
    (input.clock.foggy ? cfg.foggyExploreDangerMultiplier : 1) *
    row.exploreDanger;

  return {
    exploreDangerMultiplier: danger,
    dropMultiplier: row.drop,
    playMad: row.playMad + (night && !sleepless ? cfg.nightPlayMad : 0),
    playDigMultiplier: row.playDig * (night && sleepless ? cfg.sleeplessNightDigMultiplier : 1),
    potionSuccessBonus: row.potionSuccess + (input.clock.fullMoon ? cfg.fullMoonBrewSuccessBonus : 0),
    lossOfControlMultiplier:
      row.lossOfControl * (input.clock.fullMoon ? cfg.fullMoonLossOfControlMultiplier : 1),
    eventPool: row.eventPool,
  };
}

/** 危险倍率 + 能力的探索危险倍率合并（能力的 0.8 与世界的 1.1 相乘） */
export function combineDangerMultiplier(worldMultiplier: number, abilityMultiplier: number): number {
  return worldMultiplier * abilityMultiplier;
}

/** 掉落倍率 → 额外掉落概率（clamp 到 0—1） */
export function bonusDropChanceWith(weatherMultiplier: number): number {
  return Math.min(1, Math.max(0, NUMERIC.explore.bonusDropChance * weatherMultiplier));
}

/** 一行天气文案：`雾（黄昏 · 常见）` */
export function weatherLine(id: WeatherId, clock?: WorldClock): string {
  const row = weatherRow(id);
  if (!clock) return row.label;
  return `${row.label}（${TIME_OF_DAY_LABELS[clock.timeOfDay]}）`;
}

/** 氛围短句（探索回执首行、.世界 用）；数据表里没有的天气给通用句 */
export function weatherFlavor(id: WeatherId): string {
  switch (id) {
    case 'clear':
      return '天色干净，远处能看清。';
    case 'fog':
      return '雾贴着地面走，三步以外就只剩轮廓。';
    case 'rain':
      return '雨把整条街洗得发亮，脚步声被吞掉一半。';
    case 'storm':
      return '雷声在云层里滚，每一次亮起来都照见不该在的东西。';
    case 'greyfog_tide':
      return '灰雾像潮水一样涨上来，退下去的时候带走了些东西。';
    case 'blood_moon':
      return '月亮是红的，所有人都在做同一个梦。';
    case 'silence':
      return '一点声音都没有，连你自己的心跳都显得吵。';
    case 'spirit_creep':
      return '有什么东西从另一边渗了过来，纸上的字在动。';
    default:
      return '空气里有什么东西在变。';
  }
}

/** 数值化影响一览（.世界 地点 用） */
export function weatherEffectLines(id: WeatherId): string[] {
  const row = weatherRow(id);
  const pct = (value: number): string => {
    const delta = (value - 1) * 100;
    return `${delta >= 0 ? '+' : ''}${delta.toFixed(0)}%`;
  };
  const lines = [
    `探索危险 ${pct(row.exploreDanger)}`,
    `掉落 ${pct(row.drop)}`,
    `扮演消化 ${pct(row.playDig)}`,
    `扮演疯狂 ${row.playMad >= 0 ? '+' : ''}${row.playMad}/次`,
    `调制成功率 ${row.potionSuccess >= 0 ? '+' : ''}${(row.potionSuccess * 100).toFixed(0)}%`,
    `失控概率 ${pct(row.lossOfControl)}`,
  ];
  if (row.eventPool.length > 0) lines.push(`事件池 +${row.eventPool.length} 张（${row.eventPool.join(' / ')}）`);
  return lines;
}
