/**
 * 告警（W6 封测）：只在「需要人工介入」时触发，避免告警疲劳。
 *   - 死循环比例超过开关阈值（默认 5%）
 *   - 失控触发率异常（单日超过 20%，说明数值或行为异常）
 *   - 应急开关被打开（记录一次，便于复盘）
 */
import { getSwitches } from '../config/switches.ts';
import { computeGameplayStats } from './stats.ts';
import type { Db } from '../infra/db/sqlite.ts';

export interface Alert {
  level: 'P0' | 'P1';
  code: string;
  message: string;
  value: number;
  threshold: number;
  hint: string;
}

export function checkAlerts(db: Db, date: string): Alert[] {
  const switches = getSwitches();
  const gameplay = computeGameplayStats(db);
  const alerts: Alert[] = [];

  if (gameplay.deadlockRate > switches.deadlockAlertThreshold) {
    alerts.push({
      level: 'P0',
      code: 'DEADLOCK_RATE',
      message: '死循环比例超过阈值：有角色 DIG 达标但 MAD/COR 双双越线，卡在序列 9',
      value: gameplay.deadlockRate,
      threshold: switches.deadlockAlertThreshold,
      hint: '打开 EMERGENCY_PURIFY_HALF=1（净化消耗减半）或发放圣盐，并在当天日报里记录',
    });
  }

  if (gameplay.lostControlRate > 0.2) {
    alerts.push({
      level: 'P1',
      code: 'LOST_CONTROL_RATE',
      message: '失控触发率异常偏高（按角色日统计超过 20%）',
      value: gameplay.lostControlRate,
      threshold: 0.2,
      hint: '先看是不是有人在刷高 MAD 玩法，再决定要不要动数值（封测期原则上不动）',
    });
  }

  if (switches.purifyHalfCost) {
    alerts.push({
      level: 'P1',
      code: 'EMERGENCY_SWITCH_ON',
      message: '应急开关已打开：净化消耗减半',
      value: 1,
      threshold: 0,
      hint: '复盘时必须记录开关的开启与关闭时间，并在封测报告里说明影响面',
    });
  }

  void date;
  return alerts;
}

export function renderAlerts(alerts: readonly Alert[]): string[] {
  return alerts.map(
    (alert) =>
      `[${alert.level}] ${alert.code}：${alert.message}（实测 ${(alert.value * 100).toFixed(2)}%，阈值 ${(alert.threshold * 100).toFixed(2)}%）→ ${alert.hint}`,
  );
}
