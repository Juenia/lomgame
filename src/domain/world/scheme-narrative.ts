/**
 * 阴谋的**叙事层**（M2.85 RPG 化）—— **纯函数，无 IO**。
 *
 * ## 用户三次拍板
 *
 * > ① 「阴谋是否需要对接 AI？硬性数据能写出好的针对阴谋吗」
 * > ② 「太儿戏了，阿蒙那种半神算计偷你一点东西吗？」
 * > ③ 「阴谋不应该过于单调，现在就我提出来的两种和你的小偷行为」
 *
 * 三条各解决一件事：
 *
 *   ① 的答案：**针对性来自数据**（项目已在记 72 种 domain_events），不来自文笔
 *   ② 的答案：**按「谁在下」分层**（street 只能顺你东西，半神下的是棋）
 *   ③ 的答案：**按「他图什么」分性质**（损害/操纵/误导/渗透/颠覆/收割）
 *
 * 于是这一层的结构对应③：**按性质写文案 + 用事实做槽位**。
 * 三十多个手段不需要三十多段文案 —— 性质只有六种，而每个性质都能引用玩家的真实经历。
 *
 * ⚠️ 借不到原料就降级为泛化句 —— 宁可含糊，绝不编造。
 */
import { natureOfKind, omenTextOf, strikeTextOf, type SchemeNature } from './npc-scheme.ts';

/** 从玩家的 domain_events 里提取出来的可用事实（命令层负责查库） */
export interface SchemeFacts {
  lastFoe?: string;
  lastItem?: string;
  lastPlace?: string;
  wantedLevel?: number;
  tabooViolations?: number;
  churchName?: string;
  lastPromotionSeq?: number;
  lastPlaceName?: string;
}

export function hasFacts(facts: SchemeFacts): boolean {
  return Boolean(facts.lastFoe ?? facts.lastItem ?? facts.lastPlace) || (facts.wantedLevel ?? 0) > 0 || (facts.tabooViolations ?? 0) > 0;
}

const placeOf = (f: SchemeFacts): string => f.lastPlaceName ?? f.lastPlace ?? '那一带';

/**
 * 端倪 —— 按**性质**给句子，用**事实**做槽位。
 *
 * 棋局级（subvert / infiltrate / harvest）的端倪刻意不像危险，
 * 而像「你自己出了点问题」—— 这是它与街面算计最大的区别。
 */
export function omenTextFor(kind: string, facts: SchemeFacts): string {
  const nature: SchemeNature = natureOfKind(kind);
  const place = placeOf(facts);
  const foe = facts.lastFoe;
  const item = facts.lastItem;
  switch (nature) {
    case 'harm':
      if (foe !== undefined) return `${place}的事有人翻出来了 —— 说的是你和一个「${foe}」之间的那一次。他们连你当时站在哪都知道。`;
      if (item !== undefined) return `你放「${item}」的地方被动过。东西还在，但位置差了一点。`;
      return omenTextOf(kind);
    case 'use':
      return facts.lastPlace !== undefined
        ? `你回想这几天的安排。去${place}那一趟是你自己决定的吗？—— 你想不起是什么时候决定的，但你确实去了。`
        : omenTextOf(kind);
    case 'deceive':
      if (item !== undefined) return `有人给你递了个消息，说最近有一件和「${item}」很配的东西。递消息的人不肯露面。`;
      return omenTextOf(kind);
    case 'infiltrate':
      return facts.churchName !== undefined
        ? `${facts.churchName}的人最近对你客气了一些。客气得像是在和另一个人说话。`
        : omenTextOf(kind);
    case 'subvert':
      if (facts.lastPromotionSeq !== undefined) return '你翻自己的记录：那次晋升还在，日期差了两天。你不确定是记错了，还是有人动过。';
      return omenTextOf(kind);
    case 'harvest':
      return facts.lastPlace !== undefined ? `${place}那边最近总有人问你还在不在。问得很随便，随便得像随口。` : omenTextOf(kind);
  }
}

/**
 * 发动 —— 后果由命令层按**性质**落到具体数值上（见 npc-scheme.ts 的 effectOfNature）。
 */
export function strikeTextFor(kind: string, facts: SchemeFacts): string {
  const nature = natureOfKind(kind);
  const place = placeOf(facts);
  const foe = facts.lastFoe;
  const item = facts.lastItem;
  switch (nature) {
    case 'harm':
      if (foe !== undefined) return `有人把${place}那件事讲成了另一个版本 —— 在那个版本里，先动手的是你。现在已经有人信了。`;
      if (item !== undefined) return `「${item}」不见了。你甚至想不起最后一次拿它是什么时候 —— 那正是他们想要的效果。`;
      return strikeTextOf(kind);
    case 'use':
      return `你替他把那件事做完了。做完之后你才看明白：从一开始，需要那件事发生的就不是你 —— 是${place}的另一头。`;
    case 'deceive':
      return item !== undefined
        ? `你照着那条关于「${item}」的线索走到底，才发现整条线索都是给人准备的 —— 包括你。`
        : strikeTextOf(kind);
    case 'infiltrate':
      return facts.churchName !== undefined
        ? `${facts.churchName}里开始有人按别人的意思说话。而他们看起来还是他们。`
        : strikeTextOf(kind);
    case 'subvert':
      return `你赖以为生的那件事不成立了 —— 而这不是意外。你回头去看，每一步都有人铺过。`;
    case 'harvest':
      return `你身上少的那部分，不是丢的，是**被取走的** —— 而你连什么时候被取的都想不起来。`;
  }
}
