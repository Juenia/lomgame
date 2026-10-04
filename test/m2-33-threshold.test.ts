/**
 * M2.33 任务 0/1：**P5 落地 —— 失控闸门按序列**。
 *
 * 拍板原文（`docs/M2.28-拍板清单.md` P5，A 方案）：
 *
 *     9—7 冻结 65/65，6—4 → 60，3—1 → 55，0 → 50
 *
 * M2.33 任务 0 的现场读数：在那之前闸门是**全局一份**（`madThreshold` / `corThreshold`），
 * `computeLossOfControlProbability` 直接读它 —— **不分序列**，所以 P5 从未落地。
 *
 * ## 「9—7 冻结」这四个字是这条拍板里最重要的一半
 *
 * 65 是 M2.1 用实测分布回灌校准出来的（`docs/M2-失控重定报告.md`），而 **9—7 是跑批里
 * 唯一真实出现过的序列段** ⇒ 改它等于让所有历史跑批读数失锚。所以 9—7 必须与现值同值，
 * 本文件第 1 条用例就守这件事。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NUMERIC } from '../src/config/numeric.ts';
import {
  computeLossOfControlProbability,
  lossOfControlThresholdFor,
  rollLossOfControl,
} from '../src/domain/character/rules.ts';

const table = NUMERIC.lossOfControl.thresholdBySequence as Record<number, { mad: number; cor: number }>;

test('M2.33：闸门表与 P5 拍板逐档一致，且 9—7 **冻结**在 M2.1 的现值', () => {
  const order = [9, 8, 7, 6, 5, 4, 3, 2, 1, 0];
  assert.deepEqual(
    order.map((sequence) => table[sequence]!.mad),
    [65, 65, 65, 60, 60, 60, 55, 55, 55, 50],
    'P5 A 方案（MAD）：9—7 冻结 65，6—4 → 60，3—1 → 55，0 → 50',
  );
  assert.deepEqual(
    order.map((sequence) => table[sequence]!.cor),
    [65, 65, 65, 60, 60, 60, 55, 55, 55, 50],
    'P5 A 方案（COR）：与 MAD 同档（但结构上分成两个数，见下）',
  );
  // 两个全局字段是「9—7 那一档」的历史落点，必须与表同值（否则两处存同一件事、没有守卫）
  assert.equal(NUMERIC.lossOfControl.madThreshold, table[9]!.mad, 'madThreshold 就是序列 9 那一档的 MAD');
  assert.equal(NUMERIC.lossOfControl.corThreshold, table[9]!.cor, 'corThreshold 就是序列 9 那一档的 COR');
  /*
   * M2.33：每一档是 `{ mad, cor }` **两个数**，不是一个数 ——
   * `scripts/m21-sweep.ts` 扫的就是 mad × cor × divisor 三维，扫参能力不能在这一轮丢掉。
   * P5 拍的方案里两者同值，但结构必须能分开（下次想只调 COR 不用改类型）。
   */
  assert.notEqual(
    typeof table[9],
    'number',
    '档位必须是 { mad, cor } 对象 —— 退化成单值就丢掉 mad/cor 分开扫参的能力',
  );
  // 死循环的尺子**不跟着闸门走**（跨版本比同一个指标要用同一把尺）
  assert.equal(NUMERIC.lossOfControl.deadlockMadThreshold, 80);
  assert.equal(NUMERIC.lossOfControl.deadlockCorThreshold, 70);
});

test('M2.33（直验）：同样的 MAD/COR，序列越高概率越高 —— 这就是「第三重意义」', () => {
  const state = { mad: 75, cor: 75 };
  const high = computeLossOfControlProbability({ ...state, sequence: 9 });
  const mid = computeLossOfControlProbability({ ...state, sequence: 5 });
  const top = computeLossOfControlProbability({ ...state, sequence: 0 });
  assert.ok(high < mid && mid < top, '序列 9 < 5 < 0：越接近神性越容易失控（P5 的设计意图）');
  // 逐档算式可复核（铁律 11：数字要能从库里/式子复算）
  const divisor = NUMERIC.lossOfControl.divisor;
  assert.equal(high, ((75 - 65) + (75 - 65)) / divisor);
  assert.equal(mid, ((75 - 60) + (75 - 60)) / divisor);
  assert.equal(top, ((75 - 50) + (75 - 50)) / divisor);
});

test('M2.33（硬闸门也按序列）：序列 9 的人不掷骰子，序列 6 的人掷', () => {
  /*
   * 这一条守的是「两处门槛必须同源」：概率公式按序列取、硬闸门却读全局的话，
   * 会出现「闸门说没风险、公式说 0.04」这种自相矛盾的状态。
   */
  const always = { next: () => 0 };
  const mad = 62; // 高于序列 6—4 的 60，低于序列 9—7 的 65
  assert.equal(rollLossOfControl({ mad, cor: 0, sequence: 9 }, always), false, '序列 9 的闸门是 65 ⇒ 连骰子都不掷');
  assert.equal(rollLossOfControl({ mad, cor: 0, sequence: 5 }, always), true, '序列 5 的闸门是 60 ⇒ 过闸门，掷出 0 必触发');
  assert.equal(
    computeLossOfControlProbability({ mad, cor: 0, sequence: 9 }),
    0,
    '未过闸门时概率必须是 0 —— 硬闸门与公式同源',
  );
  assert.ok(computeLossOfControlProbability({ mad, cor: 0, sequence: 5 }) > 0);
});

test('M2.33：普通人（sequence = null）按最低序列那一档读 —— 行为与 M2.1 一致', () => {
  /*
   * 普通人没有序列，但也**没有往上走过** ⇒ 落在最低那一档（= 9—7 = 65）。
   * 这不是「兜底默认值」：`null` 在这里有确切语义，而且它落在**冻结**的那一档上，
   * 所以普通人的失控行为与接线前**逐位相同**。
   */
  assert.equal(lossOfControlThresholdFor(null).mad, 65);
  assert.equal(lossOfControlThresholdFor(null).cor, 65);
  assert.deepEqual(lossOfControlThresholdFor(null), lossOfControlThresholdFor(9));
  const state = { mad: 70, cor: 70 };
  assert.equal(
    computeLossOfControlProbability({ ...state, sequence: null }),
    computeLossOfControlProbability({ ...state, sequence: 9 }),
  );
});

test('M2.33：闸门表缺失键**报错**，不隐含一个默认档（K19）', () => {
  assert.throws(() => lossOfControlThresholdFor(10), /没有序列 10 的档/);
  assert.throws(() => lossOfControlThresholdFor(-1), /没有序列 -1 的档/);
  for (const sequence of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]) {
    assert.doesNotThrow(() => lossOfControlThresholdFor(sequence), '序列 ' + sequence + ' 必须有档');
  }
});

test('M2.33 对照侧（K9）：改表值，概率跟着变 —— 证明读的真是这张表', () => {
  const state = { mad: 75, cor: 75, sequence: 5 };
  const before = computeLossOfControlProbability(state);
  const original = table[5]!;
  try {
    table[5] = { mad: 65, cor: 65 }; // 把它抬回冻结档
    assert.equal(
      computeLossOfControlProbability(state),
      computeLossOfControlProbability({ mad: 75, cor: 75, sequence: 9 }),
      '改成 65 之后必须与序列 9 的结果一致',
    );
    assert.notEqual(computeLossOfControlProbability(state), before);
  } finally {
    table[5] = original;
  }
  assert.equal(computeLossOfControlProbability(state), before, '恢复之后回到原值');
});
