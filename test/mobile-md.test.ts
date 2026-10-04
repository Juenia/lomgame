/**
 * M2.86：**手机端不渲染 `**`**（用户实机截图确认）。
 *
 * 截图里 `**【曾经】**铁工厂(极危险)` 在手机 QQ 上**带星号原样显示** ——
 * 那份「官方白名单里有 `**加粗**`」的旧记录在手机端不成立，
 * 而电脑端会渲染出来，于是两端看到的不是同一个东西。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stripBoldForMobile, toQQMarkdown } from '../src/adapter/official.ts';

test('手机端兼容：`**X**` 去掉星号，只留文字', () => {
  assert.equal(stripBoldForMobile('**【曾经】**铁工厂'), '【曾经】铁工厂');
  assert.equal(stripBoldForMobile('**生命** 94/100'), '生命 94/100');
  assert.equal(stripBoldForMobile('| **物品** | 数量 |'), '| 物品 | 数量 |');
  assert.equal(stripBoldForMobile('**货币**　1 金镑'), '货币　1 金镑');
});

test('手机端兼容：**不动分割线 `***`**（它是行级语法，两端都认）', () => {
  assert.equal(stripBoldForMobile('***'), '***');
  assert.equal(stripBoldForMobile('上文\n***\n下文'), '上文\n***\n下文');
});

test('手机端兼容：原文没星号时**逐字不变**（不能误伤）', () => {
  for (const s of ['普通文字', '【标题】正文', '> 引用块', '- 列表项', '| a | b |']) {
    assert.equal(stripBoldForMobile(s), s);
  }
});

test('手机端兼容：toQQMarkdown 的产物里**不该再有 `**`**', () => {
  const md = toQQMarkdown('**【曾经】**铁工厂(极危险)\n***\n**生命** 94/100');
  /*
   * ⚠️ 不能简单断言「不含 `**`」—— **分割线 `***` 本身就含两个星号**，而它是合法的。
   * 要断言的是「没有 `**…**` 这种**成对的加粗**」。
   */
  assert.ok(!/\*\*[^*\n]+\*\*/.test(md), '产物里还有加粗星号：' + JSON.stringify(md));
  assert.ok(md.includes('***'), '分割线要留着');
  assert.ok(md.includes('【曾经】'), '文字要留下');
  assert.ok(md.includes('***'), '分割线要在');
});
