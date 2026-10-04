/**
 * M2.19 任务 3：接入 sailor（水手）途径，使「可争教会对」≥ 3。
 *
 * 分三段：
 *   §A **可争教会对** —— 从内容表算出来，不手抄数字（这一轮的验收标准）
 *   §B 水手能走完入途径链路 —— .创建 → .调制 → .服用（参考 m2-7-6 的入途径用例）
 *   §C 风暴之主的教会技能能解锁（参考 m2-17 的 D2 / D3）
 *
 * 为什么 §A 要现场算：这一轮改的正是**内容锚点**（风暴之主与女神由同盟改成敌对），
 * 而「几对可争」这个数字会随着内容表的任何一次改动而变。把它写死在断言里，
 * 下一轮改关系时红的是这条用例、而不是那条内容 —— 那就没人知道该改哪一边。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NUMERIC } from '../src/config/numeric.ts';
import { loadContent, loadFactions, loadRecipes } from '../src/data/loader.ts';
import { unlockedChurchAbilities } from '../src/domain/ability/ability.ts';
import { currentRank } from '../src/domain/church/membership.ts';
import { potionProductId, type RecipeDef } from '../src/domain/potion/recipe.ts';
import { FLAG_LOCATION } from '../src/infra/db/flags.ts';
import { createHarness, DEFAULT_USER, type Harness } from './helpers/app.ts';

const content = loadContent();

/* ================================================================== *
 * §A 可争教会对
 * ================================================================== */

interface ContestedPair {
  a: string;
  b: string;
  pathway: string;
  otherPathway: string;
}

/**
 * 「可争」的定义（M2.18-参数扫描 §四）：
 *   一对教会可争 = 两边的 pathway **都非 null**（都有玩家能入教）且 relations **互为 hostile**。
 *
 * 第一条不能省：把还没实现的途径也算进来，就等于把「烈阳教会没有玩家」这件事
 * 当成不存在 —— 而 M2.18 实测出来的「5 次胜利」正是这个数字的直接后果。
 */
function contestedChurchPairs(): ContestedPair[] {
  const churches = content.churches;
  const pairs: ContestedPair[] = [];
  for (let i = 0; i < churches.length; i += 1) {
    for (let j = i + 1; j < churches.length; j += 1) {
      const a = churches[i]!;
      const b = churches[j]!;
      if (!a.pathway || !b.pathway) continue;
      if ((a.relations[b.id] ?? 'neutral') !== 'hostile') continue;
      // 对称由 loader 强制（不对称直接报 error），这里再要求一次 —— 判据写全，不靠别人的校验
      if ((b.relations[a.id] ?? 'neutral') !== 'hostile') continue;
      pairs.push({ a: a.id, b: b.id, pathway: a.pathway, otherPathway: b.pathway });
    }
  }
  return pairs;
}

test('M2.19-A：从内容表算出的「可争教会对」≥ 3', (t) => {
  const pairs = contestedChurchPairs();
  t.diagnostic(
    '可争教会对（两边 pathway 都非 null 且互为 hostile）共 ' +
      pairs.length +
      ' 对：\n' +
      pairs.map((pair) => '  · ' + pair.a + '(' + pair.pathway + ') ↔ ' + pair.b + '(' + pair.otherPathway + ')').join('\n'),
  );

  /*
   * M2.26 第三批之后的结构事实是 ≥ 6（拍板数字：女神/战神/风暴两两敌对 + 蒸汽↔战神 + 蒸汽↔知识）。
   * **M2.76：七家教会全部绑上途径**（22 条正途径全落地）⇒ 可争对只会更多，不会更少。
   * 下限保留 ≥ 6：它守的是「至少还有那么多家互为敌对」，那件事没变。
   */
  assert.ok(pairs.length >= 6, '结构事实是 ≥ 6（拍板数字），实际 ' + pairs.length + ' 对');

  // 具体的五对（顺序无关）：女神 / 战神 / 风暴三家两两敌对 + 蒸汽↔战神 + 蒸汽↔知识
  const key = (pair: ContestedPair) => [pair.a, pair.b].sort().join('|');
  const keys = new Set(pairs.map(key));
  assert.deepEqual(
    [...keys].sort(),
    [
      'earth_mother|god_of_war',
      // M2.76：+烈阳↔女神（sun 落地之后，这家教会终于「有人能入教」，于是算进可争）
      'eternal_blazing_sun|night_goddess',
      'god_of_knowledge|god_of_steam',
      'god_of_steam|god_of_war',
      'god_of_war|night_goddess',
      'god_of_war|storm_lord',
      'night_goddess|storm_lord',
    ],
    '七对可争（M2.26 的六对 + M2.76 的烈阳↔女神）',
  );
});

test('M2.19-A：没实现途径的教会不算「可争」—— 这是这个数字的全部意义', () => {
  const pairs = contestedChurchPairs();
  const involved = new Set(pairs.flatMap((pair) => [pair.a, pair.b]));
  /*
   * M2.76：**七家全部进来了** —— sun 落地之后，烈阳也「有人能入教」，
   * 于是可争名单第一次等于「全部绑了途径的教会」。
   *
   * 这条用例的名字（「没实现途径的教会不算可争」）在 22 途径全落地后
   * **在内容表上不可达**：一家未实现的都不剩。
   * ⇒ 改成守卫**这件事本身**（全绑 = 名单等于全体），比留一条永远不触发的断言强。
   */
  assert.deepEqual(
    [...involved].sort(),
    ['earth_mother', 'eternal_blazing_sun', 'god_of_knowledge', 'god_of_steam', 'god_of_war', 'night_goddess', 'storm_lord'],
    '七家全部绑了途径 ⇒ 敌对关系都算可争',
  );

  const sun = content.churches.find((church) => church.id === 'eternal_blazing_sun')!;
  assert.notEqual(sun.pathway, null, 'M2.76 起太阳途径已落地，烈阳真的绑上了');
  assert.equal(sun.relations['night_goddess'], 'hostile', '这一对确实是 hostile');
  assert.equal(involved.has('eternal_blazing_sun'), true, '绑上途径之后它就算可争了');

  // 风暴之主是真的绑上了 sailor（而不是「登记了但没实现」）
  const storm = content.churches.find((church) => church.id === 'storm_lord')!;
  assert.equal(storm.pathway, 'sailor');
  assert.equal(storm.plannedPathway, null, '途径实现之后 plannedPathway 必须清空');
});

/* ================================================================== *
 * §B 水手能走完入途径链路
 * ================================================================== */

/**
 * 凑齐材料 → 反复调制直到出一瓶 → 服用，返回服用那一刻的回执。
 *
 * 两条入途径链路（被人找上 / 自己找）在这一步之后**完全一样**，
 * 所以它只写一次。调制有失败概率（base_success 0.74），失败就补料重试；
 * 重试之间必须跨过 .魔药 的频控（3 个令牌 + 每 30 秒补一个），
 * 还要把 MP / COR 复位 —— 与 m2-7-6 那段注释是同一个理由。
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

/** 把一个人挪到某座城市（出生城市是派生的，测试要指定城市只能这样摆夹具，与 m2-17 的 prepare 同一手法） */
function moveTo(h: Harness, characterId: string, cityId: string, center: string): void {
  const state = h.repos.characters.findById(characterId)!;
  h.repos.characters.update({ ...state, currentCityId: cityId, updatedAt: h.now() });
  h.repos.flags.set(characterId, FLAG_LOCATION, h.now(), center);
}

/* ---- 生产链路：被人找上（保底那条路） ---- */

test('M2.19-B（生产链路）：普利兹港的水手 —— 内容表对齐 + 翻到线索 → 调制 → 服用', async () => {
  const h = createHarness();
  try {
    const userId = '830003';
    const mortal = await h.createMortal(userId, '港湾边的人');
    assert.equal(mortal.pathwayStatus, 'mortal', '.创建 出来的是一张白纸');
    moveTo(h, mortal.id, 'pritz', 'pritz');

    /*
     * M2.85：原来「等引水人协会找上门」的邀约链路随引导玩法删除。
     * 「普利兹港传水手的是引水人协会」这条内容事实改为直接对内容表断言；
     * 线索的途径落点（本城势力权重）由判定层测试与 test/m2-7-6 的双向对齐守卫。
     */
    const { factions: allFactions } = loadFactions();
    const pilots = allFactions.find((entry) => entry.id === 'harbor_pilots')!;
    assert.equal(pilots.cityId, 'pritz');
    assert.equal(pilots.pathway, 'sailor', '引水人协会传承的必须是水手 —— 否则这张配方玩家永远翻不到');

    // 翻到一张水手的纸（M2.85 起这是唯一入口）
    h.repos.clues.insert({
      id: 'clue-sailor',
      characterId: mortal.id,
      pathway: 'sailor',
      clueText: '一枚被海水磨圆的黄铜纽扣。',
      foundAt: h.now(),
      usedAt: null,
    });

    const { recipes } = loadRecipes();
    const recipe = recipes.find((entry) => entry.pathway === 'sailor' && entry.seq === 9)!;
    const text = await brewAndDrink(h, userId, mortal.id, recipe);

    assert.match(text, /【入途径 · 水手】/, '入途径的回执要用「水手」这个中文途径名');
    const initiated = h.repos.characters.findById(mortal.id)!;
    assert.equal(initiated.pathwayStatus, 'initiated');
    assert.equal(initiated.pathway, 'sailor');
    assert.equal(initiated.sequence, 9);
    assert.equal(h.repos.clues.unusedOf(mortal.id).length, 0, '入途径之后线索被用掉');
  } finally {
    h.app.close();
  }
});

/* ---- 夹具捷径：自己找那条路（线索直接插库） ---- */

test('M2.19-B（夹具捷径 · 自己找那条路）：插一张线索 → .调制 → .服用', async () => {
  const h = createHarness();
  try {
    const userId = '830001';
    const mortal = await h.createMortal(userId, '码头上的新人');
    assert.equal(mortal.pathwayStatus, 'mortal', '.创建 出来的是一张白纸');

    /*
     * ⚠️ 这一条是**夹具捷径**：生产链路见上面那条（被人找上那条路，一行夹具都没有）。
     *
     * 这一条守的是「自己找」那条路的**后半段**：手上有配方 → 凑材料 → 调制 → 服用 → 入途径。
     * 前半段（5% 探索翻到线索、以及线索正文按途径取 CLUE_TEXT）由 m2-7-6 的纯函数用例守着，
     * 这里直接插一张库里的线索把两段接起来 —— 与 m2-7-6 第二个端到端用例同一手法。
     */
    h.repos.clues.insert({
      id: 'clue-sailor',
      characterId: mortal.id,
      pathway: 'sailor',
      clueText: '一张被盐渍透的纸，上面只有一行字：海盐结晶。',
      foundAt: h.now(),
      usedAt: null,
    });

    // 配方与材料都从内容表读，不手抄
    const { recipes } = loadRecipes();
    const recipe = recipes.find((entry) => entry.pathway === 'sailor' && entry.seq === 9)!;
    assert.equal(recipe.id, 'sailor_9');
    assert.ok(recipe.main.length >= 1 && recipe.aux.length >= 1, '主材料与辅助材料都要有');

    const text = await brewAndDrink(h, userId, mortal.id, recipe);
    assert.match(text, /【入途径 · 水手】/, '入途径的回执要用「水手」这个中文途径名');
    assert.match(text, /水手序列 9/, '序列 9 的称号也从内容表来');

    const initiated = h.repos.characters.findById(mortal.id)!;
    assert.equal(initiated.pathwayStatus, 'initiated');
    assert.equal(initiated.pathway, 'sailor');
    assert.equal(initiated.sequence, 9);
    assert.equal(h.repos.clues.unusedOf(mortal.id).length, 0, '入途径之后线索被用掉');
  } finally {
    h.app.close();
  }
});

test('M2.19-B：水手的序列 9 主材料在普利兹港真的捡得到（潮汐码头，min_seq 9）', () => {
  const { recipes } = loadRecipes();
  const recipe = recipes.find((entry) => entry.id === 'sailor_9')!;
  const pritz = content.cities.find((city) => city.id === 'pritz')!;
  const harbor = content.locations.find((location) => location.id === 'pritz_harbor')!;

  assert.equal(harbor.min_seq, 9, '拿配方的人必然是还没有序列的普通人 —— 产出点必须是 9');
  assert.ok(pritz.locations.includes(harbor.id), '潮汐码头要在普利兹港名下');

  for (const need of [...recipe.main, ...recipe.aux]) {
    const reachable = content.locations.some(
      (location) =>
        pritz.locations.includes(location.id) &&
        location.min_seq >= recipe.seq &&
        location.loot.some((loot) => loot.itemId === need.itemId),
    );
    assert.ok(reachable, need.itemId + ' 在普利兹港没有 min_seq ≥ 9 的产出点');
  }
});

/* ================================================================== *
 * §C 风暴之主的教会技能
 * ================================================================== */

test('M2.19-C：风暴之主的教会技能按档位解锁（算出来的，不落库）', () => {
  const defs = content.churchAbilities;

  assert.deepEqual(unlockedChurchAbilities(0, 'storm_lord', defs), [], '信徒（0 档）还没有技能');
  const atRank1 = unlockedChurchAbilities(1, 'storm_lord', defs);
  assert.equal(atRank1.length, 1, '1 档解锁第 1 条');
  assert.equal(atRank1[0]!.id, 'storm_lord_1_steady_deck');
  assert.equal(atRank1[0]!.effect.exploreDangerMultiplier, 0.95);
  /*
   * M2.19 收尾：风暴之主的教会技能从 1 条补齐到 3 条（与女神 / 战神对齐）。
   * 理由不是凑数 —— 可争的三对里有一对是「风暴↔战神」，只有一条探索向技能的水手
   * 在那一对里等于没练过（结构指标达标 ≠ 那条路真能打）。
   */
  assert.deepEqual(
    unlockedChurchAbilities(5, 'storm_lord', defs).map((ability) => ability.id),
    ['storm_lord_1_steady_deck', 'storm_lord_2_windward', 'storm_lord_3_storm_eye'],
    '档位拉满时三档的技能都在（解锁是算出来的，不落库）',
  );
  assert.deepEqual(unlockedChurchAbilities(2, 'storm_lord', defs).map((a) => a.id), [
    'storm_lord_1_steady_deck',
    'storm_lord_2_windward',
  ]);
  assert.equal(unlockedChurchAbilities(3, 'storm_lord', defs).length, 3);

  // 途径能力与教会技能叠在同一个数字上（两源合并，M2.17）
  const mergeable = [...content.abilities.filter((ability) => ability.pathway === 'sailor'), ...atRank1];
  assert.deepEqual(
    mergeable.map((ability) => ability.id).sort(),
    // M2.29：批次 A1 加 sailor_6、批次 A2 加 sailor_5；M2.39 批次 B 加 sailor_4 / sailor_3；M2.43 批次 C 加 sailor_2
    ['sailor_2', 'sailor_3', 'sailor_4', 'sailor_5', 'sailor_6', 'sailor_7', 'sailor_8', 'storm_lord_1_steady_deck'],
    '水手的能力 + 风暴之主的教会技能都进得来',
  );
});

test('M2.19-C：水手真的进得去风暴之主的教会（据点城市 pritz / backlund）', async () => {
  const h = createHarness({ deterministicIds: true });
  try {
    const created = await h.createCharacter(DEFAULT_USER, '普利兹港的水手', 'sailor');
    const state = h.repos.characters.findById(created.id)!;
    // 出生地是派生出来的，这里把他挪到风暴之主的据点城市（席位与城市是两件事）
    h.repos.characters.update({ ...state, currentCityId: 'pritz', updatedAt: h.now() });
    h.advance(1000);

    const joined = await h.send({ rawText: '.加入教会 storm_lord', userId: DEFAULT_USER });
    const text = joined.map((message) => message.text).join('\n');
    assert.match(text, /【入教 · 风暴之主】/, '水手必须能入这一家：' + text.slice(0, 120));

    const after = h.repos.characters.findById(created.id)!;
    assert.equal(after.churchId, 'storm_lord');

    // 档位是算出来的：贡献到了门槛就是 1 档，也就解锁了那一条技能
    const storm = content.churches.find((church) => church.id === 'storm_lord')!;
    const threshold = NUMERIC.church.ranks.contributionThreshold[1] ?? 5;
    const rank = currentRank({ churchContribution: threshold, sequence: state.sequence ?? 9 }, storm);
    assert.equal(rank, 1);
    assert.equal(unlockedChurchAbilities(rank, 'storm_lord', content.churchAbilities).length, 1);
  } finally {
    h.app.close();
  }
});
