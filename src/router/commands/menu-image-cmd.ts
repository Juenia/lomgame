/**
 * `.菜单 [编号]` —— **图片版指令菜单**（M2.86）。
 *
 * 用户：「检索项目所有指令　绘制永久性的精美图片菜单　不要过长，可以多分几张
 * 菜单不应该是一次性的」
 *
 * ## 「不应该是一次性的」怎么落地
 *
 * 它不是「发一次就没了的一条消息」，而是：
 *
 *   · **随时可再取**：`.菜单` 默认第 1 张，`.菜单 3` 看第 3 张；
 *   · **图带缓存**：同一张图全服只画一次（`card/menu-image.ts` 的缓存键 = 内容哈希），
 *     之后每个玩家拿到的都是同一份文件 —— 这就是「永久性」的字面意思；
 *   · **内容改了自动失效**：清单或说明一改，哈希变，下次请求重画。
 *
 * ## 为什么不一次把 6 张全发
 *
 * 那就是刷屏，而且手机上要滑很久才找得到要看的那一类。一次一张，尾部提示怎么看下一张。
 */
import { MENU_H, MENU_W, menuPageCount, menuText, renderMenuImage } from '../../card/menu-image.ts';
import type { InteractiveOption } from '../../adapter/interactive.ts';
import type { CommandContext, CommandResult } from '../index.ts';
import { requireCharacter } from './common.ts';

// 张数不写死：拆组之后它就不对了（每张不过长那条测试会先红）
export const MENU_USAGE = '用法：.菜单 [编号] —— 图片版指令表，分多张，随时可再取';

export async function handleMenu(ctx: CommandContext): Promise<CommandResult> {
  /*
   * 原生按钮需要一个**待答状态**（平台回传 id 之后，后端要知道它在答哪道题），
   * 那条状态挂在角色上 —— 所以这里必须有角色。
   */
  const gate = requireCharacter(ctx);
  if (!gate.ok) return gate.result;
  const character = gate.character;
  void character;
  const total = menuPageCount();
  const raw = (ctx.args[0] ?? '').trim();
  const index = raw === '' ? 1 : Number.parseInt(raw, 10);
  if (!Number.isFinite(index) || index < 1 || index > total) {
    return {
      privateText: `菜单一共 ${total} 张。发 .菜单 1 到 .菜单 ${total} 都能看。`,
      detailToPrivate: true,
    };
  }

  const scene = ctx.msg.scene;
  // 与 .角色 同一口径：私聊回给本人，群聊回给群（sceneId 就是群号）
  const targetId = scene === 'private' ? ctx.msg.userId : ctx.msg.sceneId;
  const adapter = ctx.deps.adapter;

  /*
   * 出图失败 / 通道发不出图 —— **一律退回同源的文字版**。
   *
   * 「同源」是要紧的：文字版和图片版都从 `COMMAND_GROUPS` 生成，
   * 所以不存在「图上有的字版没有」这种漂移。
   */
  /*
   * 文字兜底（通道发不出图时走这条）。
   *
   * ⚠️ M2.86 修正：用户报「菜单的两个按钮响应不对」，实测发现两条都错：
   *   · `.菜单 2` 时只有 **1 个**按钮（缺「上一张」「回到第一张」）；
   *   · `.菜单 6`（最后一张）时**一个按钮都没有**，于是路由层的「下一步」
   *     补了一套**通用菜单**上来 —— 玩家看到的是「继续扮演 / 休息一下」，
   *     跟菜单毫无关系。
   *
   * 所以两处都要治：**给全导航按钮** + **suppressMenu**（最后一张也必须自己说了算，
   * 不能让通用菜单掺进来）。
   */
  const fallback = (): CommandResult => {
    const actions: Array<{ label: string; command: string; preview?: string }> = [];
    if (index > 1) actions.push({ label: '上一张', command: '菜单 ' + (index - 1), preview: '第 ' + (index - 1) + ' 张' });
    if (index < total) actions.push({ label: '下一张', command: '菜单 ' + (index + 1), preview: '还有 ' + (total - index) + ' 张' });
    actions.push({ label: '回到第一张', command: '菜单 1', preview: '从头看' });
    return {
      privateText: menuText(index),
      nextActions: actions,
      // ★ 关键：不让路由层再补一套「继续扮演 / 休息」的通用菜单
      suppressMenu: true,
      detailToPrivate: true,
    };
  };

  let image;
  try {
    image = renderMenuImage(index);
  } catch (error) {
    ctx.deps.logger?.warn?.(`[menu] 出图失败，退回文字：${(error as Error).message}`);
  }
  if (image === undefined) return fallback();

  /*
   * ⚠️ M2.86 修正：**走「正文里嵌图」那条路，一条消息就够**。
   *
   * 用户指出：「菜单应该是一条消息的 md 模式，而不是两条消息的富文本模式」。
   *
   * 第一版用的是 `sendImage`（富媒体）：它**先发一条图、再发一条正文** ——
   * 用户看到的是两条消息。而官方 markdown 通道本来就能把图当正文的一行
   * （`![alt #宽px #高px](url)`），`.角色` 早就在用这条路（见 card.ts:255 起）。
   *
   * 所以这里对齐它：上传换 URL → `sendInteractive` 发一条带图的 markdown →
   * 用 `selfSent` 告诉路由**不要再补一条**。
   */
  if (adapter?.supportsInlineImages === true && adapter.sendInteractive && adapter.prepareInlineImage) {
    try {
      const url = await adapter.prepareInlineImage(scene, targetId, {
        bytes: image.png,
        mediaType: 'image/png',
        alt: '指令菜单 第 ' + index + ' 张',
      });
      if (url !== undefined) {
        const tip = index < total
          ? '第 ' + index + ' / ' + total + ' 张 · 发 .菜单 ' + (index + 1) + ' 看下一张'
          : '第 ' + total + ' / ' + total + ' 张（最后一张）';
        /*
         * ⚠️ M2.86 修正：**这里必须是 `options`（原生按钮），不是 `quickButtons`**。
         *
         * 用户：「菜单的按钮为何是输入按钮？不是原生响应按钮？而且输入的按钮指令也是无效的」。
         *
         * 两件事都是真的，而且是一件事：
         *   · `quickButtons` 的语义是「**把指令插进输入框**」（见 adapter/interactive.ts:46 的注释），
         *     平台不会回传什么，玩家还得自己按一次发送 —— 那不是原生按钮；
         *   · 而且 `QuickButton.command` 要求**含前导点号**，我写的是 `'菜单 2'`，
         *     插进输入框的就是一句无效指令。
         *
         * 正解是 `options`：平台回传它的 `id`，后端走 MENU_REPLY 那条判定路径。
         * 代价是它需要一个**待答状态**，所以下面先 `openWith` 开一份菜单。
         */
        const navOptions: InteractiveOption[] = [];
        if (index > 1) navOptions.push({ id: String(navOptions.length + 1), label: '上一张', command: '菜单 ' + (index - 1) });
        if (index < total) navOptions.push({ id: String(navOptions.length + 1), label: '下一张', command: '菜单 ' + (index + 1) });
        navOptions.push({ id: String(navOptions.length + 1), label: '回到第一张', command: '菜单 1' });
        // MenuType 里没有「导航」这一种，用 'result' —— 它就是「上一件事的后续选项」
        const opened = ctx.deps.pendingMenus.openWith(character.id, 'result', {
          title: '菜单导航',
          context: ['第 ' + index + ' / ' + total + ' 张'],
          options: navOptions.map((option) => ({ key: option.id, label: option.label, command: option.command })),
          allowFreeform: true,
        }, ctx.now);
        const sent = await adapter.sendInteractive(scene, targetId, {
          // 图是正文的一行 —— 这就是「一条消息」
          text: '![指令菜单 第 ' + index + ' 张 #' + MENU_W + 'px #' + MENU_H + 'px](' + url + ')\n\n' + tip,
          options: opened.interactive.options,
          noHeader: true,
        });
        if (sent) {
          /*
           * 已经发出去了 ⇒ 告诉路由**什么也别补**。
           *
           * ⚠️ M2.86 修正：这里原来只有 `selfSent`，漏了 `menuOpened` ——
           * 于是路由层的「下一步菜单」（`#attachNextMenu`）又跑了一遍，
           * `openWith('result', 通用菜单)` **把我刚开的导航菜单覆盖掉了**。
           *
           * 症状正是用户报的：「直接点按钮，他响应的不是菜单 2，而是查看手上线索的」——
           * 平台回传 `id=1`，而 `pending_menus` 里已经是那份通用菜单，
           * 它的 `key='1'` 恰好是「看线索」。**按钮本身没错，是菜单被后写的覆盖了。**
           *
           * 这是同一个坑第三次出现（前两次是 `.看` 的 quickButtons 被丢、`.菜单` 的兜底按钮被通用菜单顶掉）：
           * **凡是自己开了菜单/自己发了消息的分支，都必须显式告诉路由「别管了」。**
           */
          return { privateText: '', selfSent: true, menuOpened: true, detailToPrivate: false };
        }
      }
    } catch (error) {
      ctx.deps.logger?.warn?.(`[menu] 内嵌图失败，回落富媒体/文字：${(error as Error).message}`);
    }
  }

  // 次选：富媒体直发（图一条 + 文字一条，不如上面那条干净，但通道不支持内嵌时只能这样）
  if (adapter?.supportsImages === true && adapter.sendImage) {
    try {
      const sent = await adapter.sendImage(scene, targetId, {
        bytes: image.png,
        mediaType: 'image/png',
        alt: '指令菜单 第 ' + index + ' 张',
      });
      if (sent) {
        /*
         * 图上已经有全部内容，正文只留「怎么看下一张」这一句 ——
         * 把整份文字再发一遍就是把同一件事说两遍（M2.45 的「霸屏」教训）。
         */
        return {
          privateText: index < total
            ? '这是第 ' + index + ' / ' + total + ' 张。发 .菜单 ' + (index + 1) + ' 看下一张。'
            : '这是最后一张（' + total + '/' + total + '）。玩法循环里大多数步骤都有按钮，能点就不用打字。',
          detailToPrivate: false,
          menuOpened: true,
          ...(index < total ? { nextActions: [{ label: '下一张菜单', command: '菜单 ' + (index + 1), preview: '还有 ' + (total - index) + ' 张' }] } : {}),
        };
      }
    } catch (error) {
      ctx.deps.logger?.warn?.(`[menu] 通道发图失败，退回文字：${(error as Error).message}`);
    }
  }
  return fallback();
}
