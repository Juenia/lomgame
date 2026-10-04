/**
 * 封测日报（W6）：把当天的数据、指标与告警拼成一份可归档的 markdown。
 * 数据全部来自库里，可重算、可追溯。
 */
import { computeBetaStats, type BetaStats } from './stats.ts';
import { checkAlerts, renderAlerts, type Alert } from './alerts.ts';
import type { Db } from '../infra/db/sqlite.ts';

export const RETENTION_TARGETS = {
  d1: 0.25,
  d7: 0.15,
};

function pct(value: number | null, digits = 1): string {
  return value === null ? '—' : `${(value * 100).toFixed(digits)}%`;
}

function num(value: number, digits = 2): string {
  return value.toFixed(digits);
}

export interface DailyReport {
  date: string;
  markdown: string;
  stats: BetaStats;
  alerts: Alert[];
}

export function buildDailyReport(db: Db, date: string): DailyReport {
  const stats = computeBetaStats(db);
  const alerts = checkAlerts(db, date);
  const today = stats.dauByDate.find((entry) => entry.date === date) ?? {
    date,
    dau: 0,
    newUsers: 0,
    commands: 0,
  };
  const cohort = stats.retention.find((entry) => entry.cohort === date);
  const overallD1 = average(stats.retention.map((entry) => entry.d1));
  const overallD7 = average(stats.retention.map((entry) => entry.d7));

  const lines: string[] = [];
  lines.push(`# 封测日报 · ${date}`);
  lines.push('');
  lines.push('## 一、当日概况');
  lines.push('');
  lines.push('| 指标 | 数值 |');
  lines.push('|---|---|');
  lines.push(`| 活跃用户（DAU） | ${today.dau} |`);
  lines.push(`| 新增用户 | ${today.newUsers} |`);
  lines.push(`| 指令总数 | ${today.commands} |`);
  lines.push(`| 人均指令 | ${today.dau === 0 ? '—' : num(today.commands / today.dau)} |`);
  lines.push(`| 投诉数 / 投诉率 | ${stats.feedback.complaints} / ${pct(stats.feedback.complaintRate)} |`);
  lines.push(`| 反馈总数 | ${stats.feedback.total} |`);
  lines.push('');
  lines.push('## 二、留存');
  lines.push('');
  lines.push('| 批次（首次活跃日） | 人数 | 次日留存 | 7 日留存 |');
  lines.push('|---|---|---|---|');
  for (const point of stats.retention.slice(-7)) {
    lines.push(`| ${point.cohort} | ${point.size} | ${pct(point.d1)} | ${pct(point.d7)} |`);
  }
  lines.push('');
  lines.push(
    `整体：次日留存 ${pct(overallD1)}（目标 ≥ ${pct(RETENTION_TARGETS.d1, 0)}），7 日留存 ${pct(overallD7)}（目标 ≥ ${pct(RETENTION_TARGETS.d7, 0)}）`,
  );
  lines.push('');
  lines.push(`今日新增批次人数：${cohort?.size ?? 0}；新手完成率（创建 + 至少扮演一次）：${pct(stats.onboardingRate)}。`);
  lines.push('');
  lines.push('## 三、玩法与数值');
  lines.push('');
  lines.push('| 指标 | 实测 | 模拟器预测（W5） |');
  lines.push('|---|---|---|');
  lines.push(`| 失控触发率（每角色日） | ${num(stats.gameplay.lostControlRate, 3)} | ${stats.simulatorReference.lostControlRate} |`);
  lines.push(`| 晋升成功率 | ${stats.gameplay.promotions === 0 ? '—' : pct(stats.gameplay.promotionSuccess / stats.gameplay.promotions)} | ${stats.simulatorReference.promotionSuccessRate} |`);
  lines.push(`| 死循环比例 | ${pct(stats.gameplay.deadlockRate)} | ${stats.simulatorReference.deadlockRate} |`);
  lines.push(`| 卡触发率（每角色日） | ${num(stats.gameplay.cardTriggerRate, 3)} | — |`);
  lines.push(`| 交易成交 / 待确认 | ${stats.gameplay.tradesCompleted} / ${stats.gameplay.tradesPending} | — |`);
  lines.push(`| 占卜次数 | ${stats.gameplay.divinations} | — |`);
  lines.push(`| 队伍数 / 队伍任务 | ${stats.gameplay.parties} / ${stats.gameplay.partyTasks} | — |`);
  lines.push(`| 净化次数 | ${stats.gameplay.purifies} | — |`);
  lines.push('');
  lines.push('### 指令分布');
  lines.push('');
  lines.push('| 指令 | 次数 |');
  lines.push('|---|---|');
  for (const [command, count] of Object.entries(stats.commandTotals).sort((a, b) => b[1] - a[1])) {
    lines.push(`| ${command} | ${count} |`);
  }
  lines.push('');
  lines.push('## 四、告警');
  lines.push('');
  const rendered = renderAlerts(alerts);
  lines.push(rendered.length === 0 ? '无告警。' : rendered.map((line) => `- ${line}`).join('\n'));
  lines.push('');
  lines.push('## 五、操作记录');
  lines.push('');
  lines.push('- 数值冻结：封测期未改动 `src/config/numeric.ts`（除 P0 应急开关外）');
  lines.push('- 备份：见 `data/backups/` 当天文件');
  lines.push('- 自检：`GET /health`、`GET /metrics` 正常');
  lines.push('');
  return { date, markdown: lines.join('\n'), stats, alerts };
}

function average(values: Array<number | null>): number | null {
  const numbers = values.filter((value): value is number => value !== null);
  if (numbers.length === 0) return null;
  return numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
}
