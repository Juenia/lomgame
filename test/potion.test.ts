import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NUMERIC } from '../src/config/numeric.ts';
import { PATHWAY_LABELS } from '../src/domain/character/rules.ts';
import type { PathwayId } from '../src/domain/character/types.ts';
import {
  abilityFlag,
  computePotionSuccess,
  potionMpCost,
  resolveBrew,
  resolveDrink,
} from '../src/domain/potion/potion.ts';
import { recipeMaterials, potionProductId } from '../src/domain/potion/recipe.ts';
import { loadRecipes } from '../src/data/loader.ts';
import { createSeededRng } from '../src/domain/rng.ts';
import type { CharacterState } from '../src/domain/character/types.ts';

const { recipes } = loadRecipes();
const seer9 = recipes.find((r) => r.id === 'seer_9')!;

function makeState(overrides: Partial<CharacterState> = {}): CharacterState {
  return {
    id: 'char-1', userId: 'u1', name: '克莱恩', pathway: 'seer', pathwayStatus: 'initiated', gender: 'male', sequence: 9,
    hp: 100, mp: 100, mad: 0, cor: 0, dig: 0, dp: 0,
    status: 'active', promotionFails: 0, createdAt: 0, updatedAt: 0,
    ...overrides,
  };
}

function scriptedRng(values: number[]): { next(): number } {
  let index = 0;
  return { next: () => values[index++] ?? 0 };
}

test('配方数据：材料与成品齐备，每条途径都有序列 9', () => {
  // M2.12：序列 8→7 上线，每途径多一份「序列 8 的魔药」
  // M2.19：接入 sailor（水手），它有且只有序列 9 那一份，6 → 7
  // M2.26 三批 ⇒ 13；M2.29：sailor 补序列 8 ⇒ 14；A1（序列 6）逐途径 +1 ⇒ **21**
  // 批次 A2（序列 5）逐途径 +1 ⇒ 28
  // M2.33：补 **seq 7**（那条断链）逐途径 +1 ⇒ **35** = 7 途径 × 5 档（9/8/7/6/5）
  // M2.39 批次 B：序列 4、3 逐途径各 +1 ⇒ **49** = 7 途径 × 7 档（9/8/7/6/5/4/3）
  // M2.43 批次 C：序列 2 逐途径 +1 ⇒ **56** = 7 途径 × 8 档（9—2）
  // ⚠️ 这个数字同时是 G 表守卫的 G12（docs/架构铁律.md），改它要两处一起改。
  // M2.76：22 途径 × 8 档 = 176（原 7 途径 × 8 = 56）
  /*
   * M2.85 内容填充 P4：**序列 1、0 的配方试过、又撤了**。
   *
   * 撤的原因不是材料凑不齐（那一步已经解决：六个高门槛地点都挂上了它们需要的材料），
   * 而是**越过了本版的内容边界** —— `CONTENT_TARGET_SEQ = 2` 的语义是
   * 「本版配方做到 seq 2，玩家可达最高序列 1」（见 src/config/content-scope.ts）。
   * 补到 seq 0 会让 `CONTENT_MAX_SEQUENCE` 变成 −1，而 m2-35 的判据当场说了：
   * 「目标被改大了 —— 两处必须一起动」。
   * 所以本轮**回到 176 = 22 途径 × 8 档**；真要往下做，是一次**版本边界**的决定，不是补数据。
   */
  assert.equal(recipes.length, 176);
  for (const recipe of recipes) {
    // M2.29：序列 9—0 逐步落地 ⇒ 不再写死「只有 9 与 8 两档」
    assert.ok(Number.isInteger(recipe.seq) && recipe.seq >= 0 && recipe.seq <= 9, '配方序列必须在 0—9 内');
    assert.ok(recipe.main.length >= 1);
    assert.ok(recipe.aux.length >= 1);
    // M2.29：序列 9—0 逐步落地 ⇒ 不再写死 (9|8)，改成一位数字（批次 A1 起有 6）
    /*
     * M2.76：这个正则原来**手抄了 7 条途径** —— 22 途径落地后 `potion_door_9` 被判非法。
     * 改成不列举途径的形状：id 的约定是 `potion_<途径>_<序列>`，
     * 而「途径是否合法」由 schema 守（`PathwayIdSchema`），不需要在正则里再抄一遍。
     * 这是本轮抓到的**第 5 处同形状的清单副本**。
     */
    assert.match(potionProductId(recipe), /^potion_([a-z_]+)_([0-9])$/);
    assert.ok(recipe.ritual.length > 0, '仪式描述不能为空');
  }
  /*
   * **七条途径各自至少两份**（序列 9 与序列 8）。
   *
   * M2.29：sailor 补上序列 8 ⇒ 它不再是例外，并回这个循环（P8 拍板）。
   * ⚠️ 断言从「**正好**两份 [8,9]」改成「**至少**含 9 与 8」——
   *    因为批次 A1 起每途径会继续加 6/5/… ；写死 `[8,9]` 会让每加一级都来改这一条（那是 K16 的形状）。
   */
  // M2.76：**不再手抄途径清单**（第 6 处同形状的副本）—— 从 PATHWAY_LABELS 派生，
  // 加途径时它自动跟上。
  for (const pathway of Object.keys(PATHWAY_LABELS) as PathwayId[]) {
    const seqs = recipes.filter((recipe) => recipe.pathway === pathway).map((recipe) => recipe.seq);
    assert.ok(seqs.includes(9), pathway + ' 缺序列 9 的配方（入途径那一瓶）');
    assert.ok(seqs.includes(8), pathway + ' 缺序列 8 的配方（8→7 那一瓶）');
    assert.equal(new Set(seqs).size, seqs.length, pathway + ' 的配方序列不能重复');
  }
  /*
   * M2.29：sailor 的序列 8 配方已补（P8）。
   *
   * 原来这里钉着 `[9]`（「水手这一轮只做序列 9 —— 序列 8 的配方与产出点留给下一轮」）。
   * ⚠️ 那条断言守的是**内容表**（sailor 有几份配方），**没人守「序列 8 的水手能不能晋升」** ——
   * 而缺 seq 8 配方的后果正是后者：两条晋升路径都按 `recipe.seq === character.sequence` 取配方，
   * 取不到就回「这个序列暂时没有对应的晋升路径」（K18 的形状：守卫守一端）。
   */
  const sailorSeqs = recipes.filter((recipe) => recipe.pathway === 'sailor').map((recipe) => recipe.seq);
  assert.ok(sailorSeqs.includes(9) && sailorSeqs.includes(8), 'sailor 与其余六条途径同口径：序列 9 + 序列 8 都要有');
  // （不写死成 [8,9]：M2.29 起批次 A1 又给它加了序列 6，写死会让每加一级都来改这一条）
});

test('成功率：base - 0.2×COR/100，clamp 5%—95%', () => {
  assert.equal(computePotionSuccess(seer9, { cor: 0 }), seer9.base_success);
  assert.ok(Math.abs(computePotionSuccess(seer9, { cor: 100 }) - (seer9.base_success - 0.2)) < 1e-9);
  assert.ok(Math.abs(computePotionSuccess(seer9, { cor: 50 }) - (seer9.base_success - 0.1)) < 1e-9);
  // 极端配方：base 1.0 也不超过上限，base 0 也不低于下限
  const high = { ...seer9, base_success: 1 };
  const low = { ...seer9, base_success: 0 };
  assert.equal(computePotionSuccess(high, { cor: 0 }), NUMERIC.potion.successCeil);
  assert.equal(computePotionSuccess(low, { cor: 100 }), NUMERIC.potion.successFloor);
});

test('调制：成功产出成品，只扣灵性', () => {
  const outcome = resolveBrew({
    state: makeState({ mp: 100 }),
    recipe: seer9,
    rng: scriptedRng([0]),
    seed: 's1',
  });
  assert.equal(outcome.success, true);
  assert.deepEqual(outcome.deltas, [{ type: 'mp', value: -potionMpCost() }]);
  assert.equal(outcome.productItemId, 'potion_seer_9');
  assert.deepEqual(outcome.consumed, recipeMaterials(seer9));
});

test('调制：失败涨 COR/MAD，且不产出成品', () => {
  const outcome = resolveBrew({
    state: makeState({ mp: 100 }),
    recipe: seer9,
    rng: scriptedRng([0.999]),
    seed: 's1',
  });
  assert.equal(outcome.success, false);
  assert.deepEqual(outcome.deltas, [
    { type: 'mp', value: -potionMpCost() },
    { type: 'cor', value: seer9.cor_on_fail + NUMERIC.potion.failExtraCor },
    { type: 'mad', value: seer9.mad_on_fail + NUMERIC.potion.failExtraMad },
  ]);
});

test('调制：COR 越高越容易失败（同一抽样下结论不同）', () => {
  const roll = 0.6;
  const clean = resolveBrew({ state: makeState({ cor: 0 }), recipe: seer9, rng: scriptedRng([roll]), seed: 's' });
  const polluted = resolveBrew({ state: makeState({ cor: 100 }), recipe: seer9, rng: scriptedRng([roll]), seed: 's' });
  assert.equal(clean.success, true, '干净时 0.75 > 0.6');
  assert.equal(polluted.success, false, '污染 100 时 0.55 < 0.6');
});

test('调制：同 seed 复现同一次判定', () => {
  const input = { state: makeState({ cor: 30 }), recipe: seer9, seed: 'brew-seed' };
  const first = resolveBrew({ ...input, rng: createSeededRng(input.seed) });
  const again = resolveBrew({ ...input, rng: createSeededRng(input.seed) });
  assert.deepEqual(first, again);
});

test('服用：DIG 上涨、MAD 上升，首次服用有额外叙事', () => {
  const outcome = resolveDrink({
    state: makeState(),
    potionItemId: 'potion_seer_9',
    rng: createSeededRng('drink'),
    seed: 'drink',
    firstTime: true,
  });
  const digDelta = outcome.deltas.find((delta) => delta.type === 'dig');
  const madDelta = outcome.deltas.find((delta) => delta.type === 'mad');
  assert.ok(digDelta && 'value' in digDelta && madDelta && 'value' in madDelta);
  assert.equal(digDelta.value, NUMERIC.potion.digOnDrink);
  assert.equal(madDelta.value, NUMERIC.potion.madOnDrink);
  assert.equal(outcome.firstTime, true);
  assert.ok(outcome.narrative.some((line) => line.includes('第一次')));
  assert.equal(abilityFlag({ pathway: 'seer', seq: 9 }), 'ability_seer_9');
});

test('服用：失控判定与 §8 共用同一个公式（超出阈值的部分 / divisor）', () => {
  // 取一对「刚过闸门、不触发 clamp」的数值（跟随 config，别写死：闸门在 M2.1 调过两次）
  const mad = NUMERIC.lossOfControl.madThreshold + 10;
  const cor = NUMERIC.lossOfControl.corThreshold + 5;
  const outcome = resolveDrink({
    state: makeState({ mad, cor }),
    potionItemId: 'potion_seer_9',
    rng: createSeededRng('x'),
    seed: 'x',
    firstTime: false,
  });
  // 投影 MAD = mad + madOnDrink → ((MAD - 闸门) + (COR - 闸门)) / divisor
  const projectedMad = mad + NUMERIC.potion.madOnDrink;
  const expected = Math.max(
    0,
    Math.min(
      1,
      (projectedMad - NUMERIC.lossOfControl.madThreshold + (cor - NUMERIC.lossOfControl.corThreshold)) /
        NUMERIC.lossOfControl.divisor,
    ),
  );
  assert.ok(Math.abs(outcome.controlChance - expected) < 1e-9, `期望 ${expected}，实际 ${outcome.controlChance}`);

  // 双满：超出量算满，必要时被 clamp 到 1（跟随闸门，别写死数值）
  const capped = resolveDrink({
    state: makeState({ mad: 100, cor: 100 }),
    potionItemId: 'potion_seer_9',
    rng: createSeededRng('x'),
    seed: 'x',
    firstTime: false,
  });
  const cappedExcess =
    100 + NUMERIC.potion.madOnDrink - NUMERIC.lossOfControl.madThreshold +
    (100 - NUMERIC.lossOfControl.corThreshold);
  assert.ok(
    Math.abs(capped.controlChance - Math.min(1, cappedExcess / NUMERIC.lossOfControl.divisor)) < 1e-9,
    '双满时的概率应为 clamp(超出量 / divisor)',
  );
});

test('服用：触发失控时追加 MAD/COR 代价', () => {
  const state = makeState({ mad: 100, cor: 100 });
  const outcome = resolveDrink({
    state,
    potionItemId: 'potion_seer_9',
    rng: scriptedRng([0]),
    seed: 'x',
    firstTime: false,
  });
  assert.equal(outcome.lossOfControl, true);
  assert.equal(outcome.controlRoll, 0);
  assert.ok(outcome.deltas.some((d) => d.type === 'mad' && d.value === NUMERIC.potion.controlMadBonus));
  assert.ok(outcome.deltas.some((d) => d.type === 'cor' && d.value === NUMERIC.potion.controlCorBonus));
});

test('服用：低 MAD/COR 时即便抽样为 0 也不失控（保留闸门）', () => {
  const outcome = resolveDrink({
    state: makeState({ mad: 10, cor: 10 }),
    potionItemId: 'potion_seer_9',
    rng: scriptedRng([0]),
    seed: 'x',
    firstTime: false,
  });
  assert.equal(outcome.lossOfControl, false);
});
