/**
 * Koishi 插件：把游戏接到 Koishi 的消息总线上。
 *
 * ## 它做什么（三件事，别的不做）
 *
 *   1. 收到消息 → `POST /api/v1/inbound`（原文照送，一行都不改）；
 *   2. 长轮询 `/api/v1/outbound` → 用 `bot.sendMessage` / `bot.sendPrivateMessage` 发出去；
 *   3. 启动时声明这条通道的能力（默认**不摆按钮**，走文本菜单 + 数字回复）。
 *
 * ## 三条来自游戏侧的口径，接线时必须照做
 *
 *   · **userId 必须是稳定的玩家 id**（OneBot 下就是 QQ 号）。同一个人从 Koishi 与从
 *     BEE 进来要是同一个 id，否则他在两个框架下是**两个角色**；
 *   · **私聊的 targetId 是 userId**（服务端的 private 回执发给 `userId`）——
 *     所以私聊不必用 Koishi 的 `channelId`（那通常是 `private:12345` 这种带前缀的）；
 *   · **群聊的 targetId 是 channelId**（OneBot 下就是群号）。
 */
import { join } from 'node:path';
import type { Context } from 'koishi';
// h 在模块顶部一次性引入。
//
// 原来是 `await import('koishi')` 写在发图那条分支里 —— 每次发图都要走一次
// 动态导入（即便有缓存，也要过一次 promise 与模块解析）。发图是热路径，
// 这条开销纯属白付。
import { h, Schema } from 'koishi';
import { BridgeClient, imageSrc, isBlockedGroup, parseBlockedGroups, renderOutbound, startOutboundLoop } from './client.js';
import { uploadImageForMarkdown, type OfficialUploadApi } from './upload-image.js';
import { ensureCore, type CoreHandle } from './core.js';
import { describeError } from './client.js';

export const name = 'lom-bridge';

/**
 * 最近一条消息的 session，按会话 id 存。
 *
 * ## 为什么必须缓存它
 *
 * QQ 官方通道对「主动消息」有硬限制：要单独申请、而且有限频。
 * 实测下来的表现是——**回执用主动消息发会拿到 400 Bad Request**：
 *
 *   sendPrivateMessage(FA3B…) 失败：AggregateError(1 个)：[0] Bad Request
 *
 * adapter-qq 的被动回复靠 `session.messageId` 当 `msg_id`（见它的 1157-1172 行），
 * 而回执是长轮询取回来的、手上没有 session —— 于是 msg_id 为空、退化成主动消息。
 *
 * 所以入站时把 session 记下来，发送时借它走**被动回复**。
 * 这也正是 BEE 版的做法（借用当前回调的 msg_id）。
 */
/**
 * 只声明我们要用的那一个方法。
 *
 * 不写 `Session` 是因为 koishi 的类型定义里没有 `send`（运行时有）——
 * 拿类型去卡反而写不通。这里按**结构**约定，够用即可。
 */
interface Sendable {
  send: (content: unknown) => Promise<unknown>;
}
const recentSessions = new Map<string, Sendable>();

/** 单例：内核只能拉一个 —— Koishi 可能多次 apply（热重载、多实例） */
let coreHandle: CoreHandle | undefined;

/** 用 Koishi 的 HTTP 服务（有它就能复用代理设置与超时配置） */
export const inject = ['http'];

export interface Config {
  /** 游戏这一侧的地址（bridge-api 的地址） */
  apiBase: string;
  /** 与 bridge-api 的 BRIDGE_TOKEN 一致 */
  token: string;
  /** 上游框架名（写进审计与出站回源） */
  platform: string;
  /** 用哪个 bot 发主动消息（多账号时指定；留空用第一个） */
  selfId: string;
  /** 长轮询挂多久（秒） */
  waitSec: number;
  /** 启动时是否声明能力（关掉就用服务端的缺省档：不摆按钮、能发图） */
  declareCapabilities: boolean;
  /** 声明"能发图"。Koishi 的 OneBot adapter 能发图，默认开着 */
  capabilitiesImages: boolean;
  /** 声明"能摆按钮"。⚠️ 打开后**判定层会发精简正文**，选项由本插件渲染 */
  capabilitiesButtons: boolean;
  /** 发图失败的兜底：把图片地址当文本发出去（否则玩家什么都看不到） */
  imageFallbackToText: boolean;
  /**
   * 声明「我能把图上传换成公网 URL」。
   *
   * 只对 **QQ 官方通道**有意义：富媒体上传是官方独有的能力，换来的是
   * 「**图 + 正文 + 按钮塞进一条消息**」。OneBot 不需要它 —— 它本来就能
   * 一条消息里带图和文字。
   *
   * 打开后若上传失败（权限没开、配额、通道不支持），服务端会回落成
   * 「图单独发一条」—— 最多是回到老样子，不会更糟。
   */
  inlineUpload: boolean;
  /**
   * M2.172：**管理员名单**（一行一个）。
   *
   * 能在群里发管理员指令的人：封禁 / 解禁 / 开关游戏 / 主动推送 / 主动事件推送，
   * 以及 .游戏状态 / .世界状态 / .机器人状态（完整清单发 .管理）。
   *
   * 填 **QQ 号**（OneBot 通道）；QQ 官方通道下是 openid，两者不通用，各填各的。
   * 内核自己的 .env 里也可以配一份，两边取**并集** —— 插件这一路是上报，不是权威。
   */
  adminIds: string;

  /**
   * 屏蔽的群（**一行一个群号**）。
   *
   * 被屏蔽的群：
   *   · **不处理指令** —— 群里发什么都不会送进游戏（也就没有回执，玩家看到的是「机器人不在」）；
   *   · **不主动推送** —— 世界播报、事件回执这类主动消息一律不投递。
   *
   * ⚠️ 两边都要挡，只挡一半等于没屏蔽：只挡入站的话，世界还在为这个群跑，
   * 别的玩家触发的播报照样往里灌。
   *
   * 空行忽略；`#` 开头的行当注释（能顺手写一句「这个群为什么屏蔽」）。
   * 私聊不受影响 —— 屏蔽群不等于封掉群里那个人的角色。
   */
  blockedGroups: string;
  /**
   * 头像直链模板（**不填就永远没有头像**）。
   *
   * 判定层只产出「头像属于谁」（userId），"这个人在你这条通道上长什么样"
   * 只有上游知道 —— 所以服务端要一个模板，自己把 {userId} / {size} 填进去
   * （见 bridge-api/src/channel.ts 的 avatarUrlForUser）。
   *
   * ⚠️ 缺了这一项的表现不是报错，而是**卡面永远是名字首字纹章**，
   * 以及回执里多一行「没拿到你的 QQ 头像，卡面用的是名字首字纹章」
   * （src/router/commands/card.ts 的 usedAvatar 分支）。
   * BEE 版一直有这一项（bridge-api/integrations/bee-go/runtime.go 的 avatarTemplate），
   * koishi 版漏了 —— 这就是两个框架下同一张卡一个有头像、一个没有的原因。
   *
   * · OneBot / 第三方（userId 就是 QQ 号）：默认值即可；
   * · QQ 官方通道（userId 是 openid）：改成
   *   `https://q.qlogo.cn/qqapp/<你的 AppID>/{userId}/{size}`
   *   —— 拿 QQ 号去拼官方链接一定 404，这一点是实测过的。
   */
  avatarTemplate: string;
  /**
   * 自己拉起游戏内核（**装完就能用**）。
   *
   * 关掉的话你得自己跑一份 bridge-api，再把 apiBase 指过去。
   * 开着也是「先找后拉」：已经在跑的直接复用 —— 两份内核会各自打开同一个
   * SQLite 文件，世界会被写坏。
   */
  /** 运营后台的端口（只用来拼一个能点的地址，不影响 Koishi 自己监听哪个口） */
  /** 交流群号（设置页里显示成一个可点的链接） */
  community: string;
  manageCore: boolean;
  /** 用哪个 node 跑内核（留空 = 自动找一个够新的） */
  nodePath: string;
  /** 本机没有够新的 node 时，自己下载一个便携版（不装进系统） */
  autoInstallNode: boolean;
  /** 自动安装的下载地址（内网改成自己的镜像） */
  nodeDownloadURL: string;
  /** 自己拉起内核时用哪个端口（默认 3201，与 BEE 那边的 3200 分开） */
  corePort: number;
  /** 存档目录（内核的 data/ 放这儿）。留空用 Koishi 数据目录 */
  dataDir: string;
}

export const Config: Schema<Config> = Schema.object({
  apiBase: Schema.string().default('').description(
    '外部内核地址。留空 = 自己拉一个（默认）'
  ),
  nodePath: Schema.string().default('').description('用哪个 node 跑内核（留空 = 自动找）'),
  autoInstallNode: Schema.boolean().default(true).description('本机没有够新的 Node 时自动下载一个便携版（不装进系统）'),
  nodeDownloadURL: Schema.string().default('').description('自动安装的下载地址（内网可改成自己的镜像）'),
  corePort: Schema.number().default(3201).description('自己拉内核时用的端口（3201，避开 BEE 那边的 3200）'),
  token: Schema.string().default('').description('与 bridge-api 的 BRIDGE_TOKEN 一致'),
  platform: Schema.string().default('koishi').description('上游框架名（用于审计）'),
  selfId: Schema.string().default('').description('用哪个 bot 发主动消息（留空用第一个）'),
  waitSec: Schema.number().default(25).description('出站长轮询挂多久（秒）'),
  declareCapabilities: Schema.boolean().default(true).description('启动时声明通道能力'),
  capabilitiesImages: Schema.boolean().default(true).description('声明能发图'),
  capabilitiesButtons: Schema.boolean().default(true).description('声明能摆原生按钮（QQ 官方 keyboard）'),
  avatarTemplate: Schema.string()
    .default('https://q1.qlogo.cn/g?b=qq&nk={userId}&s={size}')
    .description(
      '头像直链模板（qq官方通道填 https://q.qlogo.cn/qqapp/<AppID>/{userId}/{size}）；留空 = 卡面用名字首字纹章',
    ),
  imageFallbackToText: Schema.boolean().default(true).description('发图失败时退化成发链接'),
  inlineUpload: Schema.boolean()
    .default(true)
    .description('声明能把图上传换公网 URL（QQ 官方通道）。换来的是「图+正文+按钮」合成一条；失败会回落成图单独发一条'),
  adminIds: Schema.string()
    .role('textarea')
    .default('')
    .description(
      '管理员名单，一行一个（也认逗号分隔）。填 QQ 号；QQ 官方通道填 openid。' +
        '他们能在群里用封禁 / 开关游戏 / 状态这些指令，完整清单发 `.管理`。' +
        '改完重载插件生效；内核自己的 .env 里那份会一起合并。',
    ),
  blockedGroups: Schema.string()
    .role('textarea')
    .default('')
    .description('屏蔽的群号，一行一个。被屏蔽的群不处理指令、也不主动推送；`#` 开头当注释。私聊不受影响。'),
  /** 交流群号（顶部那行已是可点链接，这里给一个能复制的） */
  community: Schema.string()
    .default('1121395453')
    .description('交流群 1121395453 —— https://qm.qq.com/q/wxW7hgC6sM（复制到浏览器打开）'),
  manageCore: Schema.boolean().default(true).description('自己拉起游戏内核（装完就能用；已在跑的直接复用）'),
  dataDir: Schema.string().default('').description('存档目录（留空用 Koishi 数据目录）'),
}).description(
  '**交流群**：[1121395453](https://qm.qq.com/q/wxW7hgC6sM)　点群号加群\n\n' +
    '《诡秘之主：群星低语》—— 装完就能玩，发 `.帮助` 看指令。',
);

export async function apply(ctx: Context, config: Config): Promise<void> {
  const logger = {
    info: (m: string, meta?: Record<string, unknown>) => ctx.logger.info(m, meta ?? {}),
    warn: (m: string, meta?: Record<string, unknown>) => ctx.logger.warn(m, meta ?? {}),
    error: (m: string, meta?: Record<string, unknown>) => ctx.logger.error(m, meta ?? {}),
    // 屏蔽名单的命中只走 debug：屏蔽就是「别管这个群」，不该在默认级别里刷屏
    debug: (m: string, meta?: Record<string, unknown>) => ctx.logger.debug(m, meta ?? {}),
  };

  /* 屏蔽名单：一行一个群号。每条消息、每条回执都要查，所以先解析成 Set */
  const blockedGroups = parseBlockedGroups(config.blockedGroups);
  if (blockedGroups.size > 0) {
    logger.info('已启用屏蔽群', { count: blockedGroups.size, groups: [...blockedGroups].slice(0, 20) });
  }

  /* ---------------- 内核：先找，找不到自己拉 ---------------- */
  let apiBase = config.apiBase;
  if (config.manageCore) {
    if (coreHandle === undefined) {
      coreHandle = await ensureCore({
        port: config.corePort,
        // 用进程 cwd，不要碰 ctx 上的东西。
        //
        // 试过两个都不行，都是**运行时才炸**的那种：
        //   · `ctx.baseDir` —— Koishi 4 根本没有这个属性（查过 cordis / koishi 的类型定义，0 处）；
        //   · `ctx.root`   —— 它是 Cordis 的**根 Context 对象**，不是路径，
        //                     传给 path.join 会报 ERR_INVALID_ARG_TYPE。
        //
        // Koishi 的 cwd 就是实例目录，这是它自己的约定。
        dataDir: config.dataDir !== '' ? config.dataDir : join(process.cwd(), 'data', 'lom'),
        token: config.token,
        nodePath: config.nodePath,
        autoInstallNode: config.autoInstallNode,
        nodeDownloadURL: config.nodeDownloadURL,
        logger,
        // apiBase 只有用户**显式填了**才当外部内核用；默认空 = 自己拉一个。
        ...(config.apiBase !== '' ? { externalBase: config.apiBase } : {}),
      });
      if (coreHandle !== undefined) {
        /*
         * ⚠️ **必须 await**：Koishi 卸载插件之后紧接着就会去替换包目录
         * （安装/更新），而内核还在退出路上 —— `stop()` 最多等 5 秒。
         * 那几秒里包目录还被内核的 cwd 与写文件句柄占着，正是
         * 「插件停不干净，Koishi 就装不上」的另一半原因。
         *
         * cordis 会 await 异步的 dispose 监听器，所以这里等得住；
         * 即便某个版本不等，也只是退回原来的行为，不会更糟。
         */
        ctx.on('dispose', async () => {
          const handle = coreHandle;
          coreHandle = undefined;
          await handle?.stop();
        });
      }
    }
    if (coreHandle === undefined) {
      logger.error('拿不到游戏内核，插件这次不做任何事。查上面那几行日志定位原因。');
      return;
    }
    apiBase = coreHandle.base;
  }

  const client = new BridgeClient({
    apiBase,
    ...(config.token !== '' ? { token: config.token } : {}),
    platform: config.platform,
  });
  /*
   * M2.172：管理员名单随启动报一次。
   *
   * 与能力声明并列而不是塞进它里面：那两件事的失败互不相关 ——
   * 能力声明失败会让玩家看到发不出的图，管理员名单失败只会让名单少一路。
   * 分开报，日志上也就分得清是哪一件出了问题。
   */
  {
    const adminIds = config.adminIds.split(/[\s,;，；]+/).map((s) => s.trim()).filter((s) => s !== '');
    if (adminIds.length > 0) {
      void client.reportAdmins(adminIds).catch((error: unknown) => {
        ctx.logger.warn('上报管理员名单失败（内核自带的那份不受影响）：' + String(error));
      });
    }
  }
  if (config.declareCapabilities) {
    void client
      .declareCapabilities({
        images: config.capabilitiesImages,
        buttons: config.capabilitiesButtons,
        // ⚠️ 头像模板必须跟着能力一起声明：不声明 = 服务端拼不出头像，
        // 卡面画首字纹章（channel.ts 的 avatarUrlForUser 拿不到模板就返回 undefined）。
        ...(config.avatarTemplate !== '' ? { avatarTemplate: config.avatarTemplate } : {}),
        // 反向通道：声明了它，服务端才会问我们「这张图能不能换成 URL」
        inlineUpload: config.inlineUpload,
        // ⚠️ 必须显式声明 richText：服务端对这个字段的缺省是 **false**。
        // 不声明 = 告诉判定层「我不懂富文本」，于是它不生成彩色标记 ——
        // 玩家看到的是一堆黑字。BEE 版踩过一模一样的坑，这里是同一个。
        richText: true,
      })
      .then((caps) => logger.info('已向游戏声明通道能力', { caps }))
      .catch((error: unknown) => {
        // 声明失败不是致命的：服务端会用最保守的缺省档，游戏照样能玩
        logger.warn('声明通道能力失败（游戏会用缺省档）', { error: (error as Error).message });
      });
  }

  /* ---------------- 入站：Koishi → 游戏 ---------------- */
  /**
   * 把一条玩家输入送进游戏。
   *
   * 消息与按钮回调**共用这一条路**：回调按钮点下去，语义就是「玩家回了一个数字」，
   * 与手打数字完全等价 —— 分开写两套迟早会漂移。
   */
  const forward = (session: {
    isDirect?: boolean;
    userId: string;
    channelId?: string;
    username?: string;
    author?: { name?: string };
    messageId?: string;
    timestamp?: number;
  }, text: string): void => {
    const trimmed = text.trim();
    if (trimmed === '') return;
    const isDirect = session.isDirect === true;
    const scene = isDirect ? 'private' : 'group';
    const sceneId = isDirect ? session.userId : (session.channelId ?? session.userId);
    /*
     * 屏蔽的群：**连「最近会话」都不记**。
     *
     * 记了就等于给这个群留了一条被动回复的路 —— 出站那边虽然也挡了一道，
     * 但两道防线各自都要完整：这道管「不进游戏」，那道管「不出游戏」。
     */
    if (isBlockedGroup(blockedGroups, scene, sceneId)) {
      logger.debug('这个群在屏蔽名单里，消息不进游戏', { sceneId, userId: session.userId });
      return;
    }
    recentSessions.set(sceneId, session as unknown as Sendable);
    void client
      .inbound({
        scene,
        sceneId,
        userId: session.userId,
        nickname: session.author?.name ?? session.username ?? session.userId,
        text: trimmed,
        ...(messageIdFor(session) !== undefined ? { messageId: messageIdFor(session)! } : {}),
        ...(typeof session.timestamp === 'number' ? { timestamp: session.timestamp } : {}),
      })
      .catch((error: unknown) => {
        logger.error('消息没能送进游戏', { error: describeError(error), userId: session.userId });
      });
  };

  /*
   * 原生按钮的回调。
   *
   * 适配器已经把 `data`（我填的选项 id）放在 `session.event.button.data` 里，
   * 而且只要机器人没开 manualAcknowledge，它自己会回应平台（点了不会一直转圈）。
   * 所以这里只做一件事：把 data 当成玩家发的一句话。
   */
  // Koishi 的类型定义里没有 interaction/button（那是 adapter 自己发的事件），
  // 直接用 ctx.on 过不了类型检查 —— 这里按结构放宽，运行时是对的。
  const onButton = (ctx as unknown as {
    on: (name: string, callback: (session: { userId: string; event?: { button?: { data?: unknown } } }) => void) => void;
  }).on;
  onButton('interaction/button', (session) => {
    const data = session.event?.button?.data;
    const text = typeof data === 'string' ? data : data === undefined ? '' : String(data);
    logger.info('按钮回调', { userId: session.userId, value: text });
    forward(session as never, text);
  });

  ctx.on('message', (session) => {
    const text = session.content ?? '';
    // 空消息（纯图片/表情）不送 —— 判定层认的是文本指令
    if (text.trim() === '') return;
    forward(session as never, text);
  });

  /* ---------------- 出站：游戏 → Koishi ---------------- */
  const pickBot = (): (typeof ctx.bots)[number] | undefined =>
    config.selfId === ''
      ? ctx.bots[0]
      : (ctx.bots.find((bot) => bot.selfId === config.selfId) ?? ctx.bots[0]);

  /**
   * 处理 `kind: 'upload'`：把图上传换 URL，再回传给服务端。
   *
   * ⚠️ **无论如何都要回传一次**（成功给 url、失败给 error）——
   * 不回传的话服务端要干等到超时，玩家那张卡就白等十秒。
   */
  const handleUploadRequest = async (item: {
    seq: number;
    scene: string;
    targetId: string;
    requestId?: string;
    image?: { base64?: string; mediaType: string };
  }): Promise<void> => {
    const requestId = item.requestId;
    const base64 = item.image?.base64;
    if (requestId === undefined || base64 === undefined) return;
    const bot = pickBot();
    const uploader = bot === undefined ? undefined : officialUploader(bot, ctx);
    if (uploader === undefined) {
      await client.declareInlineImage({ requestId, error: '这条通道没有富媒体上传能力' });
      return;
    }
    const mediaType = item.image?.mediaType ?? 'image/png';
    const url = await uploadImageForMarkdown(
      uploader,
      { targetId: item.targetId, isDirect: item.scene === 'private' },
      { base64, mediaType },
    );
    if (url === undefined) {
      logger.debug('这张图没能换成公网 URL，交回服务端回落', { seq: item.seq });
      await client.declareInlineImage({ requestId, error: '上传没成功' });
      return;
    }
    logger.info('图片已换成公网 URL，交回服务端合成一条', { seq: item.seq });
    await client.declareInlineImage({ requestId, url });
  };

  const loop = startOutboundLoop({
    client,
    logger,
    waitSec: config.waitSec,
    deliver: async (item) => {
      /*
       * 反向通道：这条**不是给玩家的回执**，是服务端请我们把图换成公网 URL。
       * 处理完就返回 —— 它不该走下面的投递逻辑。
       */
      if (item.kind === 'upload') {
        await handleUploadRequest(item);
        return;
      }
      /*
       * 屏蔽的群：**回执一律不投递** —— 用户要的「不主动推送」落在这里。
       * 放在最前面：屏蔽掉的消息连「准备投递」都不该打，省得日志里全是它。
       */
      if (isBlockedGroup(blockedGroups, item.scene, item.targetId)) {
        logger.debug('这个群在屏蔽名单里，回执不投递', { seq: item.seq, target: item.targetId });
        return;
      }
      // 每一步都留痕。上一版这里只在最外层记一句 '回执投递失败'，
      // 而那个错误的 message 是空的 —— 等于什么都没说。
      logger.info('准备投递', { seq: item.seq, scene: item.scene, target: item.targetId });
      const bot = pickBot();
      logger.info('选中的 bot', { selfId: bot?.selfId, count: ctx.bots.length });
      if (bot === undefined) {
        logger.warn('还没有可用的 bot，这条回执先跳过', { seq: item.seq });
        return;
      }
      const rendered = renderOutbound(item);
      logger.info('渲染完成', {
        hasImage: rendered.image !== undefined,
        textLen: rendered.text.length,
        buttons: rendered.buttons.length,
      });
      // 有按钮就摆出来。adapter-qq 一见到 button 元素就会把整条消息切成 markdown
      //（见它的 visit()：button-group 分支里先 ensureMarkdown），所以正文也会跟着渲染。
      const content = rendered.buttons.length > 0 ? withButtons(rendered.text, rendered.buttons) : rendered.text;

      /*
       * ⚠️ 图片的 src **由 `imageSrc` 拼**，不要在这里把裸 Buffer 交给 `h.image` ——
       * 那会变成 `base64://…` 前缀，而 QQ 官方适配器只认 `data:…;base64,`，
       * 图会静默发不出去（详见 client.ts 里 imageSrc 的注释）。
       */
      const imageSource = rendered.image !== undefined ? imageSrc(rendered.image) : undefined;
      if (imageSource !== undefined) {
        const image = h.image(imageSource);
        try {
          /*
           * 图与文字分成两条发（与 OneBot 通道同一形态）。
           *
           * 不拼成一条是有意的：把元素（`h.image` 的结果）插进模板字符串会变成
           * `[object Object]`，而 Koishi 的 `session.send(string)` 不会把字符串当元素解析 ——
           * 那个 bug 的表现是"图变成一行乱码"，且只在真机上出现。
           */
          if (rendered.text !== '') await send(bot, item, content);
          await send(bot, item, image);
          return;
        } catch (error) {
          if (!config.imageFallbackToText) throw error;
          logger.warn('发图失败，退化成链接', { seq: item.seq, error: (error as Error).message });
          const link = rendered.image?.url ?? '（图片，但本通道发不出）';
          await send(bot, item, `${rendered.text}\n${link}`.trim());
          return;
        }
      }
      await send(bot, item, content);
    },
  });


  ctx.on('dispose', () => {
    loop.stop();
  });
}

/**
 * 取一个能用的 messageId。
 *
 * ## 为什么要筛
 *
 * 协议的 messageId 上限是 **128 字符**，而 Koishi 的 `session.messageId` 在
 * **按钮回调**那条路上是个很长的内部 id。直接传过去，内核会以
 * 「入参不合法：messageId 太长」**整条拒收** —— 表现是玩家点了按钮什么反应都没有，
 * 而插件日志里只有一条 400。真实踩过。
 *
 * 做法是**超长就不传**：这个字段是可选的信息（给判定层做回执关联用），
 * 少了它不影响判定，传个超长的反而让整条消息进不去。
 */
function messageIdFor(session: { messageId?: string }): string | undefined {
  const id = session.messageId;
  if (typeof id !== 'string' || id === '') return undefined;
  return id.length <= 128 ? id : undefined;
}

/**
 * 把按钮拼到正文后面。
 *
 * 形状照 @satorijs/adapter-qq 的 decodeButton 来：
 *
 * **不写 `type`** → 适配器译成 `action.type = 1`（**回调按钮**）：
 * 点了平台推 `INTERACTION_CREATE`（走 WebSocket，不需要公网回调地址），
 * 适配器变成 `interaction/button` 事件交回来 —— 点了**直接执行**。
 *
 * ⚠️ **前提是机器人订阅了 `INTERACTIONS` intent**（值 67108864 = 1<<26）。
 * 缺了它平台根本不推事件，客户端等不到回应，会提示「请求第三方失败」——
 * 那个提示看着像网络问题，其实是没订阅。
 * （adapter-qq 的 acknowledgeInteraction 是 `.catch(() => {})` 吞掉的，日志里也看不出来。）
 *
 * 写 `type: 'input'` 会变成 `action.type = 2`（指令按钮）：只把文字插进输入框，
 * 玩家还要再按一次发送。那是「常用指令」的形态，不是菜单选项要的。
 *   · 每行 3 个：平台每行最多 5 个，但排满手机上会被截。
 */
function withButtons(
  text: string,
  buttons: { label: string; command: string }[],
): unknown[] {
  const rows: unknown[] = [];
  for (let i = 0; i < buttons.length; i += 3) {
    const group = buttons.slice(i, i + 3).map((b) =>
      h('button', { id: b.command, class: 'primary' }, b.label),
    );
    rows.push(h('button-group', group));
  }
  // 正文必须包在 qq:markdown 里。
  //
  // 适配器的 ensureMarkdown() 会把正文 escapeMarkdown() 一遍 —— 那是给
  // 「本来是纯文本、因为带了按钮才升格成 markdown」的消息准备的。
  // 而判定层给的正文**本来就是 markdown**（$\textcolor{…}$、**加粗**），
  // 转义之后 $ 和 \ 就没了，玩家看到的是 `textcolor#c2185b100/100`。
  //
  // 套一层 qq:markdown 元素，适配器会把 inMarkdown 置位，那段文字就不再被转义
  //（见它的 visit()：type==="text" 时才看 inMarkdown）。
  const body = h('qq:markdown', text);
  return [body, ...rows];
}

/**
 * 把 adapter-qq 的内部接口包成 `upload-image.ts` 要的形状。
 *
 * 拿不到（OneBot 通道、或者 adapter 版本变了）就返回 `undefined` ——
 * 调用方直接回传「换不到」，服务端回落，一个来回都不浪费。
 */
function officialUploader(bot: { internal?: unknown }, ctx: Context): OfficialUploadApi | undefined {
  const internal = bot.internal as Record<string, unknown> | undefined;
  if (internal === undefined) return undefined;
  const call = (name: string) => {
    const fn = internal[name];
    if (typeof fn !== 'function') return undefined;
    return (targetId: string, body: Record<string, unknown>) =>
      (fn as (id: string, b: Record<string, unknown>) => Promise<Record<string, unknown>>).call(internal, targetId, body);
  };
  const prepPrivate = call('uploadPreparePrivate');
  const prepGuild = call('uploadPrepareGuild');
  const partPrivate = call('uploadPartFinishPrivate');
  const partGuild = call('uploadPartFinishGuild');
  const filePrivate = call('sendFilePrivate');
  const fileGuild = call('sendFileGuild');
  if ([prepPrivate, prepGuild, partPrivate, partGuild, filePrivate, fileGuild].some((fn) => fn === undefined)) {
    return undefined;
  }
  return {
    prepare: (targetId, isDirect, body) => (isDirect ? prepPrivate! : prepGuild!)(targetId, body),
    partFinish: (targetId, isDirect, body) => (isDirect ? partPrivate! : partGuild!)(targetId, body),
    finish: (targetId, isDirect, body) => (isDirect ? filePrivate! : fileGuild!)(targetId, body),
    // Koishi 的 http 是抛错式的：没抛出来就是成功
    put: async (url, bytes, contentType) => {
      await ctx.http.put(url, bytes, { headers: { 'content-type': contentType } });
      return { ok: true, status: 200 };
    },
  };
}

/** 私聊用 sendPrivateMessage、群聊用 sendMessage —— 两者的 targetId 含义不同（见文件头） */
async function send(
  bot: { sendMessage: (id: string, content: unknown) => Promise<unknown>; sendPrivateMessage?: (id: string, content: unknown) => Promise<unknown> },
  item: { scene: string; targetId: string },
  content: unknown,
): Promise<void> {
  // 优先借最近那条消息的 session 走被动回复。
  // 失败（session 过期、平台不认）就往下走原来的主动消息那条路。
  const cached = recentSessions.get(item.targetId);
  if (cached !== undefined) {
    try {
      await cached.send(content as never);
      return;
    } catch (error) {
      // 这里**不抛**：退到下面那条路再试一次，让两条路都有机会。
      // 但要把原因留住 —— 两条都失败时，两条的原因都要看得到。
      (item as { passiveError?: string }).passiveError = describeError(error);
    }
  }
  if (item.scene === 'private' && bot.sendPrivateMessage !== undefined) {
    try {
      await bot.sendPrivateMessage(item.targetId, content);
    } catch (error) {
      // 把「走的是哪条路、发给了谁」一起带上。
      // 只抛原始错误的话，外面看到的是一句空 message —— 上一次排障就卡在这儿。
      const passive = (item as { passiveError?: string }).passiveError;
      throw new Error(
        "sendPrivateMessage(" + item.targetId + ") 失败：" + describeError(error) +
          (passive !== undefined ? "（被动回复也失败：" + passive + "）" : ""),
      );
    }
    return;
  }
  try {
    await bot.sendMessage(item.targetId, content);
  } catch (error) {
    const passive = (item as { passiveError?: string }).passiveError;
    throw new Error(
      "sendMessage(" + item.targetId + ") 失败：" + describeError(error) +
        (passive !== undefined ? "（被动回复也失败：" + passive + "）" : ""),
    );
  }
}
