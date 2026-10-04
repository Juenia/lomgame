/**
 * 正神教会内容表的 schema（src/data/churches.yaml，M2.15）。
 *
 * 与 items / locations / cities / factions 一个口径：**代码只认这份 schema**，
 * YAML 写错了在启动时就报错，而不是等到某个玩家站在一座不存在的教堂门口。
 *
 * 字段的取值域一律**显式声明**（铁律 9）：途径是 `PathwayIdSchema` /
 * `PlannedPathwayIdSchema` 的枚举、据点城市要交叉校验存在、关系要交叉校验对称 ——
 * 这一份表里没有自由文本字段。
 *
 * ## ⚠️ 这是「教会」，不是「本地势力」（factions.yaml）
 *
 * 两份内容表的名字很像，概念完全不同，落点也不同（都不落库，各有一个只读 Index）：
 *
 * | | `factions.yaml`（M2.7.6） | `churches.yaml`（M2.15） |
 * |---|---|---|
 * | 是什么 | **本地势力**：本城的世俗组织，决定线索指向哪条途径 | **正神教会**：信仰谁、信什么、地盘在哪、与谁为敌 |
 * | 几家 | 10（世俗组织为主） | 7（七正神） |
 * | 绑什么 | **城市**（线索只落在本城势力的途径上） | **途径**（教会与途径强绑定） |
 * | Index | `InitiationIndex` | `ChurchIndex` |
 *
 * 还有第三个「factions」：M2.6 的 **`factions` 表**（势力范围，通缉系统的地基，`0013_m2_6.sql`）。
 * 三者的关系是「没有任何数据关系，只是名字撞了」（见 docs/M2.15-前置调查.md §A4）。
 *
 * ## 本轮的边界
 *
 * M2.15 只做**骨架**：把七正神、途径绑定、教义、禁忌、等级阶梯、据点、彼此的关系
 * **声明出来并交叉校验**。判定的东西一条都没有 —— 入教、贡献、教义 flag、技能树是 M2.16；
 * 教会之间的争夺与 PVP 加成是 M2.17；隐秘组织 / 学会 / 邪教是 M2.18。
 */
import { z } from 'zod';
import { PathwayIdSchema, PlannedPathwayIdSchema } from '../geo/types.ts';

/**
 * 教会之间的关系（M2.15 只声明**静态**的那一份）。
 *
 * `ally` 同盟 / `neutral` 中立 / `hostile` 敌对。
 * 未声明的两个教会一律 `neutral` —— 所以 YAML 里**只写非中立的对**，
 * 21 对里全写一遍只会让真正的对立关系淹在噪声里。
 *
 * ⚠️ 这是**对称**关系：A 对 B 是 hostile，B 对 A 就必须是 hostile。
 * 单条 YAML 看不出不对称，所以这条校验在 `src/data/loader.ts` 的交叉校验里
 * （非对称是设计错误，不是内容风格问题）。
 *
 * 「随事件浮动的动态关系」是 M2.17 的事，本轮不做。
 */
export const RelationSchema = z.enum(['ally', 'neutral', 'hostile']);
export type Relation = z.infer<typeof RelationSchema>;

/**
 * 组织类型。
 *
 * **M2.15 只加载 `church`** —— `src/data/loader.ts` 里有一条守卫，
 * 见到非 church 的组织直接报 error。
 *
 * `order`（组织）/ `cult`（邪教）是给 M2.18 的预留值。现在就写进 schema，
 * 是为了让已拍的那条前提（**序列 0 创建的是教会，序列 0 以下是组织 / 学会 / 邪教**）
 * 有一个落在代码里的落点，而不是等到 M2.18 再回头改 schema 的合法性边界。
 */
export const ChurchTypeSchema = z.enum(['church', 'order', 'cult']);
export type ChurchType = z.infer<typeof ChurchTypeSchema>;

/**
 * 等级阶梯的一级。
 *
 * **M2.15 只声明，没有任何机制**：贡献怎么算、怎么升、升了给什么，全是 M2.16 的事。
 * 所以这里**刻意没有贡献阈值字段** —— 一个这一轮没人读的数值字段，
 * 除了对 M2.16 的设计构成一种误导性的预设之外没有任何作用。
 *
 * `id` 是稳定的机器名（`believer` / `deacon` / …），`name` 是各教会的称谓。
 * 同一档在不同教会的叫法不一样（女神的「守夜人」与战神的「士兵」是同一级），
 * 所以阶梯是**逐教会声明**的，不是全局一张表。
 */
export const ChurchRankSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
});
export type ChurchRank = z.infer<typeof ChurchRankSchema>;

/* ============================ M2.17：教义判据 ============================ */

/**
 * 可检查的**动作类型**。
 *
 * 五个值对应五类玩家行为，同时也是 NUMERIC.church.taboo.checkAfter 的取值域：
 *   explore 探索（.探索）  use 使用（.使用）  ritual 仪式（.仪式）
 *   donate  捐献（.教会 捐献）  play 扮演（.扮演）
 *
 * ⚠️ **不是中文指令名**：指令名会改（M2.3 起菜单路径与完整指令并存），
 * 判定层用稳定的英文动作名，翻译发生在命令层一处。
 */
/**
 * 战斗类的**目标情形**（M2.18 F）。
 *
 * 为什么需要它：动作类型（action）只能说到「他在战斗 / 他在挑战」，
 * 而战神的原文要判的是「**对手是什么状态**」：
 *
 *   fleeing  这一下是**撤退**（`.战斗 撤退`）—— 原文「不得背对敌人逃跑」
 *   mortal   对手**还没入途径**（序列 9，没有非凡能力 ≈ 未持械）—— 原文「不得对未持械的人出手」
 *
 * ⚠️ 只有**命令层能算出来的**状态才进这个枚举。
 * 「对手放下武器之后继续动手」那条**没有落点**（PVP 里认输 = 战斗立即结束，
 * 不存在「认输之后还能继续打」的窗口）—— 它不在这里，见 docs/M2.18-F交付说明.md。
 */
export const TabooTargetSchema = z.enum(['fleeing', 'mortal']);
export type TabooTarget = z.infer<typeof TabooTargetSchema>;

export const TabooActionSchema = z.enum(['explore', 'use', 'ritual', 'donate', 'play', 'challenge', 'battle']);
export type TabooAction = z.infer<typeof TabooActionSchema>;

/**
 * 禁忌的**判据** —— 固定可选字段，**多个字段之间是 AND**。
 *
 * 刻意不做成通用规则引擎（when: { and: [...] } / when: { or: [...] }）：
 * 嵌套判据的 lint 写不出来、报告拆不开、测试覆盖不了，
 * 而玩家看得懂回执却看不懂规则。五个字段能覆盖七家的全部禁忌。
 *
 * 字段语义（**空着 = 不设这个条件**）：
 *   action     这一步必须是这个动作，否则不检查
 *   location   玩家**此刻所在地点**的 id（locations.yaml）必须等于它
 *   cityId     玩家**此刻所在城市**的 id（cities.yaml）必须等于它
 *   rankBelow  只有 rank >= rankBelow 的信徒才受约束（低阶豁免）。不填 = 不设下界
 *   rankAbove  只有 rank <= rankAbove 的信徒才受约束（高阶豁免）。不填 = 不设上界
 *
 * ⚠️ rankBelow / rankAbove 是**适用范围**（豁免边界），不是「违反了」的判据 ——
 * 这样两个字段天然是 AND。若把语义定成「rank < rankBelow 就违反」，
 * 两个字段同时出现就变成 OR，与「多字段是 AND」这条约定直接冲突。
 *
 * location / cityId 写的是 **id 不是中文名**（铁律 9 的同一口径）：
 * 中文名不是稳定标识，改一次名就要迁移内容；cities.yaml / locations.yaml 已经是同一套 id 空间。
 * loader 交叉校验它们存在。
 */
export const TabooWhenSchema = z.object({
  action: TabooActionSchema.optional(),
  location: z.string().min(1).optional(),
  cityId: z.string().min(1).optional(),
  rankBelow: z.number().int().min(0).max(5).optional(),
  rankAbove: z.number().int().min(0).max(5).optional(),
  /**
   * M2.18（F）：**战斗类判据的目标情形**（见 TabooTargetSchema）。
   *
   * 它与 action 是 AND：`{ action: battle, target: fleeing }` 读作
   * 「这一步是战斗、**且这一下是撤退**」。
   */
  target: TabooTargetSchema.optional(),
});
export type TabooWhen = z.infer<typeof TabooWhenSchema>;

/**
 * 违反的**代价**（M2.17 只做精神代价：疯狂与污染）。
 *
 * 为什么不复用 EffectDelta 的全字段：教义违反是「精神上的代价」，
 * 世界观上它不该扣血扣钱（那与「被禁止的行为」没有因果关系）。
 * 两个字段也让「罚则倍率」NUMERIC.church.taboo.penaltyMultiplier 只有一处作用点。
 */
export const TabooPenaltySchema = z.object({
  mad: z.number().int().min(0).optional(),
  cor: z.number().int().min(0).optional(),
});
export type TabooPenalty = z.infer<typeof TabooPenaltySchema>;

/**
 * 一条禁忌。
 *
 *   id      稳定机器名（<教会>_<slug>），落进 domain_events 的 church_taboo_violation.payload
 *   text    给玩家看的短句（入教回执与违反回执都读它）
 *   when    判据。**省略 = 纯声明**（这条禁忌还没有可判定的形式）
 *   penalty 代价。**有 when 必须有 penalty，没有 when 不许有 penalty**
 *
 * 后一条不变式是这一版最重要的语义：它把「还没做」与「做了、判据是空的」
 * 分成两种状态 —— 与 churches.yaml 里五家占位教会**不写 when** 是同一件事的两面。
 */
export const TabooSchema = z
  .object({
    id: z.string().min(1),
    text: z.string().min(1),
    when: TabooWhenSchema.optional(),
    penalty: TabooPenaltySchema.optional(),
  })
  .superRefine((taboo, ctx) => {
    if (taboo.when && !taboo.penalty) {
      ctx.addIssue({ code: 'custom', message: '有 when 的禁忌必须给 penalty（否则违反了也没有任何代价）' });
      return;
    }
    if (taboo.when && taboo.penalty && (taboo.penalty.mad ?? 0) === 0 && (taboo.penalty.cor ?? 0) === 0) {
      ctx.addIssue({ code: 'custom', message: 'penalty 至少要有一项非零（mad 或 cor）' });
    }
    if (!taboo.when && taboo.penalty) {
      ctx.addIssue({ code: 'custom', message: '没有 when 的禁忌不该写 penalty —— 判据还没翻译出来' });
    }
  });
export type Taboo = z.infer<typeof TabooSchema>;

export const ChurchSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  type: ChurchTypeSchema.default('church'),
  /**
   * 教会**强绑定**的途径（已拍的前提：风暴之主教会只收水手，入教会前先有对应途径）。
   *
   * `null` = **待定** —— 这条途径在 MVP 里还没有实现（`PathwayIdSchema` 只有
   * `seer` / `warrior` / `sleepless`）。**对不上的一律 null，不硬绑**：
   * 硬绑一个错的途径，症状是「玩家入了教却拿到了不相干的途径加成」，
   * 而那是 M2.16 里最难查的那一类 bug。
   */
  pathway: PathwayIdSchema.nullable().default(null),
  /**
   * `pathway` 为 null 时，这里是**那条途径的 id**（`PlannedPathwayIdSchema`）。
   *
   * 为什么是 id 而不是中文途径名（第一版写的是「水手途径」这种自由文本）：
   *   1. **铁律 9** —— 内容 YAML 里的每一个机制字段必须显式声明在 schema 里；
   *      自由文本无法校验，而它正是 M2.16 判定「这家教会现在能不能收人」的依据之一。
   *   2. 中文名不是稳定标识，改一次 id 就要迁移内容。
   *   3. `cities.yaml` 的 `planned_pathways` 已经是同一套 id 空间，不该有两套。
   *
   * 取值域与 `cities.yaml` 共用同一个枚举（M2.15 新登记了 perfect / sun / reader / mother 四个，
   * `sailor` 沿用 M2.7 的）。**它与 `pathway` 互斥且必有一个** ——
   * 校验在 loader：途径真做出来之后，这个字段搬进 `pathway` 并清空。
   */
  plannedPathway: PlannedPathwayIdSchema.nullable().default(null),
  /** 教义一句话（宣告「我们信什么」）。M2.15 只读，判定在 M2.16 */
  dogma: z.string().min(1),
  /**
   * 禁忌清单（宣告「我们不许做什么」）+ **判据**（M2.17 起）。
   *
   * M2.15 写的是一条条可判定的行为短句；M2.17 把能翻译的翻译成 TabooWhen，
   * 翻译不了的**保留 text、不写 when** —— 那是「还没做」，不是「做了、判据是空的」。
   * 这个区分由 TabooSchema 的 superRefine 守着（有 when 必须有 penalty，反之不许有）。
   */
  taboos: z.array(TabooSchema).default([]),
  /** 等级阶梯（信徒 → … → 教宗）。M2.15 只声明 */
  ranks: z.array(ChurchRankSchema).min(1),
  /**
   * 据点**城市** id 列表（`cities.yaml`）。
   *
   * 语义是「这座城市的教会势力存在」，**不是**「占了哪块地」——
   * 后者是 M2.6 的 `factions` 表（`territory_json`，玩家此刻站的地方归谁管），
   * 也是本轮任务 B「动态据点」要算的东西。
   *
   * 为什么写城市而不是地点：本轮只做骨架；M2.16 入教发生在具体地点，
   * 而「城市的哪个地点是教会堂口」在 `cities.yaml` 里已经有一个权威答案（`center`），
   * 不需要在这里提前写死第二个。
   */
  seats: z.array(z.string().min(1)).min(1),
  /**
   * 与其它教会的关系：`{ 教会 id: ally | neutral | hostile }`。
   *
   * 只写非中立的对（见 `RelationSchema` 的注释）。校验在 loader：
   * key 必须是登记过的教会 id、不能指向自己、且必须**对称**。
   */
  relations: z.record(z.string(), RelationSchema).default({}),
});

export type ChurchDef = z.infer<typeof ChurchSchema>;

export function parseChurch(
  raw: unknown,
): { ok: true; church: ChurchDef } | { ok: false; issues: string[] } {
  const result = ChurchSchema.safeParse(raw);
  if (result.success) return { ok: true, church: result.data };
  return {
    ok: false,
    issues: result.error.issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`),
  };
}
