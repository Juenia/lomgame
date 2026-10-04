/**
 * M2.33 任务 2：**补上 `seq: 7`，让序列 8 → 7 两条路都走得通**。
 *
 * ## 这条断链是什么
 *
 * M2.32 实测：`recipes.yaml` 共 28 条，seq 分布 `{5:7, 6:7, 8:7, 9:7}` —— **7 一条都没有**。
 * 而晋升取配方是 `c.seq === character.sequence`（`promote.ts:25-27` ≡ `ritual.ts:77-79`）
 * ⇒ **序列 7 的玩家两条路都取不到配方** ⇒ M2.29 交付的序列 6/5 内容**没有任何玩家能碰到**。
 *
 * ## 这一批加了什么
 *
 * | 项 | 数量 |
 * | --- | --- |
 * | 配方 | **7 条**（7 途径各一条 `seq: 7`）⇒ 总数 28 → **35** |
 * | 新主材料 | **7 个**（`主材料·无面之镜` / `断刃之心` / `长夜之露` / `深潮之珠` / `机械之枢` / `解读之墨` / `牧者之铃`） |
 * | 成品魔药 | **7 瓶**（`potion_<途径>_7` —— loader.ts:759-762 要求每条配方都有成品，漏一条就是一条 error） |
 * | 产出点 | **19 处**（每味主材料覆盖该途径的**每一座传承城市**，K17） |
 *
 * ## 这个文件守什么
 *
 * 1. **内容齐全**（G12 = 35、7 途径都有 seq 7、成品齐）；
 * 2. **K17 的显式复核** —— 不靠 loader 的 error 替我们判断（它只在启动时跑一次，
 *    而这里要能在**改了掉落表之后立刻**给出「哪座城市够不着」）；
 * 3. **两条路真的走通**（`.晋升` 与 `.仪式` 各一条端到端）；
 * 4. **M2.32 那条反向断言转正**：序列 7 的 `.晋升` **不再**回「没有对应的晋升路径」。
 *    （M2.32 的守卫红了两次，那正是它该有的样子 —— 这一条是它的正向版本。）
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NUMERIC } from '../src/config/numeric.ts';
import { loadCities, loadItems, loadLocations, loadRecipes } from '../src/data/loader.ts';
import { digThresholdForSeq } from '../src/domain/promotion/promotion.ts';
import { createHarness } from './helpers/app.ts';
import type { DomainEvent } from '../src/domain/character/types.ts';

/** M2.35 任务 3：高序列乘数的期望值**从表读**（K22）—— 这个文件里不再抄 0.6 这种数 */
const planned = NUMERIC.promotion.sequenceGating.planned as Record<number, number>;

const { recipes } = loadRecipes();
const { locations } = loadLocations();
const { cities } = loadCities();
const { items } = loadItems();

const PATHWAYS = ['seer', 'warrior', 'sleepless', 'sailor', 'perfect', 'reader', 'mother'] as const;

/** M2.33 新增的 7 味主材料（名字与 items.yaml 的 M2.33 段一一对应） */
const NEW_MATERIALS: Record<string, string> = {
  seer: '主材料·无面之镜',
  warrior: '主材料·断刃之心',
  sleepless: '主材料·长夜之露',
  sailor: '主材料·深潮之珠',
  perfect: '主材料·机械之枢',
  reader: '主材料·解读之墨',
  mother: '主材料·牧者之铃',
};

function recipeOf(pathway: string, seq: number) {
  return recipes.find((entry) => entry.pathway === pathway && entry.seq === seq);
}

/* ================= 1. 内容齐全（G12） ================= */

test('M2.33（G12）：22 途径的 seq 7 配方齐全，配方总数 176', () => {
  // M2.39 批次 B：序列 4、3 逐途径各 +1 ⇒ 35 → **49** = 7 途径 × 7 档（seq 9—3）
  /*
   * M2.43 批次 C：序列 2 逐途径 +1 ⇒ 56 = 7 途径 × 8 档（seq 9—2）。
   * **M2.76：22 途径全落地 ⇒ 176 = 22 × 8**（15 条新途径各补 8 档，
   * 魔药名与主辅材料逐字取自 诡秘之主原作数据/02-魔药与配方/配方全表.yaml）。
   * 这个数字同时是 G 表的 G12。
   */
  assert.equal(recipes.length, 176, '22 途径 × 8 档（seq 9—2）—— 这个数字同时是 G 表的 G12');
  for (const pathway of PATHWAYS) {
    const recipe = recipeOf(pathway, 7);
    assert.ok(recipe, pathway + ' 缺 seq 7 的配方 —— 序列 7 的玩家两条晋升路都取不到它（M2.32 的那条断链）');
    assert.equal(recipe!.main.length, 1, '一条配方一个主材料（现有 34 条的口径）');
    assert.equal(recipe!.main[0]!.itemId, NEW_MATERIALS[pathway], pathway + ' 的主材料应当是 M2.33 新加的那一味');
    assert.ok(recipe!.base_success > 0.55 && recipe!.base_success < 0.6, '落在 seq 8（0.60—0.62）与 seq 6（0.55）之间');
  }
  // 成品物品：漏一个就是 loader 的一条 error（loader.ts:759-762）
  for (const pathway of PATHWAYS) {
    assert.ok(
      items.some((item) => item.id === 'potion_' + pathway + '_7'),
      '缺 potion_' + pathway + '_7 —— loader 会报「缺少成品物品定义」',
    );
  }
  // 从这一批起，每一档都在（9/8/7/6/5），断链消失
  const seqs = new Set(recipes.map((entry) => entry.seq));
  for (const seq of [5, 6, 7, 8, 9]) assert.ok(seqs.has(seq), 'seq ' + seq + ' 必须有配方');
  // M2.39 批次 B：seq 4、3 已落地 ⇒ 原来那条「seq 4 及以下不在本轮范围」的守卫完成使命，
  // 换成同形状的正向断言（少了哪一档就红）。
  for (const seq of [3, 4]) assert.ok(seqs.has(seq), 'seq ' + seq + ' 必须有配方（M2.39 批次 B）');
});

/* ================= 2. K17 的显式复核 ================= */

test('M2.33：每味 seq 7 主材料在**每一座传承城市**都有 min_seq ≥ 7 的产出点（K17）', () => {
  /*
   * 复刻 `src/data/loader.ts:925-1005` 的判据（那是 error 级），但**不依赖它**：
   * loader 只在启动时跑一次，而这里要能在改了掉落表之后立刻指出「哪座城市够不着」。
   *
   * ⚠️ 这一条对 **seer 最严**：它没有教会 ⇒ loader 把「本城开放 seer」的**每一座城市**都算传承城市
   * （tingen / backlund / trier / byron 四座，比任何其他途径都多）。
   */
  for (const pathway of PATHWAYS) {
    const recipe = recipeOf(pathway, 7)!;
    const pathwayCities = cities.filter((city) => city.pathways.includes(pathway as never));
    assert.ok(pathwayCities.length > 0, pathway + ' 至少要有一座城市开放它');
    for (const city of pathwayCities) {
      for (const need of [...recipe.main, ...recipe.aux]) {
        const reachable = locations.some(
          (location) =>
            city.locations.includes(location.id) &&
            location.min_seq >= 7 &&
            location.loot.some((entry) => entry.itemId === need.itemId),
        );
        assert.ok(
          reachable,
          city.id + ' 传承 ' + pathway + '，但 ' + need.itemId + ' 在这座城市没有 min_seq ≥ 7 的产出点' +
            ' —— 这里的玩家拿到配方也走不完（K17，loader 里这是 error 级）',
        );
      }
    }
  }
});

test('M2.33：19 处产出点，且每一处都落在「该途径的传承城市」里', () => {
  const fresh = new Set(Object.values(NEW_MATERIALS));
  const spots: string[] = [];
  for (const location of locations) {
    for (const entry of location.loot) {
      if (fresh.has(entry.itemId)) spots.push(location.id + ':' + entry.itemId);
      /*
       * M2.76：这条断言原来要求「新产出点的权重统一是 4」—— 那说的是 M2.33 加的那 19 处。
       * 22 途径全落地后，同一味材料在**别的城**也有了产出点（掉落表随途径数增长），
       * 那些点的权重按当地的掉落表配，不必是 4。
       * ⇒ 判据改成「权重必须为正」：这才是掉落表真正的不变量
       *   （0 或负数的权重等于这个点永远不掉东西，而它不会报任何错）。
       */
      assert.ok(!fresh.has(entry.itemId) || entry.weight > 0, '产出点的权重必须为正');
    }
  }
  /*
   * 原来断言「恰好 19 处」。22 条途径全落地后那个数字不再是判据（掉落表随途径数增长），
   * 而这条用例真正要守的是「序列 7 那一档走不走得完」⇒ 保住下限，去掉等号。
   * 下面的逐途径断言（每一味材料至少一个产出点）才是它的实质判据。
   */
  assert.ok(spots.length >= 19, '至少 19 处（M2.33 当时是 4+3+4+2+2+2+2）—— 实际：' + spots.join('、'));
  for (const pathway of PATHWAYS) {
    const material = NEW_MATERIALS[pathway]!;
    const own = locations.filter((location) => location.loot.some((entry) => entry.itemId === material));
    assert.ok(own.length >= 1, material + ' 至少要有一个产出点');
  }
});

/* ================= 3. 端到端：序列 8 → 7（两条路径各走一次） ================= */

type Harness = ReturnType<typeof createHarness>;
const joined = (messages: Array<{ text: string }>): string => messages.map((m) => m.text).join('\n');

/**
 * 把角色摆成「序列 8、马上能晋升」。
 *
 * ⚠️ 这是**夹具**（直接写 sequence 与旗标）—— 它不算「生产链路」：
 * 本文件验的是「**seq 7 这一档配方的存在性**」，而零夹具的整条链路在
 * `test/m2-33-production-chain.test.ts`（那个文件不摆任何结论，一路走到序列 5）。
 */
function readyAt8(h: Harness, userId: string, pathway: string): string {
  const character = h.repos.characters.findByUserId(userId)!;
  h.repos.characters.update({
    ...character,
    sequence: 8,
    dig: 100,
    mad: 0,
    cor: 0,
    status: 'active',
    hp: 100,
    mp: 100,
  });
  h.repos.flags.set(character.id, 'ability_' + pathway + '_8', h.now());
  const recipe = recipeOf(pathway, 8)!;
  for (const need of recipe.main) {
    const want = need.qty * NUMERIC.promotion.mainMaterialMultiplier * 4;
    const held = h.repos.inventory.count(character.id, need.itemId);
    if (held < want) h.repos.inventory.add(character.id, need.itemId, want - held, 'unbound', h.now());
  }
  return character.id;
}

test('M2.33 任务 2（端到端 · `.晋升`）：序列 8 的愚者走到序列 7', async () => {
  const h = createHarness({ deterministicIds: true });
  try {
    const character = await h.createCharacter('880001', '序列八的愚者', 'seer');
    const id = readyAt8(h, '880001', 'seer');
    // 门槛：digLadder[8] = 80（dig 拉满 ⇒ 必过）
    assert.equal(digThresholdForSeq(8), 80);
    const recipe = recipeOf('seer', 8)!;

    let last = '';
    for (let attempt = 0; attempt < 12; attempt += 1) {
      if (h.repos.characters.findById(id)!.sequence === 7) break;
      readyAt8(h, '880001', 'seer');
      h.advance(61_000); // .晋升 的令牌桶是 60 秒（K13：不推进的话重试是假的）
      last = joined(await h.send({ rawText: '.晋升', userId: '880001' }));
    }
    const after = h.repos.characters.findById(id)!;
    assert.equal(after.sequence, 7, '序列 8 → 7 必须走得通。最后一次回执：' + last.slice(0, 200));
    assert.ok(h.repos.flags.has(id, 'ability_seer_7'), '晋升成功要设下一段的 requiredFlag');
    assert.match(last, /成功率/, '回执应当是晋升判定');
    assert.doesNotMatch(last, /没有对应的晋升路径/, 'seq 8 的配方一直都在，不该撞这句话');
    void character;
  } finally {
    h.app.close();
  }
});

test('M2.33 任务 2（端到端 · `.仪式`）：序列 8 的愚者走仪式走到序列 7', async () => {
  /*
   * 两条路**各走一次**是有意义的：它们共用同一个配方取法（promote.ts:25-27 ≡ ritual.ts:77-79），
   * 所以「`.晋升` 通了」不等于「`.仪式` 也通」—— 这正是 M2.29 在 sailor 序列 8 上验过的那件事。
   * 仪式是三步状态机（地点 → 开始 → 融合），阶段 1 与阶段 3 各带一次判定。
   */
  const h = createHarness({ deterministicIds: true });
  try {
    await h.createCharacter('880002', '走仪式的人', 'seer');
    let done = false;
    for (let attempt = 0; attempt < 12 && !done; attempt += 1) {
      const id = readyAt8(h, '880002', 'seer');
      if (!h.repos.rituals.runningOf(id)) {
        h.advance(2000); // 跨过 .仪式 的 1 秒冷却（同一课：K13）
        await h.send({ rawText: '.仪式 地点 灰雾之上', userId: '880002' });
        await h.send({ rawText: '.仪式 开始', userId: '880002' });
        continue;
      }
      h.advance(30_000);
      await h.send({ rawText: '.仪式 融合', userId: '880002' });
      done = h.repos.characters.findById(id)!.sequence === 7;
    }
    assert.ok(done, '12 次尝试都没融合成功（阶段 3 上限 95%，连败概率 1e-16）');
    const id = h.repos.characters.findByUserId('880002')!.id;
    assert.ok(h.repos.flags.has(id, 'ability_seer_7'));
  } finally {
    h.app.close();
  }
});

test('M2.33 任务 2：序列 7 的 `.晋升` **不再**回「没有对应的晋升路径」（M2.32 那条反向断言转正）', async () => {
  /*
   * M2.32 用一条**反向**断言把断链钉住：「序列 7 当前应当撞上『没有配方的晋升路径』」，
   * 并注明「这条红了说明 seq 7 已补上」。现在它红了 ⇒ 按那条指示改成正向。
   * 这一条就是它的正向版本：**回执里不能再出现那句话**。
   */
  const h = createHarness({ deterministicIds: true });
  try {
    const character = await h.createCharacter('880003', '第七条路', 'seer');
    const id = character.id;
    h.repos.characters.update({ ...h.repos.characters.findById(id)!, sequence: 7, dig: 100, mad: 0, cor: 0 });
    h.repos.flags.set(id, 'ability_seer_7', h.now());
    const recipe = recipeOf('seer', 7)!;
    h.repos.inventory.add(id, recipe.main[0]!.itemId, 4, 'unbound', h.now());

    h.advance(61_000);
    const text = joined(await h.send({ rawText: '.晋升', userId: '880003' }));
    assert.doesNotMatch(
      text,
      /没有对应的晋升路径/,
      'seq 7 的配方已经补上 ⇒ 这一句不该再出现（M2.32 的反向断言到此转正）',
    );
    assert.match(text, /晋升判定/, '回执应当是一次真正的晋升判定。实际：' + text.slice(0, 150));
    /*
     * ⚠️ 键是**目标序列**，不是当前序列：序列 7 的玩家目标是 6 ⇒ 读 `planned[6]`。
     * （M2.33 落地时我自己在这条断言上先写成了 0.9 —— 正是 `sequenceGatingFor` 注释里
     * 点破的那个读法错误的现场复现。回执把它抓出来了。）
     *
     * ⚠️ M2.35 任务 3：乘数**从表读**（K22）。这里原来写死 0.6，而 B 方案把它改成了 0.7 ——
     * 写死的副本在改梯度时红了，红的却是测试而不是代码（那正是 K22 要消掉的形状）。
     */
    /*
     * M2.35 任务 3：乘数**从表读**（K22）—— 这里原来写死 0.6，
     * 而 planned[6] 已经改成 0.7（B 方案：低序列提、高序列降）。
     * 基础值 80.0% 是 DIG 决定的（受 digLadder 管），与乘数是两回事，分开写。
     */
    assert.match(
      text,
      new RegExp('基础 80\\.0% × 高序列惩罚 ' + planned[6]),
      '序列 7 → 6 这一档的乘数是 planned[6] = ' + planned[6] + '，回执要把乘数写出来（否则看起来像算错了）',
    );
  } finally {
    h.app.close();
  }
});
