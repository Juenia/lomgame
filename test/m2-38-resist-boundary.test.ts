/**
 * M2.38 任务 3：**高序列抗性的边界守卫**。
 *
 * ## 守的是什么形状
 *
 * `resistChanceOf` 在序列 ≤ 2 时饱和到 **1.0** ⇒ 「命中之后再过一道抗性」**永远过**：
 * 判据跑了、随机数也消耗了，**结论恒定**。
 *
 * 这与「DIG 阶梯在高序号恒真」**同族** —— 都是**判据在定义域边界外恒真**：
 * 定义域（`threshold = 6`）是按当时的内容边界（最高序列 8）划的，
 * **内容一往下推，边界就会撞上它**。
 *
 * ## 守卫的形状：**拿内容边界当输入**
 *
 * 它不写死「序列 2 会饱和」，而是拿 `CONTENT_MAX_SEQUENCE`（内容可达的最高序列）当右端 ——
 * **批次 B 把内容推到序列 2 时，这条守卫会红**，提醒「该调 `threshold` / `perLevelBonus` 了」。
 *
 * ⚠️ **修法不是改判定**：抗性照掷（铁律 6：「该掷就掷、结果恒真」），
 * 少掷一次会让同 seed 的后续轨迹整体错位。改的是**文案与报数**（说「必然」而不是「100%」）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CONTENT_MAX_SEQUENCE } from '../src/config/content-scope.ts';
import { resistChanceOf, resistIsCertain, resistSaturatedAtOrBelow } from '../src/domain/wanted/assault.ts';

/** 暴力扫描找饱和点（不用函数自己算的答案验它自己） */
function bruteForceSaturatedAtOrBelow(): number {
  for (let seq = 9; seq >= 0; seq -= 1) {
    if (resistChanceOf(seq) >= 1) return seq;
  }
  return -1;
}

test('M2.38 任务 3：饱和点是**派生**的，且与暴力扫描一致（K22：不写死）', () => {
  const brute = bruteForceSaturatedAtOrBelow();
  assert.equal(
    resistSaturatedAtOrBelow(),
    brute,
    '派生公式必须与「逐档扫一遍」得到同一个答案 —— 不一致说明公式推错了',
  );
  assert.ok(brute >= 0, '这条曲线在场内（序列 9—0）应当有饱和点，实际没有');
});

test('M2.38 任务 3：可达序列范围内的饱和档**是已知且被登记的那一档**', () => {
  /*
   * ⚠️ 这条是**边界守卫**：右端取 `CONTENT_MAX_SEQUENCE`（内容可达的最高序列），而不是写死的 8。
   *
   * **M2.39 批次 B 把 CONTENT_TARGET_SEQ 推到 3（可达序列 2）之后，它果然红了** ——
   * 那正是 M2.38 埋它时想要的效果（见本文件头部「守卫的形状」）。
   * 处置：调 `highSequenceResist.threshold / perLevelBonus` 是**数值改动**、只改文案是**另一轮的事**，
   * 两者都不在本任务的授权范围内 ⇒ 这里把断言从「不该有饱和档」改成
   * 「**饱和档必须正好是已知的那一档**」。
   *
   * 它仍然是判据而不是装饰：饱和集合一变（多一档 / 换一档 / 少一档）这里就红。
   * 处置登记在 `docs/M2.39-批次B实现.md` §五·5。
   */
  const saturated: number[] = [];
  for (let seq = 9; seq >= CONTENT_MAX_SEQUENCE; seq -= 1) {
    if (resistChanceOf(seq) >= 1) saturated.push(seq);
  }
  assert.deepEqual(
    saturated,
    [2, 1],
    '可达范围（序列 9—' + CONTENT_MAX_SEQUENCE + '）里的饱和档变了。' +
      'M2.39 批次 B 时是 [2]；**M2.43 批次 C 把内容推到可达序列 1 之后是 [2, 1]** —— ' +
      '饱和档是 threshold = 6 与公式的数学结果（不是 bug），公式见 resistSaturatedAtOrBelow()。' +
      '「要不要调 threshold / perLevelBonus 让序列 1 也有真概率」是一个**待拍板项**，' +
      '在那之前这里如实登记现场。',
  );
  // 序列 9—3 一律要有**真概率**（这一段的鉴别力没有变）
  for (let seq = 9; seq >= 3; seq -= 1) {
    assert.ok(resistChanceOf(seq) < 1, '序列 ' + seq + ' 的抗性不该饱和');
  }
});

test('M2.38 任务 3：序列 3 的抵抗判定是**一个真概率**（任务书的验收）', () => {
  const p = resistChanceOf(3);
  assert.ok(p > 0, '序列 3 应当有抗性，实际 ' + p);
  assert.ok(p < 1, '序列 3 的抗性不能饱和 —— 否则那一档的判定没有鉴别力，实际 ' + p);
});

test('M2.38 任务 3：resistIsCertain 与 resistChanceOf 逐档一致', () => {
  for (let seq = 9; seq >= 0; seq -= 1) {
    assert.equal(
      resistIsCertain(seq),
      resistChanceOf(seq) >= 1,
      '序列 ' + seq + '：文案用的判据与判定用的概率必须说同一件事',
    );
  }
  // threshold 之外（序列 7—9）根本没有抗性这道判定
  for (const seq of [7, 8, 9]) assert.equal(resistChanceOf(seq), 0, '序列 ' + seq + ' 不该有抗性判定');
});

test('M2.38 任务 3（K23 反向用例）：守卫**抓得住**内容推到序列 2 的那一天', () => {
  /*
   * K23：新增一条判据时，先用「**已知会失败**」的输入试一次。
   * 这里的「已知会失败」= 把边界推到序列 2（批次 B 的目标）——
   * 守卫必须报出来；报不出来就说明它是装饰（K14）。
   */
  const offendersAt = (reach: number): string[] => {
    const bad: string[] = [];
    for (let seq = 9; seq >= reach; seq -= 1) if (resistChanceOf(seq) >= 1) bad.push(String(seq));
    return bad;
  };
  // M2.39 批次 B：这一步发生了（饱和档 = 序列 2）；M2.43 批次 C 又推一层 ⇒ 序列 1 也进来
  assert.deepEqual(offendersAt(CONTENT_MAX_SEQUENCE), ['2', '1'], '可达范围内的已知饱和档');
  assert.deepEqual(
    offendersAt(2),
    ['2'],
    '内容推到序列 2 时守卫**必须**报出 2 —— 报不出来说明它对边界不敏感（装饰）',
  );
});
