/**
 * M2.33 任务 1：**P6 落地 —— `sequenceGating.planned` 接上生产读取点**。
 *
 * ## 本文件取代了 `test/m2-32-planned-gating.test.ts`（已删）
 *
 * M2.32 的那个文件用探针证明了「整张 `planned` 归零也改不动成功率」——
 * **那个结论当时是对的**（这张表没有任何读取点，K19 的标本）。
 * M2.33 把读取点接上之后它被推翻 ⇒ 探针**改写成行为断言**（本文件）。
 * 旧文件已删：留着一个写着「零行为变化」的绿灯，会把下一个人带沟里。
 *
 * ## 接的是哪一根线
 *
 *     promotionChance(state, fails, targetSequence)
 *       = clamp(computePromotionSuccess(state) × sequenceGatingFor(targetSequence) + failBonus, floor, ceil)
 *
 *     checkPromotion(...) 在 planned[target] <= 0 时**直接拒绝**（不让玩家先去凑材料再发现这条路关着）
 *
 * `.仪式` **不走这条线**：它有自己的 `RitualChanceInput`，而这张表的名字就叫「高序列**晋升**惩罚」
 * （README 的设计意图表里，`.仪式` 那一列写的是「唯一路径」—— 它是被留下的那条路，不是被惩罚的那条）。
 *
 * ## 键是**目标序列**，不是当前序列
 *
 * 任务书里写的是 `planned[character.sequence]`，**那是错的**（三条现场证据见
 * `sequenceGatingFor` 的注释）。本文件第 4 条用例专门钉住这件事：
 * 把读法改回「当前序列」会让它红。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NUMERIC } from '../src/config/numeric.ts';
import { clamp, computePromotionSuccess } from '../src/domain/character/rules.ts';
import { promotionChance, sequenceGatingFor } from '../src/domain/promotion/promotion.ts';
import { loadRecipes } from '../src/data/loader.ts';
import { createHarness } from './helpers/app.ts';
import type { InitiatedCharacter } from '../src/domain/character/types.ts';

const planned = NUMERIC.promotion.sequenceGating.planned as Record<number, number>;

/** 序列 N 的、已入途径的角色（照 `test/m2-29-sailor-8.test.ts` 的形状） */
function initiated(sequence: number): InitiatedCharacter {
  return {
    id: 'c-gating',
    userId: 'u-gating',
    name: '序列 ' + sequence + ' 的人',
    pathway: 'sailor',
    sequence,
    pathwayStatus: 'initiated',
    gender: 'male',
    hp: 100,
    mp: 100,
    mad: 0,
    cor: 0,
    dig: 95,
    dp: 0,
    status: 'active',
    promotionFails: 0,
    createdAt: 0,
    updatedAt: 0,
  } as InitiatedCharacter;
}



/* ================= 1. 乘数真的生效（直验） ================= */

test('M2.33 任务 1：`planned[目标序列]` 是成功率的乘数 —— 改表值，成功率跟着变', () => {
  /*
   * 任务书的验收原文：「`planned[5] = 0.3` 时成功率是 `base × 0.3`」。
   * 注意键的读法：**序列 6 的玩家目标序列是 5** ⇒ 读 `planned[5]`（M2.32 之前那句
   * 「planned[4] = 0.2 表示序列 4 的 .晋升」也是同一读法）。
   */
  const state = initiated(6);
  const target = 5;
  const base = computePromotionSuccess(state);
  /*
   * ⚠️ M2.35 任务 3：**期望值从表读，不抄数值（K22）**。
   * 这里原来写死 0.3，于是「改梯度」时要改两处；现在读 planned[target] 本身 ——
   * 这条用例验的因此变成「**表被真的读了**」，而不是「表等于我记得的那个数」（后者是副本）。
   */
  const multiplier = planned[target]!;
  assert.equal(sequenceGatingFor(target), multiplier, '目标序列 ' + target + ' 这一档的惩罚就是表里的值');

  const chance = promotionChance(state, 0, target);
  assert.equal(chance.gating, multiplier);
  assert.ok(
    Math.abs(chance.chance - base * multiplier) < 1e-9,
    '成功率必须是 base × ' + multiplier + ' —— 实际 ' + chance.chance + '，期望 ' + base * multiplier,
  );

  // 对照侧（K9）：把这一档改掉，同一个调用必须跟着变 —— 证明读的真是这张表
  const original = planned[target]!;
  /*
   * 探针值只要**与原值不同**即可 —— 它不能被写死：
   * 写死的话，某次改梯度让它恰好等于原值时，这个对照侧会静默失效（测试仍然绿）。
   */
  const probe = original === 0.25 ? 0.75 : 0.25;
  try {
    planned[target] = probe;
    assert.equal(promotionChance(state, 0, target).gating, probe);
    assert.ok(Math.abs(promotionChance(state, 0, target).chance - base * probe) < 1e-9);
  } finally {
    planned[target] = original;
  }
  assert.equal(promotionChance(state, 0, target).gating, original, '恢复之后必须回到原值');
});

test('M2.33 任务 1：连续失败保护是**绝对加成**，不被乘数折算掉', () => {
  /*
   * 口径：`chance = base × gating + failBonus`（不是 `(base + failBonus) × gating`）。
   * 「连续失败保护」的语义是防卡死，它是一块**固定的** +10 个百分点 ——
   * 高序列惩罚把它一起折掉的话，最需要它的那一档反而最得不到它。
   */
  const state = initiated(6);
  const fails = NUMERIC.promotion.failStreakThreshold;
  const withBonus = promotionChance(state, fails, 5);
  assert.equal(withBonus.failBonus, NUMERIC.promotion.failStreakBonus);
  assert.ok(
    Math.abs(withBonus.chance - (withBonus.base * planned[5]! + NUMERIC.promotion.failStreakBonus)) < 1e-9,
    '口径是 base × 乘数 + 绝对加成；乘数从表读（K22），加成也是',
  );
});

/* ================= 2. 关闭 ================= */

test('M2.33 任务 1：`planned[目标序列] = 0` ⇒ `.晋升` 关闭（判定层与命令层各一道）', async () => {
  const original = planned[4]!;
  try {
    planned[4] = 0;

    // 判定层的读取点如实返回 0（它不替调用方决定「关不关」）
    assert.equal(sequenceGatingFor(4), 0);

    // 命令层：序列 5 的玩家发 `.晋升` 被拒绝，且**材料一份都不动**
    const h = createHarness({ deterministicIds: true });
    try {
      const recipe = loadRecipes().recipes.find((r) => r.pathway === 'sailor' && r.seq === 5)!;
      const character = await h.createCharacter('860010', '序列五的水手', 'sailor');
      h.repos.characters.update({ ...h.repos.characters.findById(character.id)!, sequence: 5, dig: 95, mad: 0, cor: 0 });
      h.repos.flags.set(character.id, 'ability_sailor_5', h.now());
      const item = recipe.main[0]!.itemId;
      h.repos.inventory.add(character.id, item, 6, 'unbound', h.now());
      const before = h.repos.inventory.count(character.id, item);

      h.advance(61_000);
      const sent = await h.send({ rawText: '.晋升', userId: '860010' });
      const text = sent.map((message) => message.text).join('\n');
      assert.match(text, /没有捷径可走了/, '关闭的那一档必须明说「这条路关了」');
      assert.match(text, /用 \.仪式/, '而且要给出替代路径 —— 否则就是 K13 的「一直撞同一条拒绝」');
      assert.equal(h.repos.characters.findById(character.id)!.sequence, 5, '序列不动');
      assert.equal(h.repos.inventory.count(character.id, item), before, '关闭的路不消耗材料');
    } finally {
      h.app.close();
    }
  } finally {
    planned[4] = original;
  }
});

test('M2.33 任务 1（隔离性）：同一档位下 `.仪式` **不受** planned 影响 —— 否则两条路一起断', async () => {
  /*
   * 这一条守的是一个**真实的实现陷阱**（M2.33 落地时踩到）：
   * `checkPromotion` 是 `.晋升` 与 `.仪式` **共用**的资格检查（`ritual.ts:105` 也调它）。
   * 把「planned[target] <= 0 ⇒ 拒绝」写进那个函数，`planned[4] = 0` 时会把**两条路一起关掉** ——
   * 而设计意图是「`.晋升` 关闭 ⇒ `.仪式` 是唯一路径」（P7 警告过的 K13 形状：永久卡住）。
   * ⇒ 关闭判定必须留在命令层（`promote.ts`）。把这条用例删掉，那个坑就会回来。
   */
  const original = planned[4]!;
  try {
    planned[4] = 0;
    const h = createHarness({ deterministicIds: true });
    try {
      const character = await h.createCharacter('860011', '没有捷径的人', 'sailor');
      h.repos.characters.update({ ...h.repos.characters.findById(character.id)!, sequence: 5, dig: 95, mad: 0, cor: 0 });
      h.repos.flags.set(character.id, 'ability_sailor_5', h.now());
      h.advance(11_000);
      const sent = await h.send({ rawText: '.仪式 准备', userId: '860011' });
      const text = sent.map((message) => message.text).join('\n');
      assert.doesNotMatch(text, /没有捷径可走了/, '.仪式 不该被 .晋升 的关闭判定波及');
      assert.doesNotMatch(
        text,
        /没有对应的晋升路径/,
        '序列 5 的配方在（sailor_5）⇒ 仪式这条路要能算出配置',
      );
    } finally {
      h.app.close();
    }
  } finally {
    planned[4] = original;
  }
});

/* ================= 3. 缺失键报错（K19） ================= */

test('M2.33 任务 1：`planned` 缺失键**报错**，不隐含 0', () => {
  /*
   * 「没写」与「写了 0」必须能区分：前者是**表漏了**，后者是**设计上关闭**。
   * 静默回 0 会让「表漏了一格」表现成「这一档不能走捷径」—— 一个看起来像设计的假象（K19）。
   */
  assert.throws(() => sequenceGatingFor(-1), /没有目标序列 -1 的键/, '序列 0 的玩家没有目标序列，应当显式报错');
  assert.throws(() => sequenceGatingFor(99), /没有目标序列 99 的键/);

  // 键域是 0—8（目标序列的域），九个键缺一不可
  for (const target of [0, 1, 2, 3, 4, 5, 6, 7, 8]) {
    assert.doesNotThrow(() => sequenceGatingFor(target), '目标序列 ' + target + ' 必须有值');
  }
});

test('M2.33 任务 1：读的是**目标序列**，不是当前序列（读法守卫）', () => {
  /*
   * 任务书里写的是 `planned[character.sequence]`，那是错的（证据见 sequenceGatingFor 的注释）。
   * 这条用例把正确读法钉住：**序列 9 的玩家读 `planned[8]`**（= 1.0，标准成功率）。
   * 若有人改回「按当前序列读」，`planned[9]` 会缺失 ⇒ 报错 ⇒ 这条红。
   */
  const state = initiated(9);
  /*
   * 序列 9 的玩家，目标序列是 8 ⇒ 读 planned[8]。
   * ⚠️ M2.35 起 planned[8] = 0.95（**不再是 1.0**），所以这里不能写死 1 ——
   * 下面那条 notEqual 就是「9→8 也吃惩罚」这个口径变化的守卫。
   */
  assert.equal(promotionChance(state, 0, state.sequence - 1).gating, planned[8]);
  assert.notEqual(planned[8], 1, 'planned[8] 必须 < 1（M2.35）：把它改回 1.0 会抹掉这条口径');
  assert.equal(promotionChance(state, 0, 8).gating, planned[8], '按目标序列读 —— 两种写法必须一致');
  assert.throws(() => promotionChance(state, 0, 9), /没有目标序列 9 的键/, '按当前序列读会立刻撞缺失键');
});

/* ================= 4. 端到端：表值与回执一致 ================= */

test('M2.33 任务 1（端到端）：序列 5 的 `.晋升` 回执与表值一致，并写出乘数', async () => {
  const h = createHarness({ deterministicIds: true });
  try {
    const recipe = loadRecipes().recipes.find((r) => r.pathway === 'sailor' && r.seq === 5)!;
    const character = await h.createCharacter('860012', '第五条路', 'sailor');
    h.repos.characters.update({ ...h.repos.characters.findById(character.id)!, sequence: 5, dig: 95, mad: 0, cor: 0 });
    h.repos.flags.set(character.id, 'ability_sailor_5', h.now());
    h.repos.inventory.add(character.id, recipe.main[0]!.itemId, 6, 'unbound', h.now());

    const base = computePromotionSuccess({ dig: 95, mad: 0, cor: 0, sequence: 5 });
    const expected = clamp(
      base * planned[4]!,
      NUMERIC.promotion.floor,
      NUMERIC.promotion.ceil,
    );

    h.advance(61_000);
    const sent = await h.send({ rawText: '.晋升', userId: '860012' });
    const text = sent.map((message) => message.text).join('\n');

    assert.match(text, new RegExp('成功率 ' + (expected * 100).toFixed(1) + '%'), '回执的成功率必须等于 base × planned[4]');
    assert.match(text, new RegExp('基础 ' + (base * 100).toFixed(1) + '%'));
    assert.match(
      text,
      new RegExp('× 高序列惩罚 ' + planned[4]),
      '乘数要写出来，否则「基础 90% / 成功率 36%」看起来像算错了（乘数从表读，K22）',
    );
  } finally {
    h.app.close();
  }
});

/* ================= 5. P4 的阶梯（顺带守） ================= */

test('M2.33 任务 0/1：DIG 阶梯是显式表，且与既有两个字段锁死一致', () => {
  const ladder = NUMERIC.promotion.digLadder as Record<number, number>;
  assert.equal(ladder[9], NUMERIC.promotion.digThreshold, 'digThreshold 就是 9→8 那一档');
  /*
   * ⚠️ **M2.38 任务 2：这里从「逐字抄整张表」改成「守形状」**（K22 的漏网）。
   *
   * 原来这一行是 `deepEqual([...], [60, 80, 85, 90, 95, 95, 95, 95, 95])` ——
   * 一份**手抄的副本**：改阶梯要改两处，而两处不同步时**红的是测试、不是代码**。
   * `planned` 在 M2.35 已经改成引用表，这张表当时漏了。
   *
   * 现在守的是**设计约束**（形状）；具体值由 `docs/M2.38-digLadder.md` 与
   * `test/m2-38-dig-ladder.test.ts` 负责。
   */
  for (const seq of [9, 8, 7, 6, 5, 4, 3, 2, 1]) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(ladder, seq),
      'DIG 阶梯缺 seq ' + seq + ' 的键 —— 不留空（K19）',
    );
  }
  for (let seq = 8; seq >= 1; seq -= 1) {
    assert.ok(
      ladder[seq]! > ladder[seq + 1]!,
      'DIG 阶梯必须**严格递增**（否则高序号门槛恒真 —— K14）：' +
        '[' + seq + ']=' + ladder[seq] + ' 应当**大于** [' + (seq + 1) + ']=' + ladder[seq + 1] +
        '（序列号越小 = 越深 = 门槛越高）',
    );
  }
  assert.ok(ladder[1]! <= 95, '最高一档不越过 95（P4 封顶口径：不要求满值），实际 ' + ladder[1]);
  assert.equal(ladder[8], NUMERIC.sequence7.digThreshold, 'sequence7.digThreshold 是 8→7 那一档的历史落点，两处必须同值');
});
