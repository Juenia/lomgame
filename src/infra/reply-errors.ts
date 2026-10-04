/**
 * 被动回复的两条硬限制，以及违反它们时抛的错误。
 *
 * ## 为什么单独一个文件
 *
 * 这两个类原来住在 `adapter/qq-official/index.ts` 里，而 `app.ts` 为了
 * 一句 `instanceof NoReplyTicketError` **值导入**了那个文件 —— 于是整个 QQ 官方适配器
 *（网关、token、登录检查）被拉进了 bridge-api 的模块图。
 *
 * `bridge-api/test/no-platform-adapter.test.ts` 的运行时守卫当场变红，
 * 而它的注释里早写过同一类事故的教训：**「地址是配置，协议实现才是适配器」**。
 * 这次是同一条道理的另一个面：**错误类型是契约，不是适配器实现** ——
 * 判断「这条路发不出去」不该以引入一整个网关为代价。
 *
 * ## 为什么不能放 `src/adapter/` 下
 *
 * 那条静态守卫规定：`adapter/` 路径下的**任何**非 `import type` 导入都算违规。
 * 所以它必须待在 adapter 之外 —— 这里选 infra：它是被各层共用的基础设施。
 */
import type { Scene } from '../adapter/types.ts';

/** 对同一个 msg_id 的回复条数超过官方上限时抛这个 */
export class ReplyQuotaError extends Error {
  constructor(scene: Scene, targetId: string, msgId: string, max: number) {
    super(
      `无法向 ${scene === 'group' ? '群 ' : ''}${targetId} 发送：对同一条消息（msg_id=${msgId.slice(0, 24)}…）的` +
        `回复条数已达官方上限 ${max} 条。官方限制「每条消息可回复次数」群聊 5 次、单聊 4 次；` +
        `多出来的内容应当合并进上一条，或者挂进菜单让玩家下一步再取。`,
    );
    this.name = 'ReplyQuotaError';
  }
}

/** 没有被动回复凭证（窗口过期 / 从没收到过该会话的消息）时抛这个 */
export class NoReplyTicketError extends Error {
  constructor(scene: Scene, targetId: string, ageMs: number | null) {
    super(
      scene === 'group'
        ? `无法向群 ${targetId} 发送：没有可用的被动回复凭证。` +
          `官方要求被动回复必须带 5 分钟内的 msg_id；而这条路径**没有**取到凭证 —— ` +
          `它会退化成主动消息（M2.115 起不再抛错，见 #consumeTicket）。` +
          (ageMs === null ? '（这个会话从未收到过消息）' : `（最近一条凭证已过期 ${Math.round(ageMs / 1000)} 秒）`)
        : `无法向 ${targetId} 发送私聊消息：缺少被动回复凭证（C2C 会话必须由玩家先发一条消息）。` +
          `官方对主动消息有限频（单关系 20/qpm、每用户每天 1000 条），所以「群聊给摘要、明细走私聊」里的明细，` +
          `只有在玩家私聊过机器人之后才送得达 —— 这是设计好的路径，群里的回执本来就提示了玩家私聊。` +
          (ageMs === null ? '该玩家尚未私聊过机器人。' : `最近一条私聊凭证已过期 ${Math.round(ageMs / 1000)} 秒。`),
    );
    this.name = 'NoReplyTicketError';
  }
}
