/**
 * `.管理 [编号]` —— **管理员指令的卡片菜单**（M2.172）。
 *
 * 与 `.菜单` 同一套三级降级：内嵌图（一条消息）→ 富媒体直发 → 同源文字版。
 * 两个不同之处，都是有意的：
 *
 *   1. **发到私聊**。管理员指令的回执一律只回给本人（见 `commands/admin.ts` 的纪律），
 *      菜单也一样 —— 在群里刷一张写着「封禁 / 关闭游戏」的图，等于告诉所有人这个群有管理员。
 *   2. **没有角色也能看**。`.菜单` 需要角色是因为原生按钮的回传要靠角色的待答菜单；
 *      而管理员可能根本没建过号。所以这里把角色当**可选**：有角色就带导航按钮，
 *      没有就只发图 —— 而不是把他挡在门外。
 */
import { ADMIN_MENU_H, ADMIN_MENU_W, adminMenuText, renderAdminMenuImage } from '../../card/admin-menu.ts';
import { adminMenuPageCount } from '../../domain/menu/admin-commands.ts';
import type { InteractiveOption } from '../../adapter/interactive.ts';
import type { CommandContext, CommandResult } from '../index.ts';
import { requireAdmin } from './admin.ts';

export const ADMIN_MENU_USAGE = '用法：.管理 [编号] —— 管理员指令菜单';

export async function handleAdminMenu(ctx: CommandContext): Promise<CommandResult> {
  const denied = requireAdmin(ctx);
  if (denied !== null) return denied;

  const total = adminMenuPageCount();
  const raw = (ctx.args[0] ?? '').trim();
  const index = raw === '' ? 1 : Number.parseInt(raw, 10);
  if (!Number.isFinite(index) || index < 1 || index > total) {
    return {
      privateText: '管理员菜单一共 ' + String(total) + ' 张。发 .管理 1 到 .管理 ' + String(total) + ' 都能看。',
      detailToPrivate: true,
      suppressMenu: true,
    };
  }

  /* 一律私聊：管理员的回执不回群里 */
  const scene = 'private' as const;
  const targetId = ctx.msg.userId;
  const adapter = ctx.deps.adapter;

  const navText = index < total
    ? '第 ' + String(index) + ' / ' + String(total) + ' 张 · 发 .管理 ' + String(index + 1) + ' 看下一张'
    : '第 ' + String(total) + ' / ' + String(total) + ' 张（最后一张）';

  const fallback = (): CommandResult => {
    const actions: Array<{ label: string; command: string; preview?: string }> = [];
    if (index > 1) actions.push({ label: '上一张', command: '管理 ' + String(index - 1), preview: '第 ' + String(index - 1) + ' 张' });
    if (index < total) actions.push({ label: '下一张', command: '管理 ' + String(index + 1), preview: '还有 ' + String(total - index) + ' 张' });
    actions.push({ label: '回到第一张', command: '管理 1', preview: '从头看' });
    return {
      privateText: adminMenuText(index),
      detailToPrivate: true,
      suppressMenu: true,
      nextActions: actions,
    };
  };

  const image = renderAdminMenuImage(index);
  if (image === undefined) return fallback();

  /* ① 内嵌图：图 + 提示 + 导航按钮合成一条消息 */
  if (adapter?.supportsInlineImages === true && adapter.sendInteractive && adapter.prepareInlineImage) {
    try {
      const url = await adapter.prepareInlineImage(scene, targetId, {
        bytes: image.png,
        mediaType: 'image/png',
        alt: '管理员指令菜单 第 ' + String(index) + ' 张',
      });
      if (url !== undefined) {
        const options: InteractiveOption[] = [];
        if (index > 1) options.push({ id: String(options.length + 1), label: '上一张', command: '管理 ' + String(index - 1) });
        if (index < total) options.push({ id: String(options.length + 1), label: '下一张', command: '管理 ' + String(index + 1) });
        options.push({ id: String(options.length + 1), label: '回到第一张', command: '管理 1' });
        /* 有角色才开待答菜单（按钮回传靠它）；没有角色就把按钮去掉，图照发 */
        const character = ctx.deps.characters.findByUserId(ctx.msg.userId);
        const opened = character === null
          ? null
          : ctx.deps.pendingMenus.openWith(character.id, 'result', {
              title: '管理员菜单导航',
              context: ['第 ' + String(index) + ' / ' + String(total) + ' 张'],
              options: options.map((option) => ({ key: option.id, label: option.label, command: option.command })),
              allowFreeform: true,
            }, ctx.now);
        const sent = await adapter.sendInteractive(scene, targetId, {
          text: '![管理员指令菜单 第 ' + String(index) + ' 张 #' + String(ADMIN_MENU_W) + 'px #' + String(ADMIN_MENU_H) + 'px](' + url + ')\n\n' + navText,
          /* options 是必传字段：没有角色时给空数组（图照发，只是没有按钮） */
          options: opened === null ? [] : opened.interactive.options,
          noHeader: true,
        });
        if (sent) return { privateText: '', selfSent: true, menuOpened: true, detailToPrivate: false };
      }
    } catch (error) {
      ctx.deps.logger?.warn?.('[admin-menu] 内嵌图失败，回落：' + (error as Error).message);
    }
  }

  /* ② 富媒体直发：图一条，提示一条 */
  if (adapter?.supportsImages === true && adapter.sendImage) {
    try {
      const sent = await adapter.sendImage(scene, targetId, {
        bytes: image.png,
        mediaType: 'image/png',
        alt: '管理员指令菜单 第 ' + String(index) + ' 张',
      });
      if (sent) {
        return {
          privateText: navText,
          detailToPrivate: true,
          suppressMenu: true,
          ...(index < total ? { nextActions: [{ label: '下一张菜单', command: '管理 ' + String(index + 1), preview: '还有 ' + String(total - index) + ' 张' }] } : {}),
        };
      }
    } catch (error) {
      ctx.deps.logger?.warn?.('[admin-menu] 通道发图失败，退回文字：' + (error as Error).message);
    }
  }

  /* ③ 同源文字版 */
  return fallback();
}
