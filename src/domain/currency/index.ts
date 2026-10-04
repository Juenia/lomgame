/**
 * 三层货币（M2.5 追加）域层出口。
 *
 * 内部一律便士整数；三层只在显示与输入解析里出现。
 */
export {
  CURRENCY_RATES,
  formatCurrency,
  formatCurrencyInput,
  formatCurrencyWithPennies,
  parseCurrency,
  splitCurrency,
  type CurrencyParts,
  type CurrencyUnit,
} from './currency.ts';
