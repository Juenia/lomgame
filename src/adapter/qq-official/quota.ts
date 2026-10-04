/**
 * 会话配额账本（M2.76b）
 *
 * ## 它管的是哪一件事
 *
 * 官方 \`session_start_limit\` 是**每天能建立几次网关会话**的额度（真机实测 total=1500）。
 * 消耗它的只有一个动作：**op 2 identify**（也就是「重新登录」）。op 6 resume **不消耗**。
 *
 * M2.75 把配额变成了看得见的数（体检 / \`/health\` / 后台面板）。但「看得见」还不够 ——
 * 真正会出事的是**重连风暴**：平台抖动 → 断线 → 重连 → identify → 再断 → 再重连……
 * 一小时能烧掉几百次。烧光之后当天再也连不上，**而现象和「凭证错」一模一样**。
 *
 * 这个类把「看得见」变成「管得住」：
 *
 *   1. 每次 identify 前问一句能不能连（\`canStartSession\`）；
 *   2. 每次 identify 之后**乐观扣减**一次（不等下一次体检 —— 那样会滞后一整个窗口）；
 *   3. 配额见底时不再重连，而是等到配额重置（\`resetAfterMs\`）—— **什么都不做，比乱试更接近恢复**；
 *   4. 有会话可 resume 时**不受配额限制**：resume 不消耗额度，
 *      这也正是「重启续接」在配额见底时的额外价值。
 *
 * ## 两个刻意的设计
 *
 * - **乐观扣减**：平台的真实余量只有 \`GET /gateway/bot\` 知道，两次查询之间我们只能自己记。
 *   扣多了（比如 identify 其实失败了）顶多让我们早一点停下重连 —— 那是安全方向；
 *   扣少了则会让风暴烧得更久。**宁可保守**。
 * - **不知道配额时一律放行**：从没查过配额（\`remaining === null\`）就不拦。
 *   拦的依据必须是「确知没额度了」，不能是「不知道」—— 后者会让一次网络抖动变成停机。
 *
 * 纯逻辑、零 IO、可注入时钟，所以能直接在 Node 里测（\`test/m2-76-qq-quota.test.ts\`）。
 */

export interface SessionQuotaSnapshot {
  total: number;
  remaining: number;
  resetAfterMs: number;
  /** 拿到这份数据的时刻（本地时钟） */
  at: number;
}

export interface QuotaDecision {
  ok: boolean;
  /** 不能连的原因（给日志与面板看的整句话） */
  reason: string | null;
  /** 建议等多久再试（毫秒）；0 = 不用等 */
  waitMs: number;
}

export interface SessionQuotaOptions {
  /** 观测：低于这个数就开始往日志里说 */
  warnBelow?: number;
  /** 可注入时钟 */
  now?: () => number;
}

export class SessionQuota {
  #snapshot: SessionQuotaSnapshot | null = null;
  /** 上次体检之后我们自己扣掉的次数 */
  #spentSinceSnapshot = 0;
  readonly #warnBelow: number;
  readonly #now: () => number;
  /** 观测：被配额拦下过几次（>0 说明重连风暴被挡住了） */
  blocked = 0;

  constructor(options: SessionQuotaOptions = {}) {
    this.#warnBelow = options.warnBelow ?? 50;
    this.#now = options.now ?? (() => Date.now());
  }

  /** 体检 / 后台刷新拿到新的余量时喂进来（会清掉乐观扣减的历史） */
  update(snapshot: { total: number; remaining: number; resetAfterMs: number }): void {
    this.#snapshot = { ...snapshot, at: this.#now() };
    this.#spentSinceSnapshot = 0;
  }

  /** 当前余量（考虑乐观扣减）。从没查过就是 null */
  get remaining(): number | null {
    if (this.#snapshot === null) return null;
    return Math.max(0, this.#snapshot.remaining - this.#spentSinceSnapshot);
  }

  get total(): number | null {
    return this.#snapshot?.total ?? null;
  }

  get snapshot(): SessionQuotaSnapshot | null {
    return this.#snapshot;
  }

  /** 距离配额重置还有多久（毫秒）。没数据就是 null */
  get resetInMs(): number | null {
    if (this.#snapshot === null) return null;
    const elapsed = this.#now() - this.#snapshot.at;
    return Math.max(0, this.#snapshot.resetAfterMs - elapsed);
  }

  /** 这次能不能建会话（identify） */
  canStartSession(): QuotaDecision {
    const remaining = this.remaining;
    if (remaining === null) {
      // 不知道就不拦：拦的依据必须是「确知没额度」，不能是「不知道」
      return { ok: true, reason: null, waitMs: 0 };
    }
    if (remaining > 0) return { ok: true, reason: null, waitMs: 0 };
    this.blocked += 1;
    const waitMs = this.resetInMs ?? 0;
    return {
      ok: false,
      reason:
        '今天的会话配额已经用尽（' + this.#snapshot?.total + ' 次全部用完）。' +
        '再 identify 只会继续失败 —— 等配额重置，或先查日志里是不是在反复重连。',
      waitMs,
    };
  }

  /**
   * 记一次 identify（乐观扣减）。
   *
   * 注意：**resume 不走这里** —— op 6 不消耗配额，这也是配额见底时 resume 的价值。
   */
  noteIdentify(): void {
    this.#spentSinceSnapshot += 1;
  }

  /** 后台面板/日志用的一行话 */
  describe(): string {
    const remaining = this.remaining;
    if (remaining === null) return '会话配额未知（还没查过 /gateway/bot）';
    const total = this.#snapshot?.total ?? 0;
    const resetIn = this.resetInMs;
    const tail = resetIn === null || resetIn <= 0 ? '即将重置' : '约 ' + Math.round(resetIn / 60000) + ' 分钟后重置';
    return '今日会话配额还剩 ' + remaining + '/' + total + '（' + tail + '）';
  }

  /** 余量偏低（体检与后台用它决定要不要变色） */
  get low(): boolean {
    const remaining = this.remaining;
    return remaining !== null && remaining <= this.#warnBelow;
  }
}
