/**
 * M2.40：**显示名** —— 群里不该出现 id。
 *
 * ## 这一轮修的是什么
 *
 * 玩家在群里看到的 `事件【daily_013】` / `调制【seer_9】`，根因是**两件事叠在一起**：
 *
 *   1. 渲染层直接念 id（`play.ts` / `event.ts` / `explore.ts` 念 `card.id`；`brew.ts` 念 `recipe.id`）；
 *   2. 被念的那两类内容**当时根本没有名字**（卡片 schema 没有 `name`、配方也没有）。
 *
 * 修法：数据源补权威名字（卡片 YAML 的 `name`；配方从**成品物品**派生），
 * 渲染层一律走 `src/domain/display.ts`。见 `docs/M2.40-显示名修复.md`。
 *
 * ## 这个文件守什么
 *
 * 1. 65 张卡都有中文名，且两两不同（渲染层用它去重，重名会静默改变语义）；
 * 2. 49 条配方的显示名 = 成品物品的中文名，**不是**配方 id；
 * 3. 端到端：群里的回执标题里不含 id（这条是「不再回归」的那道闸）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadCards } from '../src/cards/loader.ts';
import { loadItems, loadRecipes } from '../src/data/loader.ts';
import { PATHWAY_LABELS } from '../src/domain/character/rules.ts';
import { cardDisplayName, recipeDisplayName, type ItemNameLookup } from '../src/domain/display.ts';
import { createHarness } from './helpers/app.ts';

/** 「像 id」的形状：全小写字母开头 + 下划线/数字。纯 ASCII，不含全角字符 */
const ID_LIKE = /^[a-z][a-z0-9_]*$/;
const HAN = /[一-龥]/;
const OPEN = '\u3010';
const CLOSE = '\u3011';

/**
 * 从回执里取出标题。
 *
 * M2.45 第二十三版起，回执小标题统一成独立成行的 `**事件 · 名字**`（行内的 `事件【…】`
 * 拿不到加粗，渲染层只认**独占一行**的【…】）—— 所以这里按新格式取，
 * 后面还可能跟 ` · 地点`，一并由调用方比对。
 */
function headOf(text: string, label: string): string | null {
  /*
   * ⚠️ M2.90：**不再假设标题是 `**标签 · 名字**`。**
   *
   * M2.86 加了 emoji 与上色之后，标题长这样：
   *   `🔮 调制 · 魔药·愚者·序列9 · 成功率 $...$`（原来是 `**调制 · seer_9**`）
   * 而这条断言还按老格式去找前缀，于是「要有调制标题」一直红 —— 而回执里
   * 那行标题其实一直在。判据改成「按标记定位那一行」，再去掉加粗标记。
   */
  const mark = label + ' · ';
  const line = text.split(String.fromCharCode(10)).find((row) => row.includes(mark));
  if (!line) return null;
  const rest = line.slice(line.indexOf(mark) + mark.length);
  const end = rest.indexOf(' · ');
  return (end >= 0 ? rest.slice(0, end) : rest).replace(/\*\*/g, '');
}

function itemLookup(): ItemNameLookup {
  const index = new Map(loadItems().items.map((item) => [item.id, item]));
  return { get: (id: string) => index.get(id) ?? null };
}

test('M2.40：每张事件卡都有中文显示名，且两两不同', () => {
  const { cards } = loadCards();
  // 现场读：daily 51 + mortal 14 = 65
  assert.ok(cards.length >= 65, '卡数应当不少于 65，实际 ' + cards.length);

  const seen = new Set<string>();
  for (const card of cards) {
    assert.ok(card.name.length > 0, card.id + ' 缺显示名');
    assert.ok(!ID_LIKE.test(card.name), card.id + ' 的显示名还是 id 形状：' + card.name);
    assert.ok(HAN.test(card.name), card.id + ' 的显示名里没有中文：' + card.name);
    assert.equal(cardDisplayName(card), card.name, '显示名必须来自卡片 YAML（唯一权威）');
    seen.add(card.name);
  }
  /*
   * 唯一性是**功能性的**，不是审美要求：
   * `.事件：同一天不会重复触发同一张卡` 那条用例拿显示名当去重键。
   */
  assert.equal(seen.size, cards.length, '显示名必须两两不同');
});

test('M2.40：魔药的显示名 = 成品物品的中文名，不是配方 id', () => {
  const { recipes } = loadRecipes();
  const items = itemLookup();
  // M2.76：22 途径全落地 ⇒ 176 = 22 × 8 档（seq 9—2）
  assert.equal(recipes.length, 176, '22 途径 × 8 档（seq 9—2）');

  for (const recipe of recipes) {
    const name = recipeDisplayName(recipe, items);
    assert.notEqual(name, recipe.id, recipe.id + ' 的显示名回落成了 id —— 说明成品物品查不到');
    assert.ok(HAN.test(name), recipe.id + ' 的显示名里没有中文：' + name);
  }
});

test('M2.40：批次 B 的新配方（seq 4 / 3）显示名也全中文', () => {
  /*
   * M2.76：这一段原来**又手抄了一份途径中文名**（第 7 处同形状的副本）——
   * 它抄的内容与 `PATHWAY_LABELS` 一模一样，而抄的代价是 15 条新途径在这里没有名字。
   * ⇒ 直接用 `PATHWAY_LABELS`（途径中文名的唯一出处）。
   */
  const { recipes } = loadRecipes();
  const items = itemLookup();
  const fresh = recipes.filter((recipe) => recipe.seq === 4 || recipe.seq === 3);
  // M2.76：14（7 途径 × 2 档）→ **44**（22 × 2）
  assert.equal(fresh.length, 44, '批次 B 的 44 个节点（22 途径 × seq 4/3）');
  for (const recipe of fresh) {
    assert.equal(
      recipeDisplayName(recipe, items),
      '魔药·' + PATHWAY_LABELS[recipe.pathway] + '·序列' + recipe.seq,
      recipe.id + ' 的显示名应当等于成品名',
    );
  }
});

test('M2.40 端到端：群里的回执标题不含 id', async () => {
  const h = createHarness();
  try {
    const c = await h.createCharacter('20001', '测试者', 'seer');
    const join = (sent: Array<{ text: string }>): string => sent.map((m) => m.text).join(String.fromCharCode(10));

    const eventHead = headOf(join(await h.send({ rawText: '.事件', scene: 'group' })), '事件');
    assert.ok(eventHead, '要有事件标题');
    assert.ok(!ID_LIKE.test(eventHead!), '事件标题里不该是 id：' + eventHead);

    h.repos.inventory.add(c.id, '主材料·灰雾结晶', 2, 'unbound', h.now());
    h.repos.inventory.add(c.id, '辅助材料·银粉', 2, 'bound', h.now());
    const brewHead = headOf(join(await h.send({ rawText: '.魔药', scene: 'group' })), '调制');
    assert.ok(brewHead, '要有调制标题');
    assert.ok(!ID_LIKE.test(brewHead!), '调制标题里不该是 id：' + brewHead);
    assert.ok(HAN.test(brewHead!), '调制标题应当是中文魔药名：' + brewHead);

    const listText = join(await h.send({ rawText: '.魔药 没有这瓶', scene: 'group' }));
    assert.ok(!/[a-z]+_\d+（序列/.test(listText), '候选清单里不该出现配方 id');
  } finally {
    h.app.close();
  }
});
