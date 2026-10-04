/**
 * 频控（S1 §7）：令牌桶，粒度 = 用户 × 指令，配置化。
 * 数值全部来自需求方案 §12「QQ交互与指令设计」的频控列。
 */
export interface RateLimitConfig {
  /** 令牌上限 */
  capacity: number;
  /** 每秒补充 */
  refillPerSec: number;
}

export interface RateLimitDecision {
  ok: boolean;
  /** 被拒时距离下次可用的毫秒数；终身一次的命令为 Infinity */
  retryAfterMs: number;
}

interface Bucket {
  tokens: number;
  lastRefill: number;
}

export class TokenBucket {
  #config: RateLimitConfig;
  #buckets = new Map<string, Bucket>();

  constructor(config: RateLimitConfig) {
    this.#config = config;
  }

  consume(key: string, now: number): RateLimitDecision {
    const { capacity, refillPerSec } = this.#config;
    let bucket = this.#buckets.get(key);
    if (!bucket) {
      bucket = { tokens: capacity, lastRefill: now };
      this.#buckets.set(key, bucket);
    }

    const elapsedSec = Math.max(0, now - bucket.lastRefill) / 1000;
    bucket.tokens = Math.min(capacity, bucket.tokens + elapsedSec * refillPerSec);
    bucket.lastRefill = now;

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { ok: true, retryAfterMs: 0 };
    }

    const retryAfterMs =
      refillPerSec > 0 ? Math.ceil(((1 - bucket.tokens) / refillPerSec) * 1000) : Infinity;
    return { ok: false, retryAfterMs };
  }

  get size(): number {
    return this.#buckets.size;
  }
}

/** 需求方案 §12 频控列 → 令牌桶参数 */
export const RATE_LIMITS: Record<string, RateLimitConfig> = {
  // 「.创建 1 次/人」是业务唯一性（角色表唯一约束），不是频控：
  // 若做成终身一次的令牌桶，玩家第一次打错参数就永久无法建号。这里只防刷屏。
  创建: { capacity: 5, refillPerSec: 1 / 10 },
  状态: { capacity: 1, refillPerSec: 1 / 5 }, // 5 秒冷却
  帮助: { capacity: 3, refillPerSec: 1 / 5 },
  扮演: { capacity: 1, refillPerSec: 1 / 10 }, // 10 秒冷却
  探索: { capacity: 5, refillPerSec: 1 / 10 }, // 另受 AP 限制
  事件: { capacity: 3, refillPerSec: 1 / 10 }, // 主约束是 AP，这里只防连点
  攻击: { capacity: 1, refillPerSec: 1 / 30 }, // 30 秒一回合
  交易: { capacity: 3, refillPerSec: 1 / 10 },
  组织: { capacity: 3, refillPerSec: 1 / 10 },
  背包: { capacity: 2, refillPerSec: 1 / 5 },
  使用: { capacity: 3, refillPerSec: 1 / 10 },
  魔药: { capacity: 3, refillPerSec: 1 / 30 },
  服用: { capacity: 3, refillPerSec: 1 / 30 },
  确认: { capacity: 5, refillPerSec: 1 / 5 },
  取消: { capacity: 5, refillPerSec: 1 / 5 },
  晋升: { capacity: 1, refillPerSec: 1 / 60 }, // 主约束是材料与消化度
  休息: { capacity: 1, refillPerSec: 1 / 10 },
  净化: { capacity: 1, refillPerSec: 1 / 10 },
  占卜: { capacity: 1, refillPerSec: 1 / 10 }, // 每日次数由 daily_counters 管
  队伍: { capacity: 3, refillPerSec: 1 / 10 },
  反馈: { capacity: 3, refillPerSec: 1 / 60 }, // 防刷，避免把反馈表打满
  // M2.6：通缉系统的两条指令。.袭击 与"攻击"同档（动手是重动作，30 秒一回合）；
  // .举报 的主约束是 AP，这里只防连点。
  袭击: { capacity: 1, refillPerSec: 1 / 30 },
  举报: { capacity: 3, refillPerSec: 1 / 10 },
  /*
   * M2.9：战斗的每回合一次出招。
   *
   * 5 秒 / capacity 3 —— 与 .袭击 的「30 秒一回合」**刻意不同**：
   * .袭击 是单次判定（一次点错就是一次犯罪），而战斗是每回合点一下的连续动作，
   * 30 秒冷却会把八回合的战斗拖成四分钟，玩家会在等冷却里失去这场战斗的节奏。
   * capacity 3 不是「允许连点三次」，而是给网络抖动与按钮重发留的余量。
   */
  战斗: { capacity: 3, refillPerSec: 1 / 5 },
  /*
   * M2.10：.挑战 摆菜单是纯读，10 秒冷却只防连点。
   * 「不能反复点同一个人」那件事由 NUMERIC.battle.pvp.challengeCooldownMs（30 分钟）管 ——
   * 两者管的是不同的东西：一个是手感，一个是社交骚扰。
   */
  挑战: { capacity: 2, refillPerSec: 1 / 10 },
};

/** 未登记指令的兜底：5 次/秒，防脚本空转 */
export const FALLBACK_LIMIT: RateLimitConfig = { capacity: 5, refillPerSec: 1 };

export class RateLimiter {
  #limits: Record<string, RateLimitConfig>;
  #fallback: RateLimitConfig;
  #buckets = new Map<string, TokenBucket>();

  constructor(limits: Record<string, RateLimitConfig> = RATE_LIMITS, fallback: RateLimitConfig = FALLBACK_LIMIT) {
    this.#limits = limits;
    this.#fallback = fallback;
  }

  configOf(command: string): RateLimitConfig {
    return this.#limits[command] ?? this.#fallback;
  }

  check(command: string, userId: string, now: number): RateLimitDecision {
    let bucket = this.#buckets.get(command);
    if (!bucket) {
      bucket = new TokenBucket(this.configOf(command));
      this.#buckets.set(command, bucket);
    }
    return bucket.consume(userId, now);
  }

  /** 把 retryAfterMs 变成给玩家看的话术 */
  static describe(decision: RateLimitDecision): string {
    if (decision.retryAfterMs === Infinity) return '这条指令每人只能使用一次。';
    const seconds = Math.ceil(decision.retryAfterMs / 1000);
    if (seconds >= 3600) return `冷却中，请 ${Math.ceil(seconds / 3600)} 小时后再试。`;
    if (seconds >= 60) return `冷却中，请 ${Math.ceil(seconds / 60)} 分钟后再试。`;
    return `冷却中，请 ${seconds} 秒后再试。`;
  }
}
