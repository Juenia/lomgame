/**
 * M2.37 任务 1：**门禁分级**的守卫。
 *
 * ## 为什么要有这个文件
 *
 * M2.35 定了三档（`docs/对照规范.md` §四·补三），但**只改了手册** ——
 * 冒烟档（20 人 × 3 天）跑完仍然「红 7 项、退出码 1」（m236s 的现场），
 * 而那七项在 3 天窗口里**本来就测不到**。分级不落到代码，「选档」只是文档上的一句话。
 *
 * ## 判据只有一份
 *
 * 规则实现在 `acceptance.ts` 的 `gateParticipates`，`cli.ts` 引用它 ——
 * 本文件测的是**那一份**，不是另抄一遍的副本（K22）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BATCH_TIERS, inferTier, type BatchTierId } from '../src/config/batch-tiers.ts';
import { gateParticipates, type GateTier } from '../src/vplayer/acceptance.ts';

const ALL: BatchTierId[] = ['smoke', 'medium', 'diagnostic'];
const gate = (tier: GateTier): { tier?: GateTier } => ({ tier });

test('M2.37 任务 1：三档的参与规则（smoke < medium < diagnostic，observe 永不参与）', () => {
  for (const batch of ALL) {
    assert.equal(gateParticipates(batch, gate('smoke')), true, 'smoke 项在 ' + batch + ' 档必须判');
  }

  assert.equal(gateParticipates('smoke', gate('medium')), false, 'medium 项冒烟档不判');
  assert.equal(gateParticipates('medium', gate('medium')), true);
  assert.equal(gateParticipates('diagnostic', gate('medium')), true);

  assert.equal(gateParticipates('smoke', gate('diagnostic')), false, 'diagnostic 项冒烟档不判');
  assert.equal(gateParticipates('medium', gate('diagnostic')), false, 'diagnostic 项中批也不判');
  assert.equal(gateParticipates('diagnostic', gate('diagnostic')), true);

  /*
   * ⚠️ `observe` 是**任何档都不参与** —— 它装的是**绝对门槛**（长链路「≥ N 人」），
   * 而 M2.35 **整类取消**了绝对门槛判定（§四·补三）。它留在报告里当观察项，但不进退出码。
   */
  for (const batch of ALL) {
    assert.equal(
      gateParticipates(batch, gate('observe')),
      false,
      '绝对门槛在 ' + batch + ' 档也不该参与退出码（M2.35 已整类取消）',
    );
  }

  // 缺省按**最严**（K19 的保守方向：读不出来的东西按最严判，错只错在「多拦一次」）
  assert.equal(gateParticipates('smoke', {}), false);
  assert.equal(gateParticipates('medium', {}), false);
  assert.equal(gateParticipates('diagnostic', {}), true);
});

test('M2.37 任务 1：档位推断 —— 三档规格各自匹配，**匹配不上按最严**（向后兼容）', () => {
  for (const tier of BATCH_TIERS) {
    assert.equal(inferTier(tier.players, tier.days), tier.id, tier.label + ' 的规模应当推断出它自己');
  }
  /*
   * 历史命令的规模匹配不上任何一档（8 片 × 200 人 × 30 天里的**每片**是 25 人）
   * ⇒ 落回 `diagnostic`（最严）—— **那是 M2.37 之前的行为，退出码口径一个字节都没变**。
   */
  assert.equal(inferTier(25, 30), 'diagnostic', '单片 25 人匹配不上任何档 ⇒ 最严');
  assert.equal(inferTier(200, 14), 'diagnostic', '200 人 × 14 天不是任何一档 ⇒ 最严');
  assert.equal(inferTier(20, 30), 'diagnostic', '人数对得上、天数对不上 ⇒ 也要落最严');
});

test('M2.37 任务 1（K23 反向用例）：分级必须**真的改变结论**，否则它是装饰', () => {
  /*
   * K23 要求：写下一条判据时，先用「**已知会失败**」的输入试一次。
   *
   * 这里的「已知会失败」= **M2.37 之前的判据**（所有红项一律参与退出码）。
   * 输入取 **m237s 那一批的真实红项构成**（4 项本档不判 + 2 项永不判）：
   * 旧判据 ⇒ 6 条失败、退出码 1；新判据 ⇒ 0 条、退出码 0。
   *
   * ⚠️ 若这两者相等，说明分级什么也没做 —— 那它就是 K14 意义上的装饰。
   */
  const observedRedsInSmoke: { tier?: GateTier }[] = [
    { tier: 'medium' }, // 袭击的序列差判定
    { tier: 'diagnostic' }, // 无条件卡触发
    { tier: 'diagnostic' }, // 地点覆盖
    { tier: 'diagnostic' }, // 配方覆盖
    { tier: 'observe' }, // 长链路：入途径 → 序列 8
    { tier: 'observe' }, // 长链路：序列 8 → 序列 7
  ];
  const legacy = observedRedsInSmoke.length; // 旧：不分级 ⇒ 全部参与
  const graded = observedRedsInSmoke.filter((item) => gateParticipates('smoke', item)).length;
  assert.equal(legacy, 6, 'm237s 那一批在冒烟档下红了 6 项（从跑批输出读出来的）');
  assert.equal(graded, 0, '分级之后冒烟档一条都不该判 —— 这 6 项正是它退出码为 1 的原因');
  assert.notEqual(legacy, graded, '分级**必须**改变结论；相等就说明它没有起作用（K14）');
});
