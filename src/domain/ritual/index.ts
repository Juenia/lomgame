/**
 * 晋升仪式（M2.5）域层出口。
 *
 * 目录结构：
 *   types.ts         数据形状（RitualConfig / RitualChanceBreakdown / RitualResult）
 *   preview.ts       成功率拆解（W5 公式展开 + 配置加成 + MAD/COR 拆开显示）
 *   resolve.ts       三阶段判定与失败惩罚
 *   interference.ts  干扰判定
 *
 * 一句话：**判定层没有 IO** —— 命令层负责查库、拼输入、落库、播报，这里只做算术。
 */
export * from './types.ts';
export {
  locationBonusOf,
  materialBonusOf,
  materialGradeOf,
  renderBreakdownLines,
  ritualChance,
  ritualPreview,
  signedPct,
  timeBonusOf,
  w5Chance,
  weatherBonusOf,
  witnessBonusOf,
} from './preview.ts';
export {
  materialLossOf,
  outcomeLine,
  resolveRitualFuse,
  resolveRitualSetup,
  type RitualFuseInput,
  type RitualFuseResult,
  type RitualSetupInput,
  type RitualSetupResult,
} from './resolve.ts';
export { interferenceChance, resolveInterference, type ResolveInterferenceInput } from './interference.ts';