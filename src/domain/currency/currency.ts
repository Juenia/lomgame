/**
 * 三层货币（M2.5 追加）：金镑 / 苏勒 / 便士。
 *
 * 诡秘之主的货币是十进制三层：**1 金镑 = 20 苏勒 = 240 便士**。
 *
 * 三条硬规则：
 *   1. **存储永远是便士整数**（最小单位）。三层只活在显示层与输入解析里 ——
 *      绝不出现「三个字段互相同步」那类账目 bug。
 *   2. **换算只在显示层做**。业务代码拿到的永远是便士数，数值比较也一律按便士。
 *   3. 后缀 p / s / g 与中文单位都认（玩家真的会打「8苏勒」）。
 *
 * 这里全是纯函数：没有 IO、没有时钟、没有 rng，所以可以直接单测。
 */
import { NUMERIC } from '../../config/numeric.ts';

const CFG = NUMERIC.currency;

export type CurrencyUnit = 'penny' | 'shilling' | 'pound';

/** 各单位的进位数（便士为基准） */
export const CURRENCY_RATES = CFG.rates;

export interface CurrencyParts {
  pound: number;
  shilling: number;
  penny: number;
}

/**
 * 便士 → 三层。
 * 负数按 0 处理（账目不该为负；真出现了也用 0 兜住，不让显示层炸）。
 */
export function splitCurrency(totalPennies: number): CurrencyParts {
  const total = Math.max(0, Math.floor(Number.isFinite(totalPennies) ? totalPennies : 0));
  const pound = Math.floor(total / CURRENCY_RATES.pound);
  const rest = total - pound * CURRENCY_RATES.pound;
  const shilling = Math.floor(rest / CURRENCY_RATES.shilling);
  return { pound, shilling, penny: rest - shilling * CURRENCY_RATES.shilling };
}

/**
 * 便士 → 显示文本。**零头不显示**：
 *   8    → 8 便士
 *   25   → 2 苏勒 1 便士（25 = 2×12 + 1）
 *   250  → 1 金镑 10 便士（250 = 240 + 10）
 *   1920 → 8 金镑
 * 全为 0 时显示「0 便士」（而不是空字符串）。
 */
export function formatCurrency(totalPennies: number): string {
  const parts = splitCurrency(totalPennies);
  const chunks: string[] = [];
  if (parts.pound > 0) chunks.push(parts.pound + ' ' + CFG.labels.pound);
  if (parts.shilling > 0) chunks.push(parts.shilling + ' ' + CFG.labels.shilling);
  if (parts.penny > 0 || chunks.length === 0) chunks.push(parts.penny + ' ' + CFG.labels.penny);
  return chunks.join(' ');
}

/** 便士 → 带总额的显示（交易额上限、税这类需要「看得见底数」的地方用） */
export function formatCurrencyWithPennies(totalPennies: number): string {
  const total = Math.max(0, Math.floor(Number.isFinite(totalPennies) ? totalPennies : 0));
  const parts = splitCurrency(total);
  if (parts.pound === 0 && parts.shilling === 0) return formatCurrency(total);
  return formatCurrency(total) + '（' + total + ' 便士）';
}

/** 后缀 / 中文单位 → 单位名（大小写不敏感） */
function unitOf(raw: string): CurrencyUnit | null {
  const text = raw.trim().toLowerCase();
  if (!text) return null;
  if (text === CFG.labels.pound || text === 'g') return 'pound';
  if (text === CFG.labels.shilling || text === 's') return 'shilling';
  if (text === CFG.labels.penny || text === 'p') return 'penny';
  return null;
}

/**
 * 玩家输入 → 便士数。返回 null = 不合法（调用方负责给出提示）。
 *
 *   8            → 8 便士（**默认单位是便士**）
 *   8p           → 8 便士
 *   8s           → 8 苏勒 = 96 便士
 *   8g           → 8 金镑 = 1920 便士
 *   1g5s3p       → 1 金镑 5 苏勒 3 便士 = 303 便士
 *   1 金镑 5 苏勒 → 300 便士（中文单位也认）
 */
export function parseCurrency(input: string): number | null {
  const text = String(input ?? '').trim();
  if (!text) return null;
  // 纯数字 = 便士（最常见的一种，先走快路径）
  if (/^[0-9]+$/.test(text)) return Number(text);

  // 组合：逐段匹配「数字 + 单位」，并要求**整串都被吃掉**（不然 8x 会被当成 8）
  const pattern = /([0-9]+)\s*([A-Za-z\u4e00-\u9fa5]+)/g;
  let total = 0;
  let consumed = 0;
  let matched = pattern.exec(text);
  while (matched !== null) {
    const unit = unitOf(matched[2]!);
    if (!unit) return null;
    total += Number(matched[1]) * CURRENCY_RATES[unit];
    // 用 lastIndex 而不是「累加匹配长度」：段与段之间的空格不在匹配里，
    // 累加长度会少算（'1 金镑 5 苏勒' 会被误判成没吃完整串）。
    consumed = pattern.lastIndex;
    matched = pattern.exec(text);
  }
  if (consumed === 0) return null;
  // 整串必须被吃掉：把空格去掉之后比长度
  if (text.slice(0, consumed).replace(/\s+/g, '').length !== text.replace(/\s+/g, '').length) {
    return null;
  }
  return total;
}

/** 便士 → 输入格式（回执里回显玩家的报价，例如 303 → 1g5s3p） */
export function formatCurrencyInput(totalPennies: number): string {
  const parts = splitCurrency(totalPennies);
  const chunks: string[] = [];
  if (parts.pound > 0) chunks.push(parts.pound + 'g');
  if (parts.shilling > 0) chunks.push(parts.shilling + 's');
  if (parts.penny > 0 || chunks.length === 0) chunks.push(parts.penny + 'p');
  return chunks.join('');
}
