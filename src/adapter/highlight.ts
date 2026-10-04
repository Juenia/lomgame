/**
 * 正文高亮（M2.86）：按信息类型给**字体颜色**。
 *
 * ## 用户拍板
 *
 * > 「正文信息也不能过于精简，起码的信息量要凸显出来，还有重要信息要高亮显示，
 * >   尝试置入字体颜色，我在手机端发现了是存在 MD 消息的字体颜色的」
 *
 * ## ⚠️ 这里与项目里的一份旧实测记录冲突
 *
 * `docs/QQ-markdown-能力实测.md` 记着：
 *
 *   `<font color="#e54d42">` ｜ 手机 QQ **标签原样打出来** ｜ 电脑 QQ 红字
 *   ⇒ 「玩家绝大多数在手机上，所以颜色一律按不支持处理」—— 当时整体撤回了颜色。
 *
 * 而用户**在手机端亲眼看到了字体颜色**。可能是 QQ 手机端在这之后更新了。
 * 处理办法（既不盲从旧记录、也不裸奔）：
 *
 *   ① **默认开启**（以用户的真机观察为准）；
 *   ② 给一个开关 `supportsColor`，真机复验失败时可以一键关掉，不必改文案；
 *   ③ **颜色只做增强，不承载唯一信息** —— 每一条被上色的信息，旁边都还有
 *      加粗 / 符号 / 引用块在说同一件事。颜色失效时信息不丢，这是底线。
 */

/**
 * 通道是否默认支持彩色（LaTeX）。
 *
 * ## 为什么需要它
 *
 * `supportsColor` 这个开关本来就是为「真机复验失败时一键关掉」留的（见文件头第 ② 条），
 * 但它是**逐调用**的 —— 而绝大多数调用点（`router/commands/*`、`domain/scene`）用的是默认值
 * `true`。于是它实际上关不掉：想关就得改几十处，还要保证以后新加的调用点记得传。
 *
 * 现在默认值由环境变量决定：
 *
 *   · **不设**（QQ 官方 markdown 通道）→ `true`，行为与以前**逐字不变**；
 *   · **`LOM_PLAIN_TEXT=1`**（BEE 这类不走 markdown 的通道）→ `false`，出纯文本。
 *
 * ## 不管它会怎样
 *
 * 玩家在 BEE 上看到的是 `$\textcolor{#c2185b}{…}$` 这样的**源码**，
 * 因为那个通道根本不渲染 markdown。而 QQ 官方通道会把它渲染成彩色文字 ——
 * 同一份内容，两种通道下的观感完全不同，这不是文案问题，是通道能力问题。
 */
const SUPPORTS_COLOR_BY_DEFAULT = process.env['LOM_PLAIN_TEXT'] !== '1';

/** 颜色表：按**信息的性质**分，不按位置分（玩家记住的是「红=危险」） */
export const HL_COLORS = {
  /*
   * ⚠️⚠️ **MD 消息是白底** —— 这条约束决定了一切（M2.86 实机修正）。
   *
   * 用户截图指出：`.探索` 的收获里物品名**完全看不见**，只剩 `× 1（非绑定·常见）`。
   * 原因是我把 `name` 改成了**纯白 `#ffffff`** —— 白底上白字。
   *
   * 更糟的是：那一次我为了「解决颜色太单调」把**所有颜色都调亮了**
   * （`#4ade80` `#fb923c` `#ff5470` `#fbbf24` `#60a5fa` `#a78bfa` `#22d3ee` `#facc15`），
   * 那批色是给**深色背景**挑的 —— 在白底上对比度全部不足，浅色几乎读不出来。
   *
   * ## 现在的口径
   *
   * **白底 + 深色文字**，每个色都取「深色系」中的一档，保证在白底上清晰可读。
   * 判断标准：与 `#ffffff` 的对比度要够（这几档都在 4.5:1 以上）。
   *
   * 教训：**「提亮」和「看得清」是两件事** —— 在浅色底上，能看清靠的是**够深**，
   * 不是够亮。上一轮我按「深色卡面」的直觉调色，而消息正文根本不是深色的。
   */
  /** 生命红（血条本色）—— 深玫红，白底可读 */
  vital: '#c2185b',
  /** 健康 / 安全 —— 深绿 */
  ok: '#1a7f37',
  /** 警告 / 注意 —— 深橙 */
  warn: '#b45309',
  /** 危险 / 损失 / 失败 —— 深红 */
  danger: '#c62828',
  /** 收益 / 获得 —— 深金 */
  gain: '#8a6100',
  /** 普通信息 —— 深蓝 */
  info: '#1d4ed8',
  /** 非凡 / 神秘 —— 深紫 */
  arcane: '#6d28d9',
  /** 线索 / 传闻 —— 深青 */
  clue: '#0e7490',
  /** 人的名字 —— 深墨（不是白！白底上白字等于隐形） */
  name: '#3f3325',
  /** 地点 —— 深黄棕 */
  place: '#8a6a12',
  /*
   * M2.86：**数值升降**（用户：「提升就是绿色的三角块，降低就是红色的倒三角块」）。
   *
   * 与 `gain` / `danger` 的区别是语义：
   *   · `gain` / `danger` 说的是**性质**（这是好事 / 这是坏事）；
   *   · `up` / `down` 说的是**方向**（它涨了 / 它跌了）—— 而方向在屏幕上
   *     只是两个三角块，**颜色就是它唯一的语义**。
   *
   * 所以这两个色取最直白的那一对：绿 = 涨、红 = 跌。
   * （`gain` 是深金，它在「收益」语境里更合适，但不适合表示方向。）
   */
  up: '#1a7f37',
  down: '#c62828',
  /*
   * M2.117：**红色警告，但不是升降**（用户点名的：三角块只用来表示方向）。
   *
   * 现场：`.状态` 里的「疯狂 / 污染」高位时用的是 `danger`，而 `danger` 的符号是 **▼** ——
   * 于是「疯狂 62」会显示成「▼ 疯狂 62」，读起来像「疯狂**降了**」，而它恰恰是**高得危险**。
   *
   * 所以拆开：颜色（红）与符号（`!`）分开取 ——
   *   红 + `!` = 危险，需要留意（不是方向）
   *   绿 + `▲` / 红 + `▼` = 涨 / 跌（**只有**这一对表示方向）
   */
  alarm: '#c62828',
} as const;

/**
 * 高亮的语义类别。
 *
 * **从色板派生**（`keyof typeof HL_COLORS`）而不是手抄一遍 —— 加一种颜色只改一处。
 * 手抄的后果与 AGENTS §3.1 说的一样：类型上看着齐全，而实际取色时静默拿到 undefined。
 */
export type HlKind = keyof typeof HL_COLORS;

/** 每种高亮**同时**带的非颜色标记（颜色失效时靠它） */
export const HL_MARKS: Record<HlKind, string> = {
  // 健康不需要符号 —— 它没有「要留意的异常」，加符号反而吵
  ok: '',
  // 生命条也不加符号：它本身就是最显眼的那一条
  vital: '',
  // 警告用「!」：它既不是好消息也不是坏消息，但需要留意（与 ▼/▲ 区分开）
  warn: '!',
  danger: '▼',
  // 红色感叹号：危险，但**不表示方向**（方向只有 ▲/▼ 一对）
  alarm: '!',
  gain: '▲',
  arcane: '✦',
  clue: '·',
  info: '·',
  name: '',
  place: '⌖',
  // 数值升降：绿 ▲ / 红 ▼（用户点名的形态）
  up: '▲',
  down: '▼',
};

/**
 * 把一段文字上色。
 *
 * `supportsColor = false` 时**只返回原文**（不加任何标签）——
 * 这是「按不支持处理」那条旧结论的落点，一键可回退。
 */
export function hl(text: string, kind: HlKind, supportsColor = SUPPORTS_COLOR_BY_DEFAULT): string {
  if (!supportsColor) return text;
  /*
   * M2.86：**用 LaTeX 上色，不用 `<font>`**。
   *
   * 用户从那个机器人消息里复制出来的原始文本是 `\small{\textcolor{#FF6B6B}{…}}`，
   * 而它显示出来**是彩色的** ⇒ 官方 markdown 渲染 LaTeX。
   * 而 `<font color>` 在手机端显示成原始标签（用户实测）。
   *
   * ⚠️ **不加 `$`**：`$\textcolor{...}$` 是数学模式，手机会裸着打出来。
   */
  /*
   * ⚠️ **必须包在 `$…$` 里**（行内数学模式），用户实机对照过：
   *
   *   ① `\textcolor{#e05a4f}{红}`      → **裸文本** ✗
   *   ② `$\textcolor{#e05a4f}{红}$`    → **红色** ✅
   *
   * 而那个机器人的「复制文本」里**没有 `$`** —— 因为 **QQ 复制富文本时会吃掉定界符**，
   * 我照着复制结果推断，于是把方向搞反了一次（写成不带 `$`，全裸）。
   * 教训：**复制出来的文本不能当源文本用**，定界符要单独验证。
   */
  return '$\\textcolor{' + HL_COLORS[kind] + '}{' + text + '}$';
}

/**
 * 带符号的高亮：**符号在颜色之外**，所以颜色失效时仍然一眼看得出这是哪一类。
 *
 * 例：`hlMark('生命 -12', 'danger')` →
 *   开：`▼ <font color="#e05a4f">生命 -12</font>`
 *   关：`▼ 生命 -12`
 */
export function hlMark(text: string, kind: HlKind, supportsColor = SUPPORTS_COLOR_BY_DEFAULT): string {
  const mark = HL_MARKS[kind];
  /*
   * M2.86：**符号跟着一起上色**（用户：「用颜色的三角块」）。
   *
   * 原来只给正文上色、符号裸着 —— 于是「▲ 生命 +3」里的三角块是黑的，
   * 而用户要的正是「绿色 ▲ / 红色 ▼」：**方向类信息里，颜色就是那个三角块本身**。
   *
   * （`hl(text, kind)` 单独用时不带符号，那条路没变。）
   */
  if (mark.length === 0) return hl(text, kind, supportsColor);
  return hl(mark + ' ' + text, kind, supportsColor);
}

/** 一组「标签 + 数值」的通用渲染（正文里的信息行用它，避免每处各写一遍） */
export function hlStat(label: string, value: string, kind: HlKind, supportsColor = SUPPORTS_COLOR_BY_DEFAULT): string {
  // 加粗与颜色是**同一个决定的两半**：都靠 markdown 才有效。
  // 关掉颜色却留着 `**`，玩家看到的是 `**生命** 100/100` —— 比纯文本更难看。
  if (!supportsColor) return label + ' ' + hlMark(value, kind, supportsColor);
  return '**' + label + '** ' + hlMark(value, kind, supportsColor);
}

/**
 * **LaTeX 颜色**（M2.86，用户真机确认）—— 这才是官方 markdown 上色的正解。
 *
 * ## 证据（用户从那个机器人消息里**复制出来的原始文本**）
 *
 * ```
 * 设置显示文字：\small{\textcolor{#FF6B6B}{你好 选择样式1}}　填写
 * 选择速度1 - 9：\small{\textcolor{#FFA500}{8}}　填写
 * ```
 *
 * **复制出来是 LaTeX，显示出来是彩色的文字** ⇒ 官方 markdown 会渲染 LaTeX。
 *
 * ## 两个坑（都踩过）
 *
 *   ① **不能加 `$`**：`$\small{\textcolor{...}{...}}$` 是**数学模式**，手机端会**裸着打出来**
 *      （用户给过一张截图正是这个症状）；去掉 `$` 才渲染。
 *   ② **`<font color>` / `<span style>` 都不行**：手机端显示成原始标签（用户实测）。
 *      项目那份 `docs/QQ-markdown-能力实测.md` 记的「HTML 按不支持处理」是对的 ——
 *      但结论不该停在「没有颜色」，而该继续找，最后找到的是 **LaTeX**。
 *
 * 颜色值用 **HTML 十六进制**（`#RRGGBB`），与那个机器人一致。
 */
/** 上色（**必须带 `$…$`**，见 hl() 里的实测对照） */
export function latexColor(text: string, hex: string): string {
  return '$\\textcolor{' + hex + '}{' + text + '}$';
}

/** 按信息类型上色（LaTeX 版）—— 与 hl() 同一套颜色表 */
export function latexHl(text: string, kind: HlKind): string {
  return latexColor(text, HL_COLORS[kind]);
}

/**
 * 带符号的 LaTeX 高亮（符号在颜色之外 —— 万一某端不认 LaTeX，信息也不丢）。
 */
export function latexHlMark(text: string, kind: HlKind): string {
  const mark = HL_MARKS[kind];
  const body = latexHl(text, kind);
  return mark.length > 0 ? mark + ' ' + body : body;
}

/** 小号（`$\small{}`）—— 与颜色同一条路线，定界符不能少 */
export function latexSmall(text: string): string {
  return '$\\small{' + text + '}$';
}

// emoji 表已挪到 domain（域层也要用）—— 这里 re-export，既有 import 不破
export { EMOJI, withEmoji } from '../domain/emoji.ts';
