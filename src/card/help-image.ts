/**
 * **新手入门图**（M2.87）。
 *
 * ## 用户的要求
 *
 * > 「交易体系做完要补充帮助菜单的图片」
 *
 * `.菜单` 已经是图片版（6 张指令表）。`.帮助` 一直是纯文本 —— 而它是**新玩家
 * 第一个会发的命令**，也是最该被看懂的一个。
 *
 * ## 画什么：不是「帮助目录」，是「怎么开始」
 *
 * `.帮助` 下面已经有 FAQ / 群规则 / 封测说明三块（文字，各有各的用处）。
 * 再给它们配图是重复 —— 新玩家真正缺的是**「我现在该做什么」**。
 *
 * 所以这张图画的是**四步**：创建 → 扮演 → 探索 → 晋升，外加两条最要紧的提醒。
 *
 * ## 与 `.菜单` 共用同一套视觉与缓存思路
 *
 * 深色底 + 金色标题、720×1000 的竖版、内容哈希做缓存键、版式版本号 ——
 * 理由与 `menu-image.ts` 里写的一样（改版式必须 +1，否则老玩家拿到的还是旧图）。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataPath } from '../infra/paths.ts';
import { measureHtmlHeight, renderHtmlToPng } from '../render/browser.ts';

/** 与 `.菜单` 同一个网格（竖版，手机一屏） */
export const HELP_W = 720;
/**
 * 高度比 `.菜单` 的 1000 高 120px。
 *
 * ⚠️ 第一版用了 1000，**底部被裁掉了**：`.note` 的最后一行压边、`.ft` 整块没显示 ——
 * 而 `.ft` 里写着「全部指令看 .菜单」，那正是这张图最该导流的地方。
 * 出图不会因为内容超长而报错，它只会**安静地裁掉**，所以验收必须用眼睛看。
 */
export const HELP_H = 1120;
export const DEFAULT_HELP_DIR = dataPath('cards', 'help');
/** 改了 CSS / 文案就 +1 —— 缓存键只看内容，不加版本号的话老玩家永远拿旧图 */
export const HELP_LAYOUT_VERSION = 'v2';
//
// v2：高度改成**按内容量**。上面那句「第一版用了 1000，底部被裁掉了」是同一个坑的
//     第一次发作 —— 当时靠把常量加到 1120 救回来，但那只是把裁切线往下挪了一截，
//     内容再长一点照样裁。现在由 measureHtmlHeight 量出真实高度。

const CSS = [
  'html,body{margin:0;padding:0;background:#0f1310;}',
  '.wrap{width:720px;min-height:1000px;box-sizing:border-box;padding:40px 42px;',
  'font-family:"Microsoft YaHei","PingFang SC",system-ui,sans-serif;color:#e8e2d4;}',
  '.hd{border-bottom:1px solid #3a332a;padding-bottom:20px;margin-bottom:24px;}',
  '.hd .t{font-size:40px;font-weight:700;color:#c9a961;letter-spacing:3px;}',
  '.hd .s{margin-top:12px;font-size:20px;color:#8d8577;line-height:1.5;}',
  '.step{display:flex;align-items:flex-start;gap:18px;padding:16px 0;border-bottom:1px dashed #262119;}',
  '.step .n{flex:0 0 auto;width:46px;height:46px;border-radius:23px;background:#1d241c;',
  'color:#c9a961;font-size:24px;font-weight:700;line-height:46px;text-align:center;}',
  '.step .b{flex:1 1 auto;min-width:0;}',
  '.step .b .h{font-size:25px;font-weight:700;color:#f0e6d2;}',
  '.step .b .d{margin-top:7px;font-size:20px;line-height:1.5;color:#c4bdae;}',
  '.step .b .c{margin-top:8px;font-size:19px;color:#c9a961;font-family:Consolas,monospace;}',
  '.note{margin-top:22px;padding:18px 20px;background:#161a15;border-left:3px solid #6b5a2f;}',
  '.note .l{font-size:20px;line-height:1.6;color:#c4bdae;}',
  '.note .l b{color:#c9a961;}',
  '.ft{margin-top:20px;font-size:18px;color:#6b6558;line-height:1.6;}',
  '.ft b{color:#c9a961;}',
].join('');

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 四步走。每一句都对应一条真实存在的指令（写错等于教错人） */
const STEPS: ReadonlyArray<{ h: string; d: string; c: string }> = [
  {
    h: '先成为一个人',
    d: '你在鲁恩王国的某个街角醒来。发 .创建 给自己一个名字 —— 这时你只是个普通人。',
    c: '.创建 <名字>',
  },
  {
    h: '每天先看今日',
    d: '这个世界按天推进。.今日 会告诉你今天能去哪些地方、还能做什么 —— 它是你的日程表。',
    c: '.今日',
  },
  {
    h: '去雾里找东西',
    d: '探索是唯一的产出手段，也是唯一的危险来源。危险度越高，收获越好，伤得也越重。',
    c: '.探索 <地点>',
  },
  {
    h: '走上那条路',
    d: '凑齐材料调制魔药（.魔药），喝下去（.服用）就不再是普通人。之后靠扮演消化序列。',
    // ⚠️ 第一版写成 `.魔药 · .服用 · .扮演`，那个 `·` 会让人以为要连着打三个 ——
    // 而它们是三步、每步单独发。用 `/` 表示「或者」，与指令里的 `·` 区分开。
    c: '.魔药  /  .服用  /  .扮演',
  },
];

export function helpHtml(): string {
  const steps = STEPS.map((s, i) =>
    '<div class="step"><div class="n">' + (i + 1) + '</div><div class="b">' +
    '<div class="h">' + esc(s.h) + '</div>' +
    '<div class="d">' + esc(s.d) + '</div>' +
    '<div class="c">' + esc(s.c) + '</div>' +
    '</div></div>',
  ).join('');
  return '<!doctype html><html><head><meta charset="utf-8"><style>' + CSS + '</style></head><body><div class="wrap">' +
    '<div class="hd"><div class="t">怎么玩《群星低语》</div>' +
    '<div class="s">一个用文字进行的诡秘世界。你发的每一句话，它都会回答。</div></div>' +
    steps +
    '<div class="note">' +
    '<div class="l"><b>两件要紧的事</b></div>' +
    '<div class="l">· 指令前面要带一个点：<b>.今日</b>、<b>.探索 老码头</b>。</div>' +
    '<div class="l">· 拿不准发什么时，看底部的按钮 —— <b>点一下就行</b>。</div>' +
    '</div>' +
    '<div class="ft">全部指令看 <b>.菜单</b>（图片版，一张张翻）。<br>' +
    '常见问题 <b>.帮助 faq</b> · 群规则 <b>.帮助 规则</b>。</div>' +
    '</div></body></html>';
}

export function helpCacheKey(): string {
  return createHash('sha256').update(HELP_LAYOUT_VERSION + helpHtml()).digest('hex').slice(0, 16);
}

export interface HelpImage { png: Buffer; fromCache: boolean; file: string }

/** 出图（有缓存就不重画 —— 内容没变时它永远不会重画） */
export function renderHelpImage(dir: string = DEFAULT_HELP_DIR): HelpImage {
  const key = helpCacheKey();
  const file = join(dir, 'help-' + key + '.png');
  if (existsSync(file)) return { png: readFileSync(file), fromCache: true, file };
  mkdirSync(dir, { recursive: true });
  /*
   * 高度按**内容量**走：先量一次真实高度，再按那个高度截图（理由见 browser.ts 的
   * measureHtmlHeight）。HELP_H 退化成**下限** —— 内容比它高时以内容为准。
   */
  const html = helpHtml();
  const measured = measureHtmlHeight(html, HELP_W);
  const png = renderHtmlToPng(html, { width: HELP_W, height: Math.max(HELP_H, measured), scale: 2, tag: 'help' });
  writeFileSync(file, png);
  return { png, fromCache: false, file };
}
