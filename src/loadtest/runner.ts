/**
 * 压测执行器（W6）：100 并发用户 × 每人 20 条指令。
 * 用户之间并发、单个用户内部串行（模拟真人在群里连续操作）。
 */
import { buildMessageEvent, reportEvent } from './client.ts';
import type { TestServer } from './harness.ts';

export interface LoadOptions {
  users: number;
  perUser: number;
  /** 每条指令的超时（毫秒） */
  timeoutMs?: number;
  /** 前缀，便于区分不同批次 */
  tag?: string;
}

export interface LoadReport {
  users: number;
  perUser: number;
  total: number;
  ok: number;
  errors: number;
  errorRate: number;
  p50Ms: number;
  p90Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  meanMs: number;
  wallMs: number;
  throughputPerSec: number;
  statusCounts: Record<string, number>;
  sampleErrors: string[];
  /** 压测结束时服务进程是否还活着 */
  alive: boolean;
  /** 落库效果：防止「请求被静默丢弃」也算通过 */
  effects: {
    characters: number;
    auditRows: number;
    idempotencyKeys: number;
    userDaily: number;
  };
}

const PATHWAYS = ['愚者', '战士', '不眠者'];
const LOCATIONS = ['廷根市', '迷雾街区', '老码头', '烛火书店', '蒸汽车站'];
const PLAYS = [
  '我占卜今天的运势',
  '我按战士的方式守着这条街',
  '我整夜不睡，盯着黑暗',
  '我观察路过的每一个人',
  '我尝试一段很短的仪式',
];

/** 单用户的 20 条指令脚本（覆盖创建、日常、组队、反馈等主要路径） */
export function commandScript(index: number): string[] {
  const name = `压测者${index}`;
  const pathway = PATHWAYS[index % PATHWAYS.length]!;
  const location = LOCATIONS[index % LOCATIONS.length]!;
  const play = PLAYS[index % PLAYS.length]!;
  return [
    `.创建 ${name} ${pathway}`,
    '.状态',
    '.帮助',
    `.扮演 ${play}`,
    `.探索 ${location}`,
    '.背包',
    '.事件',
    `.扮演 ${play}`,
    '.占卜 今天会出事吗',
    '.队伍 创建',
    '.队伍',
    '.休息',
    '.净化',
    `.探索 ${LOCATIONS[(index + 1) % LOCATIONS.length]}`,
    '.状态',
    `.扮演 ${play}`,
    '.队伍 任务',
    `.反馈 压测第 ${index} 号：这是一条压测反馈`,
    '.背包 1',
    '.状态',
  ];
}

function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[index] ?? 0;
}

export async function runLoad(server: TestServer, options: LoadOptions): Promise<LoadReport> {
  const tag = options.tag ?? 'load';
  const timeoutMs = options.timeoutMs ?? 10_000;
  const started = Date.now();
  const latencies: number[] = [];
  const statusCounts: Record<string, number> = {};
  const sampleErrors: string[] = [];
  let ok = 0;
  let errors = 0;
  let messageSeq = 0;

  await Promise.all(
    Array.from({ length: options.users }, async (_, userIndex) => {
      const userId = String(900000 + userIndex);
      const script = commandScript(userIndex);
      for (let step = 0; step < options.perUser; step += 1) {
        const rawText = script[step % script.length]!;
        messageSeq += 1;
        const event = buildMessageEvent({
          messageId: `${tag}-${messageSeq}`,
          userId,
          rawText,
          scene: step % 3 === 0 ? 'group' : 'private',
          nickname: `压测者${userIndex}`,
        });
        const result = await reportEvent(server.appPort, event, timeoutMs, server.token);
        latencies.push(result.costMs);
        const key = String(result.status);
        statusCounts[key] = (statusCounts[key] ?? 0) + 1;
        if (result.ok) ok += 1;
        else {
          errors += 1;
          if (sampleErrors.length < 5) sampleErrors.push(`${result.error ?? 'unknown'} @ ${rawText}`);
        }
      }
    }),
  );

  // 落库效果核对：事件真的被处理了才会产生这些行
  const db = server.openDb();
  let effects = { characters: 0, auditRows: 0, idempotencyKeys: 0, userDaily: 0 };
  try {
    const one = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;
    effects = {
      characters: one('SELECT COUNT(*) AS n FROM characters'),
      auditRows: one('SELECT COUNT(*) AS n FROM audit_logs'),
      idempotencyKeys: one('SELECT COUNT(*) AS n FROM idempotency_keys'),
      userDaily: one('SELECT COUNT(*) AS n FROM user_daily'),
    };
  } finally {
    db.close();
  }

  const wallMs = Date.now() - started;
  const sorted = [...latencies].sort((a, b) => a - b);
  const meanMs = latencies.reduce((sum, value) => sum + value, 0) / Math.max(1, latencies.length);

  return {
    users: options.users,
    perUser: options.perUser,
    total: latencies.length,
    ok,
    errors,
    errorRate: latencies.length === 0 ? 0 : errors / latencies.length,
    p50Ms: percentile(sorted, 0.5),
    p90Ms: percentile(sorted, 0.9),
    p95Ms: percentile(sorted, 0.95),
    p99Ms: percentile(sorted, 0.99),
    maxMs: sorted[sorted.length - 1] ?? 0,
    meanMs,
    wallMs,
    throughputPerSec: latencies.length / Math.max(0.001, wallMs / 1000),
    statusCounts,
    sampleErrors,
    alive: server.alive(),
    effects,
  };
}

/** 压测阈值（任务书给定） */
export const LOAD_THRESHOLDS = {
  p95Ms: 2000,
  errorRate: 0.001,
  crashes: 0,
};

export function judgeLoad(report: LoadReport): { pass: boolean; failures: string[] } {
  const failures: string[] = [];
  if (report.p95Ms >= LOAD_THRESHOLDS.p95Ms) {
    failures.push(`P95 ${report.p95Ms.toFixed(0)}ms ≥ ${LOAD_THRESHOLDS.p95Ms}ms`);
  }
  if (report.errorRate >= LOAD_THRESHOLDS.errorRate) {
    failures.push(`错误率 ${(report.errorRate * 100).toFixed(3)}% ≥ 0.1%`);
  }
  if (!report.alive) failures.push('服务进程在压测期间退出');
  // 效果校验：请求「200 但什么都没发生」不算通过
  if (report.effects.characters < report.users) {
    failures.push(`只建出 ${report.effects.characters} 个角色（期望 ≥ ${report.users}），可能有请求被静默丢弃`);
  }
  if (report.effects.auditRows < Math.floor(report.total * 0.5)) {
    failures.push(`审计只有 ${report.effects.auditRows} 行（总请求 ${report.total}），处理链路可疑`);
  }
  return { pass: failures.length === 0, failures };
}
