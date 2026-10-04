/**
 * **emoji 表**（M2.86，用户：「该用 emoji 表情的也不要省」）。
 *
 * ## 为什么 emoji 比颜色更该用
 *
 * 颜色走 LaTeX（`$\textcolor{...}$`），它**依赖客户端渲染** —— 实测在手机端有效，
 * 但那终究是「平台愿意渲染时才生效」。而 **emoji 是纯文本**：
 *
 *   · 两端都渲染，而且是**彩色的**（QQ 自带 emoji 字体）；
 *   · 不受 markdown 白名单影响；
 *   · 复制出去还是那个符号（不会变成 `$\textcolor…`）。
 *
 * 所以**分层的第一手段是符号与 emoji，颜色只做加强** —— 颜色失效时信息也不丢。
 *
 * ## 为什么放在 domain 而不是 adapter
 *
 * `statsLine` / `debuffLine` 这些**域层函数**也要用（装备的加成与代价），
 * 而域层不该依赖 adapter。emoji 是纯数据、不含平台知识，放这里两边都能用。
 *
 * ## 纪律：只在「分类」和「要立刻判断的量」上用
 *
 * 与颜色同一条 —— **满屏 emoji 等于没有 emoji**。一行里最多一个，
 * 且只在它真的在标注「这一类是什么」时用。
 */
export const EMOJI = {
  place: '\u{1F5FA}\uFE0F',
  danger: '\u26A0\uFE0F',
  time: '\u23F3',
  weather: '\u{1F326}\uFE0F',
  money: '\u{1F4B0}',
  arcane: '\u{1F52E}',
  hp: '\u2764\uFE0F',
  mind: '\u{1F9E0}',
  spirit: '\u2728',
  gear: '\u{1F392}',
  battle: '\u2694\uFE0F',
  hit: '\u{1F3AF}',
  clue: '\u{1F50D}',
  gain: '\u2B06\uFE0F',
  cost: '\u2B07\uFE0F',
  quest: '\u{1F4DC}',
  bag: '\u{1F392}',
  world: '\u{1F30D}',
  book: '\u{1F4D6}',
  done: '\u2705',
} as const;

/** 拼一个「emoji + 空格 + 文字」（emoji 为空时直接返回文字，不留多余空格） */
export function withEmoji(emoji: string, text: string): string {
  return emoji.length === 0 ? text : emoji + ' ' + text;
}
