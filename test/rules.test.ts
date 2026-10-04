import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  LOSS_OF_CONTROL,
  PROMOTION,
  computeDigNext,
  computeLossOfControlProbability,
  computePromotionSuccess,
  lossOfControlCurve,
  rollLossOfControl,
} from '../src/domain/character/rules.ts';
import { createSeededRng } from '../src/domain/rng.ts';

/** DIG / 概率都是浮点，比较必须带容差 */
function closeTo(actual: number, expected: number, epsilon = 1e-9): void {
  assert.ok(
    Math.abs(actual - expected) < epsilon,
    `期望 ${expected}，实际 ${actual}`,
  );
}

test('消化度：权重按 0.6 / 0.3 / 0.1 / -0.5 结算', () => {
  closeTo(
    computeDigNext({ dig: 0 }, { matchScore: 1, exposure: 0, ritual: 0, pollutionPenalty: 0 }),
    0.6,
  );
  closeTo(
    computeDigNext({ dig: 10 }, { matchScore: 1, exposure: 1, ritual: 1, pollutionPenalty: 0 }),
    11,
  );
  closeTo(
    computeDigNext({ dig: 1 }, { matchScore: 0, exposure: 0, ritual: 0, pollutionPenalty: 1 }),
    0.5,
  );
});

test('消化度：上下界截断在 0—100', () => {
  closeTo(
    computeDigNext({ dig: 99 }, { matchScore: 1, exposure: 1, ritual: 1, pollutionPenalty: 0 }),
    100,
  );
  closeTo(
    computeDigNext({ dig: 0 }, { matchScore: 0, exposure: 0, ritual: 0, pollutionPenalty: 1 }),
    0,
  );
});

test('晋升成功率：公式与 5%—95% 限制', () => {
  closeTo(computePromotionSuccess({ dig: 100, sequence: 9, mad: 0, cor: 0 }), 0.9);
  closeTo(computePromotionSuccess({ dig: 50, sequence: 9, mad: 0, cor: 0 }), 0.8);
  // 序列 0、属性全崩 → 公式给 0.00，被下限抬到 0.05
  closeTo(computePromotionSuccess({ dig: 0, sequence: 0, mad: 100, cor: 100 }), PROMOTION.floor);
  // DIG 拉满且序列 9 → 0.90，未触顶
  assert.ok(computePromotionSuccess({ dig: 100, sequence: 9, mad: 0, cor: 0 }) < PROMOTION.ceil);
});

test('失控概率：阈值以下为 0，超过阈值后线性增长（M2.1 闸门 50/45）', () => {
  const Tm = LOSS_OF_CONTROL.madThreshold;
  const Tc = LOSS_OF_CONTROL.corThreshold;
  const divisor = LOSS_OF_CONTROL.divisor;
  // 公式形状自 W5 起没变：只统计「超出阈值的部分」；变的是闸门本身
  /*
   * M2.33（P5）：闸门改按序列取，`Tm`/`Tc` 现在是**序列 9—7 那一档**的值（65，冻结）。
   * `sequence: null` = 普通人 ⇒ 也落在同一档，所以这一条的期望值一个字没变。
   */
  const gate = { sequence: null };
  assert.equal(computeLossOfControlProbability({ mad: Tm, cor: Tc, ...gate }), 0, '刚好在阈值上不累积风险');
  assert.equal(computeLossOfControlProbability({ mad: Tm - 1, cor: Tc - 1, ...gate }), 0);
  assert.equal(computeLossOfControlProbability({ mad: Tm + 20, cor: Tc - 10, ...gate }), 20 / divisor, '只有 MAD 越线时看 MAD 的超出量');
  assert.equal(computeLossOfControlProbability({ mad: Tm - 10, cor: Tc + 20, ...gate }), 20 / divisor, '只有 COR 越线时看 COR 的超出量');
  closeTo(computeLossOfControlProbability({ mad: Tm + 15, cor: Tc + 20, ...gate }), 35 / divisor);
  closeTo(computeLossOfControlProbability({ mad: Tm + 30, cor: Tc + 40, ...gate }), 70 / divisor);
  assert.equal(computeLossOfControlProbability({ mad: 400, cor: 400, ...gate }), 1, '超出量足够大时被 clamp 到 1');
});

test('失控判定：未过闸门不判定，过闸门由 rng 决定', () => {
  const always = { next: () => 0 };
  const never = { next: () => 0.999999 };
  // M2.33（P5）：闸门按序列取；`sequence: null` = 普通人档（= 9—7 档 = 65）
  const below = { mad: LOSS_OF_CONTROL.madThreshold - 1, cor: LOSS_OF_CONTROL.corThreshold - 1, sequence: null };
  const above = { mad: LOSS_OF_CONTROL.madThreshold + 20, cor: LOSS_OF_CONTROL.corThreshold + 20, sequence: null };
  assert.equal(rollLossOfControl(below, always), false, '未过闸门连骰子都不掷');
  assert.equal(rollLossOfControl(above, always), true);
  assert.equal(rollLossOfControl(above, never), false);
});

test('随机源可复现：同种子同序列，不同种子不同序列', () => {
  const draw = (rng: { next(): number }): number[] => [rng.next(), rng.next(), rng.next()];
  assert.deepEqual(draw(createSeededRng('char-1:晋升:1000')), draw(createSeededRng('char-1:晋升:1000')));
  assert.notDeepEqual(draw(createSeededRng('char-1:晋升:1000')), draw(createSeededRng('char-1:晋升:1001')));
});

test('失控曲线取样用于调参取证（M2.1 重定：闸门 50/45、divisor=90）', () => {
  const curve = lossOfControlCurve([
    [LOSS_OF_CONTROL.madThreshold, LOSS_OF_CONTROL.corThreshold],
    [LOSS_OF_CONTROL.madThreshold + 20, LOSS_OF_CONTROL.corThreshold + 10],
    [100, 100],
  ]);
  // 1) 两个阈值点上概率必须为 0 —— 闸门是真的闸门
  assert.equal(curve[0]?.probability, 0, '阈值处必须为 0');
  // 2) 超出 20 / 10 时的概率就是 30/divisor
  closeTo(curve[1]?.probability ?? -1, 30 / LOSS_OF_CONTROL.divisor);
  // 3) 双满 100/100 时超出量 = (100-Tm) + (100-Tc)，必要时被 clamp 到 1
  const fullExcess = (100 - LOSS_OF_CONTROL.madThreshold) + (100 - LOSS_OF_CONTROL.corThreshold);
  assert.equal(curve[2]?.probability, Math.min(1, fullExcess / LOSS_OF_CONTROL.divisor));
  // 4) 闸门本身：M2.1 按实测分布回灌定（见 docs/M2-失控重定报告.md）
  assert.equal(LOSS_OF_CONTROL.divisor, 250, 'M2.1 定的终值，改动需同步更新 M2-失控重定报告.md');
  assert.equal(LOSS_OF_CONTROL.madThreshold, 65);
  assert.equal(LOSS_OF_CONTROL.corThreshold, 65);
  // 5) 死循环尺子是固定的，不跟着闸门走
  assert.equal(LOSS_OF_CONTROL.deadlockMadThreshold, 80);
  assert.equal(LOSS_OF_CONTROL.deadlockCorThreshold, 70);
});
