/**
 * M2.5 追加：三层货币（金镑 / 苏勒 / 便士）单测。
 *
 * 纯函数组 + 链路组：前者钉住换算与解析，后者钉住「存储是便士、显示是三层」这条链路。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NUMERIC } from '../src/config/numeric.ts';
import {
  CURRENCY_RATES,
  formatCurrency,
  formatCurrencyInput,
  formatCurrencyWithPennies,
  parseCurrency,
  splitCurrency,
} from '../src/domain/currency/index.ts';
import { CURRENCY_ITEM_ID } from '../src/domain/item/item.ts';
import { createHarness, DEFAULT_USER } from './helpers/app.ts';

test('货币：进位是 1 金镑 = 20 苏勒 = 240 便士', () => {
  assert.equal(NUMERIC.currency.unit, 'penny');
  assert.equal(CURRENCY_RATES.penny, 1);
  assert.equal(CURRENCY_RATES.shilling, 12);
  assert.equal(CURRENCY_RATES.pound, 240);
  assert.equal(CURRENCY_RATES.shilling * 20, CURRENCY_RATES.pound);
});

test('货币：便士 → 三层（任务书 §2.2 的四个例子）', () => {
  assert.equal(formatCurrency(8), '8 便士');
  // 任务书那张表把 25 写成了「1 苏勒 1 便士」—— 那是笔误：25 = 2×12 + 1，正确是 2 苏勒 1 便士。
  // 这里按数学实现，并在交付说明里记一笔。
  assert.equal(formatCurrency(25), '2 苏勒 1 便士');
  assert.equal(formatCurrency(13), '1 苏勒 1 便士');
  assert.equal(formatCurrency(250), '1 金镑 10 便士');
  assert.equal(formatCurrency(1920), '8 金镑');
});

test('货币：三层拆分的边界（零头不显示、0 兜底、负数兜底）', () => {
  assert.deepEqual(splitCurrency(0), { pound: 0, shilling: 0, penny: 0 });
  assert.equal(formatCurrency(0), '0 便士');
  assert.deepEqual(splitCurrency(12), { pound: 0, shilling: 1, penny: 0 });
  assert.deepEqual(splitCurrency(240), { pound: 1, shilling: 0, penny: 0 });
  assert.deepEqual(splitCurrency(303), { pound: 1, shilling: 5, penny: 3 });
  assert.deepEqual(splitCurrency(239), { pound: 0, shilling: 19, penny: 11 });
  // 负数不该出现，但显示了也不能炸
  assert.equal(formatCurrency(-5), '0 便士');
  assert.equal(formatCurrency(Number.NaN), '0 便士');
  // 中间层为 0 时跳过它（1 金镑 5 便士，而不是 1 金镑 0 苏勒 5 便士）
  assert.equal(formatCurrency(245), '1 金镑 5 便士');
});

test('货币：带总额的显示（大额时把便士数也写出来）', () => {
  assert.equal(formatCurrencyWithPennies(8), '8 便士');
  assert.equal(formatCurrencyWithPennies(1920), '8 金镑（1920 便士）');
  assert.equal(formatCurrencyWithPennies(250), '1 金镑 10 便士（250 便士）');
});

test('货币：输入解析 —— 默认便士 + p/s/g 后缀 + 组合格式', () => {
  assert.equal(parseCurrency('8'), 8, '不带后缀默认是便士');
  assert.equal(parseCurrency('8p'), 8);
  assert.equal(parseCurrency('8P'), 8, '大小写不敏感');
  assert.equal(parseCurrency('8s'), 96);
  assert.equal(parseCurrency('8g'), 1920);
  assert.equal(parseCurrency('1g'), 240);
  assert.equal(parseCurrency('1g5s3p'), 303);
  assert.equal(parseCurrency('2g3p'), 483, '跳过中间层');
  assert.equal(parseCurrency('1 金镑 5 苏勒'), 300, '中文单位也认');
  assert.equal(parseCurrency('8 苏勒'), 96);
  assert.equal(parseCurrency('0'), 0);
});

test('货币：输入解析 —— 非法输入一律返回 null（不许把 8x 当成 8）', () => {
  for (const bad of ['', '   ', 'abc', '8x', 'g', '8g5', '-3', '8.5', '１', '8 金']) {
    assert.equal(parseCurrency(bad), null, `\`${bad}\` 不该被解析成货币`);
  }
});

test('货币：往返一致（便士 → 输入格式 → 便士）', () => {
  for (const pennies of [0, 1, 8, 12, 25, 239, 240, 250, 303, 1920, 4999]) {
    const text = formatCurrencyInput(pennies);
    assert.equal(parseCurrency(text), pennies, text + ' 应该还原成 ' + pennies);
  }
});

/* ---------------- 链路：存储是便士、显示是三层 ---------------- */

test('货币链路：背包把货币单独列成三层，物品列表里不再出现货币', async () => {
  const h = createHarness();
  try {
    await h.createCharacter(DEFAULT_USER, '钱袋');
    const character = h.repos.characters.findByUserId(DEFAULT_USER)!;
    h.repos.inventory.add(character.id, CURRENCY_ITEM_ID, 303, 'unbound', h.now());
    h.repos.inventory.add(character.id, '夜香草', 2, 'bound', h.now());

    const replies = await h.send({ rawText: '.背包', userId: DEFAULT_USER });
    const text = replies.map((reply) => reply.text).join('\n');
    // M2.55：货币那行从「货币：xxx」改成加粗小标题 + 金额（**货币**　1 金镑 5 苏勒 3 便士）
  assert.match(text, /1 金镑 5 苏勒 3 便士/, '货币要按三层显示：' + text.slice(0, 200));
    assert.match(text, /夜香草/);
    assert.doesNotMatch(text, /金镑 ×/, '货币不该再以物品行的形式出现');
  } finally {
    h.app.close();
  }
});

test('货币链路：交易的存储是便士整数，回执按三层显示，税按便士向下取整', async () => {
  const h = createHarness();
  try {
    await h.createCharacter('40001', '卖家');
    await h.createCharacter('40002', '买家');
    const seller = h.repos.characters.findByUserId('40001')!;
    const buyer = h.repos.characters.findByUserId('40002')!;
    h.repos.inventory.add(seller.id, '夜香草', 2, 'unbound', h.now());
    h.repos.inventory.add(buyer.id, CURRENCY_ITEM_ID, 500, 'unbound', h.now());

    // .交易 是**卖家**发起、@ 后面写**买家**（见 TRADE_USAGE）
    const replies = await h.send({ rawText: '.交易 @40002 夜香草 1 1g5s3p', userId: '40001' });
    const text = replies.map((reply) => reply.text).join('\n');
    assert.match(text, /1 金镑 5 苏勒 3 便士/, '报价要按三层回显：' + text.slice(0, 200));

    // 库里存的必须是便士整数，而不是「1 金镑 5 苏勒 3 便士」三个字段
    const row = h.app.db.prepare('SELECT * FROM trades ORDER BY rowid DESC LIMIT 1').get() as Record<string, unknown>;
    assert.equal(Number(row.price_penny), 303, '存储是便士整数');
    assert.equal(Number(row.tax_penny), Math.floor(303 * NUMERIC.trade.taxRate), '税按便士向下取整');

    const confirmed = await h.send({ rawText: '.确认 ' + String(row.id), userId: '40002' });
    const done = confirmed.map((reply) => reply.text).join('\n');
    assert.match(done, /1 金镑 5 苏勒 3 便士/);
    assert.equal(h.repos.inventory.count(seller.id, CURRENCY_ITEM_ID), 288, '卖家到手 303 - 15 = 288 便士');
  } finally {
    h.app.close();
  }
});
