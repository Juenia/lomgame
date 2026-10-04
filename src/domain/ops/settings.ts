/**
 * **运维节奏（M2.88）** —— 世界什么时候主动说话。
 *
 * ## 用户的判断
 *
 * > 「主动推送的事件改为随机时间触发，不要再定时触发」
 * > 「后台可以设置一个随机的时间范围，从那个时间范围里随机」
 *
 * ## 为什么定时轮询是错的
 *
 * 在这之前 `main.ts` 里是 `setInterval(worldOnce, 5 * 60 * 1000)`，
 * 而世界 tick 内部按**整点**对齐（`hourStartOf`）—— 于是玩家看到的规律是：
 *
 * ```
 * 每个整点过几分钟，群里必然出现一条【世界异象】
 * ```
 *
 * 而它本来要营造的是「这个世界自己在动」。**一个能被预测的世界不是活的。**
 * 玩家很快会学会「整点再看」，那这个功能就从「世界在呼吸」退化成了「整点报时」。
 *
 * ## 改法：下一次什么时候跑，由这一次结束时掷
 *
 * 不是「每 N 分钟跑一次」，而是：**每次跑完，从 `[min, max]` 里随机挑一个间隔**。
 * 于是间隔本身有分布，而累积两次以上之后，任何时刻都不再可预测。
 *
 * ## 随机必须可复现
 *
 * 这个项目的其余部分（天气、事件、战斗）全部是 seed 派生的，跑批必须逐位可复现。
 * 所以这里**不用 `Math.random()`** —— 用上一次的 tick 时刻当种子，
 * 同一个 tick 时刻在任何进程里都会算出同一个下一次延迟。
 */
import { z } from 'zod';

/** 一个「随机的重复间隔」 */
export const RandomIntervalSchema = z
  .object({
    /** 最短间隔（分钟） */
    min_minutes: z.number().positive().max(24 * 60),
    /** 最长间隔（分钟） */
    max_minutes: z.number().positive().max(24 * 60),
    /** 后台里的说明：这一项控制的是什么 */
    note: z.string().default(''),
  })
  .refine((v) => v.max_minutes >= v.min_minutes, {
    message: 'max_minutes 不能小于 min_minutes —— 那会让随机范围是空的',
  });

export const OpsSettingsSchema = z.object({
  meta: z.record(z.string(), z.unknown()).default({}),
  /** 世界 tick：推进天气、世界事件、权柄。它也是主动推送的来源 */
  world_tick: RandomIntervalSchema,
  /** 每日结算的检查间隔（固定分钟，不需要随机 —— 它对齐日期，玩家看不见）*/
  daily_check_minutes: z.number().positive().max(24 * 60).default(1),
});

export type RandomInterval = z.infer<typeof RandomIntervalSchema>;
export type OpsSettings = z.infer<typeof OpsSettingsSchema>;

export type ParseOpsResult =
  | { ok: true; settings: OpsSettings }
  | { ok: false; issues: string[] };

export function parseOpsSettings(raw: unknown): ParseOpsResult {
  const parsed = OpsSettingsSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map(
        (i) => (i.path.length > 0 ? i.path.join('.') + '：' : '') + i.message,
      ),
    };
  }
  return { ok: true, settings: parsed.data };
}

/**
 * **掷下一次的延迟（毫秒）。**
 *
 * 纯函数，种子由调用方给 —— 所以它可测、可复现。
 * `seedAt` 用**上一次 tick 的时刻**：同一个时刻在任何进程里得到同一个延迟。
 */
export function nextDelayMs(range: RandomInterval, seedAt: number): number {
  const span = range.max_minutes - range.min_minutes;
  // 一个廉价的整数散列（与项目其它地方的 seedFrom 同思路：确定性、无依赖）
  let h = (seedAt ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  const unit = h / 0x1_0000_0000; // [0, 1)
  const minutes = range.min_minutes + unit * span;
  return Math.round(minutes * 60_000);
}