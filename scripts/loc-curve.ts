/**
 * 只读取证脚本：把失控概率曲线与晋升成功率打印出来，供调参拍板。
 * 运行：node scripts/loc-curve.ts
 */
import {
  LOSS_OF_CONTROL,
  PROMOTION,
  computeLossOfControlProbability,
  computePromotionSuccess,
  lossOfControlCurve,
} from '../src/domain/character/rules.ts';

console.log('失控概率（软启动：max(0, MAD+COR-150)/' + LOSS_OF_CONTROL.divisor + '）');
console.log('MAD\tCOR\t每日失控概率');
for (const point of lossOfControlCurve([
  [0, 0],
  [80, 0],
  [0, 70],
  [80, 70],
  [85, 75],
  [90, 80],
  [95, 90],
  [100, 90],
  [100, 100],
])) {
  console.log(`${point.mad}\t${point.cor}\t${(point.probability * 100).toFixed(2)}%`);
}

console.log('\n文档目标区间：MAD=80/COR=70 → 约 0%；MAD=95/COR=90 → 20%—30%（divisor=150 已落进区间，W5 用真实分布定终值）');
console.log(`当前实测：80/70 → ${(computeLossOfControlProbability({ mad: 80, cor: 70, sequence: null }) * 100).toFixed(2)}%，` +
  `95/90 → ${(computeLossOfControlProbability({ mad: 95, cor: 90, sequence: null }) * 100).toFixed(2)}%`);

console.log('\n晋升成功率（基值 70% + 20%×DIG - 5%×(9-序列) - 15%×MAD - 10%×COR，限制 5%—95%）');
console.log('序列\tDIG\tMAD\tCOR\t成功率');
for (const seq of [9, 7, 5, 3]) {
  for (const dig of [0, 50, 80, 100]) {
    const p = computePromotionSuccess({ sequence: seq, dig, mad: 20, cor: 10 });
    console.log(`${seq}\t${dig}\t20\t10\t${(p * 100).toFixed(1)}%`);
  }
}
console.log(
  `\n极值检查：DIG=100/序列9/MAD=0/COR=0 → ${(computePromotionSuccess({ sequence: 9, dig: 100, mad: 0, cor: 0 }) * 100).toFixed(1)}%（上限 ${PROMOTION.ceil * 100}%）` +
    `；DIG=0/序列0/MAD=100/COR=100 → ${(computePromotionSuccess({ sequence: 0, dig: 0, mad: 100, cor: 100 }) * 100).toFixed(1)}%（下限 ${PROMOTION.floor * 100}%）`,
);
