/**
 * 权柄（M2.76）—— **世界级能力**：它不改变某个人的数值，它改变世界的状态。
 *
 * ## 为什么按「世界事件」而不是「玩家技能」来做
 *
 * 原著里权柄是**序列 0** 的东西，而本项目当前内容目标只到 seq 2（玩家可达序列 1）
 * ⇒ 做成玩家技能的话，**没有任何人能用到它**，那 118 条内容等于摆设。
 *
 * 而目标里那句「权柄影响世界 seed」要的是**这个机制存在**，不是「玩家能用」。
 * ⇒ 落成**世界级事件**：由 GM（后台）或世界 tick 触发，玩家**见证**它 ——
 *   全服播报 + 天气真的变了。等序列 0 落地之后，把触发方从「世界」换成「玩家」即可，
 *   机制不用改（覆盖层不关心是谁写的）。
 *
 * ## 它落在哪一层
 *
 * 天气在项目里是 \`(WORLD_SEED, 时间)\` 的**纯函数结果**，没有第三个输入。
 * ⇒ 权柄要「改写世界状态」就必须先有一个**可写的覆盖层**（迁移 \`0032_m2_76_world_overrides\`）。
 * 这一层做的是「有期限的例外」，不是「改 seed」—— 改 seed 会改写整个世界的历史。
 *
 * ## 优先级
 *
 * **覆盖层优先于 seed 派生**（\`WorldRepo.weatherOf\` 里写死）。
 * 否则「神明让雨停了」会被下一小时的 seed 计算覆盖回去，玩家看到的是一件没发生过的事。
 */
import { z } from 'zod';
import { PathwayIdSchema } from '../geo/types.ts';

export const AuthoritySchema = z.object({
  id: z.string().min(1),
  pathway: PathwayIdSchema,
  name: z.string().min(1),
  /**
   * 覆盖成什么天气。
   *
   * ⚠️ 用 \`z.string()\` 而不是 \`z.enum(WEATHER_IDS)\`：**天气清单不在这里再抄一份**（K16 形状）。
   * 合法性由加载器对着 \`WEATHER_IDS\` 校验 —— 与读天气的地方同一份清单。
   */
  weather: z.string().min(1),
  /** 作用范围：地点 id，或 '*' 表示全服 */
  scope: z.string().min(1).default('*'),
  duration_hours: z.number().positive(),
  /** 全服播报（这条是玩家唯一能看见的部分，所以它必须写得像件事发生了） */
  broadcast: z.string().min(1),
  /**
   * 除天气以外还能改写什么（M2.87）。
   *
   * ## 为什么要有这个字段
   *
   * 在这之前 `applyAuthority` 只写一条 `kind: 'weather'` 的覆盖 ——
   * 也就是说**权柄改写的只有天气**。而 `world_overrides` 表本身是有通用 `kind` 列的，
   * 只是从来没有人写过第二个值。
   *
   * 而原作的权柄远不止天气：「愚弄」能弄假成真、「深渊」让周围堕落、
   * 「审判者」能立规则、「错误」能窃取权限 —— 这些都不是天气。
   *
   * ## 形状
   *
   * ```yaml
   * effects:
   *   - { kind: 'madRate', value: '1.5' }        # 这一带疯狂增长 ×1.5
   *   - { kind: 'banCommand', value: '占卜' }     # 这一带占卜不灵
   *   - { kind: 'priceFactor', value: '0.7' }    # 物价打折（黑市被权柄压过）
   * ```
   *
   * ⚠️ `kind` 用 `z.string()` 而不是 enum：**读的那一端才是权威清单**（K16 形状）。
   * 抄一份 enum 在这里，加一个新维度时就会漏改一处，而症状是
   * 「写了但没有任何东西读它」—— 不报错。
   *
   * `value` 一律是字符串（与 `world_overrides.value` 同类型）：
   * 读的那一端自己按 kind 解析，因为不同 kind 的值类型本来就不同。
   */
  effects: z
    .array(
      z.object({
        kind: z.string().min(1),
        value: z.string().min(1),
        /** 覆盖这条 effect 的范围；不写则跟随权柄自己的 scope */
        scope: z.string().min(1).optional(),
      }),
    )
    .default([]),
  /** 后台与报告里的说明：这个权柄在原著里是什么 */
  note: z.string().default(''),
});

export const AuthoritiesFileSchema = z.object({
  authorities: z.array(AuthoritySchema).default([]),
});

export type AuthorityDef = z.infer<typeof AuthoritySchema>;

export type ParseAuthoritiesResult =
  | { ok: true; authorities: AuthorityDef[] }
  | { ok: false; issues: string[] };

export function parseAuthoritiesFile(raw: unknown): ParseAuthoritiesResult {
  const result = AuthoritiesFileSchema.safeParse(raw);
  if (!result.success) {
    return {
      ok: false,
      issues: result.error.issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`),
    };
  }
  return { ok: true, authorities: result.data.authorities };
}
