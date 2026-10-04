/**
 * **神与神的关系网**（M2.169）—— 阴谋的依据。
 *
 * 为什么它必须是一张表：原作里的关系是**成体系**的，不是散在代码里的判断 ——
 * 「黑夜女神与大地母神长期结盟」「与战神教会水火不容」「最稳固的盟友」。
 * 而 M2.169 的阴谋要回答「谁能对谁下手」，那个问题只能由这张表回答。
 *
 * 三种边：
 *   ally   盟友   —— 可以**联手**（原作：神战中联手暗算战神）
 *   rival  水火不容 —— 可以对下手（原作：「黑夜女神教会与战神教会水火不容」）
 *   covet  觊觎其位 —— **邪神对正神**的那一条（用户点名的那一种）
 *
 * ⚠️ 两端的 id 是**途径 id**（与 divine-thrones.yaml 的 pathway 同一口径），
 * 不是教会 id 也不是神名 —— 写错了加载器会拦（交叉校验）。
 */
import { z } from 'zod';

export const DivineRelationKindSchema = z.enum(['ally', 'rival', 'covet']);
export type DivineRelationKind = z.infer<typeof DivineRelationKindSchema>;

export const DivineRelationSchema = z.object({
  /**
   * 这条边的 id（唯一）。
   *
   * ⚠️ 为什么必须有：一条途径会出现在好几条边里（黑夜女神同时是「大地母神的盟友」
   * 与「战神的死敌」），所以 `a` 不能当主键 —— 后台按 id 找记录，重复的键会让
   * 「点进去编辑」打开另一条边，而且**不报错**。
   */
  id: z.string().min(1),
  a: z.string().min(1),
  b: z.string().min(1),
  kind: DivineRelationKindSchema,
  /** 这份关系从什么时候开始（原作口径：纪元 / 事件） */
  since: z.string().default(''),
  note: z.string().default(''),
  /** 原作出处（写成 `文件:行` 或 URL），内容作者要能回去核 */
  source: z.string().default(''),
});
export type DivineRelation = z.infer<typeof DivineRelationSchema>;

export const DivineRelationFileSchema = z.object({
  meta: z.record(z.string(), z.unknown()).default({}),
  divine_relations: z.array(DivineRelationSchema).default([]),
});
