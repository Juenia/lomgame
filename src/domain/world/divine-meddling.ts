/**
 * **玩家插手神明的阴谋**（M2.169）—— 纯函数。
 *
 * 用户口径：「要刺激感」。这一层的三个刺激点都是机制，不是文案：
 *
 * ```
 * ① 两条相反的路   inform 告密（帮目标）/ aid 助推（帮发起者）—— 选了就站了队
 * ② 会被发现       success 与 exposed 是**两次独立判定**：
 *                  做成了也可能被发现，被发现了也不一定没做成
 * ③ 代价是真的     被发现 ⇒ 对面直接报复（邪神降罚 / 教会通缉）——
 *                  不是「好感 -5」，而是**你要挨一下**
 * ```
 *
 * ## 数值口径（项目设计 —— 原作没写，量级照着「高序列更稳」）
 *
 * ```
 * 做成概率 0.60 + 0.03 ×（9 − 序列）     序列 9 → 0.60 · 序列 1 → 0.84
 * 被发现   0.35 − 0.03 ×（9 − 序列）     序列 9 → 0.35 · 序列 1 → 0.11
 * ```
 *
 * 于是低序列玩家插手是**真的危险**（三成半会被抓），而高序列可以反复出手 ——
 * 但那两位神也不会一直看不见（暴露度会累积到那一局上）。
 */
import type { Rng } from '../character/types.ts';

export const MEDDLE_SIDES = ['inform', 'aid'] as const;
export type MeddleSide = (typeof MEDDLE_SIDES)[number];

export const MEDDLE_SIDE_LABELS: Readonly<Record<MeddleSide, string>> = {
  inform: '告密',
  aid: '助推',
};

/** 插手一次的结果 */
export interface MeddleOutcome {
  /** 有没有做成（告密 = 把消息递到了；助推 = 那件事办了） */
  success: boolean;
  /** 有没有被发现是你（**这一下是真的会挨报复的**） */
  exposed: boolean;
  /** 玩家读到的那一段 */
  note: string;
}

export function meddleChance(sequence: number): { success: number; exposed: number } {
  const edge = Math.max(0, 9 - Math.max(0, Math.min(9, sequence)));
  return {
    success: Math.min(0.9, 0.6 + 0.03 * edge),
    exposed: Math.max(0.05, 0.35 - 0.03 * edge),
  };
}

export function meddleOutcome(input: { side: MeddleSide; sequence: number; rng: Rng }): MeddleOutcome {
  const chance = meddleChance(input.sequence);
  const success = input.rng.next() < chance.success;
  const exposed = input.rng.next() < chance.exposed;
  const lines: string[] = [];
  if (input.side === 'inform') {
    lines.push(success
      ? '你把知道的那件事递了进去 —— 有人听见了。'
      : '你在门口等了很久，最后没能把话递到该听的人耳朵里。');
  } else {
    lines.push(success
      ? '你替祂把那件事办了。办得很干净 —— 干净得让你自己有点发冷。'
      : '你伸手了，但没办成 —— 而这件事本来不该有人伸手。');
  }
  if (exposed) {
    lines.push(input.side === 'inform'
      ? '⚠️ 更糟的是：那位动手的存在**知道是你**。'
      : '⚠️ 更糟的是：那位被图谋的存在**知道是你**。');
  }
  return { success, exposed, note: lines.join('\n') };
}

/** 插手对那一局的影响（暴露度与进度） */
export function meddleEffect(input: { side: MeddleSide; success: boolean }): {
  exposure: number;
  /** 推进多少天（正数 = 让陨落来得更快） */
  accelerateDays: number;
} {
  if (input.side === 'inform') {
    // 告密：把这一局往「被察觉」推 —— 成了就 +30，没成也留了点痕迹
    return { exposure: input.success ? 30 : 10, accelerateDays: 0 };
  }
  // 助推：直接把时间表往前拽（成了拽 30 天，没成 10 天）
  return { exposure: input.success ? 0 : 10, accelerateDays: input.success ? 30 : 10 };
}

/** 被发现之后的报复（玩家读到的那一句，机制在命令层落） */
export function revengeLineOf(side: MeddleSide, godName: string): string {
  return side === 'inform'
    ? godName + '记住了你 —— 而祂不喜欢有人在祂的事上多嘴。'
    : godName + '记住了你 —— 而祂的人已经在路上了。';
}

/**
 * **他在那一局里的分量**（M2.169 修正 —— 起因是用户那一问：「多位玩家参与了怎么算？」）。
 *
 * ## 为什么不能人人有份
 *
 * 序列 0 是**唯一**的（一条途径只有一个位置）。如果一场陨落给每个插手者都记一笔，
 * 那十个玩家在一场阴谋上各伸一次手，就批量产出了十份成神资格 ——
 * 而这个世界里那个位置只有一个。
 *
 * ## 规则（三条，都可解释）
 *
 * ```
 * ① **告密不算**          它是**阻止**陨落，不是导致 —— 那一位会记你的好，但没有这一份分
 * ② 助推成功 = 10 − 序列   序列 1 的介入 = 9 分，序列 9 = 1 分（强者的手笔更重）
 * ③ **第一个动手的 +3**    先伸手的人承担最大的风险（被发现时最先挨的就是他）
 * 失败 = 1 分              留下痕迹，但不足以拿首功
 * ```
 *
 * 结算时按分排名，**只有第一名**算「在自身参与之事导致一位神灵陨落」。
 * 其余人拿**次功** —— 发起者的赏赐、播报里被提到，但不成神。
 */
export function contributionOf(input: {
  side: MeddleSide;
  success: boolean;
  sequence: number;
  /** 他是不是这一局**第一个**插手的 */
  first: boolean;
}): number {
  if (input.side === 'inform') return 0;
  if (!input.success) return 1;
  const base = Math.max(1, 10 - Math.max(0, Math.min(9, input.sequence)));
  return base + (input.first ? 3 : 0);
}

/**
 * **谁拿到首功**（并列时**先动手的优先** —— 他先承担了风险）。
 *
 * 返回 null = 这一局没有任何人促成它（比如所有插手者都是告密者）——
 * 那这场陨落**不算任何人的**。诚实：没人推，它自己掉下来的。
 */
export function firstCreditOf(
  rows: readonly { characterId: string; score: number; at: number }[],
): string | null {
  const sorted = [...rows].sort((a, b) => b.score - a.score || a.at - b.at);
  const top = sorted[0];
  return top === undefined || top.score <= 0 ? null : top.characterId;
}

/** 玩家读到的那一句（`.神战` 的账本用它） */
export function creditLineOf(input: {
  /** 他在这一局里的排名（1 = 首功） */
  rank: number;
  total: number;
  score: number;
}): string {
  if (input.total <= 1) return '那一局只有你伸了手（分量 ' + input.score + '）。';
  if (input.rank === 1) return '那一局伸过手的有 ' + input.total + ' 个人 —— 而**分量最重的是你**。';
  return '那一局伸过手的有 ' + input.total + ' 个人 —— 你排第 ' + input.rank + '（分量 ' + input.score + '）。';
}
