/**
 * 异常检测（W7）：每条指令后与每天结束时各查一遍。
 *   P0：HTTP 非 200、属性越界、资源不一致
 *   P1：响应 > 5 秒、同一指令连续 10 次无状态变化、死循环
 */
import { NUMERIC } from '../config/numeric.ts';
import type { Db } from '../infra/db/sqlite.ts';
import type { AnomalyRecord, ActionRecord, PlayerSnapshot } from './types.ts';

export const SLOW_RESPONSE_MS = 5000;
export const NO_CHANGE_STREAK = 10;

export const STAT_RANGES: Record<string, [number, number]> = {
  hp: [0, 100],
  mp: [0, 100],
  mad: [0, 100],
  cor: [0, 100],
  dig: [0, 100],
  dp: [0, 10],
  sequence: [0, 9],
};

/**
 * 能力会改上限（战士序列 8：HP 上限 +10）—— 校验必须跟着改，
 * 否则合法值 105 会被误判成 P0（W7 第一轮就踩到了这个假阳性）。
 */
export type StatCaps = Record<string, readonly [number, number]>;

export function checkAction(input: {
  record: ActionRecord;
  noChangeStreak: number;
}): AnomalyRecord[] {
  const { record } = input;
  const out: AnomalyRecord[] = [];

  if (record.status !== 200) {
    out.push({
      level: 'P0',
      code: 'HTTP_STATUS',
      playerId: record.playerId,
      day: record.day,
      virtualNow: record.virtualNow,
      command: record.command,
      detail: `HTTP ${record.status}`,
    });
  }
  if (record.costMs > SLOW_RESPONSE_MS) {
    out.push({
      level: 'P1',
      code: 'SLOW_RESPONSE',
      playerId: record.playerId,
      day: record.day,
      virtualNow: record.virtualNow,
      command: record.command,
      detail: `响应 ${record.costMs.toFixed(0)}ms > ${SLOW_RESPONSE_MS}ms`,
    });
  }
  if (input.noChangeStreak >= NO_CHANGE_STREAK) {
    out.push({
      level: 'P1',
      code: 'NO_STATE_CHANGE',
      playerId: record.playerId,
      day: record.day,
      virtualNow: record.virtualNow,
      command: record.command,
      detail: `连续 ${input.noChangeStreak} 次指令后角色状态没有变化`,
    });
  }
  return out;
}

/** 属性越界 + 资源一致性（读库校验） */
export function checkSnapshotConsistency(
  db: Db,
  snapshot: PlayerSnapshot,
  where: { playerId: number; day: number; virtualNow: number; command: string },
  caps: StatCaps = {},
): AnomalyRecord[] {
  const out: AnomalyRecord[] = [];
  const push = (code: AnomalyRecord['code'], detail: string): void => {
    out.push({ level: 'P0', code, ...where, detail });
  };

  for (const [field, base] of Object.entries(STAT_RANGES)) {
    const [min, max] = caps[field] ?? base;
    const value = (snapshot as unknown as Record<string, number>)[field];
    if (typeof value !== 'number' || Number.isNaN(value)) {
      push('STAT_OUT_OF_RANGE', `${field} 不是数字：${String(value)}`);
      continue;
    }
    if (value < min || value > max) {
      push('STAT_OUT_OF_RANGE', `${field}=${value} 越界（允许 ${min}—${max}）`);
    }
  }

  for (const slot of snapshot.inventory) {
    if (slot.quantity <= 0) {
      push('RESOURCE_INCONSISTENT', `背包出现非正数量：${slot.itemId} × ${slot.quantity}`);
    }
  }

  const negative = db
    .prepare('SELECT COUNT(*) AS n FROM inventory WHERE character_id = ? AND quantity < 0')
    .get(snapshot.characterId) as { n: number };
  if (negative.n > 0) push('RESOURCE_INCONSISTENT', `库里有 ${negative.n} 条负库存`);

  if (snapshot.partyId) {
    const party = db.prepare('SELECT id FROM parties WHERE id = ? AND status = ?').get(snapshot.partyId, 'active');
    if (!party) push('RESOURCE_INCONSISTENT', `角色报告在队伍 ${snapshot.partyId}，但该队伍不存在或已解散`);
  }

  return out;
}

/** 死循环：DIG 达标 + 仍是序列 9 + MAD/COR 双双越线（与 W5 模拟器同口径） */
export function checkDeadlock(
  snapshot: PlayerSnapshot,
  where: { playerId: number; day: number; virtualNow: number; command: string },
): AnomalyRecord | null {
  if (
    snapshot.sequence === 9 &&
    snapshot.dig >= NUMERIC.promotion.digThreshold &&
    snapshot.mad >= NUMERIC.lossOfControl.deadlockMadThreshold &&
    snapshot.cor >= NUMERIC.lossOfControl.deadlockCorThreshold
  ) {
    return {
      level: 'P1',
      code: 'DEADLOCK',
      ...where,
      detail: `DIG=${snapshot.dig.toFixed(1)} 达标但 MAD=${snapshot.mad}、COR=${snapshot.cor} 双双越线，卡在序列 9`,
    };
  }
  return null;
}

export function renderAnomaly(anomaly: AnomalyRecord): string {
  return `[${anomaly.level}] ${anomaly.code} 玩家#${anomaly.playerId} 第${anomaly.day}天 ${anomaly.command} —— ${anomaly.detail}`;
}
