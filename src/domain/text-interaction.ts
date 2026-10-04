/**
 * **文本交互标签**（M2.103）—— QQ 官方 markdown 里的「可点文字」。
 *
 * ## 出处（用户给的文档）
 *
 * https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/trans/text-chain.html
 *
 * 官方原文（「指令操作」一节，**目前仅在 markdown 支持**）：
 *
 * ```
 * 1. 回车指令格式（点击后，文本直接发送）
 *    <qqbot-cmd-enter text="xxx" />
 *    ⚠️ 群聊和文字子频道不支持该能力
 *
 * 2. 参数指令格式（点击后，文本插入输入框，用户自行编辑发送）
 *    <qqbot-cmd-input text="xxx" show="xxx" reference="false" />
 *      text  用户点击后插入输入框的文本（必填，≤100 字符，**urlencode**）
 *      show  用户在消息内看到的文本（选填，默认取 text，≤100 字符，**urlencode**）
 *      reference  插入输入框时是否带消息原文引用（默认 false）
 * ```
 *
 * ## 为什么这个文件值得存在
 *
 * 项目前面几轮一直用 `keyboard`（消息**下方**的按钮区）做交互 —— 那是另一套东西。
 * 而这个能力可以**把正文里的任意一段文字变成可点标签**：
 * 于是「背包表格里那一格物品名」本身就能是入口，不需要在消息下面再摆一排按钮。
 *
 * ⚠️ **群聊不支持 `cmd-enter`**（点击直接发送）⇒ 一律用 `cmd-input`（插进输入框），
 *   那也更符合用户的要求：「点下去自动在输入框那里输入指令」。
 */

/**
 * 生成一个「参数指令」标签：消息里显示 `show`，点一下把 `text` 插进输入框。
 *
 * ⚠️ 两个字段都必须 **urlencode**（官方原文里的加粗要求）—— 指令里带空格、
 * 物品名里带中文，不编码平台会解析不出来。
 */
/**
 * 官方对 `text` / `show` 的限制是 **100 字符**（urlencode **之前**）。
 *
 * ⚠️ 这条限制是**实机截图**发现的：物品名很长的那种（`主材料·“XXX”的非凡特性，或者…`），
 * 编码之后的 `text` 远超 100 —— 那一条标签在真机上**原样显示成了源码**，
 * 而同一屏里短的几条（「因蒂斯密信」「旧日残页」）正常渲染成了可点标签。
 *
 * ⇒ 长度不够就**不给标签**：一个坏标签比没有标签更糟（玩家看到一串乱码）。
 */
export function canUseCmdTag(text: string, show: string): boolean {
  return text.length <= 100 && show.length <= 100;
}

export function cmdInputTag(text: string, show: string): string {
  return '<qqbot-cmd-input text="' + encodeURIComponent(text) + '" show="' + encodeURIComponent(show) + '" />';
}

/**
 * 这一条通道能不能渲染上面的标签。
 *
 * 判据用 `supportsColor` —— 官方文档写明「指令操作**目前仅在 markdown 支持**」，
 * 而项目里「是不是 markdown 通道」的既有判据就是 `supportsColor`（只有 markdown 支持字体颜色）。
 * 换成别的判据要多一份状态，而它们说的是同一件事。
 */
export function canUseCmdTags(supportsColor: boolean | undefined): boolean {
  return supportsColor === true;
}
