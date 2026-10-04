/**
 * 出图高度：**内容多高就出多高**（别再被 `--window-size` 裁掉）。
 *
 * 现场（用户报）：菜单第 6 张被硬编码截断 —— CSS 写死 `height:1000px`，
 * 而 Edge 的 `--screenshot` 只按 `--window-size` 截图，多出来的部分**安静地没了**
 * （不报错、也不留痕，只能靠眼睛看出来）。
 *
 * 判据两条：
 *   ① `measureHtmlHeight` 能读回真实内容高度（`--dump-dom` 那条路）；
 *   ② 按量到的高度出图，PNG 的实际像素高度与之相符 —— 而不是窗口那个高度。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { measureHtmlHeight, renderHtmlToPng } from '../src/render/browser.ts';

/** 造一个高度确定的页面 */
function tallHtml(contentPx: number): string {
  return [
    '<!doctype html><html><head><meta charset="utf-8"></head>',
    '<body style="margin:0;padding:0;background:#111">',
    `<div style="width:720px;height:${contentPx}px;background:#222"></div>`,
    '</body></html>',
  ].join('');
}

/** PNG 的像素高：IHDR 在固定偏移上，不需要图像库 */
function pngHeight(png: Buffer): number {
  return png.readUInt32BE(20);
}

test('量高度：内容 1500px 时，量出来不能小于它', () => {
  const height = measureHtmlHeight(tallHtml(1500), 720);
  assert.ok(height >= 1500, '内容 1500px，量出来是 ' + height);
});

test('出图：按量到的高度截图 —— 1500px 的内容不能再产出一张 1000×2 的裁切图', () => {
  const html = tallHtml(1500);
  const height = measureHtmlHeight(html, 720);
  assert.ok(height > 0, '这一步量不到高度，后面的断言就没有意义');
  const png = renderHtmlToPng(html, { width: 720, height, scale: 2, tag: 'height-test' });
  assert.ok(pngHeight(png) >= 1500 * 2, 'PNG 高 ' + pngHeight(png) + '，内容 1500px × scale 2');
});

test('量高度：量不到也不抛错（调用方退回写死的高度，绝不因此出不了图）', () => {
  const height = measureHtmlHeight('<!doctype html><html><body></body></html>', 720);
  assert.ok(Number.isFinite(height) && height >= 0, '量出来是 ' + height);
});