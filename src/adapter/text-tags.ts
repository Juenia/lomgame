/**
 * **正文里的可点标签，在长度账上只算它显示出来的那几个字**（M2.116）。
 *
 * ## 用户报的 BUG
 *
 * > 「文字标签按钮的代码疑似被算在字数里了，每多一个标签指令按钮就会导致背包被过长截断」
 *
 * 一点没错。一条标签发出去长这样：
 *
 * ```
 * <qqbot-cmd-input text=".%E4%BD%BF%E7%94%A8%20%E9%A9%B1%E9%82%AA%E7%AC%A6" show="%E9%A9%B1%E9%82%AA%E7%AC%A6" />
 * ```
 *
 * **源码 96 个字符，而客户端显示的是「驱邪符」三个字。**
 * 而正文长度保护（`#clampContent`）是按 `text.length` 算的 ⇒
 * 背包里每多一件能用/能装备的东西，正文就凭空多出约 90 个字符 ——
 * 十来件就把 1000 的上限撑爆，于是**整条消息被截断**（玩家看到「（内容过长已截断）」）。
 *
 * ## 这里做的两件事
 *
 *   ① `displayLengthOf`  —— 算长度时，标签只按 `show` 的宽度计入
 *   ② `truncateKeepingTags` —— 真要截断时**不切开标签**（半个标签平台不认，会原样显示源码）
 */

/** 匹配 `<qqbot-cmd-input … />`（`<qqbot-cmd-enter>` 一起认，将来可能用到） */
const TAG_RE = /<qqbot-cmd-(?:input|enter)\b[^>]*?\/>/g;

/** 从标签源码里取出客户端真正会显示的那段文字（`show`，没有就退回 `text`） */
function visibleTextOfTag(tag: string): string {
  const show = /show="([^"]*)"/.exec(tag)?.[1];
  const text = /text="([^"]*)"/.exec(tag)?.[1];
  const raw = show ?? text ?? '';
  try {
    return decodeURIComponent(raw);
  } catch {
    // 编码坏了就按原样算 —— 宁可多算几个字符，也不能在这里抛
    return raw;
  }
}

/**
 * 正文的**有效长度**：标签按 `show` 算，其余按字符算。
 *
 * 用 `for…of` 而不是 `.length`：中文是 BMP 外还是内不影响这里（两种都算 1），
 * 但 emoji 之类的代理对按 `.length` 会算成 2 —— 显示上它是一个字。
 */
export function displayLengthOf(text: string): number {
  let total = 0;
  let last = 0;
  TAG_RE.lastIndex = 0;
  for (const match of text.matchAll(TAG_RE)) {
    total += [...text.slice(last, match.index)].length;
    total += [...visibleTextOfTag(match[0])].length;
    last = match.index + match[0].length;
  }
  total += [...text.slice(last)].length;
  return total;
}

/**
 * 按**显示长度**截断，且**不切开标签**。
 *
 * 为什么必须做到「不切开」：标签被拦腰截断之后，平台解析不出来，
 * 玩家看到的是半截源码（`<qqbot-cmd-input text=".%E4…`）—— 那比少一件物品难看得多。
 * 所以超限时**整条标签要么留、要么不要**。
 */
export function truncateKeepingTags(text: string, max: number, ellipsis = '…'): string {
  let out = '';
  let used = 0;
  let last = 0;
  TAG_RE.lastIndex = 0;
  const pushPlain = (plain: string): boolean => {
    for (const ch of plain) {
      if (used + 1 > max) return false;
      out += ch;
      used += 1;
    }
    return true;
  };
  for (const match of text.matchAll(TAG_RE)) {
    if (!pushPlain(text.slice(last, match.index))) return out + ellipsis;
    const width = [...visibleTextOfTag(match[0])].length;
    if (used + width > max) return out + ellipsis;
    out += match[0];
    used += width;
    last = match.index + match[0].length;
  }
  if (!pushPlain(text.slice(last))) return out + ellipsis;
  return out;
}
