import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NUMERIC } from '../src/config/numeric.ts';
import {
  checkPromotion,
  promotionChance,
  promotionRequirement,
  resolvePromotion,
} from '../src/domain/promotion/promotion.ts';
import { loadRecipes } from '../src/data/loader.ts';
import { createSeededRng } from '../src/domain/rng.ts';
import { materialLossOf } from '../src/domain/ritual/resolve.ts';
import { createHarness } from './helpers/app.ts';
import type { CharacterState, InitiatedCharacter } from '../src/domain/character/types.ts';

const { recipes } = loadRecipes();
const seer9 = recipes.find((r) => r.id === 'seer_9')!;

/**
 * M2.7.6：晋升的入参收窄成 InitiatedCharacter（普通人没有序列，也就没有晋升）。
 * 这个工厂造出来的一律是「已入途径」的角色，所以直接给出收窄后的类型。
 */
function makeState(overrides: Partial<InitiatedCharacter> = {}): InitiatedCharacter {
  return {
    id: 'char-1', userId: 'u1', name: '克莱恩', pathway: 'seer', pathwayStatus: 'initiated', gender: 'male', sequence: 9,
    hp: 100, mp: 100, mad: 10, cor: 5, dig: 80, dp: 0,
    status: 'active', promotionFails: 0, createdAt: 0, updatedAt: 0,
    ...overrides,
  };
}

test('晋升需求：材料 = 本途径主材料 × 倍率，门槛与目标序列来自配置', () => {
  const state = makeState();
  const requirement = promotionRequirement(seer9, state);
  assert.equal(requirement.digThreshold, NUMERIC.promotion.digThreshold);
  assert.equal(requirement.targetSequence, 8);
  assert.equal(requirement.requiredFlag, 'ability_seer_9');
  assert.deepEqual(requirement.materials, [
    { itemId: '主材料·灰雾结晶', qty: 1 * NUMERIC.promotion.mainMaterialMultiplier },
  ]);
});

test('晋升校验：失控 / 未服魔药 / 消化不足 / 材料不足 / 已到序列 0', () => {
  const requirement = promotionRequirement(seer9, makeState());
  const owned = (): number => 99;
  const base = { requirement, ownedOf: owned, hasRequiredFlag: true };

  assert.match(
    String((checkPromotion({ ...base, state: makeState({ status: 'lost_control' }) }) as { reason?: string }).reason),
    /失控状态/,
  );
  assert.match(
    String((checkPromotion({ ...base, state: makeState(), hasRequiredFlag: false }) as { reason?: string }).reason),
    /还没有服下本序列的魔药/,
  );
  assert.match(
    String((checkPromotion({ ...base, state: makeState({ dig: 10 }) }) as { reason?: string }).reason),
    /消化度不足/,
  );
  assert.match(
    String((checkPromotion({ ...base, state: makeState({ sequence: 0 }) }) as { reason?: string }).reason),
    /序列 0/,
  );
  assert.match(
    String(
      (checkPromotion({ ...base, state: makeState(), ownedOf: () => 0 }) as { reason?: string }).reason,
    ),
    /晋升材料不足/,
  );
  assert.equal(checkPromotion({ ...base, state: makeState() }).ok, true);
});

test('成功率：复用 W1 公式，连续失败 2 次后 +10%，并受 5%—95% 限制', () => {
  /*
   * M2.33：`promotionChance` 多了第三个参数（目标序列），因为 P6 落地之后
   * 成功率要乘上 `sequenceGating.planned[目标序列]`。
   *
   * ⚠️ M2.35 任务 3：本用例的角色是序列 9（目标 8），而 **`planned[8]` 由 1.0 改成了 0.95** ——
   * 所以「乘数为 1、期望值与接线前一致」那句话**不再成立**，下面两条断言随之改成
   * 「乘数就是表里的值」（K22：期望值从表算，不抄数值）。
   */
  const state = makeState({ dig: 80, mad: 10, cor: 5 });
  const clean = promotionChance(state, 0, state.sequence - 1);
  const gating8 = NUMERIC.promotion.sequenceGating.planned[8]!;
  assert.equal(clean.failBonus, 0);
  /*
   * M2.35 任务 3：**从表读，不抄数值（K22）**。
   * 这条原来断言 `gating === 1`（「序列 9→8 是标准成功率」）——
   * planned[8] 改成 0.95 之后那句话不再成立，断言随之改成「乘数就是表里的值」。
   */
  assert.equal(clean.gating, gating8, '序列 9→8 的乘数就是 planned[8]');
  assert.ok(Math.abs(clean.chance - clean.base * gating8) < 1e-9);

  const protectedOnce = promotionChance(state, NUMERIC.promotion.failStreakThreshold, state.sequence - 1);
  assert.equal(protectedOnce.failBonus, NUMERIC.promotion.failStreakBonus);
  /*
   * 口径是 `base × 乘数 + 绝对加成`，**不是** `base + 加成`。
   * 上面这句原来写的是后者 —— 它在 `planned[8] = 1.0` 时巧合成立（乘数是 1），
   * 改梯度之后它立刻红了：这说明它当时**没有真的在验接线**，只是在验一个恒等式。
   */
  assert.ok(
    Math.abs(
      protectedOnce.chance -
        Math.min(
          NUMERIC.promotion.ceil,
          Math.max(NUMERIC.promotion.floor, clean.base * gating8 + NUMERIC.promotion.failStreakBonus),
        ),
    ) < 1e-9,
    '连续失败保护是绝对加成：chance = clamp(base × 乘数 + ' + NUMERIC.promotion.failStreakBonus + ')',
  );

  // 满 DIG 时基础 0.90，加成后会撞上限被 clamp 到 0.95
  const capped = promotionChance(makeState({ dig: 100, mad: 0, cor: 0 }), 5, 8);
  assert.equal(capped.chance, NUMERIC.promotion.ceil);
  // 全崩时也给到下限（序列 1 的目标是 0 —— planned[0] 是表里那一档，乘完仍被 floor 托住）
  const floored = promotionChance(makeState({ dig: 0, sequence: 1, mad: 100, cor: 100 }), 0, 0);
  assert.equal(floored.chance, NUMERIC.promotion.floor);
});

test('晋升成功：序列 -1、MAD/COR 上升、解锁序列 8 能力', () => {
  const state = makeState();
  const requirement = promotionRequirement(seer9, state);
  const outcome = resolvePromotion({
    state,
    requirement,
    fails: 0,
    rng: { next: () => 0 },
    seed: 's',
  });
  assert.equal(outcome.success, true);
  assert.equal(outcome.status, 'active');
  assert.deepEqual(outcome.flagsToSet, ['ability_seer_8']);
  assert.deepEqual(outcome.deltas, [
    { type: 'sequence', value: -1 },
    { type: 'mad', value: NUMERIC.promotion.madOnSuccess },
    { type: 'cor', value: NUMERIC.promotion.corOnSuccess },
  ]);
});

test('晋升失败：进入重伤、材料损失、MAD/COR 上升、不解锁能力', () => {
  const state = makeState();
  const requirement = promotionRequirement(seer9, state);
  const outcome = resolvePromotion({
    state,
    requirement,
    fails: 1,
    rng: { next: () => 0.999 },
    seed: 's',
  });
  assert.equal(outcome.success, false);
  assert.equal(outcome.status, 'injured');
  assert.deepEqual(outcome.flagsToSet, []);
  assert.deepEqual(outcome.deltas, [
    { type: 'mad', value: NUMERIC.promotion.madOnFail },
    { type: 'cor', value: NUMERIC.promotion.corOnFail },
  ]);
  /*
   * M2.20（K7）：**失败只扣一半**。
   *
   * 这一条原来写的是 `assert.deepEqual(outcome.consumed, requirement.materials)`（全额）——
   * 而 .仪式 阶段 3 失败只损 50%（ritual.stage3FailMaterialLoss），
   * 「同一个失败两条路收两种费」与「两条等效的路」这个设计前提冲突，K7 就是冲它去的。
   */
  assert.deepEqual(
    outcome.consumed,
    materialLossOf(requirement.materials, NUMERIC.promotion.failMaterialLoss),
    '失败：按 failMaterialLoss 扣，算法复用 materialLossOf（向上取整）',
  );
  // 向上取整的形状：需求 2 份 → 损 1 份（**不能**四舍五入成 0）
  assert.ok(outcome.consumed.every((n) => n.qty >= 1), '向上取整：不能出现「损 0 份」');
  assert.ok(
    outcome.consumed.every((n, i) => n.qty < requirement.materials[i]!.qty),
    '失败扣的必须**少于**需求（否则 K7 没生效）',
  );
});

test('M2.20（K7 对照前提）：materialLossOf(materials, 1.0) 恒等于 materials', () => {
  /*
   * 这条是**跑 m223b 对照批的前提**（M2.20 任务 2）。
   * 对照批的做法是把 failMaterialLoss 临时改回 1.0 —— 只有当 ratio = 1.0
   * 与「全额扣」**逐位等价**时，那一批才是「旧行为」。
   *
   * 看实现：Math.ceil(qty × 1.0) = qty（需求是正整数），filter(qty > 0) 全保留 ⇒ 等价。
   * 但它等价的前提是「需求永远是正整数」—— 把这条钉住，将来有人改倍率或配方时会被拦下。
   */
  const need = [
    { itemId: '主材料·灰雾结晶', qty: 2 },
    { itemId: '主材料·夜之瞳', qty: 1 },
    { itemId: '主材料·破晓碎片', qty: 6 },
  ];
  assert.deepEqual(materialLossOf(need, 1), need, 'ratio=1.0 必须逐位等于原需求（否则 m223b 不是纯对照）');
  assert.notDeepEqual(materialLossOf(need, 0.5), need, 'ratio=0.5 必须与全额不同（否则 K7 没生效）');
});

test('M2.20（K7）：成功仍然**全额**扣 —— 只改失败分支', () => {
  const state = makeState();
  const requirement = promotionRequirement(seer9, state);
  const outcome = resolvePromotion({ state, requirement, fails: 0, rng: { next: () => 0 }, seed: 's' });
  assert.equal(outcome.success, true);
  assert.deepEqual(outcome.consumed, requirement.materials, '成功不受 K7 影响');
});

test('M2.20（K7 端到端）：.晋升 失败后，手上的材料只少一半', async () => {
  const h = createHarness({ deterministicIds: true });
  const USER = '31001';
  try {
    const created = await h.createCharacter(USER, '倒霉蛋', 'seer');
    const id = created.id;
    const recipe = seer9;
    const itemId = recipe.main[0]!.itemId;
    const need = recipe.main[0]!.qty * NUMERIC.promotion.mainMaterialMultiplier;
    const half = Math.ceil(need * NUMERIC.promotion.failMaterialLoss);

    let sawFail = false;
    /*
     * 成功率是概率的，所以循环试到「失败分支」真的被走到为止（K10 的教训：
     * **得有一个用例会走到那条分支**，否则「改了失败扣料」这件事没有任何东西守着）。
     * 把 MAD/COR 拉满压到成功率最低档，失败概率约六成 —— 40 次里走到失败几乎是必然。
     */
    for (let attempt = 0; attempt < 40 && !sawFail; attempt += 1) {
      /*
       * M2.22 任务 4（K13 全仓排查的唯一命中项）：**这个循环原来不会推进时钟。**
       *
       * .晋升 在 RATE_LIMITS 里是 `{ capacity: 1, refillPerSec: 1 / 60 }` —— **60 秒冷却**，
       * 而限流读的是注入时钟。不推进的话第 2 轮起全部回「冷却中，请 1 分钟后再试」，
       * 那 40 次重试**只有第 1 次是真的**：
       *   · 第 1 次就失败（约六成）⇒ sawFail 立刻为真 ⇒ 用例绿 —— 但它守的是**运气**；
       *   · 第 1 次成功 ⇒ 第 2 轮被拦下、序列没变 ⇒ 落进 `sequence === 9` 分支 ⇒
       *     `before - after` 是 0 而 half 大于 0 ⇒ 断言红。
       * 也就是说这条用例的红绿取决于**第一次抽样的运气**，不是产品行为。
       *
       * 61 秒 > 60 秒冷却；这个用例只断言材料差，与时刻无关，推进时钟没有副作用。
       */
      h.advance(61_000);
      const current = h.repos.characters.findById(id)!;
      h.repos.characters.update({ ...current, sequence: 9, dig: 60, mad: 100, cor: 100, status: 'active' });
      h.repos.flags.set(id, 'ability_seer_9', h.now());
      const held = h.repos.inventory.count(id, itemId);
      if (held < need) h.repos.inventory.add(id, itemId, need - held, 'unbound', h.now());

      const before = h.repos.inventory.count(id, itemId);
      await h.send({ rawText: '.晋升', userId: USER });
      const after = h.repos.inventory.count(id, itemId);
      const sequence = h.repos.characters.findById(id)!.sequence;

      if (sequence === 9) {
        assert.equal(before - after, half, '失败：扣 ' + half + ' 份（ceil(需求 x 0.5)），实测扣 ' + (before - after));
        sawFail = true;
      } else {
        // 这一轮成功了 —— 全额扣是对的（K7 只改失败分支），重置后继续找失败那一次
        assert.equal(before - after, need, '成功：仍是全额扣');
      }
    }
    assert.ok(sawFail, '40 次里应当走到至少一次失败分支');
  } finally {
    h.app.close();
  }
});

test('晋升判定：同 seed 完全复现；连续失败保护会改变结论', () => {
  const state = makeState({ dig: 55, mad: 0, cor: 0 });
  const requirement = promotionRequirement(seer9, state);
  const input = { state, requirement, seed: 'promote-seed' };
  const first = resolvePromotion({ ...input, fails: 0, rng: createSeededRng(input.seed) });
  const again = resolvePromotion({ ...input, fails: 0, rng: createSeededRng(input.seed) });
  assert.deepEqual(first, again);

  // 基础 0.70 + 0.11 = 0.81；失败 2 次后 +0.1 → 0.91，抽到 0.85 的结论会翻转
  const roll = 0.85;
  const withoutProtection = resolvePromotion({
    ...input,
    fails: 0,
    rng: { next: () => roll },
  });
  const withProtection = resolvePromotion({
    ...input,
    fails: NUMERIC.promotion.failStreakThreshold,
    rng: { next: () => roll },
  });
  assert.equal(withoutProtection.success, false);
  assert.equal(withProtection.success, true);
});
