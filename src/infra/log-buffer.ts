/**
 * 进程内日志环形缓冲（M2.53）。
 *
 * ## 为什么需要它
 *
 * 日志原来只往 stdout 写（data/qq-run.log）。要排查就只能去翻那个文件 ——
 * 而 Windows 上它被进程自己占着、没有轮转，也没法从后台读。
 * 于是「总览上知道有错，却看不到错在哪」。
 *
 * ## 为什么是环形缓冲，而不是写文件
 *
 * 固定容量、固定内存（不会因为跑得久而涨），进程重启就清空 —— 这正是排查
 * 「刚刚发生了什么」需要的窗口。长期留档有别的机制（审计表、日报），
 * 日志不该兼任那件事。
 *
 * ## 两条硬约束
 *
 * 1. **记日志绝不能抛异常**。所以序列化失败会被吞掉换成一句话，
 *    而不是让一个循环引用的 meta 把主流程打挂。
 * 2. **单条有上限**。有的地方会塞整个事件 payload 进来，不截断的话
 *    600 条就能吃掉几十兆。
 */
import { consoleLogger, type Logger } from './logger.ts';

export type LogLevel = 'info' | 'warn' | 'error';

export interface LogEntry {
  seq: number;
  at: number;
  level: LogLevel;
  message: string;
  /** 已经序列化并截断过的 meta（原样存对象会让内存随对象图膨胀） */
  meta?: string;
}

/** 单条 meta 的上限。真机上的事件 payload 能到几 KB */
const META_MAX = 700;

export class LogBuffer {
  readonly capacity: number;
  #entries: LogEntry[] = [];
  #seq = 0;
  #dropped = 0;

  constructor(capacity = 600) {
    this.capacity = Math.max(10, Math.floor(capacity));
  }

  push(level: LogLevel, message: string, meta?: Record<string, unknown>, at = Date.now()): void {
    this.#seq += 1;
    let text: string | undefined;
    if (meta !== undefined && Object.keys(meta).length > 0) {
      try {
        const json = JSON.stringify(meta);
        text = json !== undefined && json.length > META_MAX ? json.slice(0, META_MAX) + '…（截断）' : json;
      } catch {
        // 循环引用 / BigInt：记不下就记个说明，绝不因为日志本身把主流程打挂
        text = '（meta 无法序列化）';
      }
    }
    const entry: LogEntry = { seq: this.#seq, at, level, message };
    if (text !== undefined) entry.meta = text;
    this.#entries.push(entry);
    if (this.#entries.length > this.capacity) {
      this.#entries.splice(0, this.#entries.length - this.capacity);
      this.#dropped += this.#entries.length > 0 ? 1 : 0;
    }
  }

  size(): number {
    return this.#entries.length;
  }

  /** 被挤掉的条数 —— 让人知道这个窗口只覆盖了多久 */
  dropped(): number {
    return this.#dropped;
  }

  /** 最新的在前。level / 关键词都可选 */
  recent(options: { level?: LogLevel; q?: string; limit?: number } = {}): LogEntry[] {
    const limit = Math.min(Math.max(options.limit ?? 200, 1), 1000);
    const q = (options.q ?? '').trim().toLowerCase();
    const out: LogEntry[] = [];
    for (let i = this.#entries.length - 1; i >= 0 && out.length < limit; i -= 1) {
      const e = this.#entries[i]!;
      if (options.level !== undefined && e.level !== options.level) continue;
      if (q !== '' && !(e.message.toLowerCase().includes(q) || (e.meta ?? '').toLowerCase().includes(q))) {
        continue;
      }
      out.push(e);
    }
    return out;
  }

  counts(): { info: number; warn: number; error: number; total: number } {
    const c = { info: 0, warn: 0, error: 0, total: this.#entries.length };
    for (const e of this.#entries) c[e.level] += 1;
    return c;
  }

  clear(): void {
    this.#entries = [];
    this.#dropped = 0;
  }
}

/**
 * 本进程的日志缓冲。
 *
 * 这里用模块级单例是**有意**的：它描述的就是「这个进程」的状态，与进程同生共死，
 * 不存在第二个实例的语义。把它一路穿进 createApp / startHttpServer / AdminContext
 * 只会让每个签名都多一个参数，而那些地方并不关心日志。
 * 测试要隔离就自己 new LogBuffer()，别用这个。
 */
export const processLogs = new LogBuffer(600);

/**
 * 同时写环形缓冲与控制台。
 *
 * 不替代 sink：终端上照旧要看得到（开发时的第一现场），
 * 缓冲只是让后台也能看到同一批东西。
 */
export function bufferedLogger(buffer: LogBuffer, sink: Logger = consoleLogger): Logger {
  return {
    info: (m, meta) => { buffer.push('info', m, meta); sink.info(m, meta); },
    warn: (m, meta) => { buffer.push('warn', m, meta); sink.warn(m, meta); },
    error: (m, meta) => { buffer.push('error', m, meta); sink.error(m, meta); },
  };
}
