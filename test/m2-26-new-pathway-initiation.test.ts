/**
 * M2.26 任务 2.6：**两条新途径真的能从 .创建 走到「入途径」** —— 生产链路，零夹具。
 *
 * ## 为什么必须有这一条（这是本批最贵的教训）
 *
 * M2.26 前两批各自跑了一次 50 人小批，两次都读到「新途径 = 0 人」，
 * 两次都被归因成「期望太低 / 抽样运气」（第一批还为此专门论证过 P(0) = 0.119）。
 * **两次都错**：
 *
 *   玩家入哪条途径**不是**由画像偏好决定的 —— 是「本城引导势力名单」决定的：
 *     · 保底那条路：pickGuidedFaction 从本城势力里挑一家；
 *     · 自己找那条路：rollRecipeClue 走的也是同一份本城势力名单。
 *
 * 而 `factions.yaml` 里**没有任何一家势力传承 perfect / reader** ⇒
 * 这两条途径在小批里的期望**本来就是 0**，不是「低」。
 *
 * 小批读数**永远证明不了这件事**（期望 0 与期望 1.7 在下一次抽样里长得一模一样），
 * 所以判据必须是**不依赖抽样**的：一个玩家，从建号开始，被那家势力找上，做任务，
 * 拿到配方，凑材料，调制，服用 —— 断言他**真的成了那条途径的人**。
 *
 * 形状照抄 `test/m2-19.test.ts` 的「生产链路」那条（M2.19 给普利兹港加引水人协会时写的），
 * 它们是同一件事：**新途径需要一个传承它的势力，否则内容做了也走不到**。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadFactions, loadRecipes } from '../src/data/loader.ts';
import { potionProductId, type RecipeDef } from '../src/domain/potion/recipe.ts';
import { FLAG_LOCATION } from '../src/infra/db/flags.ts';
import { createHarness, type Harness } from './helpers/app.ts';

/**
 * 凑齐材料 → 反复调制直到出一瓶 → 服用，返回服用那一刻的回执。
 *
 * 与 `test/m2-19.test.ts` 的同名函数一字不差：两条入途径链路（被人找上 / 自己找）
 * 在这一步之后完全一样。调制有失败概率，失败就补料重试；
 * 重试之间必须跨过 .魔药 的频控，还要把 MP / COR 复位。
 */
async function brewAndDrink(
  h: Harness,
  userId: string,
  characterId: string,
  recipe: RecipeDef,
): Promise<string> {
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
  const drunk = await h.send({ rawText: '.服用 ' + potionProductId(recipe), userId });
  return drunk.map((message) => message.text).join('\n');
}

/** 把一个人挪到某座城市（出生城市是派生的，测试要指定城市只能这样摆夹具） */
function moveTo(h: Harness, characterId: string, cityId: string, center: string): void {
  const state = h.repos.characters.findById(characterId)!;
  h.repos.characters.update({ ...state, currentCityId: cityId, updatedAt: h.now() });
  h.repos.flags.set(characterId, FLAG_LOCATION, h.now(), center);
}

/**
 * 生产链路：建号 → 翻到目标途径的线索 → 调制 → 服用 → 入途径。
 *
 * M2.85：原来「等目标势力找上门」的邀约链路随引导玩法删除。
 * 「cityId 传 pathway 的是 factionId」这条内容事实改为直接对内容表断言；
 * 线索的途径落点（本城势力权重）由判定层测试与 test/m2-7-6 的双向对齐守卫。
 */
async function runInitiation(input: {
  h: Harness;
  userId: string;
  name: string;
  cityId: string;
  cityCenter: string;
  pathway: 'perfect' | 'reader' | 'mother';
  factionId: string;
  label: string;
}): Promise<void> {
  const { h, userId, name, cityId, cityCenter, pathway, factionId, label } = input;
  const mortal = await h.createMortal(userId, name);
  assert.equal(mortal.pathwayStatus, 'mortal', '.创建 出来的是一张白纸');
  moveTo(h, mortal.id, cityId, cityCenter);

  const { factions: allFactions } = loadFactions();
  const owner = allFactions.find((entry) => entry.id === factionId)!;
  assert.equal(owner.cityId, cityId);
  assert.equal(
    owner.pathway,
    pathway,
    cityId + ' 传 ' + pathway + ' 的那家势力应当是 ' + factionId + '（否则这张配方玩家永远翻不到 —— 这正是 M2.26 前两批 0 人的根因）',
  );

  // 翻到一张写着主材料的纸（M2.85 起这是唯一入口）
  h.repos.clues.insert({
    id: 'clue-' + pathway,
    characterId: mortal.id,
    pathway,
    clueText: '一张看不懂的纸。',
    foundAt: h.now(),
    usedAt: null,
  });

  const { recipes } = loadRecipes();
  const recipe = recipes.find((entry) => entry.pathway === pathway && entry.seq === 9)!;
  const text = await brewAndDrink(h, userId, mortal.id, recipe);

  assert.match(text, new RegExp('【入途径 · ' + label + '】'), '入途径的回执要用「' + label + '」这个中文途径名');
  const initiated = h.repos.characters.findById(mortal.id)!;
  assert.equal(initiated.pathwayStatus, 'initiated');
  assert.equal(initiated.pathway, pathway);
  assert.equal(initiated.sequence, 9);
  assert.equal(h.repos.clues.unusedOf(mortal.id).length, 0, '入途径之后线索被用掉');
}

test('M2.26 任务 2.6：贝克兰德的完美者由引导势力带出来 —— .创建 → 被找上 → 做任务 → 调制 → 服用', async () => {
  const h = createHarness();
  try {
    await runInitiation({
      h,
      userId: '840001',
      name: '桥上的工匠',
      cityId: 'backlund',
      cityCenter: 'backlund',
      pathway: 'perfect',
      factionId: 'steam_guild',
      label: '完美者',
    });
  } finally {
    h.app.close();
  }
});

test('M2.26 任务 2.6：特里尔的阅读者由引导势力带出来 —— .创建 → 被找上 → 做任务 → 调制 → 服用', async () => {
  const h = createHarness();
  try {
    await runInitiation({
      h,
      userId: '840002',
      name: '旧书摊边上的人',
      cityId: 'trier',
      cityCenter: 'trier',
      pathway: 'reader',
      factionId: 'bookmen_trier',
      label: '阅读者',
    });
  } finally {
    h.app.close();
  }
});

test('M2.26 任务 3.5：拜朗的母亲由引导势力带出来 —— .创建 → 被找上 → 做任务 → 调制 → 服用', async () => {
  /*
   * ⚠️ 这一条在**补势力之前必然红**（`assert.ok(offer, …)` 找不到那家势力）——
   * 而拜朗在补之前只有死神教会（不眠者）与部落萨满（愚者）两家 ⇒ 母亲的期望是 0。
   * 这正是第三批「三件事必须同步」的验收点：cities.yaml 开 mother、factions.yaml 加传承它的势力、
   * 然后这一条才会绿（K18：守卫的方向要覆盖链路两端）。
   */
  const h = createHarness();
  try {
    await runInitiation({
      h,
      userId: '840003',
      name: '地头边上的人',
      cityId: 'byron',
      cityCenter: 'byron',
      pathway: 'mother',
      factionId: 'field_wardens_byron',
      label: '母亲',
    });
  } finally {
    h.app.close();
  }
});
