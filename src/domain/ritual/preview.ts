/**
 * 仪式成功率（M2.5）：纯函数，无 IO、无 rng。
 *
 * 两条设计要点：
 *   1. **沿用 W5 的晋升公式**：base / dig / sequence / mad / cor 五项就是
 *      `computePromotionSuccess` 的原式展开，一个系数都没改。
 *      单测里有一条恒等式守着它：五项之和（未越界时）必须等于 computePromotionSuccess(state)。
 *   2. **每一项都要能单独显示**（任务书 §3.2）：MAD/COR 惩罚必须拆开，
 *      因为「玩家看到 -10.8% 才知道该先去休息」正是 M2.4 发现的死循环 UX 缺口的落点。
 */
import { NUMERIC } from '../../config/numeric.ts';
import { computePromotionSuccess } from '../character/rules.ts';
import { clamp } from '../character/rules.ts';
import type { TimeOfDay } from '../world/clock.ts';
import type { WeatherId } from '../world/weather.ts';
import type { RitualChanceBreakdown, RitualChanceInput, RitualPreview } from './types.ts';

const RITUAL = NUMERIC.ritual;
const PROMOTION = NUMERIC.promotion;

/** 主材料成色档（内容表暂无品质字段，见 numeric.ritual.materialGrade） */
export function materialGradeOf(mainMaterialId: string | null): 'high' | 'normal' | 'low' {
  if (!mainMaterialId) return 'normal';
  const table = RITUAL.materialGrade as Record<string, string>;
  const grade = table[mainMaterialId];
  return grade === 'high' || grade === 'low' ? grade : 'normal';
}

export function locationBonusOf(locationId: string | null): number {
  if (!locationId) return 0;
  const table = RITUAL.locationBonus as Record<string, number>;
  return table[locationId] ?? 0;
}

export function timeBonusOf(timeOfDay: TimeOfDay): number {
  const table = RITUAL.timeBonus as Record<string, number>;
  return table[timeOfDay] ?? 0;
}

export function weatherBonusOf(weather: WeatherId): number {
  const table = RITUAL.weatherBonus as Record<string, number>;
  return table[weather] ?? 0;
}

export function witnessBonusOf(witnessCount: number): number {
  const capped = Math.min(Math.max(0, witnessCount), RITUAL.witnessMax);
  return capped * RITUAL.witnessBonusPer;
}

export function materialBonusOf(mainMaterialId: string | null): number {
  const table = RITUAL.materialQuality as Record<string, number>;
  return table[materialGradeOf(mainMaterialId)] ?? 0;
}

/**
 * 成功率拆解。
 * 前五项 = W5 的 `computePromotionSuccess` 展开，后六项 = 仪式的配置加成。
 */
export function ritualChance(input: RitualChanceInput): RitualChanceBreakdown {
  const state = input.state;
  const base = PROMOTION.base;
  const dig = PROMOTION.digBonus * (state.dig / 100);
  const sequence = -PROMOTION.sequencePenalty * (9 - state.sequence);
  const mad = -PROMOTION.madPenalty * (state.mad / 100);
  const cor = -PROMOTION.corPenalty * (state.cor / 100);
  const failStreak = input.fails >= PROMOTION.failStreakThreshold ? PROMOTION.failStreakBonus : 0;

  const location = locationBonusOf(input.locationId);
  const time = timeBonusOf(input.timeOfDay);
  const weather = weatherBonusOf(input.weather);
  const witness = witnessBonusOf(input.witnessCount);
  const material = materialBonusOf(input.mainMaterialId);
  const interference = input.interferenceCount * RITUAL.interferencePenalty;

  const raw = base + dig + sequence + mad + cor + failStreak + location + time + weather + witness + material + interference;
  const final = clamp(raw, PROMOTION.floor, RITUAL.successCap);
  return {
    base,
    dig,
    sequence,
    mad,
    cor,
    failStreak,
    location,
    time,
    weather,
    witness,
    material,
    interference,
    raw,
    final,
    capped: raw > RITUAL.successCap,
    floored: raw < PROMOTION.floor,
  };
}

/** W5 公式本身（用于单测的恒等式：五项之和必须等于它） */
export function w5Chance(input: RitualChanceInput): number {
  return computePromotionSuccess(input.state);
}

/**
 * 预览：拆解 + 提醒 + 能不能开始。
 * 「能不能开始」只看配置是否完整，不看材料（材料在命令层查，纯函数不读库）。
 */
export function ritualPreview(input: RitualChanceInput): RitualPreview {
  const breakdown = ritualChance(input);
  const notes: string[] = [];
  const pct = (value: number): string => (value * 100).toFixed(1) + '%';

  // MAD / COR 惩罚提示 —— 这是本轮专门补的 UX 缺口
  if (breakdown.mad <= -0.05) {
    notes.push('MAD 惩罚正在压低你的成功率（' + pct(breakdown.mad) + '）。当前 MAD ' + Math.round(input.state.mad) + '，.休息 一次可降 5。');
  }
  if (breakdown.cor <= -0.03) {
    notes.push('COR 惩罚正在压低你的成功率（' + pct(breakdown.cor) + '）。当前 COR ' + Math.round(input.state.cor) + '，.净化 一次可降 15。');
  }
  if (input.interferenceCount > 0) {
    notes.push('这个仪式已经被干扰 ' + input.interferenceCount + ' 次（' + pct(breakdown.interference) + '）—— 换个地方或者先把人赶走。');
  }
  if (breakdown.capped) {
    notes.push('成功率已经顶到上限 ' + pct(RITUAL.successCap) + '，再加配置也不会更高 —— 可以考虑省下材料。');
  }
  if (breakdown.floored) {
    notes.push('成功率已经低到下限 ' + pct(PROMOTION.floor) + '，这样开始基本等于送材料。');
  }
  if (!input.locationId) {
    notes.push('还没有选地点。地点加成从 ' + pct(Math.min(...Object.values(RITUAL.locationBonus as Record<string, number>))) + ' 到 ' + pct(Math.max(...Object.values(RITUAL.locationBonus as Record<string, number>))) + '，值得挑一挑。');
  }

  const canStart = input.locationId !== null;
  const preview: RitualPreview = { breakdown, notes, canStart };
  if (!canStart) preview.blockedReason = '还没有选地点（.仪式 地点 <地点名>）。';
  return preview;
}

/** 一行百分比（+10.0% / -4.5%） */
export function signedPct(value: number): string {
  return (value >= 0 ? '+' : '') + (value * 100).toFixed(1) + '%';
}

/** 把拆解渲染成任务书 §3.2 那种「一行一项」的清单 */
export function renderBreakdownLines(breakdown: RitualChanceBreakdown, labels: {
  location: string;
  time: string;
  weather: string;
  witness: string;
  material: string;
}): string[] {
  const lines: string[] = [];
  lines.push('基础成功率（W5 公式）：' + signedPct(breakdown.base));
  lines.push('消化度（DIG）：' + signedPct(breakdown.dig));
  lines.push('序列：' + signedPct(breakdown.sequence));
  lines.push('地点（' + labels.location + '）：' + signedPct(breakdown.location));
  lines.push('时段（' + labels.time + '）：' + signedPct(breakdown.time));
  lines.push('天气（' + labels.weather + '）：' + signedPct(breakdown.weather));
  lines.push('见证人（' + labels.witness + '）：' + signedPct(breakdown.witness));
  lines.push('材料（' + labels.material + '）：' + signedPct(breakdown.material));
  lines.push('MAD 惩罚：' + signedPct(breakdown.mad));
  lines.push('COR 惩罚：' + signedPct(breakdown.cor));
  if (breakdown.failStreak > 0) {
    lines.push('连续失败保护：' + signedPct(breakdown.failStreak));
  }
  if (breakdown.interference !== 0) {
    lines.push('被干扰：' + signedPct(breakdown.interference));
  }
  return lines;
}