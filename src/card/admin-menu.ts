/**
 * **管理员指令卡片菜单**（M2.172）—— `.管理 [编号]` 出图。
 *
 * 与玩家的 `.菜单` 同一套做法（`card/menu-image.ts`）：HTML → PNG、内容哈希做缓存键、
 * 版式改了要 +1 版号。区别只有两处：
 *
 *   · 数据源是 `domain/menu/admin-commands.ts`（管理员那一份），不进玩家菜单；
 *   · 配色换成**暗红 + 金**，一眼能跟玩家菜单分得开 —— 管理员在群里发这张图时，
 *     截图传出去也不会被当成普通菜单。
 *
 * 出图失败时由命令层退回同源的文字版（`adminMenuText`），与 `.菜单` 完全一致。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ADMIN_COMMAND_GROUPS, type AdminCommandGroup } from '../domain/menu/admin-commands.ts';
import { dataPath } from '../infra/paths.ts';
import { measureHtmlHeight, renderHtmlToPng } from '../render/browser.ts';

/** 与玩家菜单同尺寸（竖版，手机一屏正好） */
export const ADMIN_MENU_W = 720;
export const ADMIN_MENU_H = 1000;
/** 出图缓存目录 */
export const DEFAULT_ADMIN_MENU_DIR = dataPath('cards', 'admin-menu');
/** 版式版本：改了 CSS / 字号 / 间距就 +1（否则老缓存图永远不刷新） */
export const ADMIN_MENU_LAYOUT_VERSION = 'v1';

const CSS = [
  'html,body{margin:0;padding:0;background:#120e10;}',
  '.wrap{width:720px;min-height:1000px;box-sizing:border-box;padding:38px 40px;',
  'font-family:"Microsoft YaHei","PingFang SC",system-ui,sans-serif;color:#e8e2d4;}',
  '.hd{border-bottom:1px solid #4a2b2b;padding-bottom:18px;margin-bottom:26px;}',
  '.hd .t{font-size:38px;font-weight:700;color:#d98b6a;letter-spacing:2px;}',
  '.hd .h{margin-top:12px;font-size:19px;color:#8d8577;line-height:1.5;}',
  '.hd .n{margin-top:10px;font-size:16px;color:#7a5f5f;letter-spacing:1px;}',
  '.hd .n b{color:#c9a961;}',
  '.it{display:flex;align-items:flex-start;gap:16px;padding:15px 0;border-bottom:1px dashed #2a1f1f;}',
  '.it .c{flex:0 0 auto;min-width:168px;font-size:24px;font-weight:700;color:#f0e6d2;}',
  '.it .b{flex:1 1 auto;min-width:0;}',
  '.it .b .d{font-size:21px;line-height:1.45;color:#c4bdae;}',
  '.it .b .u{margin-top:6px;font-size:17px;color:#b07a52;font-family:Consolas,monospace;}',
  '.ft{margin-top:22px;font-size:17px;color:#7a5f5f;line-height:1.6;}',
  '.ft b{color:#d98b6a;}',
].join('');

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 一张管理员菜单的 HTML（与玩家菜单同一条渲染管线） */
export function adminMenuHtml(group: AdminCommandGroup, index: number, total: number): string {
  const rows = group.commands.map((command) => {
    const usage = command.usage === undefined ? '' : '<div class="u">' + esc(command.usage) + '</div>';
    return (
      '<div class="it"><div class="c">.' + esc(command.name) + '</div>' +
      '<div class="b"><div class="d">' + esc(command.brief) + '</div>' + usage + '</div></div>'
    );
  });
  const head =
    '<div class="hd"><div class="t">' + esc(group.title) + '</div>' +
    '<div class="h">' + esc(group.hint) + '</div>' +
    '<div class="n">管理员指令 · 第 <b>' + String(index) + '</b>/<b>' + String(total) + '</b> 张</div></div>';
  const foot =
    index < total
      ? '<div class="ft">还有 <b>' + String(total - index) + '</b> 张 —— 发 <b>.管理 ' + String(index + 1) + '</b> 看下一张。</div>'
      : '<div class="ft">这就是全部。<b>只有名单里的管理员能用这些指令。</b></div>';
  return (
    '<!doctype html><html><head><meta charset="utf-8"><style>' + CSS + '</style></head>' +
    '<body><div class="wrap">' + head + rows.join('') + foot + '</div></body></html>'
  );
}

export function adminMenuCacheKey(group: AdminCommandGroup, index: number, total: number): string {
  const h = createHash('sha256');
  h.update(ADMIN_MENU_LAYOUT_VERSION);
  h.update('|' + group.id);
  h.update('|' + String(index) + '/' + String(total));
  for (const command of group.commands) h.update('|' + command.name + ':' + command.brief + ':' + (command.usage ?? ''));
  return h.digest('hex').slice(0, 32);
}

export interface AdminMenuImage {
  png: Buffer;
  fromCache: boolean;
  key: string;
  file: string;
  index: number;
  total: number;
}

/** 出**一张**管理员菜单图（带缓存）。出不来返回 undefined，由命令层退回文字版 */
export function renderAdminMenuImage(
  index: number,
  options: { dir?: string; force?: boolean } = {},
): AdminMenuImage | undefined {
  const total = ADMIN_COMMAND_GROUPS.length;
  if (index < 1 || index > total) return undefined;
  const group = ADMIN_COMMAND_GROUPS[index - 1]!;
  const dir = options.dir ?? DEFAULT_ADMIN_MENU_DIR;
  const key = adminMenuCacheKey(group, index, total);
  const file = join(dir, key + '.png');
  if (options.force !== true && existsSync(file)) {
    try {
      return { png: readFileSync(file), fromCache: true, key, file, index, total };
    } catch { /* 读不出来就当没缓存 */ }
  }
  let png: Buffer | undefined;
  try {
    const html = adminMenuHtml(group, index, total);
    const measured = measureHtmlHeight(html, ADMIN_MENU_W);
    png = renderHtmlToPng(html, { width: ADMIN_MENU_W, height: Math.max(ADMIN_MENU_H, measured), scale: 2, tag: 'admin-menu' });
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

/** 某一张图的纯文本兜底（**与图同源**） */
export function adminMenuText(index: number): string {
  const total = ADMIN_COMMAND_GROUPS.length;
  if (index < 1 || index > total) return '';
  const group = ADMIN_COMMAND_GROUPS[index - 1]!;
  const lines = ['【' + group.title + '】（第 ' + index + '/' + total + ' 张）', group.hint, ''];
  for (const command of group.commands) {
    lines.push('.' + command.name + ' —— ' + command.brief);
    if (command.usage !== undefined) lines.push('　　' + command.usage);
  }
  if (index < total) lines.push('', '还有 ' + (total - index) + ' 张 —— 发 .管理 ' + (index + 1) + ' 看下一张。');
  return lines.join('\n');
}
