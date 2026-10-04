/**
 * 世界播报的合并与限流（M2.39）
 *
 * ## 为什么需要它
 *
 * 配额被打爆的根因不是「推送本身」，是**同一 tick 内逐条推**：
 * `advanceWorld` 一次调用可以补齐 72 个轻 tick + 14 个重 tick（`maxCatchUpLight` /
 * `maxCatchUpHeavy`），而每一格的天气异象 / 天气预告 / 世界事件都各自 `broadcast` 一次，
 * 每一次又对**每个群**发一遍 ⇒ 加速 30 天就是几千条主动消息。
 *
 * 正常运行下 30 天 = 30 条，离 1000 条/天很远 —— 所以要动的只有「一条 tick 推 N 条」
 * 与「连续 tick 连推」这两件事，不改判定的任何一行。
 *
 * ## 两条措施
 *
 * 1. **合并**（任务 1 / 3）：一次 `advanceWorld`（= 一个 tick）最多产出 **1 条**播报文本。
 *    逐格的播报素材先收集、最后合成一条；批量补跑时进一步聚合成「过去 N 天」的总结。
 * 2. **限流**（任务 2）：同一群主动播报每分钟最多 1 条，超出的**入队攒批**、下一分钟并发一条。
 *    阈值 1 条/分钟是由配额反推的：1000 条/天 ÷ 1440 分钟 ≈ 0.7，取 1 留余量。
 *
 * ⚠️ 「合并播报文本」对**数字回复**是安全的：世界事件的数字回复读的是
 * `WorldEventRepo.latestLive()`（库里最新一条还有效的事件），**不是**从播报文本里对编号
 * （见 src/router/menu.ts 的 MenuService.pick）。所以把 N 段菜单拼进一条消息，
 * 「群里看到播报 → 私聊回数字」这条链路一字不变。
 */
import { TokenBucket } from './ratelimit.ts';

/**
 * 同一群主动播报的**长期补充速率**。
 *
 * ## 依据是官方现行文档，不是我猜的
 *
 * 用户让我「去看 QQ 机器人的官方文档，主动推送是已经下放了」。查证（bot.qq.com）：
 *
 *   主动消息频控规则
 *     · Bot 维度（发送方）：企业认证/个人身份证认证 60/qpm；未认证 30/qpm
 *     · 单关系维度（接收方）：20/qpm，每个群 1 天最多接收 1000 条
 *
 * 取 **3 秒/条 = 20 条/分钟** —— 正好是**单群接收上限**（20/qpm），
 * 再快就会被平台限流；而每群每天 1000 条的额度，按这个速率跑满一小时也才用掉 1200，
 * 正常运行时远远碰不到。
 *
 * ⚠️ **我上一版写的是 1 条/分钟，依据是一份过期的文档**（那里写着「主动消息每月 4 条」，
 *    以及「主动推送能力于 2025-04-21 起不再提供」）。那份是 GitHub 上的 `tencent-connect/bot-docs`
 *    归档，已经不对了 —— 现行文档在 bot.qq.com，主动推送**是开着**的。
 *    教训：**查平台能力要认准现行文档域名**，归档仓库里的红框公告可能早已撤销。
 */
export const BROADCAST_MIN_INTERVAL_MS = 3_000;

/**
 * 出队节拍：队列多久检查一次（M2.86）。

 * 用户：「主动推送如果短时间内多次推送，增加下推送延迟队列」。
 *
 * 与上面那个**不是一回事**，所以拆成两个常量：
 *   · `BROADCAST_MIN_INTERVAL_MS` 管**长期速率**（令牌多久补一个 ⇒ 配额安全）；
 *   · 这个管**检查频率**（队列多久看一眼 ⇒ 有令牌时多快发出去）。
 *
 * 原来两者共用一个 60 秒：于是攒下的第二条要等整整一分钟才动，
 * 「短时间内多次推送」看起来就像卡住了。现在 5 秒看一次，
 * 只要桶里有令牌就立刻发 —— 长期速率不变，突发响应快得多。
 */
export const BROADCAST_FLUSH_INTERVAL_MS = 5_000;

/**
 * 突发容量：桶里最多攒几个令牌（M2.86）。
 *
 * capacity 1 时，「同一批产生的 3 条世界事件」会被拉成 3 分钟才发完 ——
 * 而它们本来就是**同时发生**的，玩家隔一分钟收到一条会以为世界在挤牙膏。
 *
 * 给到 3：允许短时间连发 3 条，长期速率仍由补充速率守着。
 * 这个数只影响「一批事件」的观感，不影响配额的安全性。
 */
const BROADCAST_BURST = 3;

/**
 * 把若干段播报文本合成一条。
 *
 * 空段（全空白）丢掉；一段都没有时返回 null（= 不发，而不是发一条空消息 ——
 * 一条空播报比不播报更糟：它会被玩家当成"世界出事了但没说"）。
 */
export function mergeBroadcastParts(parts: readonly string[]): string | null {
  const kept: string[] = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed.length > 0) kept.push(trimmed);
  }
  if (kept.length === 0) return null;
  return kept.join('\n');
}

/** 一次立即投递的判定结果 */
export type BroadcastDecision = 'sent' | 'queued';

/**
 * 播报按钮的**最小形状**（M2.86）。
 *
 * 为什么不用 adapter 的 `ButtonSpec`：`infra` 不该依赖 `adapter` ——
 * 而这里需要的只是「一个标签 + 一条指令」，两边结构相同、语义一致，
 * 用结构类型自然对上，不需要引入依赖。
 */
export interface BroadcastButton {
  label: string;
  /** 完整指令原文（不含前导点号）—— 点了等于手打这条 */
  command: string;
}

export interface FlushedBroadcast {
  /** group_openid（QQ 官方通道）/ 群号（OneBot）—— 一律当成不透明字符串 */
  groupId: string;
  text: string;
  /** 事件底部附的原始按钮（可选） */
  buttons?: BroadcastButton[];
}

/**
 * 主动播报的限流器（M2.39 任务 2）。
 *
 * 形状是**令牌桶 + 每群一条待发槽**，不是「拒绝」：
 * 超限的播报**不丢**，进队列等下一分钟；到点时同群积压的几条**合并成一条**发出去
 * —— 这正好就是任务书说的「攒到下一分钟发」。
 *
 * 队列按群各一条（而不是一个数组）：同一群里积压 N 条主动播报，
 * 对玩家来说就是一串连推，合并成一条才是「攒批」；保序由「有积压就不再抢令牌」保证。
 *
 * 时钟全部由调用方注入（`now`），所以它可测、也不依赖墙上时间。
 */
export class BroadcastThrottle {
  #bucket: TokenBucket;
  #queues = new Map<string, Array<{ text: string; buttons?: BroadcastButton[] }>>();

  constructor(
    minIntervalMs: number = BROADCAST_MIN_INTERVAL_MS,
    burst: number = BROADCAST_BURST,
  ) {
    /*
     * M2.86：capacity 从 1 提到 `BROADCAST_BURST`。
     *
     * 原来写的是「capacity 1 ⇒ 不存在攒几个令牌连推几条的窗口」。那个考虑本身没错
     * （连推确实会刷屏），但代价是**同一批事件被硬拉成一分钟一条**：
     * 三次异象同时发生，玩家要隔三分钟才收全，看起来像世界卡住了。
     *
     * 现在给 3：一批最多连发 3 条，再多就得等令牌 ——
     * 既不会刷屏，也不会把「同时发生」演成「陆续发生」。
     */
    this.#bucket = new TokenBucket({ capacity: burst, refillPerSec: 1000 / minIntervalMs });
  }

  /**
   * 尝试投递一条。
   *
   * **已有积压时一律排队**（不再抢令牌）：否则积压的几条会卡在队列里，
   * 而新的一条插队先发 —— 玩家看到的世界动态会倒序。
   */
  offer(groupId: string, text: string, now: number, buttons?: BroadcastButton[]): BroadcastDecision {
    const queued = this.#queues.get(groupId);
    if (queued) {
      queued.push({ text, buttons });
      return 'queued';
    }
    if (this.#bucket.consume(groupId, now).ok) return 'sent';
    this.#queues.set(groupId, [{ text, buttons }]);
    return 'queued';
  }

  /**
   * 把**已经到点**的群出队。
   *
   * ## M2.86：改成「一次只出一条」，不再合并
   *
   * 用户：「没必要整合在一起了，主动推送如果短时间内多次推送，增加下推送延迟队列，
   *        事件底部附带对应的原始按钮」
   *
   * 原来这里把同群积压的几条 `mergeBroadcastParts` **并成一条**发。那样做的问题是：
   * 合并后只有**最后一条事件**能拿到待答菜单，而前面几条的编号还挂在正文里 ——
   * 玩家看到「1. 去皇家剧院看看」，回 `1` 却执行了别的事件。
   *
   * 现在每条**各自成一条消息**，靠 `minIntervalMs` 错开发送：
   * 既不会同一秒刷屏，也不会出现「编号指向别的消息」。
   * 积压的留在队列里等下一次 flush，顺序不变（`offer` 那条「已有积压就不插队」仍然守着）。
   */
  flush(now: number): FlushedBroadcast[] {
    const out: FlushedBroadcast[] = [];
    // 拷贝一份再遍历：循环里会删键
    for (const [groupId, queued] of [...this.#queues]) {
      if (!this.#bucket.consume(groupId, now).ok) continue;
      const item = queued.shift();
      if (item === undefined) { this.#queues.delete(groupId); continue; }
      if (queued.length === 0) this.#queues.delete(groupId);
      out.push(item.buttons !== undefined
        ? { groupId, text: item.text, buttons: item.buttons }
        : { groupId, text: item.text });
    }
    return out;
  }

  /** 该群还积压着几条（排查与测试用） */
  pendingOf(groupId: string): number {
    return this.#queues.get(groupId)?.length ?? 0;
  }

  /** 还有几个群在排队 */
  get pendingGroups(): number {
    return this.#queues.size;
  }
}
