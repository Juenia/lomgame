/**
 * `.角色` —— 把角色数据画成一张图（M2.47）。
 *
 * ## 它与 `.状态` 的分工
 *
 * `.状态` 回答「我现在什么数值」，`.角色` 回答「我这张卡长什么样」——
 * 两者**读同一份 CharacterState**，只是形态不同（文本表 vs PNG）。
 * 所以这里不重算任何东西：城市/教会名照 `.状态` 的查法，晋升率与闸门走判定层，
 * 卡面组装交给 `characterCardData`。
 *
 * ## 降级的三条路
 *   1. 通道能发图 → 直接发图；
 *   2. 发不了图（**当前官方通道就是这样**）→ 回执给出卡片的落盘路径 + 文字状态卡；
 *   3. 出图服务没配或出图失败 → 同样回落到文字状态卡，并把原因写进回执。
 *
 * 三条路玩家都拿得到完整信息 —— 这是「降级是正常路径」在功能层的形态。
 */

import { renderStatus } from './status.ts';
import type { CommandContext, CommandResult } from '../index.ts';
import type { CharacterState } from '../../domain/character/types.ts';
import { computePromotionSuccess, lossOfControlThresholdFor } from '../../domain/character/rules.ts';
import { CARD_RATIO } from '../../card/render.ts';
import { isAllowedMediaHost } from '../../card/media-host.ts';
import type { QuickButton } from '../../adapter/interactive.ts';

/**
 * 卡面在 markdown 里的显示尺寸（M2.45 第十三版；**M2.86 第二轮按真机反馈缩小**）。
 *
 * 设计网格是 620×1000，这里按同一比例缩小。**只改宽度**，
 * 高度由 `CARD_RATIO` 派生 —— 换设计网格或改宽度时，两处都不会漂。
 *
 * ## 为什么从 300 缩到 240（2026-09-30 真机）
 *
 * 用户原话：
 *   「把角色卡的图片绘制给他缩小一个比例试试，图片好像是太长被拉伸了 然后裁掉了」
 *
 * 现象：markdown 内嵌的卡面在**电脑端**底部被裁（切在「生命 94/100」那一行），手机端完整。
 * 两个探测给出的依据：
 *   · `.探针 size` —— **平台会按标注强制拉伸**（正方形标 60×180 就渲染成竖长条），
 *     所以标注与真实比例不符时会**变形**，这是「太长被拉伸」那一半的解释；
 *   · `.探针 size2` —— 手机端 800px 高都完整，说明手机端不是高度卡住的；
 *     但两端渲染本就不同（这批实测里已经出现过「手机行、电脑不行」的相反方向）。
 *
 * ⇒ 「画得太长」这个方向成立，而**缩小对手机端无损**（它本来就不裁，图变小只会更安全）。
 *
 * ⚠️ **必须等比缩**：宽高比一旦与卡面 620:1000 不一致，平台就会拉伸变形（D 档的读数）。
 * 所以这里只改 `CARD_DISPLAY_W`，`CARD_DISPLAY_H` 跟着派生 —— 别再手写第二个数。
 *
 * 240 → 高 387（原来 300 → 484，**缩了 20%**）。
 */
const CARD_DISPLAY_W = 240;
const CARD_DISPLAY_H = Math.round(CARD_DISPLAY_W / CARD_RATIO);

/**
 * 角色卡底部的**常用指令按钮**（M2.86）。
 *
 * 用户口径：「角色卡的情况下 不需要信息头和正文尾，只需要角色卡和几个常用指令的按钮」。
 *
 * 它们是**指令按钮**（`action.type = 2`）：点一下等于手打这条指令 ——
 * 平台不推事件、也不需要回执，与菜单选项（回调按钮，要 `PUT /interactions/{id}`）不是一回事。
 * 语义见 `adapter/interactive.ts` 的 `QuickButton`。
 *
 * 为什么由业务层给、而不是通道写死：**「这个指令要提供哪些快捷入口」是业务决定**，
 * 通道只负责把它画成按钮。
 */
/**
 * 角色卡底部那排按钮：**按当下的处境给**，而不是永远那四件套。
 *
 * 用户口径两件事：
 *   · 「各个 MD 消息模板的回调按钮是否是对应环境能够执行下一步的按钮？而不是基础四件套」；
 *   · 「重伤情况下要显示休息按钮和求医的按钮」。
 *
 * 所以这里只做两件事：**重伤时把「休息 / 就医」摆在最前面**（那是这种状态下
 * 唯一还能做的事），其余仍然是查看类入口 —— 但走的是 `options`（回调按钮），
 * 点了**直接执行**；不再是 `quickButtons`（指令按钮，只把指令插进输入框，
 * 玩家还得再按一次发送）。`.菜单` 已经因为同一件事返工过一次。
 */
export function cardActionsFor(character: CharacterState): Array<{ label: string; command: string }> {
  const actions: Array<{ label: string; command: string }> = [];
  if (character.status === 'injured') {
    actions.push({ label: '休息', command: '休息' });
    actions.push({ label: '就医', command: '就医' });
  }
  actions.push({ label: '状态', command: '状态' });
  actions.push({ label: '今日', command: '今日' });
  actions.push({ label: '背包', command: '背包' });
  return actions;
}

/** 城市名 / 教会名 —— 与 `.状态` 完全同一份查法（两处口径不能分叉） */
function statusExtras(
  ctx: CommandContext,
  character: CharacterState,
): { cityName?: string; churchName?: string; churchContribution?: number } {
  const cityName = character.currentCityId
    ? ctx.deps.locations.get(character.currentCityId)?.name ?? character.currentCityId
    : undefined;
  const churchName = character.churchId
    ? ctx.deps.churches.all().find((church) => church.id === character.churchId)?.name ?? character.churchId
    : undefined;
  return {
    ...(cityName ? { cityName } : {}),
    ...(churchName ? { churchName } : {}),
    ...(character.churchContribution !== undefined
      ? { churchContribution: character.churchContribution }
      : {}),
  };
}

export async function handleCard(ctx: CommandContext): Promise<CommandResult> {
  const character = ctx.deps.characters.findByUserId(ctx.msg.userId);

  /** 任何一步走不通都落到这里：一句原因 + 完整文字状态卡 */
  const textFallback = (reason: string): CommandResult => {
    if (!character) {
      return {
        privateText: '你还没有角色。发送 .创建 姓名 开始。',
        groupText: `【${ctx.msg.nickname || ctx.msg.userId}】还没有角色。`,
        detailToPrivate: true,
      };
    }
    return {
      privateText: `${reason}\n\n${renderStatus(character, statusExtras(ctx, character))}`,
      groupText: `【卡】${reason}（完整状态走私聊）`,
      detailToPrivate: true,
    };
  };

  if (!character) return textFallback('你还没有角色。');
  const service = ctx.deps.card;
  if (!service) return textFallback('这条通道没有开出图。');

  /*
   * **图发到玩家说话的那个地方**（群聊就发群里、私聊就发私聊）。
   *
   * 这是跟 M2.45 的既有口径走的：那一版把「群聊只发摘要、明细走私聊」合并掉了 ——
   * 路由的 #reply 对两种场景返回**同一份 privateText**，理由写在 index.ts：
   * 「玩家在哪说话，完整内容就回哪里」。文字状态卡现在就是群里全量发的，
   * 卡面没有理由比它更矜持（图是玩家主动发的指令要来的，不是机器人自说自话）。
   */
  const scene = ctx.msg.scene;
  const targetId = scene === 'private' ? ctx.msg.userId : ctx.msg.sceneId;
  const adapter = ctx.deps.adapter;

  const facts = {
    ...statusExtras(ctx, character),
    // 晋升率只对已入途径的人有意义（公式要求 sequence 非空）
    ...(character.pathway !== null && character.sequence !== null
      ? {
          promotionSuccess: computePromotionSuccess({
            dig: character.dig,
            mad: character.mad,
            cor: character.cor,
            sequence: character.sequence,
          }),
        }
      : {}),
    lossGate: lossOfControlThresholdFor(character.sequence),
  };

  /*
   * 头像：**问通道要**。官方通道给 `q.qlogo.cn/qqapp/{appid}/{openid}`，
   * OneBot 给 `q1.qlogo.cn`。通道答不出来（没有这个能力/没有 openid）就画首字纹章。
   * 之前这里根本没传 —— 卡面永远是首字，用户一眼就看出来了。
   */
  const avatarUrl = adapter?.avatarUrlForUser?.(ctx.msg.userId);

  let outcome: Awaited<ReturnType<typeof service.generate>>;
  try {
    outcome = await service.generate({
      character,
      facts,
      ...(avatarUrl !== undefined ? { avatarUrl } : {}),
    });
  } catch (error) {
    // 出图失败（PowerShell 起不来 / 字体缺失 / 头像写盘失败）不该让玩家只收到一句报错
    ctx.deps.logger?.warn?.(`[card] 出图失败：${(error as Error).message}`);
    return textFallback('这次没能画出卡（原因已经记进日志）。');
  }

  /*
   * 发图顺序：**先问通道能不能自己发**，不行再用 markdown 外链。
   *
   * 为什么这个顺序（实测得出的）：
   *   · 通道直发（官方富媒体 msg_type=7 / OneBot base64 CQ）不走第三方图床，
   *     实测比"上传图床 + markdown 外链"快 2 秒以上，而且不依赖外链可达性；
   *   · markdown 外链要先把图传到图床（uguu 实测 2.4s），
   *     还要求那个 URL 公网可达 —— 真机上出现过破图框。
   * 但外链那条也不废：通道不支持直发时它仍然能出图（且能带按钮）。
   */
  /*
   * M2.45 第十三版：**卡面与文字发在同一条消息里**。
   *
   * 用户原话：「还有角色卡，别人是合并一起发出来，你是分开来发的」——
   * 上一版在官方通道上是「sendImage 发一条图 ＋ 再发一条只有菜单的正文」，真机上就是两条。
   *
   * 官方 markdown 通道天生支持这件事：**图片就是正文里的一行** `![alt #宽px #高px](url)`，
   * 于是图、文字状态卡、按钮同属一条消息。
   *
   * ⚠️ 破图这件事的根因是**国内可达性**，不是「图床只有一个」：
   * 本机实测（`node` 直连）5 个图床，**只有 uguu 能传**（telegraph / catbox / tmpfiles
   * 网络不通，freeimage 拒绝），而 `n.uguu.se` 在 QQ 服务器那一侧抓不到 —— 于是裂图。
   * 换图床解决不了这一层；**能解决的是把图片地址换到国内可达的域名上**：
   * 配 `CARD_PUBLIC_BASE_URL` 指向你自己的公网地址（反代 / 内网穿透 / 公网 IP），
   * 那条路由由你的机器提供，平台抓得到。
   *
   * 所以判据放宽为「**有 URL 就合并**」——用户明确要求合并，且图床可以换；
   * 拿不到 URL 的通道（OneBot）走下面那条：先发图、再发文字。
   */
  /*
   * ⚠️ 判据是 `publicUrlSource === 'self-hosted'`（第十五版改回来，而且这次有实测撑着）：
   *
   * 官方文档（markdown 页「图片」一节）：
   *   「QQ 后台为了**保护用户 IP 隐私**，会通过**域名代理和内容缓存机制**解析到 QQ 客户端，
   *     但**不会持久化存储**，请开发者**自身维护图片 url 的可用性**，
   *     当 url 不可用时，markdown 消息内的图片可能不能正常渲染展示。」
   *
   * 于是两个**国内/国外图床**各试了一次，真机上都是裂图：
   *   · uguu.se —— 本机回读 200，平台侧抓不到；
   *   · picui.cn —— 本机回读 200 / image/webp，平台侧同样裂。
   * 也就是说：**「我能打开」不等于「QQ 的域名代理能取到」**，而这一点服务端无法自检。
   *
   * 所以合并只留给**自建托管**那条路：域名由部署者掌握（反代 / 内网穿透 / 公网 IP），
   * 不过期、不经过第三方 —— 那条路上的 URL 是唯一「开发者自身能维护」的。
   * 图床来源仍旧走下面那条：平台富媒体直发，图**一定显示**，代价是两条消息。
   */
  /*
   * 图片能不能写进正文，取决于 **URL 的来源可不可控**：
   *   · `self-hosted`（服务自己的 /cards/ 路由）✅
   *   · `github`（仓库 + jsDelivr，实测 200 / image/png，**且不需要部署方自建服务**）✅
   *   · `upload`（第三方临时图床：uguu / picui …）❌ —— 两个都真机实测裂图
   * 拿不到 URL 的通道走下面那条：平台富媒体直发，零依赖，图一定显示。
   */
  /*
   * ⚠️ 判据是 **域名在不在平台白名单里**，不是「URL 来源可不可控」——
   * 后者是我们绕了很久的错误判据（详见 src/card/media-host.ts 与 docs/QQ-markdown-能力实测.md）。
   * 自建域名、第三方图床、全球 CDN 全都不在名单里；只有腾讯自己的域名能用。
   */
  /*
   * ── 图片 URL 的两个来源（M2.86 新增第二个）──────────────────────────
   *
   *   ① `outcome.publicUrl`：部署方自建托管 / GitHub 那条路
   *      —— 只有域名**在平台白名单里**才可用（见 media-host.ts）。
   *   ② `adapter.prepareInlineImage`：**通道自己上传**（M2.86）。
   *      官方通道把字节交给富媒体上传接口（`srv_send_msg: false`，只传不发），
   *      拿回的 `raw_url` 落在 `*.myqcloud.com` —— 正好在白名单里，
   *      而且**零配置、零成本**：不需要图床、不需要公网 IP、不需要买 COS。
   *
   * ② 的意义：M2.47 以来「官方通道只能在富媒体直发（图文字分两条）与
   * 外部图床（真机全裂）之间二选一」这个死结，到这里解开了 ——
   * 图、文字状态卡（markdown）、按钮可以重新合成**一条**消息。
   *
   * ⚠️ 判据仍旧是**域名在不在白名单里**，不是「这张图是谁给的」：
   *    官方上传给的是 `*.myqcloud.com` ⇒ 在白名单里 ⇒ 可用（真机已验，见
   *    docs/QQ-markdown-能力实测.md 第五节）。
   */
  /*
   * ── M2.86：能摆原生按钮的通道，`.角色` 只发「图 + 常用按钮」────────────────
   *
   * 用户原话：
   *   「角色卡的情况下 不需要信息头和正文尾，只需要角色卡和几个常用指令的按钮」
   *
   * 为什么这一条要排在合并路径**前面**：
   *   · 合并路径（图 + markdown 正文）解决的是「图文分两条」这个老问题，
   *     但它**挂不了按钮** —— 常用按钮是通道侧在富媒体那条路上挂的（`cardKeyboard()`）；
   *   · 而这一版要的恰恰是「图 + 按钮」，正文与信息头都是要去掉的东西。
   *
   * 判据是 `supportsButtons`：OneBot 没有原生按钮，那条路继续走下面的既有降级
   * （图 + 文字状态卡）—— 否则玩家连数值都看不到，那不是「精简」是「残缺」。
   */
  if (adapter?.supportsButtons === true && adapter.sendInteractive && adapter.prepareInlineImage) {
    try {
      /*
       * 图片先上传换 URL：这条路发的是 **markdown（msg_type: 2）**，图是正文里的一行
       * （`![alt #宽px #高px](url)`），不能像富媒体那样直接塞字节。
       * 上传拿到的 `raw_url` 落在 `*.myqcloud.com` —— 平台白名单内（见 prepareInlineImage）。
       */
      const url = await adapter.prepareInlineImage(scene, targetId, {
        bytes: outcome.png,
        mediaType: 'image/png',
        alt: `${character.name} 的角色卡`,
      });
      if (url !== undefined) {
        /*
         * 按钮走 `options`（**回调按钮**）：点了平台回传 id，后端走 MENU_REPLY，
         * **直接执行**。原来的 `quickButtons` 是「指令按钮」，点了只把指令插进输入框，
         * 玩家还得再按一次发送 —— 用户问的「这些按钮是不是能执行下一步的按钮」就是它。
         *
         * ⚠️ 回调按钮需要一份**待答状态**（平台回传的是 id，得有人认领），
         * 所以先 openWith 开一张 —— 与 `.菜单` 的导航按钮同一套做法。
         * 代价是这份菜单会盖住玩家原来的待答菜单，所以下面必须带 `menuOpened`。
         */
        const actions = cardActionsFor(character);
        const opened = ctx.deps.pendingMenus.openWith(
          character.id,
          'result',
          {
            title: '常用',
            context: [],
            options: actions.map((action, index) => ({
              key: String(index + 1),
              label: action.label,
              command: action.command,
            })),
            allowFreeform: true,
          },
          ctx.now,
        );
        const sent = await adapter.sendInteractive(scene, targetId, {
          text: `![${character.name} 的角色卡 #${CARD_DISPLAY_W}px #${CARD_DISPLAY_H}px](${url})`,
          options: opened.interactive.options,
          noHeader: true,
        });
        if (sent) {
          /*
           * 已经发出去了 ⇒ 告诉路由**不要再补一条正文**。
           * 于是这条消息连信息头也不会带 —— header 是随那条 reply 一起交给通道的，
           * 那条 reply 根本不存在。
           */
          /*
           * `menuOpened` 不能漏：路由层的「下一步」见到它才会收手，
           * 否则它会再 openWith 一套通用菜单，把上面那张盖掉 ——
           * 表现是「按钮点了响应的不是这个」(`.菜单` 上已经踩过第三次)。
           */
          return { privateText: '', selfSent: true, menuOpened: true, detailToPrivate: false };
        }
      }
    } catch (error) {
      ctx.deps.logger?.warn?.(`[card] 发「图 + 常用按钮」失败，回落：${(error as Error).message}`);
    }
  }

  let inlineUrl = outcome.publicUrl !== undefined && isAllowedMediaHost(outcome.publicUrl)
    ? outcome.publicUrl
    : undefined;
  if (inlineUrl === undefined && adapter?.supportsInlineImages === true && adapter.prepareInlineImage) {
    try {
      inlineUrl = await adapter.prepareInlineImage(scene, targetId, {
        bytes: outcome.png,
        mediaType: 'image/png',
        alt: `${character.name} 的角色卡`,
      });
    } catch (error) {
      // prepareInlineImage 自己已经吞掉失败；这里兜底，别让一次上传把整条回执带走
      ctx.deps.logger?.warn?.(`[card] 通道上传图片失败，回落富媒体直发：${(error as Error).message}`);
    }
  }
  if (inlineUrl !== undefined && adapter?.supportsInlineImages === true) {
    return {
      privateText: [
        `![${character.name} 的角色卡 #${CARD_DISPLAY_W}px #${CARD_DISPLAY_H}px](${inlineUrl})`,
        '',
        ...(outcome.usedAvatar ? [] : ['（没拿到你的 QQ 头像，卡面用的是名字首字纹章）', '']),
        renderStatus(character, statusExtras(ctx, character)),
      ].join('\n'),
      detailToPrivate: false,
    };
  }

  if (adapter?.supportsImages === true && adapter.sendImage) {
    try {
      const sent = await adapter.sendImage(scene, targetId, {
        bytes: outcome.png,
        mediaType: 'image/png',
        alt: `${character.name} 的角色卡`,
        /*
         * 两种通道各取所需：
         *   · OneBot 用 bytes（base64 内联 CQ 码）；
         *   · QQ 官方用 url（markdown 图片要求公网可访问）。
         * 没配 CARD_PUBLIC_BASE_URL 时 url 是 undefined。
         */
        ...(outcome.publicUrl !== undefined ? { url: outcome.publicUrl } : {}),
      });
      if (sent) {
        /*
         * M2.45 第二十四版：**图发出去之后，正文不能再空着**。
         *
         * 原来这里返回空串，设计假设是「图里什么都有」——可图里没有地点、没有状态提示、
         * 没有数值明细。用户截图里的第二条消息因此是：头像 + 一大片空白 + 菜单。
         *
         * 现在把完整文字状态卡补上（与 .状态 同一份口径）：图那条 + 文字那条，
         * 合起来才算一条完整回执。群聊也发（detailToPrivate: false），
         * 与 M2.45「玩家在哪说话，完整内容就回哪里」的既有口径一致。
         */
        return {
          privateText: [
            ...(outcome.usedAvatar ? [] : ['（没拿到你的 QQ 头像，卡面用的是名字首字纹章）', '']),
            renderStatus(character, statusExtras(ctx, character)),
          ].join('\n'),
          detailToPrivate: false,
        };
      }
    } catch (error) {
      ctx.deps.logger?.warn?.(`[card] 通道直发失败，回落到文字：${(error as Error).message}`);
    }
  }

  return {
    privateText: [
      `卡已经画好了，但这条通道发不出图片。文件在：${outcome.path}`,
      outcome.usedAvatar ? undefined : '（这次没拿到你的 QQ 头像，卡面用的是名字首字纹章）',
      '',
      renderStatus(character, statusExtras(ctx, character)),
    ]
      .filter((line): line is string => line !== undefined)
      .join('\n'),
    detailToPrivate: false,
  };
}
