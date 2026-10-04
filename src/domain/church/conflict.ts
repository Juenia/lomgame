/**
 * 势力层争夺（M2.18 任务 B）—— **判定层纯函数，没有任何 IO、没有 rng**。
 *
 * ## 归属 = seed 底图 + 落库增量
 *
 *   churchTerritoryAt（M2.15，**不动**）  —— seed 派生的底图：某窗口这家教会在哪些地点
 *   church_territory_contest（本表）      —— 玩家行为留下的增量：谁在这个地点赢过几次
 *   本文件的 contestedOwnerAt()           —— 把两者合成「这里现在归谁」
 *
 * 这是铁律 5 的落地：底图仍然无状态（同 seed 同 t 同教会 → 同据点，补跑与逐格跑一致），
 * 被玩家改变的那一部分才是状态。**不要把整张图落库** —— 那会直接丢掉那条性质。
 *
 * ## 三个拍板（M2.18）
 *
 * 1. **单一归属**：一个地点至多一个主人（与 M2.6 的 factions 表同构：「一个地点一个势力」）。
 *    多头叠加那是**影响力**，不是归属，两者不该共用一个词。
 * 2. **只记胜者**：一次 PVP 胜利 +1，输家不记（见 0023 迁移的注释）。
 * 3. **平局维持底图**：Σ 最高者并列时不算翻转 —— 「说不清归谁」就不该给一个答案。
 */

import { NUMERIC } from '../../config/numeric.ts';

/** 一条增量（与 church_territory_contest 的一行同形） */
export interface ContestRow {
  locationId: string;
  winnerChurchId: string;
  delta: number;
}

/** 某地点某教会的累计（报告与回执都读它） */
export interface ContestTally {
  churchId: string;
  score: number;
}

/** 一个地点的归属 */
export interface TerritoryOwner {
  locationId: string;
  churchId: string;
  score: number;
}

/** 某地点各教会的 Σ delta（降序；调用方自己判阈值与平局） */
export function contestTally(contests: readonly ContestRow[]): ContestTally[] {
  const byChurch = new Map<string, number>();
  for (const row of contests) {
    byChurch.set(row.winnerChurchId, (byChurch.get(row.winnerChurchId) ?? 0) + row.delta);
  }
  return [...byChurch.entries()]
    .map(([churchId, score]) => ({ churchId, score }))
    .sort((a, b) => (b.score === a.score ? a.churchId.localeCompare(b.churchId) : b.score - a.score));
}

/**
 * 一个地点此刻归谁。
 *
 * 判据（三条，缺一不可）：
 *   1. Σ delta 最高者**唯一**（并列 → null，维持底图）；
 *   2. 它的 Σ **达到** `dominanceThreshold`；
 *   3. Σ 为正（一条都没赢过的人不该翻转任何东西）。
 */
export function contestedOwnerAt(
  locationId: string,
  contests: readonly ContestRow[],
  threshold: number,
): TerritoryOwner | null {
  const tally = contestTally(contests);
  const top = tally[0];
  if (!top) return null;
  if (top.score <= 0 || top.score < threshold) return null;
  // 平局：并列第一就不给答案（否则「这里归谁」取决于 Map 的遍历顺序）
  if (tally[1] && tally[1].score === top.score) return null;
  return { locationId, churchId: top.churchId, score: top.score };
}

/** 便捷版：阈值从 NUMERIC 取（命令层只关心「这里归谁」） */
export function ownerAt(locationId: string, contests: readonly ContestRow[]): TerritoryOwner | null {
  return contestedOwnerAt(locationId, contests, NUMERIC.church.conflict.dominanceThreshold);
}

/** 全部有归属的地点（回执与报告用） */
export function territoryOwners(
  contests: readonly ContestRow[],
  threshold: number,
): TerritoryOwner[] {
  const byLocation = new Map<string, ContestRow[]>();
  for (const row of contests) {
    const list = byLocation.get(row.locationId) ?? [];
    list.push(row);
    byLocation.set(row.locationId, list);
  }
  const owners: TerritoryOwner[] = [];
  for (const [locationId, rows] of byLocation) {
    const owner = contestedOwnerAt(locationId, rows, threshold);
    if (owner) owners.push(owner);
  }
  return owners.sort((a, b) => a.locationId.localeCompare(b.locationId));
}

/**
 * 每日衰减要写的那些条目（`runDailyTick` 逐条落库）。
 *
 * ## 作用域：**所有** contested location 的 Σ > 0 的教会，不只是未翻转的
 *
 * 两种口径的区别：
 *   - 只衰减未翻转的 → 地盘一旦易主就**永久稳定**（争夺变成一次性事件）；
 *   - 衰减全部的（**本版**）→ 已翻转的地盘每天掉 1 点，**天天有被翻回去的风险**。
 *
 * 取后者：争夺是**持续的**，不是打赢一次就盖章。阈值 5 的含义因此变成
 * 「领先者要保持 5 分以上的优势才守得住」—— 那正是「占上风」这个词的意思。
 */
/**
 * ⚠️ **观察项（M2.18 拍板三）**：`decayPerDay` 取 1 之后，「5 天掉回底图」——
 * 30 天窗口里的翻转次数需要实测才知道是设计意图还是过激。判定档位：
 *
 *   | 30 天翻转次数 | 判定 |
 *   | --- | --- |
 *   | 0 | 机制没生效（或量级不足），回头查触发条件与参数 |
 *   | 1—3 | 频率合适 |
 *   | 4—10 | 记录，看下一轮 |
 *   | > 10 | 衰减太快，调回 0.5（那时要把 delta 改成 REAL） |
 *
 * **m219 实测：翻转 0 次**（增量表 10 行、5 次敌对教会 PVP 胜利）——
 * 定性是「机制生效、量级不足」。参数扫描（docs/M2.18-参数扫描.md）证明：
 * **只算 PVP 时，任何阈值 × 任何衰减都是 0 次**；加上袭击（×1.5）也只有最松的三格翻 1 次。
 *
 * **拍定值：阈值 2 / 衰减 0.3 / 只加袭击**（M2.18 C+D）。
 *
 * ⚠️ **这一组参数贴着判定表的下沿，没有余量** —— 换一个 seed 很可能是 0 次。
 * 这不是「设计成功」，是「在现有量级下的最大可见度」。
 * 根因是**可争教会对数只有 1**（烈阳的途径未实现 → 只剩女神↔战神）。
 * M2.19 实现第二条途径之后（可争对数 → 3—4），阈值与衰减**要重扫一次**（30 秒，不跑批）。
 */
export function decayEntries(
  contests: readonly ContestRow[],
  decayPerDay: number,
): Array<{ locationId: string; winnerChurchId: string; delta: number }> {
  const byLocation = new Map<string, ContestRow[]>();
  for (const row of contests) {
    const list = byLocation.get(row.locationId) ?? [];
    list.push(row);
    byLocation.set(row.locationId, list);
  }
  const entries: Array<{ locationId: string; winnerChurchId: string; delta: number }> = [];
  for (const [locationId, rows] of byLocation) {
    for (const tally of contestTally(rows)) {
      // 只衰减正分：负分本来是「没赢过」，再减下去会变成翻不了身的负债
      if (tally.score <= 0) continue;
      entries.push({ locationId, winnerChurchId: tally.churchId, delta: -decayPerDay });
    }
  }
  return entries;
}
