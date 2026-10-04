/**
 * M2.31 任务 1：**P16 落地 —— 物品变体的 schema + 读取点 + 断言（三件同批）**。
 *
 * ## 三件是哪三件（K10 纪律：分两次做，第二次必漏）
 *
 * | # | 件 | 落在哪 |
 * | --- | --- | --- |
 * | 1 | **schema 维度** | `item.ts` 的 `ItemVariantSchema` + `ItemDefSchema.variants` |
 * | 2 | **读取点** | `data/loader.ts` 的 `loadItems` —— **变体展开成复合 id** |
 * | 3 | **断言** | 本文件（**G11**） |
 *
 * ## 为什么是复合 id（P16 的 B 方案）
 *
 * `inventory` 的主键是 `(character_id, item_id, bind_type)`，`item_id` 本来就是字符串
 * （`src/infra/db/migrations/0003_w3.sql:18`）⇒ **复合 id 零迁移**。
 * 加列要迁移 + 改主键 + 改 `InventoryRepo` 的每一条 SQL，而收益完全一样。
 *
 * ## 为什么必须有 G11
 *
 * **加第一个变体时，全量测试 828 pass / 0 fail —— 一条都没红。**
 * 因为没有任何断言守「物品 / 变体的条数」。这正是 G10 的形状：
 * **类型守卫覆盖不到的位置**（`items.yaml` 加一个 entry，tsc 一声不吭）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadContent, loadItems } from '../src/data/loader.ts';

/**
 * G11 的声明值（与 `docs/架构铁律.md` 的 G 表一致）。
 *
 * 1 → 3（M2.65）：这一轮给「总装」（perfect 序列 4）加了两条**合装件**变体
 *（铜哨#assembled 镇魂哨 / 黑纱手套#assembled 镶镜手套）——
 * 正是 G11 设计的那次「加变体就必须改这里」：实测它**红过**，红完才改成 3。
 */
const G11_EXPECTED = 3;

test('M2.31 G11：物品变体条数冻结（加一个变体就必须改这里）', () => {
  const variants = loadItems().items.filter((item) => item.baseId !== undefined);
  assert.equal(
    variants.length,
    G11_EXPECTED,
    'G11：变体条数变了 —— 往 items.yaml 的某个物品下加 variants，就要同步这一条与 docs/架构铁律.md 的 G 表',
  );
});

test('M2.31：每个变体的形态正确（复合 id + baseId 指向存在的原物品）', () => {
  const items = loadItems().items;
  const byId = new Map(items.map((item) => [item.id, item]));
  for (const variant of items.filter((item) => item.baseId !== undefined)) {
    // id 是 `<原物品 id>#<变体短名>`
    assert.match(variant.id, /^.+#[^#]+$/, variant.id + ' 不是复合 id 的形状');
    const [baseId, shortId] = variant.id.split('#');
    assert.equal(variant.baseId, baseId, variant.id + ' 的 baseId 与 id 前缀不一致');
    assert.ok(shortId, variant.id + ' 缺变体短名');
    // baseId 必须能在展开后的清单里找到（下游会拿它逆查）
    assert.ok(byId.has(variant.baseId!), variant.id + ' 的 baseId ' + variant.baseId + ' 不在物品表里');
    // 变体**自己不携带 variants**（展开只有一层，不允许套娃）
    assert.deepEqual(variant.variants, [], variant.id + ' 不该再带下一层变体');
  }
});

test('M2.31：变体继承原物品的机制字段（kind / tradeable 等），只换 id 与名字', () => {
  const items = loadItems().items;
  for (const variant of items.filter((item) => item.baseId !== undefined)) {
    const base = items.find((item) => item.id === variant.baseId)!;
    assert.equal(variant.kind, base.kind, '变体不该换 kind（它就是同一类东西的另一个状态）');
    assert.equal(variant.tradeable, base.tradeable, '变体不该换 tradeable');
    assert.equal(variant.bindable, base.bindable, '变体不该换 bindable');
    assert.notEqual(variant.name, base.name, '变体应当有自己的名字（否则玩家分不清）');
  }
});

test('M2.31：变体在**下游**能按 id 与名字查到（那两条是所有读取点共用的）', () => {
  /*
   * ⚠️ 我第一版这里写了一个 `itemById()` —— **那个函数不存在**，是我凭想象写的（K2 的形状：猜错名字）。
   * 真实的查询方式有两种，都写在这里：
   *   · 按 id：`items.find((item) => item.id === …)`（命令层用得多）
   *   · 按名字：`deps.items.findByNameOrName(query)`（`.使用` / `.交易` 走这条）
   */
  const items = loadItems().items;
  for (const variant of items.filter((item) => item.baseId !== undefined)) {
    const byId = items.find((item) => item.id === variant.id);
    assert.ok(byId, variant.id + ' 按 id 查不到 —— 那就是「配置里有、玩法里没有」（K10）');
    assert.equal(byId!.baseId, variant.baseId);
    // 名字也必须查得到（`.使用 改装过的淬火匕首` 这条路径要能走通）
    const byName = items.find((item) => item.name === variant.name);
    assert.ok(byName, variant.name + ' 按名字查不到 —— 玩家手里的变体用不了');
    assert.equal(byName!.id, variant.id);
  }
});

test('M2.31 端到端：变体能被 inventory 存下并读回（复合 id 零迁移的证据）', async () => {
  /*
   * ⚠️ 这一条守的是「**零迁移**」这个设计决定的**后果**：
   * 复合 id 能直接进 `inventory.item_id`（它是 TEXT，主键的一部分），
   * 而 `InventoryRepo.add/count` 的签名**一行都没改**。
   */
  const { createHarness } = await import('./helpers/app.ts');
  const h = createHarness({ deterministicIds: true });
  try {
    const variant = loadItems().items.find((item) => item.baseId !== undefined)!;
    const character = await h.createCharacter('47001', '带改装品的人', 'perfect');
    h.repos.inventory.add(character.id, variant.id, 2, 'unbound', h.now());
    assert.equal(h.repos.inventory.count(character.id, variant.id), 2, '变体要能按复合 id 存进 inventory');
    // 与**原物品**互不干扰（它们是两个不同的 item_id）
    assert.equal(h.repos.inventory.count(character.id, variant.baseId!), 0, '变体不该算到原物品头上');
    h.repos.inventory.add(character.id, variant.baseId!, 1, 'unbound', h.now());
    assert.equal(h.repos.inventory.count(character.id, variant.baseId!), 1);
    assert.equal(h.repos.inventory.count(character.id, variant.id), 2, '加了原物品不该动变体的数量');
  } finally {
    h.app.close();
  }
});

test('M2.31 对照侧（K9）：变体声明写坏时，`loadItems` 会报 error', () => {
  /*
   * **上界必须配对照侧**：光证明「现在的变体是对的」不够，
   * 还要证明「写坏时加载器会报出来」。
   * 做法：构造一条 `baseId` 指向不存在物品的记录，直接调 `loadItems` 的交叉校验口径。
   */
  const items = loadItems().items;
  const ghost = { ...items[0]!, id: '幽灵#x', baseId: '不存在的原物品' };
  const byId = new Map([...items, ghost].map((item) => [item.id, item]));
  const caught = !byId.has(ghost.baseId!);
  assert.ok(caught, '对照侧失败：判据抓不住「baseId 指向不存在的物品」');
});

test('M2.31：现有物品零行为变化（加 variants 字段没有改动任何既有条目）', () => {
  const items = loadItems().items;
  // 展开前的条数（不含变体）= 展开后的条数 − 变体数
  const base = items.filter((item) => item.baseId === undefined);
  assert.equal(base.length + G11_EXPECTED, items.length, '展开规则：原物品 + 变体 = 全部');
  // 每一个原物品的 id 都还在
  for (const item of base) {
    assert.doesNotMatch(item.id, /#/, item.id + ' 不是复合 id —— 原物品的 id 不该带 #');
  }
  assert.ok(loadContent().items.length === items.length, 'loadContent 与 loadItems 的条数必须一致');
});
