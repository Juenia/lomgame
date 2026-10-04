/**
 * 世界时钟（M2.2 硬约束：纯函数 + 时钟注入，绝不硬编码 Date.now()）
 *
 * 三个概念，全部由 `now` 决定，同输入同输出：
 *   - 时段 timeOfDay：黎明 6—9 / 白天 9—18 / 黄昏 18—21 / 夜晚 21—6（东八区）
 *   - 月相 moonPhase：30 天一个周期，第 15 天为月圆（农历十五）
 *   - 雾日 isFoggy：每 3—7 天随机一次、持续 1 天，序列由 seed 确定性派生
 *
 * 边界与系数一律读 `config/numeric.ts`（world.clock / world.timeOfDay），这里不写常数。
 */
import { NUMERIC } from '../../config/numeric.ts';
import { createSeededRng, seedFrom } from '../rng.ts';

export type TimeOfDay = 'dawn' | 'day' | 'dusk' | 'night';
export type Season = 'spring' | 'summer' | 'autumn' | 'winter';

export const TIME_OF_DAY_LABELS: Record<TimeOfDay, string> = {
  dawn: '黎明',
  day: '白天',
  dusk: '黄昏',
  night: '夜晚',
};

export const SEASON_LABELS: Record<Season, string> = {
  spring: '春',
  summer: '夏',
  autumn: '秋',
  winter: '冬',
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function tzOffset(): number {
  return NUMERIC.world.clock.tzOffsetMinutes;
}

/** 把时间戳平移到目标时区的「墙上时间」再取字段（与 infra/date.ts 的 dateKey 同一口径） */
function shifted(now: number, tzOffsetMinutes: number): Date {
  return new Date(now + tzOffsetMinutes * 60_000);
}

/** 时区内的整点小时 0—23 */
export function hourOf(now: number, tzOffsetMinutes: number = tzOffset()): number {
  return shifted(now, tzOffsetMinutes).getUTCHours();
}

/**
 * 时区内的「天序号」（1970-01-01 起算）。
 * 月相、雾日、每日 tick 都以它为基准 —— 它比 dateKey 更适合做算术。
 */
export function dayIndexOf(now: number, tzOffsetMinutes: number = tzOffset()): number {
  return Math.floor((now + tzOffsetMinutes * 60_000) / MS_PER_DAY);
}

/** 天序号 → 该天 0 点的时间戳（东八区口径） */
export function dayStartOf(dayIndex: number, tzOffsetMinutes: number = tzOffset()): number {
  return dayIndex * MS_PER_DAY - tzOffsetMinutes * 60_000;
}

/**
 * 该时刻所在整点的起点（东八区口径，兼容非整小时偏移）。
 * M2.2 起轻 tick 以它为粒度，M2.4 的世界事件也以它为「第几个小时」的口径 ——
 * 两条链路必须同源，否则事件会落在错误的那个小时里。
 */
export function hourStartOf(at: number, tzOffsetMinutes: number = tzOffset()): number {
  const MS_PER_HOUR = 60 * 60 * 1000;
  const shiftedAt = at + tzOffsetMinutes * 60_000;
  return Math.floor(shiftedAt / MS_PER_HOUR) * MS_PER_HOUR - tzOffsetMinutes * 60_000;
}

/** 时段：左闭右开，夜晚跨零点 */
export function timeOfDay(now: number, tzOffsetMinutes: number = tzOffset()): TimeOfDay {
  const cfg = NUMERIC.world.clock;
  const hour = hourOf(now, tzOffsetMinutes);
  if (hour >= cfg.dawnStartHour && hour < cfg.dayStartHour) return 'dawn';
  if (hour >= cfg.dayStartHour && hour < cfg.duskStartHour) return 'day';
  if (hour >= cfg.duskStartHour && hour < cfg.nightStartHour) return 'dusk';
  return 'night';
}

/** 月相：1—30 的「农历日」，15 = 月圆 */
export function moonPhase(now: number, tzOffsetMinutes: number = tzOffset()): number {
  const cycle = NUMERIC.world.clock.moonCycleDays;
  const day = dayIndexOf(now, tzOffsetMinutes);
  return (((day % cycle) + cycle) % cycle) + 1;
}

/** 是否月圆（农历十五） */
export function isFullMoon(now: number, tzOffsetMinutes: number = tzOffset()): boolean {
  return moonPhase(now, tzOffsetMinutes) === NUMERIC.world.clock.fullMoonDay;
}

/** 月相文案（.世界 用） */
export function moonPhaseLabel(phase: number): string {
  if (phase === NUMERIC.world.clock.fullMoonDay) return '月圆';
  if (phase <= 2 || phase >= 29) return '新月';
  if (phase < 15) return '盈月';
  return '亏月';
}

/** 季节（按东八区月份归属） */
export function seasonOf(now: number, tzOffsetMinutes: number = tzOffset()): Season {
  const month = shifted(now, tzOffsetMinutes).getUTCMonth() + 1;
  const seasons = NUMERIC.world.weather.seasons;
  for (const [season, months] of Object.entries(seasons) as Array<[Season, number[]]>) {
    if (months.includes(month)) return season;
  }
  return 'spring';
}

/* ---------------- 雾日：每 3—7 天一次，持续 1 天 ---------------- */

/** 每个 seed 的雾日起点表（只增不减；内容完全由 seed 决定，与调用顺序无关） */
const fogScheduleCache = new Map<string, number[]>();

/**
 * 第 index 次雾日的间隔天数（3—7 天，由 seed + index 派生）。
 * 确定性：同 seed 同 index 必然同一个间隔 → 整条雾日序列可复现。
 */
export function fogGapDays(seed: string, index: number): number {
  const cfg = NUMERIC.world.clock;
  const rng = createSeededRng(seedFrom(['fog', seed, index]));
  const span = cfg.fogGapMaxDays - cfg.fogGapMinDays + 1;
  return cfg.fogGapMinDays + Math.floor(rng.next() * span);
}

/** 雾日起点（天序号）列表，至少覆盖到 upToDay */
export function fogStartDays(seed: string, upToDay: number): readonly number[] {
  if (upToDay < NUMERIC.world.clock.fogEpochDay) return [NUMERIC.world.clock.fogEpochDay];
  let days = fogScheduleCache.get(seed);
  if (!days) {
    days = [NUMERIC.world.clock.fogEpochDay];
    fogScheduleCache.set(seed, days);
  }
  // 上限只是防御性护栏：正常调用下循环次数 ≈ 天数 / 5
  while ((days[days.length - 1] ?? 0) <= upToDay && days.length <= 20_000) {
    days.push((days[days.length - 1] ?? 0) + fogGapDays(seed, days.length - 1));
  }
  return days;
}

/** 上一次雾日起点（≤ day），没有则 null */
export function lastFogStart(seed: string, day: number): number | null {
  const days = fogStartDays(seed, day);
  let last: number | null = null;
  for (const start of days) {
    if (start <= day) last = start;
    else break;
  }
  return last;
}

/**
 * 今天是不是雾日。
 * 排布规则：从 fogEpochDay 起，每 3—7 天起一次雾，持续 fogDurationDays 天。
 */
export function isFoggy(now: number, seed = 'world', tzOffsetMinutes: number = tzOffset()): boolean {
  const day = dayIndexOf(now, tzOffsetMinutes);
  const start = lastFogStart(seed, day);
  if (start === null) return false;
  return day < start + NUMERIC.world.clock.fogDurationDays;
}

/** 下一个雾日（天序号），今天的雾日也算「下一个」里的第一个未来值 */
export function nextFogDay(seed: string, day: number): number {
  const days = fogStartDays(seed, day + NUMERIC.world.clock.fogGapMaxDays + 1);
  for (const start of days) if (start > day) return start;
  return day;
}

/** 一次性取全世界时钟状态（判定层与 .世界 都用这一份） */
export interface WorldClock {
  /** 时间戳（注入值） */
  now: number;
  dayIndex: number;
  hour: number;
  timeOfDay: TimeOfDay;
  season: Season;
  moonPhase: number;
  fullMoon: boolean;
  foggy: boolean;
  /** 下一个雾日的天序号（今天不是雾日时才有意义） */
  nextFogDay: number;
}

export function worldClock(now: number, seed = 'world', tzOffsetMinutes: number = tzOffset()): WorldClock {
  const dayIndex = dayIndexOf(now, tzOffsetMinutes);
  const phase = moonPhase(now, tzOffsetMinutes);
  return {
    now,
    dayIndex,
    hour: hourOf(now, tzOffsetMinutes),
    timeOfDay: timeOfDay(now, tzOffsetMinutes),
    season: seasonOf(now, tzOffsetMinutes),
    moonPhase: phase,
    fullMoon: phase === NUMERIC.world.clock.fullMoonDay,
    foggy: isFoggy(now, seed, tzOffsetMinutes),
    nextFogDay: nextFogDay(seed, dayIndex),
  };
}

/** 时:分（东八区，.世界 用） */
export function clockLabel(now: number, tzOffsetMinutes: number = tzOffset()): string {
  const date = shifted(now, tzOffsetMinutes);
  return `${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}`;
}
