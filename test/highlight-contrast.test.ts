/**
 * **色板必须在白底上可读**（M2.86）。
 *
 * 这条是被一次**实机事故**逼出来的：
 *
 * > 用户截图：「探索的收获看不到，md消息默认白底，不能使用白色作为字体颜色，检查全部」
 *
 * 我在「解决颜色太单调」那一轮把 `name` 改成了纯白 `#ffffff`，
 * 还把**所有颜色都调亮了**（`#4ade80` `#fb923c` `#ff5470` …）——
 * 那批色是给**深色背景**挑的。而 QQ 的 markdown 消息**是白底**，
 * 于是物品名整段隐形（截图里只剩 `× 1（非绑定·常见）`）。
 *
 * ## 判据
 *
 * 每个色与 `#ffffff` 的 **WCAG 对比度不低于 4.5:1**（正文级要求）。
 *
 * 这条用例的价值在于：**它把「那个底是什么颜色」这个一直没写下来的前提钉住了**。
 * 之前所有关于颜色的讨论都建立在「深色卡面」的直觉上 —— 而消息正文根本不是。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HL_COLORS } from '../src/adapter/highlight.ts';

/** WCAG 相对亮度 */
function luminance(hex: string): number {
  const channels = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

/** 与白底的对比度 */
function contrastOnWhite(hex: string): number {
  return (1.0 + 0.05) / (luminance(hex) + 0.05);
}

test('色板：每个颜色在白底上都够深（对比度 >= 4.5:1）', () => {
  const bad: string[] = [];
  for (const [kind, hex] of Object.entries(HL_COLORS as Record<string, string>)) {
    const ratio = contrastOnWhite(hex);
    if (ratio < 4.5) bad.push(kind + ' ' + hex + ' 只有 ' + ratio.toFixed(2) + ':1');
  }
  assert.deepEqual(bad, [],
    'MD 消息是白底 —— 这些颜色太浅，正文里会看不清：' + String.fromCharCode(10) + bad.join(String.fromCharCode(10)));
});

test('色板：没有任何颜色是纯白或近白（白底上等于隐形）', () => {
  for (const [kind, hex] of Object.entries(HL_COLORS as Record<string, string>)) {
    assert.notEqual(hex.toLowerCase(), '#ffffff', kind + ' 是纯白 —— 白底上等于隐形');
    assert.ok(luminance(hex) < 0.6, kind + ' ' + hex + ' 太亮，白底上读不出来');
  }
});
