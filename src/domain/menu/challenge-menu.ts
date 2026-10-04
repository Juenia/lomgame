/**
 * 挑战菜单（M2.11 方向 B）：**应战者在接受之前，先看清对面。**
 *
 * ## 为什么要有它
 *
 * M2.11 的前置 1（40 人 × 7 天不分片）测出：被挑战者的接受率 **43.8%**
 * （14 / 32 场可判定；另外 18 场里应战者**一次都没主动出招**，全程由系统超时代打）。
 * 按任务书 §2.3 的判定表，30%—50% 落在 **方向 B：给应战者信息优势**。
 *
 * 这一步同时修掉一个很具体的体验缺口：M2.10 里应战者收到的第一句话是
 * 「他朝你发起了挑战 —— 多回合的对战」，**却没有一个字告诉他对方有多强、还剩多少血**。
 * 他只能在被打之后才知道自己接了一场什么仗 —— 而 M2.8 起这个项目的原则是
 * **「看清了」本身就是一种力量**（感知分层）。
 *
 * ## 三个选项分别在说什么
 *
 * | 选项 | 语义 | 后果 |
 * | --- | --- | --- |
 * | 接受 | 「我接」 | 什么都不会变 —— 战斗本来就已经建立，他只是表了态 |
 * | 拒绝 | 「我不接」 | 这一场**没有输赢**地结束（不比认输差，也不比它好） |
 * | 认输 | 「你赢了，但你别通缉我」 | 自己判负（重伤 / AP 清空 / MAD +5），**对方不通缉** |
 *
 * ⚠️ 一处**如实记录的措辞偏差**：任务书 §2.2 的示例写的是
 * 「接受（你先看他出招，你先亮牌）」。而 M2.10 的异步形状是
 * **发起者先手、应战者后手**（先出招的人先亮牌，后手看完再选）——
 * 所以应战者是「先看他出招、**后**亮牌」。示例那句话前后半句互相矛盾，
 * 这里按实现的事实写：**他先出招，你看完再选**。信息优势是真的，先亮牌的不是应战者。
 */
import type { Menu } from './types.ts';

/**
 * 应战者看到的「发起者此刻长什么样」。
 *
 * 五项全部来自**公开可观察**的角色卡（血量 / 灵力 / 序列 / 伤势）——
 * 没有任何一项是隐藏数值：它们本来就是「站在你对面的人」看得见的东西。
 */
export interface ChallengeMenuInput {
  challengerName: string;
  challengerHp: number;
  challengerMaxHp: number;
  challengerMp: number;
  challengerMaxMp: number;
  /** 发起者的序列；null = 他还没有途径（普通人） */
  challengerSequence: number | null;
  /** 最多打几个回合（与 BATTLE.maxRounds 同值，由调用方传进来） */
  maxRounds: number;
}

/**
 * 「他此刻什么样」那一行。
 *
 * 单独一个函数是为了让它**只写一遍** —— 回执文本与将来的任何地方
 * （比如挑战被拒时给发起者看的回执）必须说同一句话。
 */
export function challengeGlanceLine(input: ChallengeMenuInput): string {
  const wound =
    input.challengerHp >= input.challengerMaxHp
      ? '没有伤'
      : '带着伤（HP 只有 ' + input.challengerHp + '）';
  const sequence =
    input.challengerSequence === null ? '还没有途径' : '序列 ' + input.challengerSequence;
  return (
    '你看到：HP ' +
    input.challengerHp +
    '/' +
    input.challengerMaxHp +
    ' · MP ' +
    input.challengerMp +
    '/' +
    input.challengerMaxMp +
    ' · ' +
    sequence +
    ' · ' +
    wound
  );
}

/**
 * 应战者的那一屏。
 *
 * 选项的 command 是**完整指令原文**（domain/menu/types.ts 的硬约束 2）——
 * 菜单只是入口，真正干活的是 .挑战 的三个新子命令。
 * 名字写在指令里（而不是靠「当前有一场挑战」的隐式状态），
 * 因为玩家的菜单可能在服务端重启后过期，而「我接受的是谁的挑战」必须一直说得清。
 */
export function buildChallengeMenu(input: ChallengeMenuInput): Menu {
  const title = '【挑战 · 来自 @' + input.challengerName + '】';
  const target = input.challengerName;
  return {
    title,
    context: [
      input.challengerName + ' → 你 —— 他想跟你打。',
      input.challengerName + '向你发起了挑战 —— 多回合的对战，最多 ' + input.maxRounds + ' 回合。',
      challengeGlanceLine(input),
      '',
      '看清楚再决定。他不会因为你拒绝就说你输。',
    ],
    options: [
      {
        key: '1',
        label: '接受',
        command: '挑战 @' + target + ' 接受',
        preview: '他先出招，你看完再选',
      },
      {
        key: '2',
        label: '拒绝',
        command: '挑战 @' + target + ' 拒绝',
        preview: '这一场没有输赢，他会知道',
      },
      {
        key: '3',
        label: '认输',
        command: '挑战 @' + target + ' 认输',
        preview: '自己判负 · 对方不通缉',
      },
    ],
    // 不接受自由输入：这一屏问的是「接不接」，不是一个可以随便回答的问题
    allowFreeform: false,
  };
}
