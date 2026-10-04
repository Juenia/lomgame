/**
 * **神位争夺**（M2.170）—— 用户口径：「神位得竞争本来就是残酷的」。
 *
 * M2.169 让阴谋能把一位神推下去；这一层管**那个空位之后的事**。
 *
 * ## 为什么必须残酷（原作的两条硬设定）
 *
 * ```
 * ① 序列 0 是**唯一**的 —— 一条途径只有一个位置：没有并列，没有共享，没有第二
 * ② 序列越高越受「最初」的意志影响 —— 站上去这件事本身就是在被啃
 * ```
 *
 * ## 三条残酷的落点（都是机制，不是文案）
 *
 * ```
 * ① **公开**   登位要 7 天，而这 7 天他必须待在灰雾之上 —— 所有人都看得见他在做什么
 * ② **脆弱**   期间每天被神性侵蚀（理智 +6/天）；7 天下来 42 点 —— 掉了就可能失控
 * ③ **可被杀** 其他够格的人可以直接上来打断他：那不是抢分，**那是杀人**
 * ```
 *
 * 而如果仪式断了，那个位置**不会等他** —— 它继续空着（或者被别的势力拿走）。
 */
import type { ThroneState } from './divine-throne.ts';

/** 登位要撑多少天（公开的、脆弱的 7 天） */
export const THRONE_RITE_DAYS = 7;

/** 仪式期间每天被侵蚀多少理智（序列 0 的位置在啃他） */
export const THRONE_RITE_MAD_PER_DAY = 6;

export const CONTEST_STATUSES = ['rite', 'settled', 'lapsed'] as const;
export type ContestStatus = (typeof CONTEST_STATUSES)[number];

export interface ThroneContest {
  pathway: string;
  status: ContestStatus;
  claimantId: string;
  /** 后来的争位者（对撞）—— 他们不是「打断者」，是**也上来了的人** */
  rivals: string[];
  /** 已经往后拖过几次（拖满就两败俱伤） */
  extensions: number;
  startedAt: number;
  endsAt: number;
  brokenBy: string;
  note: string;
}

/**
 * **他够不够格去坐那个位置**（四道闸，每一条都回答一个具体的问题）。
 *
 * ⚠️ 与 `canChallengeGod` 的分工：那一条问「你敢不敢去打祂」，
 * 这一条问「**祂不在了，轮不轮得到你**」—— 后者更严。
 */
export function canClaimThrone(input: {
  sequence: number;
  /** 他这辈子拿过几次首功（推下去过几位神）—— M2.169 那本账 */
  firstCredits: number;
  /** 那条途径的座位现在什么状态 */
  seatState: ThroneState;
  /** 现在有没有人正在上面（仪式中） */
  claimantId: string;
  me: string;
}): { ok: boolean; clash?: boolean; reason?: string } {
  if (input.seatState !== 'vacant') {
    return { ok: false, reason: '那个位置还有人 —— 或者它被封住了。空位才谈得上坐。' };
  }
  if (input.sequence > 1) {
    return { ok: false, reason: '你的序列还差得远。想坐上那个位置，至少要先站到序列 1。' };
  }
  if (input.firstCredits <= 0) {
    return {
      ok: false,
      reason: '你没有把任何一位从那个位置上推下来过 —— 那个位置不认旁观的人。',
    };
  }
  if (input.claimantId !== '' && input.claimantId !== input.me) {
    /*
     * ⚠️ **这里不拒绝他** —— 第一版写的是「已经有人先上去了，你只能去打断他」。
     * 但那样只覆盖了一半：后来者完全可以**也上去**，于是两个人同时在灰雾之上，
     * 而那个位置只坐得下一个。那才是「神位竞争本来就是残酷的」的完整形状。
     *
     * 返回 `clash: true` = 这一上去就是**对撞**（仪式更久、侵蚀加倍、到期不作数）。
     */
    return { ok: true, clash: true };
  }
  return { ok: true };
}

/** 仪式还剩几天（0 = 随时可能落地） */
export function daysLeftOf(contest: ThroneContest, now: number): number {
  return Math.max(0, Math.ceil((contest.endsAt - now) / 86_400_000));
}

/**
 * **仪式期间的侵蚀**：站得越高，啃得越狠。
 *
 * 这一条是「脆弱」的落点：7 天下来 42 点理智 —— 原本理智高的人可能撑住，
 * 已经在边缘的人会在最后一天失控（而失控的后果比失败重得多）。
 */
export function riteStrain(sequence: number, claimants = 1): number {
  const base = sequence <= 0
    ? THRONE_RITE_MAD_PER_DAY + 4
    : sequence === 1 ? THRONE_RITE_MAD_PER_DAY : 0;
  // 对撞时神性只有一份，而两个人在抢它 —— 侵蚀加倍
  return base * strainMultiplier(claimants);
}

/** 打断的判定：他打断了别人，自己也要付出代价（灰雾之上动手，两边都掉理智） */
export const INTERRUPT_MAD_COST = 8;

/**
 * **仪式断了之后**（被打断 / 他死了 / 自己放弃）。
 *
 * 位置继续空着 —— 但 `brokenBy` 会写下来：这件事有人做了，而世界记得。
 */
export function lapseContest(input: { brokenBy: string; note: string }): { status: ContestStatus; brokenBy: string; note: string } {
  return { status: 'lapsed', brokenBy: input.brokenBy, note: input.note };
}

/** 玩家读到的那一句 */
export function contestLineOf(input: {
  pathwayName: string;
  contest: ThroneContest | null;
  claimantName: string;
  now: number;
}): string {
  const contest = input.contest;
  if (contest === null || contest.status !== 'rite') {
    return input.pathwayName + '的位置空着 —— 而**空着的位置不会一直空着**。';
  }
  return input.pathwayName + '的位置上，' + (input.claimantName === '' ? '有人' : input.claimantName) +
    '正在往上坐（还剩 ' + daysLeftOf(contest, input.now) + ' 天）。' +
    '这段时间里他下不来 —— 而所有人都知道他在那儿。';
}

/* ===== M2.170 续：**对撞**（两个人同时争同一个位置）===== */

/** 最多拖几次（拖满就两败俱伤 —— 世界上不能有永久的仪式） */
export const THRONE_CLASH_MAX_EXTENSIONS = 3;

/** 每拖一次往后推几天 */
export const THRONE_CLASH_EXTENSION_DAYS = 3;

/**
 * **对撞时的仪式时长**（人越多越久）。
 *
 * 理由是可解释的：那个位置只有一份，两个人一起往上坐，谁也坐不实。
 * 1 人 7 天 · 2 人 12 天 · 3 人 17 天 —— 人数每多一个就多 5 天。
 */
export function riteDaysFor(claimants: number): number {
  return claimants <= 1 ? THRONE_RITE_DAYS : THRONE_RITE_DAYS + (claimants - 1) * 5;
}

/**
 * **对撞时的侵蚀倍率**：神性只有一份，而两个人在抢它。
 *
 * ⚠️ 这一条是「争神位的人可能先变成怪物」的落点 ——
 * 侵蚀加倍之后，理智在边缘的人会在仪式里失控（接 M2.167 的堕落生物）。
 */
export function strainMultiplier(claimants: number): number {
  return claimants <= 1 ? 1 : 2;
}

/** 这一局有几个人在争（第一个 + 后来的） */
export function claimantsOf(contest: ThroneContest): string[] {
  return contest.rivals.length === 0 ? [contest.claimantId] : [contest.claimantId, ...contest.rivals];
}

/** 对撞中？（两个以上的人在争同一个位置） */
export function inClash(contest: ThroneContest): boolean {
  return contest.rivals.length > 0;
}

/**
 * **到期了，但还算不算数**。
 *
 * 这是对撞里最残酷的一格：**只要还有别人在争，到期不作数** ——
 * 时间表往后拖，而两个人都继续被啃。唯一的出路是把对方逼死或逼退。
 *
 * 拖满 `THRONE_CLASH_MAX_EXTENSIONS` 次 ⇒ 两败俱伤（位置继续空着）。
 */
export function settleOrExtend(input: { contest: ThroneContest; now: number }): {
  /** settle = 上位；extend = 往后拖；stalemate = 两败俱伤 */
  kind: 'settle' | 'extend' | 'stalemate';
  endsAt: number;
  note: string;
} {
  const contest = input.contest;
  if (!inClash(contest)) {
    return { kind: 'settle', endsAt: contest.endsAt, note: '' };
  }
  if (contest.extensions >= THRONE_CLASH_MAX_EXTENSIONS) {
    return {
      kind: 'stalemate',
      endsAt: contest.endsAt,
      note: '两个人都没能熬过对方 —— 那个位置继续空着。',
    };
  }
  return {
    kind: 'extend',
    endsAt: input.now + THRONE_CLASH_EXTENSION_DAYS * 86_400_000,
    note: '还有人在争 —— 这一局不算数。',
  };
}

/** 玩家读到的那一句（对撞时） */
export function clashLineOf(input: { pathwayName: string; names: readonly string[]; daysLeft: number }): string {
  if (input.names.length <= 1) return '';
  return '**有两个人在争同一个位置**（' + input.names.join('、') + '）—— 而那个位置只坐得下一个。' +
    '还剩 ' + input.daysLeft + ' 天，而只要还有人在争，到期就不算数。';
}
