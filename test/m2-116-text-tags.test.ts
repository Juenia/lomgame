/**
 * **标签在长度账上只算它显示出来的那几个字**（M2.116）。
 *
 * 用户报的 BUG：
 *
 * > 「文字标签按钮的代码疑似被算在字数里了，每多一个标签指令按钮就会导致背包被过长截断」
 *
 * 一条标签源码 96 个字符，而客户端显示三个字 —— 按 `text.length` 算，
 * 背包里十来件可点物品就能把 1000 的上限撑爆。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { displayLengthOf, truncateKeepingTags } from '../src/adapter/text-tags.ts';

const tag = (text: string, show: string) =>
  '<qqbot-cmd-input text="' + encodeURIComponent(text) + '" show="' + encodeURIComponent(show) + '" />';

test('M2.116 长度按显示算：标签只算 show 那几个字', () => {
  const one = tag('.使用 驱邪符', '驱邪符');
  assert.ok(one.length > 60, '标签源码本来就长：' + one.length);
  assert.equal(displayLengthOf(one), 3, '账上只算三个字');
  assert.equal(displayLengthOf('· ' + one + '　×1　非绑定'), 3 + '· 　×1　非绑定'.length, '其余部分照算');
});

test('M2.116 一屏十件可点物品，账上只多三十来个字（原来会多算九百）', () => {
  const rows = Array.from({ length: 10 }, (_, i) => '· ' + tag('.使用 物品' + i, '物品' + i) + '　×1　非绑定');
  const text = rows.join('\n');
  // 源码长度：每行 90 上下 ⇒ 总共接近 1000
  assert.ok(text.length > 800, '源码本身已经很接近上限：' + text.length);
  // 显示长度：每行「· 物品N　×1　非绑定」≈ 11 字
  assert.ok(displayLengthOf(text) < 200, '显示长度要远小于源码长度：' + displayLengthOf(text));
});

test('M2.116 截断时不切开标签（半截标签平台不认，会原样显示源码）', () => {
  const text = '开头' + tag('.使用 驱邪符', '驱邪符') + '结尾';
  // 只放得下「开头」两个字
  const cut = truncateKeepingTags(text, 2);
  assert.equal(cut, '开头…', '超出的标签整条不要，而不是切一半');
  // 放得下标签本体（3 字）：开头(2) + 3 = 5
  const keep = truncateKeepingTags(text, 5);
  assert.ok(keep.includes(tag('.使用 驱邪符', '驱邪符')), '放得下就要整条留着：' + keep);
  assert.ok(!keep.includes('结尾'), '放不下的部分截掉');
});

test('M2.116 不超限时原样返回（逐字不变）', () => {
  const text = '· ' + tag('.服用 X', 'X') + '　非绑定';
  assert.equal(truncateKeepingTags(text, 1000), text);
});
