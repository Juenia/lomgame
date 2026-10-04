/**
 * 敏感词（S1 §7 / 需求方案 §15「AI 不直出」）。
 * W1 只做占位实现：入站玩家输入与出站机器人文本都要过一遍。
 * 真实词库接入后只需替换 DEFAULT_WORDS，接口不变。
 */
export const DEFAULT_WORDS: readonly string[] = [
  // 交易/引流类（占位，正式词库待运营提供）
  '加微信',
  '加V信',
  '私聊出',
  '代练',
  '卖号',
  '收号',
  '刷币',
  '外挂',
  '脚本代打',
];

export class SensitiveFilter {
  #words: readonly string[];

  constructor(words: readonly string[] = DEFAULT_WORDS) {
    this.#words = words;
  }

  /** 命中返回命中词，否则 null */
  hit(text: string): string | null {
    const lower = text.toLowerCase();
    for (const word of this.#words) {
      if (word && lower.includes(word.toLowerCase())) return word;
    }
    return null;
  }

  /** 命中则替换为等长 * */
  mask(text: string): string {
    let out = text;
    for (const word of this.#words) {
      if (!word) continue;
      out = out.split(word).join('*'.repeat(word.length));
    }
    return out;
  }
}
