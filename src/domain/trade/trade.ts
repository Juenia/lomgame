/**
 * 交易判定（W3：纯函数）
 *
 * 规则：只有非绑定物品可交易；买家付全价，卖家到手价扣 5% 税；
 * 交易单超时未确认自动取消并解冻物品（长度见 NUMERIC.trade.timeoutMs，W8 起为 6 小时）。
 */
import { NUMERIC } from '../../config/numeric.ts';
import { formatCurrency, formatCurrencyWithPennies } from '../currency/index.ts';

/**
 * 交易税：按**便士总额**算、**向下取整**（M2.5 依据：任务书 §2.4）。
 *
 * 原来是 Math.ceil —— 1 便士的单子会被抽 1 便士税（税率 100%）。
 * 改成 floor 之后小额交易不再被税吃穿，大额交易最多差 1 便士。
 * 买卖双方都不需要感知「便士被拆成三层」，税只作用在总额上。
 */
/**
 * M2.13：多了第二个参数（**税率倍率**），默认 1。
 *
 * 来处是「幸运硬币」（神奇物品，被动：交易税率 -20%）。
 * 做成一个参数而不是让判定层去读背包：判定层不认识仓储（这条纪律在
 * `wonder-hooks.ts` 里落地）—— 命令层算出倍率喂进来，判定层只负责算账。
 *
 * 默认 1 = 与 M2.5 的行为**逐位一致**（既有调用点一个都不用改）。
 */
export function tradeTax(price: number, taxMultiplier = 1): number {
  return Math.floor(Math.max(0, price) * NUMERIC.trade.taxRate * taxMultiplier);
}

export function tradeTimeoutMs(): number {
  return NUMERIC.trade.timeoutMs;
}

export function expiresAt(createdAt: number): number {
  return createdAt + NUMERIC.trade.timeoutMs;
}

/** 超时长度的人话（给文案用）：不允许在任何回执里写死"1 小时" */
export function tradeTimeoutLabel(): string {
  const minutes = Math.round(NUMERIC.trade.timeoutMs / 60_000);
  if (minutes % 60 === 0) return `${minutes / 60} 小时`;
  if (minutes > 60) return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`;
  return `${minutes} 分钟`;
}

export function isExpired(createdAt: number, now: number): boolean {
  return now - createdAt >= NUMERIC.trade.timeoutMs;
}

export interface TradeCheckInput {
  sellerId: string;
  buyerId: string;
  qty: number;
  price: number;
  /** 卖家当前可交易的该物品数量（不含绑定） */
  sellerAvailable: number;
  itemTradeable: boolean;
  /** 买家持有的货币数量（单位**便士**；M2.5 追加的三层货币内部一律最小单位） */
  buyerPenny: number;
  /** 卖家当前待确认的单数 */
  pendingCount: number;
  /** 买卖双方近 7 天已完成交易额里的较大者 */
  weeklyVolume: number;
}

export type TradeCheck = { ok: true } | { ok: false; reason: string };

export function checkTradeRequest(input: TradeCheckInput): TradeCheck {
  if (input.sellerId === input.buyerId) return { ok: false, reason: '不能和自己交易。' };
  if (!Number.isInteger(input.qty) || input.qty < 1) return { ok: false, reason: '数量必须是正整数。' };
  if (input.qty > NUMERIC.trade.maxQuantity) {
    return { ok: false, reason: `单笔最多交易 ${NUMERIC.trade.maxQuantity} 个。` };
  }
  if (!Number.isInteger(input.price) || input.price < 1) {
    return { ok: false, reason: '价格必须是正整数（默认单位是便士，也可以写 8s / 8g / 1g5s3p）。' };
  }
  if (!input.itemTradeable) return { ok: false, reason: '这件东西不能交易（绑定物或身份物）。' };
  if (input.sellerAvailable < input.qty) {
    return { ok: false, reason: `可交易的数量不足（当前 ${input.sellerAvailable} 个非绑定）。` };
  }
  if (input.pendingCount >= NUMERIC.trade.maxPendingPerUser) {
    return { ok: false, reason: `你还有 ${input.pendingCount} 笔待确认的交易，先处理掉再开新的。` };
  }
  if (input.weeklyVolume + input.price > NUMERIC.trade.weeklyVolumeCap) {
    return {
      ok: false,
      reason:
        `本周交易额已达上限（${formatCurrencyWithPennies(NUMERIC.trade.weeklyVolumeCap)}），防小号转移资产。`,
    };
  }
  return { ok: true };
}

export interface TradeSettlement {
  itemId: string;
  qty: number;
  price: number;
  /** 系统抽走的税 */
  tax: number;
  /** 卖家到手（便士） */
  sellerPennyGain: number;
  /** 买家付出（便士） */
  buyerPennyCost: number;
}

export function settleTrade(input: {
  itemId: string;
  qty: number;
  price: number;
  /** M2.13：卖家的税率倍率（幸运硬币 0.8）；缺省 = 1 = M2.5 的行为 */
  taxMultiplier?: number;
}): TradeSettlement {
  const tax = tradeTax(input.price, input.taxMultiplier ?? 1);
  return {
    itemId: input.itemId,
    qty: input.qty,
    price: input.price,
    tax,
    sellerPennyGain: input.price - tax,
    buyerPennyCost: input.price,
  };
}

/** 交易额上限用的 7 天窗口 */
export function weeklyWindowStart(now: number): number {
  return now - 7 * 24 * 60 * 60 * 1000;
}

export function describeTrade(input: {
  id: string;
  itemName: string;
  qty: number;
  price: number;
  tax: number;
  expiresAt: number;
}): string {
  return [
    `单号：${input.id}`,
    `物品：${input.itemName} × ${input.qty}`,
    `价格：${formatCurrency(input.price)}（税 ${formatCurrency(input.tax)}，卖家到手 ${formatCurrency(input.price - input.tax)}）`,
    `有效期至：${new Date(input.expiresAt).toISOString().replace('T', ' ').slice(0, 16)} UTC`,
  ].join('\n');
}
