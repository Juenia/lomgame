/**
 * M2.38 任务 2 / 5：**DIG 阶梯的守卫**。
 *
 * ## 它守的不是「值等于几」，是三条**设计约束**
 *
 * | # | 约束 | 为什么 |
 * | --- | --- | --- |
 * | ① | **严格递增** | DIG 不重置（resolvePromotion 的 deltas 只有 sequence/mad/cor）⇒ 门槛不递增的那几档**恒真**（K14） |
 * | ② | **不越过 95** | P4 的封顶口径：不要求满值（100 是 clamp 上限，98/99 等于要求满值） |
 * | ③ | **[9] / [8] 不动** | 它们与实测吻合（序列 8 停留 5 天、DIG 涨 20.8）—— 动了会推翻 M2.18 E2 的校准 |
 *
 * ## 值的依据在文档里，不在这里
 *
 * docs/M2.38-digLadder.md 记着曲线的来源与「量程不够」的算术。
 * 这份文件只保证**改值的人不会把设计约束改坏**。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { NUMERIC } from '../src/config/numeric.ts';

/**
 * DIG 自然增速（**实测**：docs/M2.38-digLadder.md §1.3）。
 *
 *     m234b（200x30）：序列 9 = 3.49/天、序列 8 = 4.16/天
 *     m229a1（50x30）：序列 9 = 3.13/天、序列 8 = 3.06/天
 *
 * 四组读数落在 3.06—4.16，取 3.6 当基准。
 */
const DIG_PER_DAY = 3.6;

const ladder = NUMERIC.promotion.digLadder as Record<number, number>;
/** 从强到弱（序列号递减 = 门槛递增） */
const SEQS = [9, 8, 7, 6, 5, 4, 3, 2, 1];

test('M2.38 任务 2 ①：DIG 阶梯**严格递增** —— 消除恒真门槛', () => {
  for (const seq of SEQS) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(ladder, seq),
      'DIG 阶梯缺 seq ' + seq + ' 的键（K19：不留空）',
    );
  }
  for (let seq = 8; seq >= 1; seq -= 1) {
    assert.ok(
      ladder[seq]! > ladder[seq + 1]!,
      '阶梯在 ' + seq + '/' + (seq + 1) + ' 处没有递增（' + ladder[seq] + ' vs ' + ladder[seq + 1] + '）' +
        ' —— 序列号越小门槛越高，所以 [' + seq + '] 必须**大于** [' + (seq + 1) + ']；' +
        '不满足时序列 ' + (seq + 1) + ' 的人必然已经够到序列 ' + seq + ' 的门槛，那一档**恒真**（K14）',
    );
  }
});

test('M2.38 任务 2 ②：不越过 95 的封顶（P4 口径：不要求满值）', () => {
  for (const seq of SEQS) {
    assert.ok(
      ladder[seq]! <= 95,
      '序列 ' + seq + ' 的门槛 ' + ladder[seq] + ' 越过了 P4 的封顶 95 —— 98/99 等于要求满值',
    );
  }
});

test('M2.38 任务 2 ③：第 9 与第 8 档不动（它们与实测吻合）', () => {
  assert.equal(ladder[9], 60, '[9] = 60 是入门档；实测序列 9 停留 20 天，DIG 不是它的瓶颈');
  assert.equal(ladder[8], 80, '[8] = 80 与实测吻合（序列 8 停留 5 天、DIG 涨 20.8）—— M2.18 E2 校准过的值');
  assert.equal(ladder[9], NUMERIC.promotion.digThreshold);
  assert.equal(ladder[8], NUMERIC.sequence7.digThreshold);
});

test('M2.38 任务 2：每档的**停留代价**与曲线相符（0.3—2 天）', () => {
  /*
   * 判据：(ladder[N] − ladder[N+1]) / DIG_PER_DAY 是这一档买到的**停留天数**。
   * 量程的算术上界是 0.9 天/档（docs/M2.38-digLadder.md §二），
   * 下界给 0.3 天是为了挡住「+1 点」那种几乎没有意义的增量。
   *
   * ⚠️ **从 [7] 起算，不含 [9] → [8]** —— 那一档是**入门**（20 点 = 5.6 天，
   * 与实测「序列 8 停留 5 天」吻合），它本来就该比后面每一档都大。
   */
  for (let seq = 7; seq >= 1; seq -= 1) {
    const gain = ladder[seq]! - ladder[seq + 1]!;
    const days = gain / DIG_PER_DAY;
    assert.ok(
      days >= 0.3 && days <= 2,
      '序列 ' + seq + ' 那一档只值 ' + days.toFixed(2) + ' 天（增量 ' + gain +
        ' 点）—— 太小等于没有门槛，太大说明越过了量程',
    );
  }
});

test('M2.38 任务 2：**量程的算术** —— 六档加起来买不到一周', () => {
  /*
   * 这条不是装饰：它把「DIG 阶梯做不到按天数挡人」这件事**钉成一个可执行的断言**。
   * 若哪天有人把 [9] 从 60 降下来（给高序列腾量程），这条会红 —— 那正是它该有的样子
   *（那时要重算 §二 的算术，而不是顺手改个值）。
   */
  // 序列 7 以下的可用量程 = [8]（8→7 的门槛）到 [1]（1→0 的门槛）
  const budget = ladder[1]! - ladder[8]!;
  assert.ok(
    budget <= 20,
    '序列 7 以下的可用量程是 ' + budget + ' 点 —— 若大于 20，说明 [9]/[8] 动了，' +
      'docs/M2.38-digLadder.md §二 的算术要重算',
  );
  const days = budget / DIG_PER_DAY;
  assert.ok(days < 7, '六档合计只买到 ' + days.toFixed(1) + ' 天 —— 这就是「DIG 不是难度杠杆」的量化依据');
});

test('M2.38 任务 5：第 2 / 第 1 档已定下界，且仍遵守前面三条约束', () => {
  assert.ok(ladder[2]! > ladder[3]!, '[2] 必须大于 [3]（否则恒真门槛在 3→2 处复发）');
  assert.ok(ladder[1]! > ladder[2]!, '[1] 必须大于 [2]');
  assert.ok(ladder[1]! <= 95, '批次 C 若要往下排，只能在 ' + ladder[1]! + ' 之上（且不超过 95）');
});

test('M2.38 任务 2（K23 反向用例）：判据**抓得住**一条平的阶梯', () => {
  /*
   * K23：新增判据时先用「**已知会失败**」的输入试一次。
   * 这里的「已知会失败」= **M2.38 之前那张表**（[4] 以下全是 95）——
   * 同一个判据必须把它报出来；报不出来就说明它是装饰（K14）。
   */
  const offenders = (table: Record<number, number>): string[] => {
    const bad: string[] = [];
    for (let seq = 8; seq >= 1; seq -= 1) {
      if (table[seq]! <= table[seq + 1]!) bad.push(String(seq));
    }
    return bad;
  };
  const legacy = { 9: 60, 8: 80, 7: 85, 6: 90, 5: 95, 4: 95, 3: 95, 2: 95, 1: 95 };
  assert.deepEqual(offenders(legacy), ['4', '3', '2', '1'], '旧的「95x5」有**四档**恒真 —— 判据必须全报出来');
  assert.deepEqual(offenders(ladder), [], '当前的阶梯不该有任何一档恒真');
});
