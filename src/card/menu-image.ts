/**
 * **图片菜单**（M2.86）。
 *
 * ## 用户的要求（逐条对应到实现）
 *
 * > 「检索项目所有指令　绘制永久性的精美图片菜单　不要过长，可以多分几张　菜单不应该是一次性的」
 *
 * | 要求 | 实现 |
 * | --- | --- |
 * | 检索所有指令 | 清单**从 `router.commands` 派生**（`command-groups.ts` 只有说明），
 *   并有测试拿两边对账 |
 * | 永久性 | 出图后**落盘缓存**，键 = 内容哈希；内容没变就**永不重画** |
 * | 不要过长 | 按「第几步」拆成 6 张，每张 6—10 条 |
 * | 不是一次性的 | 它不是「发一次的消息」，而是**按需再取的图**（`.菜单 [编号]`），
 *   而且复用同一份缓存文件 —— 同一个玩家看十次也只画一次 |
 *
 * ## 为什么不做成一条消息发完
 *
 * 6 张图连发就是刷屏，而且手机上要滑很久才找到自己要看的那一类。
 * 所以 `.菜单` 一次给一张，尾部提示还有几张、怎么看下一张。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { COMMAND_GROUPS, type CommandGroup } from '../domain/menu/command-groups.ts';
import { dataPath } from '../infra/paths.ts';
import { measureHtmlHeight, renderHtmlToPng } from '../render/browser.ts';

/** 菜单图的设计网格（竖版，手机一屏正好） */
export const MENU_W = 720;
export const MENU_H = 1000;
/** 出图缓存目录 */
export const DEFAULT_MENU_DIR = dataPath('cards', 'menu');
/**
 * **版式版本**：改了 CSS / 字号 / 间距就 +1。
 *
 * 与信息条同一个坑：缓存键只看内容，所以改版式之后所有老玩家拿到的还是旧图 ——
 * 明明代码改了，看上去却「根本没生效」。
 */
export const MENU_LAYOUT_VERSION = 'v3';
//
// v3：高度改成**按内容量**（原来 CSS 写死 height:1000px，条目一多就从中间裁断 ——
//     用户报的「菜单 6 被硬编码截断」就是它）。版式变了必须 +1，否则老玩家的缓存图
//     还是旧的，看上去「改了根本没生效」。

const CSS = [
  'html,body{margin:0;padding:0;background:#0f1310;}',
  '.wrap{width:720px;min-height:1000px;box-sizing:border-box;padding:38px 40px;',
  'font-family:"Microsoft YaHei","PingFang SC",system-ui,sans-serif;color:#e8e2d4;}',
  '.hd{border-bottom:1px solid #3a332a;padding-bottom:18px;margin-bottom:26px;}',
  '.hd .t{font-size:38px;font-weight:700;color:#c9a961;letter-spacing:2px;}',
  '.hd .h{margin-top:12px;font-size:19px;color:#8d8577;line-height:1.5;}',
  '.hd .n{margin-top:10px;font-size:16px;color:#6b6558;letter-spacing:1px;}',
  '.it{display:flex;align-items:flex-start;gap:16px;padding:15px 0;border-bottom:1px dashed #262119;}',
  '.it .c{flex:0 0 auto;min-width:132px;font-size:25px;font-weight:700;color:#f0e6d2;}',
  '.it .b{flex:1 1 auto;min-width:0;}',
  '.it .b .d{font-size:21px;line-height:1.45;color:#c4bdae;}',
  '.it .b .u{margin-top:6px;font-size:17px;color:#8a7a52;font-family:Consolas,monospace;}',
  '.ft{margin-top:22px;font-size:17px;color:#6b6558;line-height:1.6;}',
  '.ft b{color:#c9a961;}',
].join('');

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 单张菜单图的 HTML（**纯函数**） */
export function menuHtml(group: CommandGroup, index: number, total: number): string {
  const items = group.commands.map((command) => {
    const usage = command.usage !== undefined
      ? '<div class="u">' + escapeHtml(command.usage) + '</div>'
      : '';
    /*
     * ⚠️ 这里曾经少写一个字符就整页崩了：`.c` 的 `</div>'` 后面多了一个 **分号**，
     * 于是 `return` 在那里就结束了，**后面拼 `.b`（说明文字）的那半句从来没执行**。
     * 表现是：图里只剩一排指令名横着铺开、说明全丢、下半页大片空白。
     * 浏览器不会报错（它会自动补全没闭合的 div），所以只能靠**看图**发现 ——
     * 这也正是「出图之后一定要亲眼看一次」的理由。
     */
    return '<div class="it"><div class="c">.' + escapeHtml(command.name) + '</div>'
      + '<div class="b"><div class="d">' + escapeHtml(command.brief) + '</div>' + usage + '</div></div>';
  }).join('');
  const more = index < total
    ? '<div class="ft">还有 <b>' + (total - index) + '</b> 张 —— 发 <b>.菜单 ' + (index + 1) + '</b> 看下一张。</div>'
    : '<div class="ft">这是最后一张。玩法循环里大多数步骤都有<b>按钮</b>，能点就不用打字。</div>';
  return '<!doctype html><html><head><meta charset="utf-8"><style>' + CSS + '</style></head><body>'
    + '<div class="wrap"><div class="hd">'
    + '<div class="t">' + escapeHtml(group.title) + '</div>'
    + '<div class="h">' + escapeHtml(group.hint) + '</div>'
    + '<div class="n">第 ' + index + ' / ' + total + ' 张 · 共 ' + group.commands.length + ' 条指令</div>'
    + '</div>' + items + more + '</div></body></html>';
}

/** 缓存键：内容变了才重画（**这就是「永久性」**） */
export function menuCacheKey(group: CommandGroup, index: number, total: number): string {
  const h = createHash('sha256');
  h.update(MENU_LAYOUT_VERSION);
  h.update('|' + group.id);
  h.update('|' + String(index) + '/' + String(total));
  for (const command of group.commands) h.update('|' + command.name + ':' + command.brief + ':' + (command.usage ?? ''));
  return h.digest('hex').slice(0, 32);
}

export interface MenuImage { png: Buffer; fromCache: boolean; key: string; file: string; index: number; total: number }

/**
 * 出**一张**菜单图（带缓存）。
 *
 * 渲染失败返回 undefined —— 与信息条同一条纪律：**图出不来时文字照常发**，
 * 绝不因为一张说明图把消息卡死。
 */
export function renderMenuImage(
  index: number,
  options: { dir?: string; force?: boolean; scale?: number } = {},
): MenuImage | undefined {
  const total = COMMAND_GROUPS.length;
  if (index < 1 || index > total) return undefined;
  const group = COMMAND_GROUPS[index - 1]!;
  const dir = options.dir ?? DEFAULT_MENU_DIR;
  const key = menuCacheKey(group, index, total);
  const file = join(dir, key + '.png');
  if (options.force !== true && existsSync(file)) {
    try {
      return { png: readFileSync(file), fromCache: true, key, file, index, total };
    } catch { /* 读不出来就当没缓存 */ }
  }
  let png: Buffer | undefined;
  try {
    /*
     * 高度按**内容量**走：先量一次真实高度，再按那个高度截图。
     *
     * Edge 的 --screenshot 只按 --window-size 截 —— 写死 1000 的时候，
     * 条目多的那一张（比如第 6 张）就是从中间被裁断的。
     * 量不到（返回 0）时退回 MENU_H：宁可矮一点，也不能让图出不来。
     */
    const html = menuHtml(group, index, total);
    const measured = measureHtmlHeight(html, MENU_W);
    png = renderHtmlToPng(html, { width: MENU_W, height: Math.max(MENU_H, measured), scale: 2, tag: 'menu' });
  } catch {
    return undefined;
  }
  if (png === undefined || png.length === 0) return undefined;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, png);
  } catch { /* 写不进去也要把图发出去 */ }
  return { png, fromCache: false, key, file, index, total };
}

/** 菜单共有几张 */
export function menuPageCount(): number {
  return COMMAND_GROUPS.length;
}

/** 某一张图的纯文本兜底（通道发不出图时用，**与图同源**） */
export function menuText(index: number): string {
  const total = COMMAND_GROUPS.length;
  if (index < 1 || index > total) return '';
  const group = COMMAND_GROUPS[index - 1]!;
  const lines = ['【' + group.title + '】（第 ' + index + '/' + total + ' 张）', group.hint, ''];
  for (const command of group.commands) {
    lines.push('.' + command.name + ' —— ' + command.brief);
    if (command.usage !== undefined) lines.push('　　' + command.usage);
  }
  if (index < total) lines.push('', '还有 ' + (total - index) + ' 张 —— 发 .菜单 ' + (index + 1) + ' 看下一张。');
  return lines.join('\n');
}
