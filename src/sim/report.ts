/**
 * 模拟报告渲染（W5）：把 SimReport 变成 markdown / JSON。
 * 报告里必须写清 seed 与关键旋钮，保证「可复现」不只是口号。
 */
import type { SimReport } from './simulator.ts';

function pct(value: number, digits = 1): string {
  return `${(value * 100).toFixed(digits)}%`;
}

function fixed(value: number, digits = 2): string {
  return value.toFixed(digits);
}

/** 目标区间（W5 任务书给定），用来自动判断是否达标 */
export interface TargetCheck {
  name: string;
  actual: string;
  target: string;
  pass: boolean;
}

export const W5_TARGETS = {
  steadyLostControlRate: { min: 0, max: 0.1, label: '稳健型失控触发率（30 天）< 10%' },
  aggressiveLostControlRate: { min: 0.2, max: 0.4, label: '激进型失控触发率（30 天）20%—40%' },
  steadyPromotionRate: { min: 0.7, max: 0.85, label: '稳健型晋升成功率 70%—85%' },
  aggressivePromotionRate: { min: 0.5, max: 0.7, label: '激进型晋升成功率 50%—70%' },
  deadlockRate: { min: 0, max: 0.05, label: '死循环比例 < 5%' },
  aggressivePurifyUsage: { min: 0.3, max: 1, label: '激进型净化使用率 > 30%' },
  materialRatio: { min: 0.8, max: 1.2, label: '材料消耗/产出比 0.8—1.2' },
};

export function checkTargets(report: SimReport): TargetCheck[] {
  const s = report.summary;
  const checks: TargetCheck[] = [];
  if (report.config.strategy === 'steady') {
    checks.push({
      name: W5_TARGETS.steadyLostControlRate.label,
      actual: pct(s.lostControlRate),
      target: '< 10%',
      pass: s.lostControlRate < W5_TARGETS.steadyLostControlRate.max,
    });
    // 只有真的晋升过才有成功率可言（稳健型 DIG 未必攒得够）
    checks.push({
      name: W5_TARGETS.steadyPromotionRate.label,
      actual: s.promotionAttempts > 0 ? pct(s.promotionSuccessRate) : '未发起晋升',
      target: '70%—85%',
      pass:
        s.promotionAttempts > 0 &&
        s.promotionSuccessRate >= W5_TARGETS.steadyPromotionRate.min &&
        s.promotionSuccessRate <= W5_TARGETS.steadyPromotionRate.max,
    });
  }
  if (report.config.strategy === 'aggressive') {
    checks.push({
      name: W5_TARGETS.aggressiveLostControlRate.label,
      actual: pct(s.lostControlRate),
      target: '20%—40%',
      pass:
        s.lostControlRate >= W5_TARGETS.aggressiveLostControlRate.min &&
        s.lostControlRate <= W5_TARGETS.aggressiveLostControlRate.max,
    });
    checks.push({
      name: W5_TARGETS.aggressivePromotionRate.label,
      actual: s.promotionAttempts > 0 ? pct(s.promotionSuccessRate) : '未发起晋升',
      target: '50%—70%',
      pass:
        s.promotionAttempts > 0 &&
        s.promotionSuccessRate >= W5_TARGETS.aggressivePromotionRate.min &&
        s.promotionSuccessRate <= W5_TARGETS.aggressivePromotionRate.max,
    });
    checks.push({
      name: W5_TARGETS.aggressivePurifyUsage.label,
      actual: pct(s.purifyUsageRate),
      target: '> 30%',
      pass: s.purifyUsageRate > W5_TARGETS.aggressivePurifyUsage.min,
    });
  }
  checks.push({
    name: W5_TARGETS.deadlockRate.label,
    actual: pct(s.deadlockRate),
    target: '< 5%',
    pass: s.deadlockRate < W5_TARGETS.deadlockRate.max,
  });
  checks.push({
    name: W5_TARGETS.materialRatio.label,
    actual: fixed(s.materialRatio),
    target: '0.8—1.2',
    pass: s.materialRatio >= W5_TARGETS.materialRatio.min && s.materialRatio <= W5_TARGETS.materialRatio.max,
  });
  return checks;
}

export function renderMarkdown(report: SimReport, options: { title?: string } = {}): string {
  const s = report.summary;
  const lines: string[] = [];
  lines.push(`## ${options.title ?? `${report.config.strategyName} · ${report.config.characterCount} 角色 × ${report.config.days} 天`}`);
  lines.push('');
  lines.push(`- seed：\`${report.config.seed}\`（同 seed 同配置必然产出同一份报告）`);
  lines.push(`- 策略：${report.config.strategyName}（\`${report.config.strategy}\`）`);
  lines.push(
    `- 关键旋钮：divisor=${report.numeric.divisor} · 暴露概率=${report.numeric.exposureChance} · DIG 门槛=${report.numeric.digThreshold} · 失败惩罚 MAD+${report.numeric.madOnFail}/COR+${report.numeric.corOnFail} · 每日恢复 MP+${report.numeric.mpRestore} · 净化 COR${report.numeric.purifyCor}（材料 ${report.numeric.purifyMaterials}）`,
  );
  lines.push('');
  lines.push('### 汇总');
  lines.push('');
  lines.push('| 指标 | 数值 |');
  lines.push('|---|---|');
  lines.push(`| 失控触发率（30 天内至少一次） | ${pct(s.lostControlRate)} |`);
  lines.push(`| 人均失控次数 | ${fixed(s.lostControlPerCharacterAvg)} |`);
  lines.push(`| 晋升发起 / 成功率 | ${s.promotionAttempts} / ${s.promotionAttempts > 0 ? pct(s.promotionSuccessRate) : '—'} |`);
  lines.push(`| 死循环比例（DIG 达标但 COR ≥ ${report.numeric.divisor === 0 ? 0 : 70}） | ${pct(s.deadlockRate)} |`);
  lines.push(`| 净化使用率 / 休息使用率 | ${pct(s.purifyUsageRate)} / ${pct(s.restUsageRate)} |`);
  lines.push(`| 材料消耗 / 产出 / 比值 | ${s.itemsConsumed} / ${s.itemsGained} / ${fixed(s.materialRatio)} |`);
  lines.push(`| 期末均值 DIG / MAD / COR / HP | ${fixed(s.finalDigAvg)} / ${fixed(s.finalMadAvg)} / ${fixed(s.finalCorAvg)} / ${fixed(s.finalHpAvg, 1)} |`);
  lines.push(`| 序列分布 | ${Object.entries(s.sequenceDistribution).map(([seq, n]) => `序列${seq}:${n}`).join(' ')} |`);
  lines.push('');
  lines.push('### 目标区间核对');
  lines.push('');
  lines.push('| 目标 | 实测 | 结论 |');
  lines.push('|---|---|---|');
  for (const check of checkTargets(report)) {
    lines.push(`| ${check.name}（${check.target}） | ${check.actual} | ${check.pass ? '达标' : '未达标'} |`);
  }
  lines.push('');
  lines.push('### 按天曲线');
  lines.push('');
  lines.push('| 天 | DIG | MAD | COR | HP | 失控 | 恢复 | 晋升尝试/成功 | 净化 | 休息 | 材料产出/消耗 |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const day of report.daily) {
    lines.push(
      `| ${day.day + 1} | ${fixed(day.digAvg)} | ${fixed(day.madAvg)} | ${fixed(day.corAvg)} | ${fixed(day.hpAvg, 1)} | ${day.lostControl} | ${day.recovered} | ${day.promotionsAttempted}/${day.promotionsSucceeded} | ${day.purifies} | ${day.rests} | ${day.itemsGained}/${day.itemsConsumed} |`,
    );
  }
  lines.push('');
  lines.push('### 晋升成功率分布（按序列跳转）');
  lines.push('');
  lines.push('| 跳转 | 尝试 | 成功 | 成功率 |');
  lines.push('|---|---|---|---|');
  for (const [key, entry] of Object.entries(s.promotionSuccessRateBySequence)) {
    lines.push(`| ${key} | ${entry.attempts} | ${entry.success} | ${pct(entry.rate)} |`);
  }
  if (Object.keys(s.promotionSuccessRateBySequence).length === 0) {
    lines.push('| — | 0 | 0 | — |');
  }
  return lines.join('\n');
}

export function renderJson(report: SimReport): string {
  return JSON.stringify(report, null, 2);
}

/** 一行摘要，便于调参时快速扫多个组合 */
export function renderOneLine(report: SimReport): string {
  const s = report.summary;
  return [
    `strategy=${report.config.strategy}`,
    `n=${report.config.characterCount}`,
    `days=${report.config.days}`,
    `seed=${report.config.seed}`,
    `失控率=${pct(s.lostControlRate)}`,
    `晋升成功率=${s.promotionAttempts > 0 ? pct(s.promotionSuccessRate) : '—'}(${s.promotionAttempts})`,
    `死循环=${pct(s.deadlockRate)}`,
    `净化率=${pct(s.purifyUsageRate)}`,
    `材料比=${fixed(s.materialRatio)}`,
    `期末DIG=${fixed(s.finalDigAvg)}`,
  ].join(' ');
}
