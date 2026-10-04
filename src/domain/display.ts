/**
 * M2.40：**玩家看得见的名字**（唯一出处，K22）。
 *
 * ## 为什么有这个模块
 *
 * 「群里显示英文」的根因不是某一处写错了，是**渲染层到处直接念 id**：
 *
 *     event.ts / play.ts / explore.ts   念 `card.id`    ⇒ 事件【daily_013】
 *     brew.ts                           念 `recipe.id`  ⇒ 调制【seer_9】
 *
 * 而这两类内容**当时根本没有名字可念**（卡片 schema 里没有 `name`、配方也没有）。
 * 两件事叠在一起，才长成「事件名与魔药名显示英文」。
 *
 * ## 修法：数据源补权威名字，渲染层只引用（K16：引用，不是补齐）
 *
 * | 内容 | 权威名字在哪 | 为什么 |
 * | --- | --- | --- |
 * | 事件卡 | 卡片 YAML 的 `name`（schema 已收紧为**必填**） | 卡片没有别的可派生的名字 |
 * | 魔药（配方） | **成品物品**的 `name` | loader 已经要求每条配方都有 `potion_<途径>_<序列>`；那份物品的名字（「魔药·愚者·序列9」）就是玩家认得的那个 —— 再给配方写一份名字就是第二份真相 |
 *
 * ⚠️ **不要在这里加映射表**：一旦有人开始手维护「id → 中文」，
 * 下一条新内容就会漏（这正是这一轮的形状）。两个函数都只读权威源。
 */
import { potionProductId, type RecipeDef } from './potion/recipe.ts';

/** 事件卡的显示名。参数只要 name，是为了让调用点传什么形状都行（卡片对象 / 卡片 id 的持有者） */
export function cardDisplayName(card: { name: string }): string {
  return card.name;
}

/** 物品索引的最小形状（`ItemRepo` 与内存索引都满足） */
export interface ItemNameLookup {
  /** 查不到时 ItemRepo 返回 null、内存索引返回 undefined —— 两个都收 */
  get(id: string): { name: string } | null | undefined;
}

/**
 * 魔药（配方）的显示名 —— **从成品物品派生**，配方自己不存名字。
 *
 * 成品查不到时回落到 id：那不是「显示英文」，是一个**加载期就该报错**的状态
 * （`loader.ts` 会报「缺少成品物品定义」），回落只是不让渲染层崩。
 */
export function recipeDisplayName(recipe: RecipeDef, items: ItemNameLookup): string {
  const productId = potionProductId(recipe);
  return items.get(productId)?.name ?? productId;
}
