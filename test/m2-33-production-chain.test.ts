/**
 * M2.33 任务 3：**零夹具生产链路 —— 从建号一路晋升到序列 5，不注入任何内容**。
 *
 * ## 与 M2.32 那一版的区别（它已删）
 *
 * | | M2.32 | M2.33（本文件） |
 * | --- | --- | --- |
 * | 走到哪 | 序列 7（真内容）+ 注入 `seer_7` 到序列 5 | **序列 5，全真内容** |
 * | 门槛 | 两档（60/80） | **P4 阶梯**（60/80/85/90） |
 * | 成功率 | 无高序列惩罚 | **P6 生效**（×1.0 / ×0.9 / ×0.6 / ×0.3） |
 * | 失控闸门 | 全局 65 | **P5 生效**（序列 5 那一档是 60） |
 *
 * ⇒ 它是 M2.33 三条接线（P4/P5/P6）的**总验收**：这条链路上每走一步，都在用那三条改过的代码。
 *
 * ## 零夹具的口径（与 M2.26/M2.32 一致，写死在这里）
 *
 * | 允许 | 为什么 |
 * | --- | --- |
 * | 位置（`moveTo`） | 出生城市是 userId 派生的纯函数 |
 * | 材料（`inventory.add`） | 前置资源，不是结论（M2.26 的 `restock()` 同性质） |
 * | 时钟（`h.advance`） | 全部时间由注入时钟推进 |
 *
 * | **禁止** | 为什么 |
 * | --- | --- |
 * | `sequence` / `pathway` / `pathwayStatus` | 那是被测结论本身 |
 * | `ability_*` 旗标 | 同上：它是链路自持的关键，只该由晋升成功来设 |
 * | `DIG` | **真的用 `.扮演` 从 0 磨到 90**（实测：每天 12 次 ≈ +4，23 天到 90） |
 * | 邀约 / 配方 / 掉落 | 全部由生产逻辑产生 |
 *
 * ## 这条路为什么现在才走得通
 *
 * 上一轮（M2.32）走到序列 7 就断了 —— 不是用例写得不对，是**内容表断在 `seq: 7`**：
 * 序列 7 的玩家两条路都取不到配方。M2.33 任务 2 补上 7 条配方 + 7 个物品 + 19 处产出点之后，
 * 「建号 → 序列 5」这条路**第一次在真内容上全程连通**。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NUMERIC } from '../src/config/numeric.ts';
import { loadFactions, loadRecipes } from '../src/data/loader.ts';
import { potionProductId, type RecipeDef } from '../src/domain/potion/recipe.ts';
import { clamp, computePromotionSuccess } from '../src/domain/character/rules.ts';
import { sequenceGatingFor } from '../src/domain/promotion/promotion.ts';
import { FLAG_LOCATION } from '../src/infra/db/flags.ts';
import { createHarness, type Harness } from './helpers/app.ts';

const USER = '850001';
const NAME = '钟表匠的学徒';
const CITY = 'tingen';
const FACTION = 'church_tingen';
const PATHWAY = 'seer';
/**
 * 四段晋升里最高的那一道门槛 = `digLadder[6]`（6→5）。磨到它，四段全过。
 *
 * **这个数字实测红过一次**（M2.33 对照侧，K9）：把它临时改成 85 之后，
 * 用例在最后一段卡住，报错原文是「30 次尝试都没晋升到序列 5……
 * 最后一次回执：消化度不足（需要 90，当前 85.5）」——
 * ⇒ 它抓得住「P4 阶梯的第 4 档真的在拦人」，不是一路绿灯的假用例。
 */
const DIG_TARGET = 90;

/** 磨 DIG 用的扮演文本（愚者的 core 标签 + 长句子轮换，避开复读惩罚） */
const PLAY_TEXTS = [
  '我占卜',
  '我预兆',
  '我低语',
  '我在书店里替人占卜今天的运势',
  '我翻开牌看一件还没发生的事',
  '我替人看手相',
];

function textOf(messages: readonly { text: string }[]): string {
  return messages.map((message) => message.text).join('\n');
}

function moveTo(h: Harness, characterId: string, cityId: string, center: string): void {
  const state = h.repos.characters.findById(characterId)!;
  h.repos.characters.update({ ...state, currentCityId: cityId, updatedAt: h.now() });
  h.repos.flags.set(characterId, FLAG_LOCATION, h.now(), center);
}

/** 给他一张写着主材料的纸（M2.85 起线索是唯一入口；落点权重由判定层与内容表守卫） */
function giveClue(h: Harness, characterId: string): void {
  h.repos.clues.insert({
    id: 'clue-' + PATHWAY,
    characterId,
    pathway: PATHWAY,
    clueText: '一张看不懂的纸。',
    foundAt: h.now(),
    usedAt: null,
  });
}

/** 凑齐材料 → 反复调制直到出一瓶 → 服用（与 test/m2-26-new-pathway-initiation.test.ts 同名函数一字不差） */
async function brewAndDrink(h: Harness, userId: string, characterId: string, recipe: RecipeDef): Promise<string> {
  const restock = (): void => {
    for (const need of [...recipe.main, ...recipe.aux]) {
      h.repos.inventory.add(characterId, need.itemId, need.qty, 'unbound', h.now());
    }
  };
  restock();
  let brewed = false;
  for (let attempt = 0; attempt < 8 && !brewed; attempt += 1) {
    h.advance(31_000);
    await h.send({ rawText: '.魔药 ' + recipe.id, userId });
    brewed = h.repos.inventory.count(characterId, potionProductId(recipe)) > 0;
    if (!brewed) {
      restock();
      h.repos.characters.update({ ...h.repos.characters.findById(characterId)!, mp: 100, cor: 0 });
    }
  }
  assert.ok(brewed, '凑齐材料后必须能调出序列 9 魔药');
  h.advance(1000);
  return textOf(await h.send({ rawText: '.服用 ' + potionProductId(recipe), userId }));
}

/** 真的用 `.扮演` 把消化度磨上去（跨天重置标签用量；扮演全程不涨 MAD） */
async function grindDig(h: Harness, userId: string, characterId: string, target: number): Promise<void> {
  let sent = 0;
  for (let day = 0; day < 60; day += 1) {
    if (h.repos.characters.findById(characterId)!.dig >= target) return;
    for (let k = 0; k < 12; k += 1) {
      h.advance(11_000);
      await h.send({ rawText: '.扮演 ' + PLAY_TEXTS[sent % PLAY_TEXTS.length], userId });
      sent += 1;
    }
    h.advance(24 * 3600 * 1000);
  }
  assert.fail('60 天内没把消化度磨到 ' + target + '（实测 23 天到 90 —— 超了说明扮演收益被改过）');
}

function recipeOf(seq: number): RecipeDef {
  const found = loadRecipes().recipes.find((entry) => entry.pathway === PATHWAY && entry.seq === seq);
  assert.ok(found, PATHWAY + ' 序列 ' + seq + ' 的配方必须存在');
  return found!;
}

/** 备齐「一次成功 + 一次失败」的主材料（成功扣全额、失败扣一半） */
function topUpMaterials(h: Harness, characterId: string, recipe: RecipeDef): void {
  for (const need of recipe.main) {
    const required = need.qty * NUMERIC.promotion.mainMaterialMultiplier * 2;
    const held = h.repos.inventory.count(characterId, need.itemId);
    if (held < required) h.repos.inventory.add(characterId, need.itemId, required - held, 'unbound', h.now());
  }
}

/**
 * 一直 `.晋升` 到 `target`。
 *
 * ⚠️ 每次尝试前跨 61 秒（K13）：`.晋升` 的令牌桶是 capacity 1 / 60 秒，且限流在 handler **之前** ——
 * 被拒绝的那次也吃令牌 ⇒ 不推进时钟的重试循环从第 2 轮起全是「冷却中」，**重试根本没发生**。
 *
 * ⚠️ 高序列的成功率**被 P6 压得很低**（序列 6→5 那一档是 `planned[5]`，M2.35 起 = **0.5**）：
 * dig 90 时基础 0.73 ⇒ 实际只有 **36.5%**。
 * 这不是用例写得松，是**设计如此**：高序列的 `.晋升` 是「越往上越不能取巧」那条曲线的落点。
 *
 * ## ★ 重试上限**从表里现算**（M2.37 任务 3）
 *
 * 原来写死 `30` —— 那个数是按 `planned[5] = 0.3` 手算出来的，**改梯度它就失真**：
 * `planned[5] = 0.1` 时 p ≈ 0.073，30 次全败的概率是 **10.4%** ⇒ 用例变成 flaky。
 *
 * 现在按 `ceil(log(1e-6) / log(1 - p))` 现算（p 用**这一档的真实成功率**，含 clamp）：
 *
 * | `planned[5]` | p（base 0.73） | 现算上限 | 写死 30 够吗 |
 * | --- | --- | --- | --- |
 * | **0.5（M2.35 现值）** | 0.365 | **33** | ✅ |
 * | 0.3（M2.33—M2.34） | 0.219 | 60 | ✅ |
 * | **0.1** | 0.073 | **171** | ❌ 30 次只有 89.6% 把握 |
 *
 * ⇒ **改 `planned` 不用再回来改这个文件** —— 这是 K22「引用而非手抄」落在**算法**上的形态
 * （M2.36 任务 2 把这一类登记为「间接依赖**行为**」的依赖点，M2.37 就地修掉）。
 */
function promoteAttemptsFor(h: Harness, characterId: string, target: number): number {
  const state = h.repos.characters.findById(characterId)!;
  /*
   * 口径必须与判定层一致：`promotionChance` = `clamp(base × gating + failBonus, floor, ceil)`。
   * 这里取 `failBonus = 0`（**最坏**情况）再 clamp ⇒ 算出的 p 只会偏小、上限只会偏大，
   * 错的方向是「多试几次」而不是「少试几次」。
   */
  // 走到这一步的角色必然已入途径（`sequence` 不是 null）；`?? ` 只为类型收窄
  const base = computePromotionSuccess({ ...state, sequence: state.sequence ?? target + 1 });
  const p = clamp(base * sequenceGatingFor(target), NUMERIC.promotion.floor, NUMERIC.promotion.ceil);
  const attempts = Math.ceil(Math.log(1e-6) / Math.log(1 - p));
  // 护栏：p 极小时不至于把用例拖成分钟级（真到那一步说明设计本身已经不适合这条用例了）
  return Math.max(5, Math.min(attempts, 500));
}

async function promote(h: Harness, userId: string, characterId: string, recipe: RecipeDef, target: number): Promise<string> {
  let last = '';
  const attempts = promoteAttemptsFor(h, characterId, target);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (h.repos.characters.findById(characterId)!.sequence === target) return last;
    topUpMaterials(h, characterId, recipe);
    h.advance(61_000);
    last = textOf(await h.send({ rawText: '.晋升', userId }));
  }
  assert.equal(
    h.repos.characters.findById(characterId)!.sequence,
    target,
    attempts + ' 次尝试都没晋升到序列 ' + target + '。最后一次回执：' + last.slice(0, 200),
  );
  return last;
}

test('M2.33 任务 3：零夹具生产链路 —— 建号 → 入途径 → 序列 5（P4/P5/P6 的总验收）', async () => {
  const h = createHarness({ deterministicIds: true });
  try {
    /* ---------- A 段：建号 → 入途径（与 M2.26 那条零夹具链路同形） ---------- */

    const mortal = await h.createMortal(USER, NAME);
    assert.equal(mortal.pathwayStatus, 'mortal', '.创建 出来的是一张白纸');
    moveTo(h, mortal.id, CITY, CITY);

    // 内容事实：CITY 传 PATHWAY 的是 FACTION（否则那张配方玩家永远翻不到）
    const { factions: allFactions } = loadFactions();
    const owner = allFactions.find((entry) => entry.id === FACTION)!;
    assert.equal(owner.cityId, CITY);
    assert.equal(owner.pathway, PATHWAY);
    giveClue(h, mortal.id);

    const initiated = await brewAndDrink(h, USER, mortal.id, recipeOf(9));
    assert.match(initiated, /【入途径 · 愚者】/);
    const afterDrink = h.repos.characters.findById(mortal.id)!;
    assert.equal(afterDrink.pathwayStatus, 'initiated');
    assert.equal(afterDrink.pathway, PATHWAY);
    assert.equal(afterDrink.sequence, 9);
    assert.ok(
      afterDrink.dig < 60,
      '入途径时不该已经够晋升 —— 够的话这条链路就没验到「怎么达标」那一段（当前 ' + afterDrink.dig + '）',
    );

    /* ---------- B 段：真的磨 DIG（P4 阶梯最高一道是 90） ---------- */

    await grindDig(h, USER, mortal.id, DIG_TARGET);
    const ground = h.repos.characters.findById(mortal.id)!;
    assert.ok(ground.dig >= DIG_TARGET, 'DIG 要够 6→5 那一档（digLadder[6] = 90）');
    assert.notEqual(ground.status, 'lost_control', '扮演不该把人磨到失控（MAD 全程 0）');

    /* ---------- C 段：四段晋升，全部走真内容 ---------- */

    const planned = NUMERIC.promotion.sequenceGating.planned as Record<number, number>;
    const steps = [8, 7, 6, 5].map((target) => ({
      recipe: recipeOf(target + 1),
      target,
      gating: planned[target]!,
    }));

    for (const step of steps) {
      const text = await promote(h, USER, mortal.id, step.recipe, step.target);
      const state = h.repos.characters.findById(mortal.id)!;
      assert.equal(
        state.sequence,
        step.target,
        '序列 ' + (step.target + 1) + ' → ' + step.target + ' 必须走得通（配方 ' + step.recipe.id + '）',
      );
      assert.ok(
        h.repos.flags.has(mortal.id, 'ability_' + PATHWAY + '_' + step.target),
        '晋升成功要设 ability_' + PATHWAY + '_' + step.target + '（下一段的 requiredFlag）',
      );
      /*
       * P6 的直验（顺着链路走一遍）：高序列惩罚就是表里的那个数。
       *
       * ⚠️ M2.35 任务 3 之后 **9→8 那一档也是 < 1**（planned[8] 由 1.0 改成 0.95），
       * 所以回执现在**四段都会写出乘数** —— 下面那个 if 的判据（gating < 1）是形状判断，
       * 不是「第几段」的特例，改梯度时不需要动它。
       */
      if (step.gating < 1) {
        assert.match(
          text,
          new RegExp('× 高序列惩罚 ' + step.gating),
          '序列 ' + step.target + ' 那一档的乘数应当是 planned[' + step.target + '] = ' + step.gating,
        );
      }
    }

    /* ---------- 收尾断言 ---------- */

    const final = h.repos.characters.findById(mortal.id)!;
    assert.equal(final.sequence, 5, '这条链的终点：序列 5 —— **M2.29 交付的序列 6/5 内容第一次有玩家能碰到**');
    assert.equal(final.pathway, PATHWAY);
    assert.ok(h.repos.flags.has(mortal.id, 'ability_seer_5'), '序列 5 的能力旗标');
    assert.ok(final.dig >= DIG_TARGET, '晋升不消耗消化度 —— 走完四段，DIG 还是磨上去的那个值');
    assert.equal(h.repos.clues.unusedOf(mortal.id).length, 0, '整条链走完，那张线索已被用掉');

    /*
     * 四段的门槛复核（铁律 11：数字从代码出，不靠记忆）。
     *
     * ⚠️ **M2.38 任务 2：这里原来也手抄了一份阶梯**（`[60, 80, 85, 90]`）——
     * 与 `test/m2-33-gating.test.ts` 那处**同形**，都是 K22 的漏网
     *（改梯度要改两处，而不同步时红的是测试、不是代码）。
     *
     * 现在只断言**形状**与**与结果的一致性**；值本身由
     * `test/m2-38-dig-ladder.test.ts` 与 `docs/M2.38-digLadder.md` 负责。
     */
    const walked = [9, 8, 7, 6].map((seq) => NUMERIC.promotion.digLadder[seq as never]!);
    assert.equal(walked.length, 4, '这条链要跨四档门槛');
    for (let i = 0; i < walked.length - 1; i += 1) {
      assert.ok(
        walked[i]! < walked[i + 1]!,
        '链路上的门槛必须逐档升高（序列号越小门槛越高）：' + JSON.stringify(walked),
      );
    }
    assert.ok(
      final.dig >= Math.max(...walked),
      '磨到的 DIG（' + final.dig + '）必须够这一段里最高那一档（' + Math.max(...walked) + '）',
    );
  } finally {
    h.app.close();
  }
});
