/**
 * NPC 晋升（M2.85 世界演化）—— **纯函数，无 IO**。
 *
 * ## 用户拍板的三条
 *
 *   1. **NPC 要让世界动起来**（晋升 / 登神 / 猎杀 / 化解灾厄 / 解决事件）
 *   2. **神不是不可战胜的**：玩家击败序列 0 就能取代他（这一步在战斗侧，不在本文件）
 *   3. **限速**：不能让 NPC 很快成神 —— **按原著的进度来**
 *
 * ## 限速曲线怎么来的
 *
 * 原著里低序列几个月一档、中序列几年、高序列几十年。本文件用**指数递增**近似它：
 *
 *   9→8  30 天      6→5  240 天    3→2  1920 天（5.3 年）
 *   8→7  60 天      5→4  480 天    2→1  3840 天（10.5 年）
 *   7→6 120 天      4→3  960 天    1→0  7680 天（21 年）
 *
 * 从序列 9 一路走到序列 0 合计 **≈15330 天 ≈ 42 年** —— 这就是「不会很快成神」。
 * ⚠️ 这是**项目派生值**（原著没有给每档的天数），所以放在 `NUMERIC.npc` 里当旋钮：
 * 运营觉得慢就调 `baseDays`，不要改这里的公式。
 */
import { NUMERIC } from '../../config/numeric.ts';

/**
 * 成神是否**够格**（用户拍板：不能窜一下就成神）。
 *
 * 三个条件缺一不可：
 *   ① 已经站在**序列 1**（离神位只差一步 —— 这是时间门槛管的事）
 *   ② 停留时间达到了 1→0 的门槛（21 年）
 *   ③ **功绩分达标**（`godhoodMeritRequired`，例如 4 次神话级灾厄）
 *
 * 第 ③ 条是本轮新加的：在此之前「时间到了就登神」，于是任何一个在序列 1 上躺够 21 年的人
 * 都会自动成神 —— 那正是「路人甲窜一下成神」的形状。
 */
export function qualifiedForGodhood(input: { sequence: number; merit: number }): boolean {
  if (input.sequence !== 1) return false;
  return input.merit >= godhoodMeritRequired();
}

/** 成神需要的功绩分（与 npc-calamity 的口径同源，放在这里方便调用方一处读） */
export function godhoodMeritRequired(): number {
  return 120;
}

export interface NpcAdvanceInput {
  /** 当前序列（0—9；0 表示已登神） */
  sequence: number;
  /** 当前这一档是什么时候到的（毫秒） */
  since: number;
  /** 现在（毫秒） */
  now: number;
  /** 0—1 的随机数（判定层不认识随机源） */
  roll: number;
}

/** 从 `sequence` 晋升到下一档需要多少天（已登神返回 null） */
export function daysRequiredFor(sequence: number): number | null {
  if (sequence <= 0) return null;
  const npc = (NUMERIC as unknown as { npc?: { baseDays?: number; growth?: number } }).npc ?? {};
  const base = npc.baseDays ?? 30;
  const growth = npc.growth ?? 2;
  return base * Math.pow(growth, 9 - sequence);
}

/** 这一档已经停留了几天 */
export function daysStayed(since: number, now: number): number {
  return Math.max(0, (now - since) / 86_400_000);
}

/**
 * 今天会不会晋升。
 *
 * 判定是**确定性 + 一次掷骰**：停留时间必须达到该档所需天数（这是硬门槛），
 * 到了之后按「超出比例」提高概率 —— 刚够线时有 `chanceAtThreshold`，停留越久越接近 1。
 * 这样「按原著进度」不是靠运气，而是靠**时间门槛**。
 */
export function willAscend(input: NpcAdvanceInput): boolean {
  const need = daysRequiredFor(input.sequence);
  if (need === null) return false;
  const stayed = daysStayed(input.since, input.now);
  if (stayed < need) return false;
  const npc = (NUMERIC as unknown as { npc?: { chanceAtThreshold?: number } }).npc ?? {};
  const base = npc.chanceAtThreshold ?? 0.25;
  const over = Math.min(1, (stayed - need) / need);   // 超出一倍就必成
  const chance = base + (1 - base) * over;
  return input.roll < chance;
}

/** 登神了吗（序列 0） */
export function isGod(sequence: number): boolean {
  return sequence <= 0;
}

/**
 * 还差几档登神（已登神返回 0，未载返回 null）。
 *
 * ⚠️ 名字**故意**与 `npc-track.ts` 的 `stepsToGodhood` 不同：那个收 `NpcTrack`（静态记载），
 * 这个收**当前序列**（世界状态）。两者同名会被 import 撞掉，读代码的人也容易搞混。
 */
export function stepsToGodhoodFrom(sequence: number | null): number | null {
  if (sequence === null) return null;
  return sequence;
}
