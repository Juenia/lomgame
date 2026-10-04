/**
 * 出站队列（游戏 → 上游）。
 *
 * ## 为什么要有队列，而不是直接把回执塞进 HTTP 响应
 *
 * 判定层的产出是**异步**的：世界会自己往前走（`advanceWorld` 一次可以补 72 个 tick），
 * 主动播报不属于任何一条入站请求。所以「回执跟着请求返回」这条路**只覆盖得了一半** ——
 * 世界播报没有请求可以搭车。
 *
 * 于是定成：**一切都进队列**（有序、有 seq），同步返回只是把这一批也塞进响应体。
 * 这样两条路是同一份数据，不存在「同步模式丢播报」这种只在生产上出现的问题。
 *
 * ## 它会丢东西，所以要让人看得见
 *
 * 队列在内存里（进程重启即空），并且有容量上限（默认 500 条）——
 * 上游离线太久时，最旧的会被挤掉。挤掉这件事**必须显式告诉上游**（`gap: true`），
 * 否则上游只会觉得"世界突然安静了"。
 */
import type { OutboundItem, OutboundResponse } from './protocol.ts';

/** 队列里的一条（还没分配 seq 的半成品） */
export type PendingItem = Omit<OutboundItem, 'seq' | 'createdAt'>;

export interface TakeOptions {
  /** 我已经处理到 seq = cursor；返回 seq > cursor 的那些 */
  cursor: number;
  limit: number;
  /**
   * 只看发给这条上游的（含主动推送 `platform === undefined` 的那些）。
   * 不填 = 不分平台（单上游部署时最省事）。
   */
  platform?: string;
}

export interface OutboxStats {
  size: number;
  firstSeq: number | null;
  lastSeq: number | null;
  /** 因为容量上限被挤掉的条数（累计） */
  dropped: number;
  /** 正挂着的长轮询请求数（排查"上游是不是断了"最直接的一个数） */
  waiters: number;
}

export class Outbox {
  #items: OutboundItem[] = [];
  #nextSeq = 1;
  #capacity: number;
  #dropped = 0;
  #waiters = new Set<() => void>();

  constructor(capacity = 500) {
    // 容量至少留一条：写 0 会让队列变成一个"只看得到最新一条"的怪东西
    this.#capacity = Math.max(1, Math.floor(capacity));
  }

  push(item: PendingItem, createdAt: number): OutboundItem {
    const full: OutboundItem = { ...item, seq: this.#nextSeq, createdAt };
    this.#nextSeq += 1;
    this.#items.push(full);
    while (this.#items.length > this.#capacity) {
      this.#items.shift();
      this.#dropped += 1;
    }
    // 唤醒所有长轮询：有新东西了
    for (const wake of [...this.#waiters]) wake();
    return full;
  }

  /**
   * 取一批。
   *
   * `cursor` 的两种用法都是对的：
   *   · `0` = 我什么都没收过；
   *   · 上次响应里的 `cursor` = 接着上次往下取。
   */
  take(options: TakeOptions): OutboundResponse {
    const limit = Math.max(1, Math.min(200, Math.floor(options.limit)));
    const earliest = this.#items[0]?.seq;
    /*
     * 「游标太旧」的判据：我还没取到的那一段里，**已经有被挤掉的**。
     * 队列非空时，最早还留着的那条前面若还有没被取走的（cursor < earliest - 1），
     * 中间就是断的 —— 这时候不报 gap，上游会以为自己只是还没收到。
     */
    const gap = earliest !== undefined && options.cursor > 0 && options.cursor < earliest - 1;
    const items: OutboundItem[] = [];
    let cursor = options.cursor;
    for (const item of this.#items) {
      if (item.seq <= options.cursor) continue;
      if (options.platform !== undefined && item.platform !== undefined && item.platform !== options.platform) continue;
      items.push(item);
      if (items.length >= limit) break;
    }
    if (items.length > 0) cursor = items[items.length - 1]!.seq;
    return {
      ok: true,
      items,
      cursor,
      ...(gap ? { gap: true } : {}),
      ...(earliest !== undefined ? { earliest } : {}),
    };
  }

  /**
   * 等一条新数据（长轮询）。
   *
   * ⚠️ 调用方必须**先 take 再 wait**：take 是同步的，两者之间没有 await，
   * 所以不存在"刚 take 完、wait 还没注册就来了新数据"的丢唤醒窗口。
   * 顺序写反了就会时不时多等一个完整的 waitMs（表现为"偶尔卡半分钟"）。
   */
  wait(waitMs: number, options: { unref?: boolean } = {}): Promise<void> {
    if (waitMs <= 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const wake = (): void => {
        clearTimeout(timer);
        this.#waiters.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, waitMs);
      /*
       * 默认**不** unref —— 一个承诺会 resolve 的 Promise 必须有自己的计时源。
       *
       * unref 的定时器不保持事件循环：事件循环一空，它就不会再触发，
       * 于是这个 Promise 永远悬着。那个症状很难认（测试里报的是
       * "Promise resolution is still pending but the event loop has already resolved"）。
       *
       * 真正需要 unref 的只有服务端的长轮询（挂 25 秒不该拖住关服）——
       * 由调用方显式传 `{ unref: true }`，见 src/server.ts。
       */
      if (options.unref === true) timer.unref?.();
      this.#waiters.add(wake);
    });
  }

  get stats(): OutboxStats {
    return {
      size: this.#items.length,
      firstSeq: this.#items[0]?.seq ?? null,
      lastSeq: this.#items[this.#items.length - 1]?.seq ?? null,
      dropped: this.#dropped,
      waiters: this.#waiters.size,
    };
  }

  /** 只给测试与关服用 */
  clear(): void {
    this.#items = [];
    for (const wake of [...this.#waiters]) wake();
  }
}
