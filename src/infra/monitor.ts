/**
 * 运行监控（W5 运维项）：指令响应时间、错误率、滑动分位。
 * 只统计最近 maxSamples 次调用，内存占用固定；/health 与 /metrics 直接读快照。
 */
export interface CommandMetric {
  command: string;
  count: number;
  errors: number;
  totalMs: number;
  maxMs: number;
  /** 最近一次耗时 */
  lastMs: number;
}

export interface MonitorSnapshot {
  startedAt: number;
  uptimeMs: number;
  total: number;
  errors: number;
  errorRate: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  commands: CommandMetric[];
}

export class Monitor {
  #startedAt: number;
  #maxSamples: number;
  #metrics = new Map<string, CommandMetric>();
  #recent: number[] = [];
  #total = 0;
  #errors = 0;

  constructor(options: { startedAt?: number; maxSamples?: number } = {}) {
    this.#startedAt = options.startedAt ?? Date.now();
    this.#maxSamples = options.maxSamples ?? 500;
  }

  record(command: string, costMs: number, ok = true): void {
    const metric = this.#metrics.get(command) ?? {
      command,
      count: 0,
      errors: 0,
      totalMs: 0,
      maxMs: 0,
      lastMs: 0,
    };
    metric.count += 1;
    metric.totalMs += costMs;
    metric.maxMs = Math.max(metric.maxMs, costMs);
    metric.lastMs = costMs;
    if (!ok) metric.errors += 1;
    this.#metrics.set(command, metric);

    this.#total += 1;
    if (!ok) this.#errors += 1;
    this.#recent.push(costMs);
    if (this.#recent.length > this.#maxSamples) this.#recent.shift();
  }

  snapshot(now: number = Date.now()): MonitorSnapshot {
    const sorted = [...this.#recent].sort((a, b) => a - b);
    const pick = (q: number): number => {
      if (sorted.length === 0) return 0;
      const index = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
      return sorted[index] ?? 0;
    };
    return {
      startedAt: this.#startedAt,
      uptimeMs: now - this.#startedAt,
      total: this.#total,
      errors: this.#errors,
      errorRate: this.#total === 0 ? 0 : this.#errors / this.#total,
      p50Ms: pick(0.5),
      p95Ms: pick(0.95),
      maxMs: sorted[sorted.length - 1] ?? 0,
      commands: [...this.#metrics.values()].sort((a, b) => b.count - a.count),
    };
  }

  reset(): void {
    this.#metrics.clear();
    this.#recent = [];
    this.#total = 0;
    this.#errors = 0;
  }
}
