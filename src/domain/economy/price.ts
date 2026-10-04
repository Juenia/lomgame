/**
 * 物价（M2.87）—— 判定层纯数据 + 纯函数，零 IO。
 *
 * ## 这一层回答的问题
 *
 * 「这件东西值多少钱？」—— 在这之前项目里**没有答案**：948 件物品没有一件带价格，
 * 货币三层（金镑/苏勒/便士）只活在显示层，`.买` / `.卖` 没有可依的标价。
 * 用户点出的就是这件事：「现在并没有建立起交易体系，例如货币的交易，按原作设计」。
 *
 * ## 两层，必须分开（AGENTS 三条禁令的第 2、3 条）
 *
 *   `anchors` —— **原作直述的价格**，逐条带章节号。一个字都不许改。
 *   `rules`   —— **项目派生的定价规则**，给原作没给价的东西定价。
 *
 * ⚠️ **派生值不是原作数据。** 原作的锚点里没有「序列 8 的材料值多少」，
 * 那是本项目按锚点推的。所以每条规则都写了 `basis`（从哪条锚点推、怎么推的），
 * 而 `priceOf()` 的返回值带 `derived: true` —— 调用方想区分随时能区分。
 */
import { z } from 'zod';

/** 一档原作物价（逐字带章节号） */
export const PriceAnchorSchema = z.object({
  id: z.string().min(1),
  item: z.string().min(1),
  /** 便士（最小单位整数） */
  penny: z.number().int().min(0),
  chapter: z.string().min(1),
  note: z.string().optional(),
  confidence: z.string().optional(),
});
export type PriceAnchor = z.infer<typeof PriceAnchorSchema>;

/** 一条派生定价规则（项目定的，不是原作） */
export const PriceRuleSchema = z.object({
  kind: z.string().min(1),
  label: z.string().min(1),
  penny: z.number().int().min(0),
  /** **必填**：这条规则从哪条锚点推出来、怎么推的。留空就等于不可追溯 */
  basis: z.string().min(1),
  note: z.string().optional(),
});
export type PriceRule = z.infer<typeof PriceRuleSchema>;

export const SequenceMultiplierSchema = z.object({
  basis: z.string().min(1),
  note: z.string().optional(),
  /** 每提升一个序列，价格乘几 */
  factor: z.number().min(1),
  /** 哪一档是「基准」（不乘） */
  from: z.number().int().min(1).max(9),
});
export type SequenceMultiplier = z.infer<typeof SequenceMultiplierSchema>;

export const PriceTableSchema = z.object({
  meta: z.object({
    source: z.string().min(1),
    verified: z.string().optional(),
    unit: z.string().min(1),
    note: z.string().optional(),
  }),
  anchors: z.array(PriceAnchorSchema).min(1),
  /** 具体物品的锚点（键是物品 id）—— 覆盖 kind 规则 */
  itemAnchors: z.array(PriceAnchorSchema).default([]),
  rules: z.array(PriceRuleSchema).min(1),
  sequenceMultiplier: SequenceMultiplierSchema,
  /** 封印物按封印等级定价（`null` = 买不到）。项目值，从代码里搬出来的。 */
  sealLevelPrice: z.object({
    basis: z.string().min(1),
    prices: z.record(z.string(), z.number().int().min(0).nullable()),
  }),
  exchange: z.object({
    penny: z.number().int().min(1),
    shilling: z.number().int().min(1),
    pound: z.number().int().min(1),
    labels: z.object({
      penny: z.string().min(1),
      shilling: z.string().min(1),
      pound: z.string().min(1),
    }),
  }),
});
export type PriceTable = z.infer<typeof PriceTableSchema>;

/** 一次定价的结果：价格 + 它**怎么来的** */
export interface PricedItem {
  /** 便士（整数） */
  penny: number;
  /** true = 项目派生（不是原作数据）；false = 直接落在某条原作锚点上 */
  derived: boolean;
  /** 人话说明：「按武器档 480 便士（原作 ch42 双筒猎枪）」 */
  basis: string;
}

/**
 * 一件物品的价格。
 *
 * 判据顺序（**先原作、后派生**）：
 *   ① `kind` 直接命中某条锚点 → 用锚点价，`derived: false`；
 *   ② 否则命中某条规则 → 用规则价；
 *   ③ 材料类再按 `sequence` 乘 `factor^(9 - seq)`。
 *
 * `sequence` 不传 = 不乘（当作序列 9）。
 */
export function priceOf(
  table: PriceTable,
  kind: string,
  sequence?: number,
): PricedItem {
  /*
   * ⚠️ 先把序列倍率算出来，再判断命中哪一档 —— 顺序反了的话，「材料」这条规则
   * 会用基准价乘以一个还没算出来的倍数。
   */
  const seq = sequence ?? table.sequenceMultiplier.from;
  const factor = Math.pow(table.sequenceMultiplier.factor, table.sequenceMultiplier.from - seq);

  const itemAnchor = table.itemAnchors.find((a) => a.id === kind);
  if (itemAnchor !== undefined) {
    return {
      penny: itemAnchor.penny,
      derived: false,
      basis: '按物品锚点 ' + itemAnchor.penny + ' 便士；依据：' + itemAnchor.chapter + (itemAnchor.note !== undefined ? '（' + itemAnchor.note + '）' : ''),
    };
  }
  const anchor = table.anchors.find((a) => a.id === kind);
  if (anchor !== undefined) {
    return {
      penny: anchor.penny,
      derived: false,
      basis: '原作 ' + anchor.chapter + '：' + anchor.item + ' = ' + anchor.penny + ' 便士',
    };
  }

  const rule = table.rules.find((r) => r.kind === kind);
  if (rule === undefined) {
    /*
     * 没有规则时**不猜**：返回 0 并标记派生，让调用方自己决定（`.买` 会拒卖）。
     * 给一个「看着合理」的兜底价才是最坏的做法 —— 它会安静地污染整套经济。
     */
    return { penny: 0, derived: true, basis: '没有为「' + kind + '」定价的规则' };
  }

  const scaled = Math.max(1, Math.round(rule.penny * factor));
  const scaledNote =
    factor === 1 ? '' : '（序列 ' + seq + '，×' + factor.toFixed(2) + '）';
  return {
    penny: scaled,
    derived: true,
    basis: '按「' + rule.label + '」档 ' + rule.penny + ' 便士' + scaledNote + '；依据：' + rule.basis,
  };
}

/**
 * **一件物品**的价格 —— 调用方该用这个，而不是直接调 `priceOf`。
 *
 * 为什么要包一层：查价是**两步**，而两步的顺序与缺一不可都是容易写错的地方。
 *   ① 先按**物品 id** 查 `itemAnchors`（「无名者骨牌」这种不能按 kind 一刀切的）；
 *   ② 没命中再按 **kind** 查 `anchors` / `rules`（并带上序列倍率）。
 *
 * ⚠️ 实测踩过：商店渲染时只调了 `priceOf(itemId)`，于是**材料全部返回 0** ——
 * 因为材料的价在 kind 规则里，按 id 查当然查不到。表现出来是「黑市的材料不卖」，
 * 而它是全项目**唯一**该卖材料的地方。
 */
export function priceOfItem(
  table: PriceTable,
  item: { id: string; kind: string },
  sequence?: number,
): PricedItem {
  const byId = priceOf(table, item.id, sequence);
  if (byId.penny > 0 || byId.derived === false) return byId;
  return priceOf(table, item.kind, sequence);
}

/**
 * 卖出价 = 买入价 × 这个比例（派生规则）。
 *
 * 为什么不是 100%：商店要赚差价，否则「买进再卖出」就是无风险套利。
 * 0.6 的依据是**同时满足两件事**：
 *   · 玩家不至于「买错了就血本无归」（那会让人不敢买）；
 *   · 也不至于「来回倒手不亏」（那会让经济失去意义）。
 * 原作没有给二手价，所以这是**项目派生值**。
 */
export const SELL_RATIO = 0.6;

/** 卖出价（向下取整到整便士；最低 1 便士，不然卖东西等于白送） */
export function sellPriceOf(buy: PricedItem): number {
  return Math.max(1, Math.floor(buy.penny * SELL_RATIO));
}
