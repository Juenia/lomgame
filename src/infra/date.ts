/**
 * 每日边界统一按东八区切分（玩家在中国，服务器时区可能不是）。
 * daily_tag_usage / event_triggers / daily_ticks 全部用 dateKey 作为分区键。
 */
export const DEFAULT_TZ_OFFSET_MINUTES = 8 * 60;

export function dateKey(now: number, tzOffsetMinutes: number = DEFAULT_TZ_OFFSET_MINUTES): string {
  const shifted = new Date(now + tzOffsetMinutes * 60_000);
  const year = shifted.getUTCFullYear();
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const day = String(shifted.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** 相隔天数（b - a）。解析失败返回 Infinity：宁可放过冷却，也不误杀玩家一天的收益 */
export function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return Number.POSITIVE_INFINITY;
  return Math.round((b - a) / 86_400_000);
}
