/**
 * M2.13.1：**原始 DIG / MAD / COR 序列的取数** + **口径 B 的判定**（唯一一份实现）。
 *
 * ## 为什么抽出来
 *
 * 两处都要用：
 *   - scripts/m2-13-1-deadlock-recount.ts（卡死判据重审报告）
 *   - scripts/m2-13-1-8to7-attribution.ts（8→7 归因报告的 §2.2.1 分层表）
 * 如果各写一份，口径就会漂移 —— M2.13.1 已经因为「同一个数写两遍」被打回过一次。
 *
 * ## 取数口径（写死）
 *
 * 1. **指令流**：行为日志 JSONL，每条指令一行，带 playerId/day/login/step；
 *    按 (day, login, step) 排序 —— 那就是这个玩家自己的时间序。
 * 2. **数值**：domain_events 里 dig_delta / mad_delta / cor_delta 的 payload.after。
 *    这三类事件的 seed 形如 onebot:vp-<playerId>-<day>-<login>-<step>:c-XXXXXX:<ts>，
 *    **seed 里直接编码了触发它的那条指令的位置**，所以逐条精确对齐，不猜时间戳。
 * 3. **没有事件的指令**（纯读指令如 .状态）：沿用上一条的值。
 * 4. **序列**：pathway_initiated → 9；sequence_delta 用 payload.after；promotion_success 用 payload.to。
 * 5. 起手 DIG / MAD / COR = 0，序列 = null（还没入途径）。
 *
 * ## 口径 B（定义写死，报告与脚本共用同一份说明）
 *
 * | 项 | 值 |
 * | --- | --- |
 * | 「达标」阈值 | DIG 首次 ≥ 序列 9 门槛（60）—— **只看 60，不看 85** |
 * | 「回落」定义 | 达标之后出现 DIG **< 门槛（60）** —— 门槛本身，不是门槛 − 5 |
 * | 「连续」窗口 | 玩家自己的指令流上 **≥ 10 次**（含 .状态 这类纯读指令） |
 * | 起点 | 首次达标那条指令**之后** |
 * | 命中 | 存在至少一段满足上面三条 |
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { NUMERIC } from '../src/config/numeric.ts';
import { readAnomalyReport } from './m2-13-1-anomaly-lib.ts';

/** 序列 9 → 8 的 DIG 门槛（从配置读，不手抄） */
export const DIG_THRESHOLD = NUMERIC.promotion.digThreshold;
/** 序列 8 → 7 的门槛（只用来解释「峰值到没到过 85」） */
export const DIG_THRESHOLD_SEQ7 = NUMERIC.sequence7.digThreshold;
/** 字面判据 1 的阈值 = 门槛 − 5 */
export const STRICT_LIMIT = DIG_THRESHOLD - 5;
/** 「连续 N 次指令」的 N */
export const RUN = 10;
/** DEADLOCK 判据的两条线（口径 C 与 P1 同源） */
export const MAD_LIMIT = NUMERIC.lossOfControl.deadlockMadThreshold;
export const COR_LIMIT = NUMERIC.lossOfControl.deadlockCorThreshold;
/** 虚拟玩家 user_id 基数（src/vplayer/profiles.ts） */
export const USER_ID_BASE = 700000;

export interface Cmd {
  day: number;
  login: number;
  step: number;
  command: string;
}

export interface PlayerSeries {
  shard: number;
  playerId: number;
  /** 每条指令之后的 DIG / MAD / COR */
  dig: number[];
  mad: number[];
  cor: number[];
  /** 每条指令之后的序列（null = 还没入途径） */
  seq: Array<number | null>;
  commands: Cmd[];
  finalSequence: number | null;
  /** 对照：P1 清单里这个玩家的 DEADLOCK 条数 */
  deadlockLines: number;
}

export interface AfterReadyDetail {
  hit: boolean;
  firstIndex: number;
  firstDay: number;
  runLength: number;
  minDig: number;
  minDay: number;
  /** 最长回落段之后是否又回到门槛以上 */
  recovered: boolean;
}

export const SEED_POS = /^onebot:vp-(\d+)-(\d+)-(\d+)-(\d+):/;
export const posKey = (day: number, login: number, step: number): string => day + '-' + login + '-' + step;
export const nameOf = (s: PlayerSeries): string => 'shard' + s.shard + '/#' + s.playerId;

/** 最长连续低于 limit 的段（返回长度与结束下标） */
export function longestRunUnder(values: readonly number[], limit: number): { length: number; end: number } {
  let best = 0;
  let bestEnd = -1;
  let cur = 0;
  for (let i = 0; i < values.length; i += 1) {
    if (values[i]! < limit) {
      cur += 1;
      if (cur > best) {
        best = cur;
        bestEnd = i;
      }
    } else {
      cur = 0;
    }
  }
  return { length: best, end: bestEnd };
}

/** 首次 DIG ≥ 门槛的位置（-1 = 从没到过） */
export function firstReadyAt(s: PlayerSeries): number {
  return s.dig.findIndex((d) => d >= DIG_THRESHOLD);
}

/** 口径 B 的完整明细 */
export function afterReadyDetail(s: PlayerSeries): AfterReadyDetail {
  const empty: AfterReadyDetail = {
    hit: false,
    firstIndex: -1,
    firstDay: -1,
    runLength: 0,
    minDig: 0,
    minDay: -1,
    recovered: false,
  };
  const first = firstReadyAt(s);
  if (first < 0) return empty;
  const tail = s.dig.slice(first);
  const run = longestRunUnder(tail, DIG_THRESHOLD);
  if (run.length < RUN) {
    return { ...empty, firstIndex: first, firstDay: s.commands[first]!.day };
  }
  const start = run.end - run.length + 1;
  let minDig = Number.POSITIVE_INFINITY;
  let minDay = -1;
  for (let i = start; i <= run.end; i += 1) {
    if (tail[i]! < minDig) {
      minDig = tail[i]!;
      minDay = s.commands[first + i]!.day;
    }
  }
  return {
    hit: true,
    firstIndex: first,
    firstDay: s.commands[first]!.day,
    runLength: run.length,
    minDig: Number.isFinite(minDig) ? minDig : 0,
    minDay,
    recovered: tail.slice(run.end + 1).some((d) => d >= DIG_THRESHOLD),
  };
}

export function hitAfterReady(s: PlayerSeries): boolean {
  return afterReadyDetail(s).hit;
}

/** 任务书字面判据：DIG 曾连续 ≥ RUN 次指令都低于 limit */
export function hitsLiteral(s: PlayerSeries, limit: number): boolean {
  return longestRunUnder(s.dig, limit).length >= RUN;
}

/** 口径 C：够门槛却过不去（DEADLOCK 判据的独立实现），返回命中的指令条数 */
export function countBlocked(s: PlayerSeries): number {
  let n = 0;
  for (let i = 0; i < s.dig.length; i += 1) {
    if (
      s.dig[i]! >= DIG_THRESHOLD &&
      s.seq[i] === 9 &&
      s.mad[i]! >= MAD_LIMIT &&
      s.cor[i]! >= COR_LIMIT
    ) {
      n += 1;
    }
  }
  return n;
}

/** 从一片的「行为日志 + 库 + 异常清单」读出全部玩家的 DIG/MAD/COR/序列 时间序列 */
export function readShardSeries(roundKey: string, shard: number): Map<number, PlayerSeries> {
  const logPath = join('docs', roundKey + '-shard' + shard + '-行为日志.jsonl');
  const dbPath = join('data', roundKey + '-shard-' + shard + '.db');
  const out = new Map<number, PlayerSeries>();
  if (!existsSync(logPath) || !existsSync(dbPath)) return out;

  const commands = new Map<number, Cmd[]>();
  for (const line of readFileSync(logPath, 'utf8').split('\n')) {
    if (line.trim().length === 0) continue;
    const rec = JSON.parse(line) as Cmd & { playerId: number };
    const list = commands.get(rec.playerId) ?? [];
    list.push({ day: rec.day, login: rec.login, step: rec.step, command: rec.command });
    commands.set(rec.playerId, list);
  }
  for (const list of commands.values()) {
    list.sort((a, b) => a.day - b.day || a.login - b.login || a.step - b.step);
  }

  const db = new DatabaseSync(dbPath, { readOnly: true });
  const buckets: Array<[string, Map<number, Map<string, number>>]> = [
    ['dig_delta', new Map()],
    ['mad_delta', new Map()],
    ['cor_delta', new Map()],
    ['seq', new Map()],
  ];
  const rows = db
    .prepare(
      'SELECT payload, seed, type FROM domain_events ' +
        "WHERE type IN ('dig_delta','mad_delta','cor_delta','sequence_delta','promotion_success','pathway_initiated') " +
        'ORDER BY id',
    )
    .all() as Array<{ payload: string; seed: string | null; type: string }>;
  for (const row of rows) {
    const m = SEED_POS.exec(String(row.seed ?? ''));
    if (!m) continue;
    const pid = Number(m[1]);
    const key = posKey(Number(m[2]), Number(m[3]), Number(m[4]));
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(row.payload) as Record<string, unknown>;
    } catch {
      payload = {};
    }
    const bucketName =
      row.type === 'dig_delta'
        ? 'dig_delta'
        : row.type === 'mad_delta'
          ? 'mad_delta'
          : row.type === 'cor_delta'
            ? 'cor_delta'
            : 'seq';
    const after =
      bucketName === 'seq'
        ? row.type === 'pathway_initiated'
          ? 9
          : Number(payload.after ?? payload.to)
        : Number(payload.after);
    if (!Number.isFinite(after)) continue;
    const bucket = buckets.find(([name]) => name === bucketName)![1];
    const per = bucket.get(pid) ?? new Map<string, number>();
    per.set(key, after);
    bucket.set(pid, per);
  }

  const finalSeq = new Map<number, number | null>();
  for (const row of db.prepare('SELECT user_id, sequence FROM characters').all() as Array<{
    user_id: string;
    sequence: number | null;
  }>) {
    finalSeq.set(Number(row.user_id) - USER_ID_BASE, row.sequence === null ? null : Number(row.sequence));
  }
  db.close();

  const deadlocks = new Map<number, number>();
  for (const item of readAnomalyReport(roundKey, shard).items) {
    if (item.code !== 'DEADLOCK') continue;
    deadlocks.set(item.playerId, (deadlocks.get(item.playerId) ?? 0) + 1);
  }

  const per = (name: string): Map<number, Map<string, number>> =>
    buckets.find(([n]) => n === name)![1];
  for (const [playerId, list] of commands) {
    const digPer = per('dig_delta').get(playerId) ?? new Map<string, number>();
    const madPer = per('mad_delta').get(playerId) ?? new Map<string, number>();
    const corPer = per('cor_delta').get(playerId) ?? new Map<string, number>();
    const seqPer = per('seq').get(playerId) ?? new Map<string, number>();
    let dig = 0;
    let mad = 0;
    let cor = 0;
    let seq: number | null = null;
    const digSeries: number[] = [];
    const madSeries: number[] = [];
    const corSeries: number[] = [];
    const seqSeries: Array<number | null> = [];
    for (const cmd of list) {
      const key = posKey(cmd.day, cmd.login, cmd.step);
      const d = digPer.get(key);
      if (d !== undefined) dig = d;
      const m = madPer.get(key);
      if (m !== undefined) mad = m;
      const c = corPer.get(key);
      if (c !== undefined) cor = c;
      const s = seqPer.get(key);
      if (s !== undefined) seq = s;
      digSeries.push(dig);
      madSeries.push(mad);
      corSeries.push(cor);
      seqSeries.push(seq);
    }
    out.set(playerId, {
      shard,
      playerId,
      dig: digSeries,
      mad: madSeries,
      cor: corSeries,
      seq: seqSeries,
      commands: list,
      finalSequence: finalSeq.get(playerId) ?? null,
      deadlockLines: deadlocks.get(playerId) ?? 0,
    });
  }
  return out;
}
