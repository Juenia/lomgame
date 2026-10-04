/**
 * M2.29 任务 3：**sailor 序列 8 走通两条晋升路径**（补 M2.19 的缺口）。
 *
 * ## 缺口是什么
 *
 * `sailor` 原本只有 `sailor_9`。而两条晋升路径**共用同一个配方取法**：
 *
 *     deps.recipes.forPathway(character.pathway).find((c) => c.seq === character.sequence)
 *     （promote.ts:25-27 ≡ ritual.ts:77-79）
 *
 * ⇒ 序列 8 的水手取不到配方 ⇒ `.晋升` 回「这个序列暂时没有对应的晋升路径」，
 *   仪式那条路的 `requirement` 也变成 `null`。**两条路都走不通。**
 *
 * ## 判据分两层（照 M2.29 任务 2 的经验：命令层验「走得到」，判定层验「算得对」）
 *
 * | 层 | 用例 | 判据 |
 * | --- | --- | --- |
 * | 判定层 | D1 | 配方在、门槛算得出、目标序列正确 |
 * | 命令层 | D2 / D3 | `.晋升` 与 `.仪式 准备` 都**不再是「没有配方」那句拒绝** |
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadRecipes } from '../src/data/loader.ts';
import { digThresholdFor, promotionRequirement } from '../src/domain/promotion/promotion.ts';
import type { InitiatedCharacter } from '../src/domain/character/types.ts';
import { FLAG_LOCATION } from '../src/infra/db/flags.ts';
import { createHarness, type Harness } from './helpers/app.ts';

const NO_PATH = '这个序列暂时没有对应的晋升路径';

function sailor8(): InitiatedCharacter {
  return {
    id: 'c-sailor8',
    userId: 'u-sailor8',
    name: '序列八的水手',
    pathway: 'sailor',
    sequence: 8,
    pathwayStatus: 'initiated',
    gender: 'male',
    hp: 100,
    mp: 100,
    mad: 20,
    cor: 0,
    dig: 90,
    dp: 0,
    status: 'active',
    promotionFails: 0,
    createdAt: 0,
    updatedAt: 0,
  } as InitiatedCharacter;
}

/* ---- 判定层 ---- */

test('M2.29 D1：`sailor_8` 在内容表里，且门槛/目标序列都算得出来', () => {
  const recipe = loadRecipes().recipes.find((r) => r.pathway === 'sailor' && r.seq === 8);
  assert.ok(recipe, 'sailor 序列 8 的配方必须存在 —— 缺它就是序列 8 的水手走不通（本用例守的就是这个）');

  const requirement = promotionRequirement(recipe!, sailor8());
  assert.equal(requirement.targetSequence, 7, '通向序列 7');
  // 8→7 走的是序列 7 那一档门槛（`digThresholdFor` 按 recipe.seq <= 8 分流）
  assert.equal(digThresholdFor(recipe!), 80, '8→7 的门槛是 80（与其余六条途径同口径）');
  assert.ok(requirement.materials.length > 0, '要有主材料要求');
  // requiredFlag 指向「已服用过序列 8 的魔药」那个 flag
  assert.equal(requirement.requiredFlag, 'ability_sailor_8');
});

/* ---- 命令层 ---- */

/** 把一个人挪到某座城市（出生城市是派生的，测试要指定城市只能这样摆夹具） */
function place(h: Harness, characterId: string, cityId: string): void {
  const state = h.repos.characters.findById(characterId)!;
  h.repos.characters.update({ ...state, currentCityId: cityId, updatedAt: h.now() });
  h.repos.flags.set(characterId, FLAG_LOCATION, h.now(), 'pritz');
}

async function sailorAt(h: Harness, userId: string, name: string) {
  const character = await h.createCharacter(userId, name, 'sailor');
  const state = h.repos.characters.findById(character.id)!;
  h.repos.characters.update({ ...state, sequence: 8, dig: 90, mp: 100, hp: 100, status: 'active' });
  place(h, character.id, 'pritz');
  return character;
}

test('M2.29 D2（命令层）：序列 8 的水手发 `.晋升`，**不再**回「没有对应的晋升路径」', async () => {
  const h = createHarness({ deterministicIds: true });
  try {
    const character = await sailorAt(h, '46001', '港口的第八级');
    h.advance(1000);
    const out = await h.send({ rawText: '.晋升', userId: character.userId });
    const text = out.map((message) => message.text).join('\n');
    /*
     * ⚠️ 这一条断言的是**否定式**：不断言「晋升成功」（那取决于 DIG/材料/随机），
     *    只断言**不再撞上那句「没有配方」的拒绝** —— 那正是缺口在玩家侧的样子。
     */
    assert.ok(
      !text.includes(NO_PATH),
      '序列 8 的水手不该再收到「' + NO_PATH + '」—— 收到就说明配方没补上。实际回执：' + text.slice(0, 120),
    );
  } finally {
    h.app.close();
  }
});

test('M2.29 D3（命令层）：序列 8 的水手 `.仪式 准备` 能算出配置（requirement 不是 null）', async () => {
  const h = createHarness({ deterministicIds: true });
  try {
    const character = await sailorAt(h, '46002', '潮汐边的人');
    h.advance(1000);
    const out = await h.send({ rawText: '.仪式 准备', userId: character.userId });
    const text = out.map((message) => message.text).join('\n');
    assert.ok(
      !text.includes(NO_PATH),
      '仪式那条路同样依赖配方（ritual.ts:77-79）—— 它也不该再撞上「没有配方」。实际：' + text.slice(0, 120),
    );
    assert.ok(text.length > 0, '仪式准备要有回执');
  } finally {
    h.app.close();
  }
});
