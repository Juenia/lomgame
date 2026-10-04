/**
 * QQ 网关**会话的落盘**（M2.76）
 *
 * ## 解决什么问题
 *
 * 官方网关支持「恢复登录态」：断线后带着 \`session_id\` + \`seq\` 发 op 6 Resume，
 * 平台会把**断线期间漏掉的事件补发**回来。本仓库在 M2.44 就实现了 resume —— 但它只在
 * **同一个进程内**有效：\`session_id\` 活在内存里，进程一重启就没了。
 *
 * 而运营期重启是常态（改配置、发版、崩了自动拉起）。每次重启的代价是两件事：
 *
 *   1. **消耗一次 \`session_start_limit\` 配额**（一天 1500 次，重启风暴真的会烧光；
 *      烧光之后当天再也连不上，而现象和「凭证错」一模一样）；
 *   2. **丢掉重启期间的事件** —— 玩家在那几十秒里发的消息永远不会被处理，
 *      而机器人看起来「启动正常、连接正常」，没人会发现。
 *
 * 第 2 条是真正要命的：静默丢消息。
 *
 * ## 一条必须写清楚的未知
 *
 * **官方文档没有写 session 的过期时间。** 社区口径是「断开后短时间内可恢复」
 * （同类机制在 Discord 是几分钟）。所以这里的设计原则是**尽力而为**：
 *
 *   · 读到就用，读到也不用它做任何判断 —— 它只是「一个可以试试的起点」；
 *   · 平台说不行（回 4006 无效 session / 4009 会话超时）时，
 *     走的是 M2.75 已经做好的分档：**清掉会话、重新 identify**，然后 clear() 掉这份落盘。
 *
 * 换句话说：这份文件**永远不会**让机器人连不上，只可能让它少烧一次配额、少丢一批事件。
 *
 * ## 三个实现上的取舍
 *
 * 1. **节流写**：\`seq\` 每来一条事件就变，逐条落盘等于把磁盘当日志写。
 *    默认 500ms 合并一次。**方向是安全的**：落盘的 seq 只会**偏旧**，
 *    而 resume 用偏旧的 seq 会让平台**多补发**几条（重复），不会漏发。
 *    重复由既有的幂等层兜着 —— 宁可重复，不可丢失。
 * 2. **原子写**：先写 \`xxx.tmp\` 再 rename。半截文件在下次启动时会被当成「没有会话」，
 *    那正是我们要避免的情况。
 * 3. **读不动就当没有**：文件被截断、字段类型不对、权限不足 —— 一律返回 null。
 *    启动路径上不许因为一份缓存文件抛异常。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** 落盘的会话状态。字段名与网关那边一一对应，不做美化 */
export interface QQSessionState {
  sessionId: string;
  /** 最近一次收到的事件序号；null = 还没收到过带序号的事件 */
  seq: number | null;
  /** 上次握手拿到的 wss 地址（重连时优先复用，省一次 REST） */
  url: string | null;
  savedAt: number;
}

export interface QQSessionStoreOptions {
  /** 合并写的间隔（毫秒），默认 500。见文件头第 1 条取舍 */
  throttleMs?: number;
  /** 可注入时钟（测试用） */
  now?: () => number;
  /** 打印落盘失败的原因（默认吞掉：缓存写不进去不该影响机器人跑） */
  onError?: (message: string) => void;
}

export class QQSessionStore {
  readonly #file: string;
  readonly #throttleMs: number;
  readonly #now: () => number;
  readonly #onError: ((message: string) => void) | undefined;
  #pending: QQSessionState | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  /** 观测：真正落盘过几次（后台面板与测试都用它确认节流生效） */
  writes = 0;
  /** 观测：resume 被平台拒绝后清过几次盘 */
  clears = 0;

  constructor(file: string, options: QQSessionStoreOptions = {}) {
    this.#file = file;
    this.#throttleMs = options.throttleMs ?? 500;
    this.#now = options.now ?? (() => Date.now());
    this.#onError = options.onError;
  }

  get file(): string {
    return this.#file;
  }

  /**
   * 读上次的会话。
   *
   * ⚠️ 任何异常都返回 null —— 启动路径上不许因为一份缓存文件崩掉。
   * 字段类型不对（比如 seq 是字符串）也当没有：宁可多烧一次配额，不要带着脏数据去 resume。
   */
  load(): QQSessionState | null {
    if (!existsSync(this.#file)) return null;
    try {
      const parsed = JSON.parse(readFileSync(this.#file, 'utf8')) as Partial<QQSessionState>;
      const sessionId = parsed?.sessionId;
      if (typeof sessionId !== 'string' || sessionId.length === 0) return null;
      const seq = typeof parsed.seq === 'number' && Number.isFinite(parsed.seq) ? parsed.seq : null;
      const url = typeof parsed.url === 'string' && parsed.url.length > 0 ? parsed.url : null;
      const savedAt = typeof parsed.savedAt === 'number' ? parsed.savedAt : 0;
      return { sessionId, seq, url, savedAt };
    } catch (error) {
      this.#onError?.('读会话缓存失败（按「没有会话」处理）：' + (error as Error).message);
      return null;
    }
  }

  /** 记下最新会话；真正落盘按 throttleMs 合并 */
  save(state: QQSessionState): void {
    this.#pending = state;
    if (this.#timer !== null) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.flush();
    }, this.#throttleMs);
    // 定时器不该拖住进程退出（CLI 与测试里尤其明显）
    this.#timer.unref?.();
  }

  /** 立刻落盘（进程退出前、或测试里不想等节流） */
  flush(): void {
    if (this.#pending === null) return;
    const state = { ...this.#pending, savedAt: this.#now() };
    this.#pending = null;
    try {
      mkdirSync(dirname(this.#file), { recursive: true });
      const tmp = this.#file + '.tmp';
      writeFileSync(tmp, JSON.stringify(state), 'utf8');
      // 先写临时文件再 rename：半截文件会被下次启动当成「没有会话」，那是我们要避免的
      renameSync(tmp, this.#file);
      this.writes += 1;
    } catch (error) {
      this.#onError?.('写会话缓存失败（忽略，不影响运行）：' + (error as Error).message);
    }
  }

  /**
   * 会话作废（平台回了 4006 / 4009 或 resume 被拒）：把盘上那份删掉。
   *
   * 不删的话，下次重启还会拿着这个已经死掉的 session 去 resume —— 白等一轮往返，
   * 平台再回一次 4006，然后才重新 identify。
   */
  clear(): void {
    this.#pending = null;
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    try {
      rmSync(this.#file, { force: true });
      this.clears += 1;
    } catch (error) {
      this.#onError?.('删会话缓存失败：' + (error as Error).message);
    }
  }
}
