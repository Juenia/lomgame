/**
 * M2.13.1 任务 A / 任务 B **共用的异常清单口径**。
 *
 * ## 为什么单独抽一个模块
 *
 * DEADLOCK 名单在任务 A（交叉取证）与任务 B（8→7 分层）里都要用。
 * M2.13.1 最初的报告把关闭那轮的 67 条 P1 整体写成「空转扮演又回来了」，
 * 根子就是**同一个数在两份报告里各写了一遍、口径不一致**。
 * 抽成一份之后，改一次两边都对。
 *
 * ## 口径（三条，与任务书 §二 一致）
 *
 * - **玩家编号**：虚拟玩家序号 #N → user_id = 700000 + N → characters.id = 'c-' + user_id
 *   （映射写在 src/vplayer/profiles.ts）。
 * - **DEADLOCK 名单从异常清单读**，不从库里重算 —— 它是**时点判据**
 *   （DIG 达标 + 序列 9 + MAD/COR 双越线），最终快照上 MAD/COR 已经变了，重算必然漏。
 * - **P1 总数以清单条目为准**，表头计数只用来交叉验证。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** 虚拟玩家 user_id 基数（src/vplayer/profiles.ts） */
export const USER_ID_BASE = 700000;

export interface AnomalyLine {
  code: string;
  playerId: number;
  day: number;
  command: string;
  detail: string;
  raw: string;
}

export interface ShardAnomalies {
  shard: number;
  p0: number;
  p1: number;
  items: AnomalyLine[];
}

export interface DeadlockPlayer {
  shard: number;
  playerId: number;
  lines: AnomalyLine[];
}

export interface AnomalySummary {
  shards: ShardAnomalies[];
  p0: number;
  p1: number;
  byCode: Map<string, number>;
  deadlock: DeadlockPlayer[];
}

const ANOMALY_LINE = /^- \[([A-Z_]+)\]\s+玩家#(\d+)\s+第(\d+)天\s+「(.*?)」：(.*)$/;

/** 解析一份 prefix-shardN-异常.md 的 P0/P1 清单 */
export function parseAnomalyReport(text: string): { p0: number; p1: number; items: AnomalyLine[] } {
  let p0 = 0;
  let p1 = 0;
  const header = /P0：(\d+) 条；P1：(\d+) 条/.exec(text);
  if (header) {
    p0 = Number(header[1]);
    p1 = Number(header[2]);
  }
  const items: AnomalyLine[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const m = ANOMALY_LINE.exec(line);
    if (!m) continue;
    items.push({
      code: m[1]!,
      playerId: Number(m[2]),
      day: Number(m[3]),
      command: m[4]!,
      detail: m[5]!,
      raw: line,
    });
  }
  return { p0, p1, items };
}

export function readAnomalyReport(prefix: string, shard: number): ShardAnomalies {
  const path = join('docs', prefix + '-shard' + shard + '-异常.md');
  if (!existsSync(path)) return { shard, p0: 0, p1: 0, items: [] };
  const parsed = parseAnomalyReport(readFileSync(path, 'utf8'));
  return { shard, p0: parsed.p0, p1: parsed.p1, items: parsed.items };
}

/** 把一批分片的异常清单汇总，并按 code 分类、把 DEADLOCK 按玩家归并 */
export function summarizeAnomalies(prefix: string, shards: number): AnomalySummary {
  const list = Array.from({ length: shards }, (_, i) => readAnomalyReport(prefix, i));
  const byCode = new Map<string, number>();
  const deadlockByPlayer = new Map<string, DeadlockPlayer>();
  for (const a of list) {
    for (const item of a.items) {
      byCode.set(item.code, (byCode.get(item.code) ?? 0) + 1);
      if (item.code !== 'DEADLOCK') continue;
      const key = a.shard + '#' + item.playerId;
      const entry = deadlockByPlayer.get(key) ?? { shard: a.shard, playerId: item.playerId, lines: [] };
      entry.lines.push(item);
      deadlockByPlayer.set(key, entry);
    }
  }
  const deadlock = [...deadlockByPlayer.values()].sort((a, b) => a.shard - b.shard || a.playerId - b.playerId);
  return {
    shards: list,
    p0: list.reduce((sum, a) => sum + a.p0, 0),
    p1: list.reduce((sum, a) => sum + a.p1, 0),
    byCode,
    deadlock,
  };
}

/** DEADLOCK 玩家的稳定键：'<分片>#<玩家号>' */
export const deadlockKeyOf = (shard: number, playerId: number): string => shard + '#' + playerId;
export const cidOf = (playerId: number): string => 'c-' + (USER_ID_BASE + playerId);

