/**
 * 崩溃恢复（W5 运维项）：进程重启后把「本该发生但没发生」的事补上。
 *   1) SQLite 一致性自检（quick_check）
 *   2) 超时交易解冻
 *   3) 补跑当天未执行的每日结算
 *   4) M2.2：补跑错过的世界 tick（轻 tick 每小时 / 重 tick 每天，按 world_ticks 幂等去重）
 */
import { runDailyTick } from './tick.ts';
import { advanceWorld } from './world-tick.ts';
import { expireStaleTrades } from '../router/commands/common.ts';
import type { RouterDeps } from '../router/index.ts';
import { dateKey } from './date.ts';

export interface RecoveryReport {
  integrity: 'ok' | 'issues';
  integrityDetail?: string;
  pendingTrades: number;
  expiredTrades: number;
  tickSkipped: boolean;
  date: string;
  notes: string[];
  /** M2.2：启动时补跑的世界 tick（轻 / 重） */
  worldLightTicks: number;
  worldHeavyTicks: number;
}

export function checkIntegrity(deps: RouterDeps): { ok: boolean; detail?: string } {
  try {
    const rows = deps.db.prepare('PRAGMA quick_check').all() as Array<Record<string, unknown>>;
    const values = rows.map((row) => String(Object.values(row)[0] ?? ''));
    const bad = values.filter((value) => value !== 'ok');
    return bad.length === 0 ? { ok: true } : { ok: false, detail: bad.join('; ') };
  } catch (error) {
    return { ok: false, detail: (error as Error).message };
  }
}

export function runStartupRecovery(deps: RouterDeps, now: number): RecoveryReport {
  const notes: string[] = [];
  const integrity = checkIntegrity(deps);
  if (!integrity.ok) notes.push(`数据库自检异常：${integrity.detail ?? '未知'}`);

  const pendingTrades = deps.trades.listPending().length;
  const expiredTrades = expireStaleTrades(deps, now);
  if (expiredTrades > 0) notes.push(`解冻 ${expiredTrades} 笔超时交易`);

  const tick = runDailyTick(deps, now);
  if (tick.skipped) notes.push('当天每日结算已执行过，跳过补跑');
  else notes.push(`补跑每日结算：${tick.characters} 个角色`);

  // M2.2：世界时钟与天气的补跑（force 忽略进程内缓存；world_ticks 保证不重复结算）
  const world = advanceWorld(deps, now, { force: true });
  if (world.light.executed > 0) notes.push(`补跑世界轻 tick：${world.light.executed} 小时`);
  if (world.heavy.executed > 0) notes.push(`补跑世界重 tick：${world.heavy.executed} 天`);
  for (const item of world.broadcasts) deps.broadcast?.(item.text, item.buttons);

  return {
    integrity: integrity.ok ? 'ok' : 'issues',
    ...(integrity.detail ? { integrityDetail: integrity.detail } : {}),
    pendingTrades,
    expiredTrades,
    tickSkipped: tick.skipped,
    date: dateKey(now),
    notes,
    worldLightTicks: world.light.executed,
    worldHeavyTicks: world.heavy.executed,
  };
}
