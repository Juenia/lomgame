/**
 * 商店（M2.87）—— 判定层纯数据 + 纯函数，零 IO。
 *
 * 「哪里能买到什么」—— 在这之前项目里没有答案，`.买` 只能买装备。
 *
 * ## 一个商店就是一个地点
 *
 * 不另造「商店实体」的理由：玩家已经在用地点思考（`.探索 咸鱼市场`），
 * 多一层只会多一个要记的名字。而地点表里那 22 个名字（烛火书店 / 情报咖啡馆
 * / 猎犬酒馆…）**本来就是为这件事留的**。
 *
 * ## 价格：默认派生，可逐件覆盖
 *
 * `price` 不写 → 走 `prices.yaml` 的规则（调价只改一处）；
 * 写了 → 以此为准（给「这一家特别贵」留口子）；
 * `null` → **明确不卖**（比「不写」多一层语义：写的人表过态了）。
 */
import { z } from 'zod';

/** 商店的类别 —— 决定它在世界里是什么地方，也决定文案口吻 */
export const ShopKindSchema = z.enum(['general', 'bookstore', 'tavern', 'church', 'workshop', 'blackmarket']);
export type ShopKind = z.infer<typeof ShopKindSchema>;

export const SHOP_KIND_LABELS: Readonly<Record<ShopKind, string>> = {
  general: '杂货',
  bookstore: '书店',
  tavern: '酒馆',
  church: '教堂',
  workshop: '工坊',
  blackmarket: '黑市',
};

export const ShopStockSchema = z.object({
  itemId: z.string().min(1),
  /** 不写 = 按 items 的 kind 派生；写数字 = 覆盖；写 null = 不卖 */
  price: z.number().int().min(0).nullable().optional(),
  /** 这一件在这个店里有没有货（默认有）—— 留给以后做「限量 / 售罄」 */
  stock: z.number().int().min(0).optional(),
});
export type ShopStock = z.infer<typeof ShopStockSchema>;

export const ShopSchema = z.object({
  id: z.string().min(1),
  /** 商店**就是**这个地点 —— 玩家在这里才能买卖 */
  locationId: z.string().min(1),
  name: z.string().min(1),
  kind: ShopKindSchema,
  /** 店主的一句话，进门时看到（沉浸感的一半在这里） */
  keeper: z.string().min(1),
  greeting: z.string().min(1),
  stock: z.array(ShopStockSchema).min(1),
  note: z.string().optional(),
});
export type Shop = z.infer<typeof ShopSchema>;

export const ShopTableSchema = z.object({
  shops: z.array(ShopSchema).min(1),
});
export type ShopTable = z.infer<typeof ShopTableSchema>;

/** 找当前地点的商店（一个地点最多一家） */
export function shopAt(table: ShopTable, locationId: string): Shop | null {
  return table.shops.find((s) => s.locationId === locationId) ?? null;
}

/**
 * 货架上的一件：算出它在这家店里卖多少。
 *
 * 返回 `null` = **这家店不卖它**（`price: null`，或派生价是 0 —— 货币就是这种）。
 * 这个返回值必须被调用方认真对待：**把 null 当成 0 会让货币被标价买卖**。
 */
export function shelfPriceOf(
  entry: ShopStock,
  base: { penny: number },
): number | null {
  if (entry.price === null) return null;
  if (typeof entry.price === 'number') return entry.price;
  return base.penny > 0 ? base.penny : null;
}
