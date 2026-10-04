import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NUMERIC } from '../src/config/numeric.ts';
import {
  FACTIONS,
  factionOfLocation,
  isWildLocation,
  territoryCoverage,
  territoryOf,
} from '../src/domain/faction/faction.ts';
import {
  bountyOf,
  defaultWantedWorld,
  issueWanted,
  levelForTrigger,
  pickActiveWanted,
  resolveReport,
  resolveWanted,
  wantedDurationOf,
  type WantedState,
} from '../src/domain/wanted/wanted.ts';
import { createSeededRng, seedFrom } from '../src/domain/rng.ts';
import { parseCurrency } from '../src/domain/currency/index.ts';
import { TRADE_PRICE_MODEL, tradePriceToken } from '../src/vplayer/decide.ts';
import { collectCurrencyCombo } from '../src/vplayer/analyzer.ts';
import { createHarness } from './helpers/app.ts';

const DAY = 24 * 3600 * 1000;

/** 固定 roll 的 rng：判定可预期，不用去猜 seed 派生出什么 */
const rngOf = (value: number) => ({ next: () => value });

const WORLD = defaultWantedWorld();

function wantedState(over: Partial<WantedState> = {}): WantedState {
  return {
    id: 'w-1',
    characterId: 'c-1',
    level: 1,
    factionId: 'police',
    reason: '重伤了某人',
    createdAt: 1000,
    expiresAt: 1000 + 3 * DAY,
    ...over,
  };
}

/**
 * M2.6.1 起 `.袭击` 是**概率命中**（同序列 50%），M2.6 时代"袭击必定造成伤害"这个前提没了。
 * 这个 helper 把"打到出现通缉为止"封装起来：最多 12 次，全部落空的概率 < 2e-5，
 * 全部落空就说明判定层坏了，直接抛。
 *
 * 每次之间跨过 30 分钟的袭击冷却，并把双方状态补满（测试侧特权 ——
 * 真人靠 .休息 / 每日恢复，测试不需要真的等）。
 */
async function assaultUntilWanted(
  h: ReturnType<typeof createHarness>,
  attackerQq: string,
  targetQq: string,
): Promise<void> {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const attacker = h.repos.characters.findByUserId(attackerQq)!;
    if (h.repos.wanted.listActiveOf(attacker.id, h.now()).length > 0) return;
    const target = h.repos.characters.findByUserId(targetQq)!;
    h.repos.characters.update({ ...attacker, updatedAt: h.now() });
    h.repos.characters.update({ ...target, hp: 100, status: 'active', updatedAt: h.now() });
    await h.send({ rawText: '.袭击 @' + targetQq, userId: attackerQq });
    h.advance(31 * 60 * 1000);
  }
  throw new Error('连续 12 次 .袭击 都没命中（概率 < 2e-5），判定层大概率出了问题');
}

/** 数一数某类 domain_events 有几条 */
function countEvents(h: ReturnType<typeof createHarness>, characterId: string, type: string): number {
  return (
    h.app.db
      .prepare('SELECT COUNT(*) AS n FROM domain_events WHERE character_id = ? AND type = ?')
      .get(characterId, type) as { n: number }
  ).n;
}

/* ================================================================== *
 * 一、势力范围
 * ================================================================== */

test('M2.6 势力范围：四个势力把内容表的全部地点分完，不重不漏', () => {
  // 用建好的 app 读内容表（它已经做过交叉引用校验），而不是再解析一遍 yaml
  const h = createHarness();
  try {
    const ids = h.repos.locations.all().map((location) => location.id);
    // M2.7：地点从 11 涨到 36（贝克兰德 5 + 普利兹港 5 + 特里尔 5 + 拜朗 5 + 苏尼亚海 5）
    // M2.12：序列 7 门槛地点 +5（每座出生城市一个），36 → 41
    // M2.39 批次 B：序列 4/3 的产出点 +12（seer 4 + warrior 6 + perfect 2），41 → 53
    // M2.43 批次 C：序列 2 的产地 +5（每座传承城市一个，min_seq 2），53 → 58
    /*
     * M2.85 内容填充 P2/P4/P6：地点从 58 涨到 97（P2 的 22 座新城落脚点 + 17 个原作地点）。
     * 条数不再写死 —— 这条判据守的是**归属完整性**（不重不漏、四家分完），那件事没变。
     */
    assert.ok(ids.length >= 58, '地点数不少于原来的 58');
    const coverage = territoryCoverage(ids);

    assert.deepEqual(coverage.overlaps, [], '同一个地点不能被两个势力同时声称');
    assert.deepEqual(coverage.unclaimed, [], '内容表里的地点必须都归属某个势力');
    assert.deepEqual(
      coverage.byFaction.map((entry) => entry.id),
      ['police', 'church', 'gang', 'none'],
    );
    assert.equal(coverage.controlled.length, ids.length);
    assert.equal(FACTIONS.length, 4);
  } finally {
    h.app.close();
  }
});

test('M2.6 势力范围：任务书里三个写意的地点 id 已落到内容表的真实 id', () => {
  // 任务书 §主任务一 写的是 lightless_basement / cemetery_path / foggy_street，
  // locations.yaml 里实际是 dark_cellar / graveyard_path / mist_street。
  // 照抄任务书会让黑帮和无主各少一半地盘，而且运行期完全看不出来。
  // M2.7：黑帮的地盘扩到四座新城市（走私码头 / 洞窟 / 铁工厂 / 骨市 / 东区贫民窟）
  // M2.12：序列 7 门槛地点里两个没人管得住的地方也归它（锈蚀回廊 / 潮汐石窟）
  // M2.39 批次 B：序列 4/3 的新地点里七个「没人管得住」的地方（工坊 / 厂房 / 残骸 / 地窖）也归它
  // M2.43 批次 C：序列 2 的两个（无终工坊 / 未录之库）同理
  // M2.85：黑帮的地盘又多了四家酒吧（按「没人管得住的地方」这条老规矩）
  /*
   * M2.85 内容填充：名单不再逐字写死 —— 「不重不漏、四家分完」由上面的 coverage 判据守着（那才是严格性所在），
   * 这里改成「关键地盘还在 + 数量只增不减」，避免每次加一个地点都要改这张手抄名单（AGENTS §3.1）。
   */
  const gangTerritory = territoryOf('gang');
  for (const key of [
    'old_dock', 'dark_cellar', 'pritz_harbor', 'smugglers_cave', 'ironworks', 'bone_market',
    'backlund_slum', 'rusted_gallery', 'tide_cavern', 'endless_workshop', 'unrecorded_vault',
    'brave_bar', 'wild_heart_bar', 'hound_tavern', 'warrior_and_sea_bar',
  ]) {
    assert.ok(gangTerritory.includes(key), '黑帮的地盘少了：' + key);
  }
  assert.ok(gangTerritory.length >= 22, '黑帮的地盘只增不减，实际 ' + gangTerritory.length);

  // M2.12：教会多两处（雾中礼拜堂 / 墓窟深处），疫病坑无主
  assert.equal(factionOfLocation('fog_chapel'), 'church');
  assert.equal(factionOfLocation('deep_catacombs'), 'church');
  assert.equal(factionOfLocation('plague_pit'), 'none');
  assert.ok(territoryOf('none').includes('graveyard_path'));
  assert.ok(territoryOf('none').includes('mist_street'));
  assert.ok(territoryOf('none').includes('sealed_archive'));
  assert.ok(territoryOf('none').includes('above_grey_fog'));
});

test('M2.6 势力归属：认识的地点归对应势力，不认识的一律算无主（安全侧）', () => {
  assert.equal(factionOfLocation('tingen'), 'police');
  assert.equal(factionOfLocation('backlund'), 'police');
  assert.equal(factionOfLocation('steam_station'), 'police');
  assert.equal(factionOfLocation('blackthorn_abbey'), 'church');
  assert.equal(factionOfLocation('candle_bookstore'), 'church');
  assert.equal(factionOfLocation('old_dock'), 'gang');
  assert.equal(factionOfLocation('dark_cellar'), 'gang');
  assert.equal(factionOfLocation('graveyard_path'), 'none');
  assert.equal(isWildLocation('mist_street'), true);
  assert.equal(isWildLocation('tingen'), false);
  // 内容表加了新地点却忘了归属：宁可漏判一次追捕，也不要凭空围剿
  assert.equal(factionOfLocation('某个还不存在的地点'), 'none');
  assert.equal(factionOfLocation(null), 'none');
});

/* ================================================================== *
 * 二、通缉判定（纯函数）
 * ================================================================== */

test('M2.6 判定：没被通缉 / 通缉已过期 → 什么都不发生', () => {
  const action = { type: 'act' as const, locationId: 'tingen' };
  const none = resolveWanted(null, action, WORLD, rngOf(0));
  assert.equal(none.encounter, 'none');

  const now = 1000 + 4 * DAY;
  const state = wantedState();
  assert.ok(state.expiresAt < now, '这条通缉应当已经过期');
  // 过期的通缉令不会进 pickActiveWanted，判定层看到的永远是"没有"
  assert.equal(pickActiveWanted([state], 'police', now), null);
});

test('M2.6 判定：1 级只在**发通缉的那个势力**的地盘上生效', () => {
  const state = wantedState({ level: 1, factionId: 'police' });
  const now = state.createdAt + 1000;

  const inPolice = resolveWanted(
    state,
    { type: 'act', locationId: 'tingen' },
    WORLD,
    rngOf(0),
  );
  assert.equal(inPolice.encounter, 'inquiry');
  assert.equal(inPolice.inTerritory, true);
  assert.equal(inPolice.factionId, 'police');
  assert.equal(inPolice.action, '盘查');

  // 教会的地头不接警察厅的案子 —— 这是「哪个势力在通缉」这句话的实际含义
  const inChurch = resolveWanted(
    state,
    { type: 'act', locationId: 'candle_bookstore' },
    WORLD,
    rngOf(0),
  );
  assert.equal(inChurch.encounter, 'none');
  assert.equal(inChurch.inTerritory, false);

  void now;
});

test('M2.6 判定：无主地点永远安全 —— 这就是「逃到势力范围外」', () => {
  for (const level of [1, 2, 3, 4]) {
    const state = wantedState({ level, factionId: 'police' });
    for (const wild of territoryOf('none')) {
      const result = resolveWanted(
        state,
        { type: 'act', locationId: wild },
        WORLD,
        rngOf(0),
      );
      assert.equal(result.encounter, 'none', level + ' 级在 ' + wild + ' 不该被追捕');
      assert.equal(result.inTerritory, false);
    }
  }
});

test('M2.6 判定：4 级全境通缉跨势力，但一样管不到无主地点', () => {
  const state = wantedState({ level: 4, factionId: 'police' });
  const inChurch = resolveWanted(
    state,
    { type: 'act', locationId: 'blackthorn_abbey' },
    WORLD,
    rngOf(0),
  );
  assert.equal(inChurch.encounter, 'dragnet');
  assert.equal(inChurch.action, '全境通缉');

  const inWild = resolveWanted(
    state,
    { type: 'act', locationId: 'sealed_archive' },
    WORLD,
    rngOf(0),
  );
  assert.equal(inWild.encounter, 'none');
});

test('M2.6 判定：追捕的 roll 只决定「有没有被按住」（M2.85 起不再有 AP 惩罚）', () => {
  const two = resolveWanted(
    wantedState({ level: 2, factionId: 'police' }),
    { type: 'act', locationId: 'tingen' },
    WORLD,
    rngOf(0.99),
  );
  assert.equal(two.encounter, 'pursuit');
  assert.equal(two.hit, false, 'roll 0.99 > chance 0.6，这一次没被按住');
});

test('M2.6 判定：同一个 seed 必然得到同一个 roll（可复现）', () => {
  const state = wantedState({ level: 1, factionId: 'police' });
  const seed = seedFrom(['m2-6', 'reproduce']);
  const run = () =>
    resolveWanted(
      state,
      { type: 'act', locationId: 'tingen' },
      WORLD,
      createSeededRng(seedFrom([seed, 'wanted'])),
    );
  const a = run();
  const b = run();
  assert.deepEqual(
    { chance: a.chance, roll: a.roll, hit: a.hit, fine: a.finePenny },
    { chance: b.chance, roll: b.roll, hit: b.hit, fine: b.finePenny },
  );
});

test('M2.6 判定：安全区里**不推进随机流**（同 seed 别的判定不会漂）', () => {
  let calls = 0;
  const counting = {
    next: () => {
      calls += 1;
      return 0;
    },
  };
  // 没有通缉
  resolveWanted(null, { type: 'act', locationId: 'tingen' }, WORLD, counting);
  // 有通缉但人在无主地点
  resolveWanted(
    wantedState({ level: 4, factionId: 'police' }),
    { type: 'act', locationId: 'graveyard_path' },
    WORLD,
    counting,
  );
  // 有通缉但不在追捕方地盘
  resolveWanted(
    wantedState({ level: 1, factionId: 'police' }),
    { type: 'act', locationId: 'old_dock' },
    WORLD,
    counting,
  );
  assert.equal(calls, 0, '不会被追捕时不该消耗随机数，否则同 seed 下别的判定会跟着变');
});

test('M2.6 判定：pickActiveWanted 认 4 级优先、同级取最近签发', () => {
  const now = 10_000;
  const policeL1 = wantedState({ id: 'a', level: 1, factionId: 'police', createdAt: 1000, expiresAt: now + DAY });
  const churchL2 = wantedState({ id: 'b', level: 2, factionId: 'church', createdAt: 2000, expiresAt: now + DAY });

  assert.equal(pickActiveWanted([policeL1, churchL2], 'police', now)?.id, 'a');
  assert.equal(pickActiveWanted([policeL1, churchL2], 'church', now)?.id, 'b');
  assert.equal(pickActiveWanted([policeL1, churchL2], 'gang', now), null);

  const policeL4 = wantedState({ id: 'c', level: 4, factionId: 'church', createdAt: 500, expiresAt: now + DAY });
  assert.equal(
    pickActiveWanted([policeL1, policeL4], 'police', now)?.id,
    'c',
    '4 级是全境通缉，任何势力范围内都优先用它',
  );
  assert.equal(pickActiveWanted([policeL1], 'none', now), null, '无主地点不适用任何通缉');
});

/* ================================================================== *
 * 三、举报判定（纯函数）
 * ================================================================== */

test('M2.6 举报判定：成功 / 未被通缉 / 目标在无主地点 / 报错衙门', () => {
  const now = 10_000;
  const wanted = wantedState({ level: 1, factionId: 'police', createdAt: 1000, expiresAt: now + DAY });

  const ok = resolveReport({ targetStates: [wanted], targetFactionId: 'police', now });
  assert.equal(ok.ok, true);
  assert.equal(ok.rewardPenny, NUMERIC.wanted.bounty[1]);
  assert.equal(ok.wantedId, 'w-1');

  const notWanted = resolveReport({ targetStates: [], targetFactionId: 'police', now });
  assert.equal(notWanted.ok, false);
  assert.equal(notWanted.reputationDelta, NUMERIC.wanted.reportFailReputation);

  const inWild = resolveReport({ targetStates: [wanted], targetFactionId: 'none', now });
  assert.equal(inWild.ok, false, '人已经躲进无主地点了，谁也抓不了');

  const wrongFaction = resolveReport({ targetStates: [wanted], targetFactionId: 'church', now });
  assert.equal(wrongFaction.ok, false, '警察厅的案子教会不接');
});

/* ================================================================== *
 * 四、数值（任务书 §四 的口径）
 * ================================================================== */

test('M2.6 数值：通缉时长与赏金按任务书，触发源只开放 1 级', () => {
  assert.equal(wantedDurationOf(1), 3 * DAY);
  assert.equal(wantedDurationOf(2), 5 * DAY);
  assert.equal(wantedDurationOf(3), 7 * DAY);
  assert.equal(wantedDurationOf(4), 7 * DAY);

  assert.equal(bountyOf(1), 50);
  assert.equal(bountyOf(2), 200);
  assert.equal(bountyOf(3), 500);
  assert.equal(bountyOf(4), 2000);

  assert.equal(levelForTrigger('injured_player'), 1);
  assert.equal(levelForTrigger('killed_player'), 2);
  assert.equal(levelForTrigger('killed_multiple'), 3);
  assert.equal(levelForTrigger('killed_org_member'), 4);

  // MVP 只做「重伤 → 1 级」；2—4 级的数据结构就位但触发源不开放
  assert.deepEqual([...NUMERIC.wanted.triggers.enabled], ['injured_player']);
  assert.ok(NUMERIC.wanted.triggers.reserved.includes('killed_player'));
  assert.equal(NUMERIC.wanted.reportFailReputation, -5);
});

test('M2.6 数值：active 全 1.0（那一层不生效），planned 的梯度按 B 方案（指数形状）', () => {
  const gating = NUMERIC.promotion.sequenceGating;
  for (const [seq, value] of Object.entries(gating.active)) {
    assert.equal(value, 1.0, 'active 这一层永远是 1.0 —— 真正生效的是 planned（M2.33 接的读取点）');
  }
  /*
   * ===== M2.35 任务 3：**这一段不再抄数值（K22）** =====
   *
   * 它原来把 0.9 / 0.6 / 0.3 / 0.2 硬编码进断言，于是「改梯度」要改两处；
   * 而两处不同步时**红的是测试、不是代码** —— 后来的人分不清「设计变了」与「测试忘了跟」。
   * 数值的唯一出处是 `src/config/numeric.ts` 的 `sequenceGating.planned`（K22），
   * 这里只守**形状**：形状漂了才是设计漂了。
   *
   * ⚠️ 「值等于几」由 `test/m2-33-gating.test.ts` 用**行为**守（改表值 → 成功率跟着变），
   * 那一条比抄一遍数值强：它证明的是「表真的被读」。
   */
  const planned = gating.planned as Record<number, number>;

  // ① 键域完整（M2.31 任务 3.1）：0—8 九个键缺一不可，不留空（K19）
  for (const seq of [0, 1, 2, 3, 4, 5, 6, 7, 8]) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(planned, seq),
      'planned 缺序列 ' + seq + ' 的键 —— 不留空，要么写 0 要么写设计值（K19）',
    );
  }

  // ② 不归零（M2.31 A 方案）：两条路一直存在到序列 0 ⇒ K6 的奇偶分流全程可用
  for (const target of [0, 1, 2, 3, 4, 5, 6, 7, 8]) {
    assert.ok(planned[target]! > 0, 'planned[' + target + '] 不能归零 —— 归零就是「关闭」，那又回到 B 方案');
  }

  // ③ 单调不增：越往上越不能取巧
  for (let target = 7; target >= 0; target -= 1) {
    assert.ok(
      planned[target]! <= planned[target + 1]!,
      'planned 必须随目标序列递减：planned[' + target + '] = ' + planned[target] +
        ' 不该大于 planned[' + (target + 1) + '] = ' + planned[target + 1],
    );
  }

  /*
   * ④ 三段边界 —— M2.35 拍板 **B：稀有度梯度用指数**，与原作的稀有度对齐。
   *
   * | 段 | 目标序列 | 区间 | 梯度表里的位置 |
   * | --- | --- | --- | --- |
   * | 入门 | 8、7 | ≥ 0.9 | 9→8 / 8→7 |
   * | （过渡） | 6 | 0.5—0.9 之间 | 7→6「入门末端」，只由 ③ 的单调性约束 |
   * | 中序列 | 5、4、3 | 0.3—0.5 | 6→5 起 / 5→4 / 4→3 末 |
   * | 高序列 | 2、1、0 | ≤ 0.1 | 3→2 / 2→1 / 1→0（神级） |
   *
   * ⚠️ 区间是**判据**，不是数值的副本 —— 它写的是「这一段该落在哪个带里」，
   * 而不是「这一段等于几」。改梯度只要不越带，这条不会红。
   */
  for (const target of [8, 7]) {
    assert.ok(planned[target]! >= 0.9, '入门段（目标 ' + target + '）必须 ≥ 0.9，实际 ' + planned[target]);
  }
  for (const target of [5, 4, 3]) {
    assert.ok(
      planned[target]! >= 0.3 && planned[target]! <= 0.5,
      '中序列（目标 ' + target + '）必须落在 0.3—0.5，实际 ' + planned[target],
    );
  }
  for (const target of [2, 1, 0]) {
    assert.ok(planned[target]! <= 0.1, '高序列（目标 ' + target + '）必须 ≤ 0.1，实际 ' + planned[target]);
  }

  /*
   * ⑤ **9→8 不再等于「标准成功率」**（M2.35 起）。
   *
   * `planned[8]` 原来是 `1.0`，于是「序列 9 的第一次晋升」被当成基线用
   * （`docs/对照规范.md` §四·补 曾据此说「入途径 → 8 不受 P6 影响」）。
   * 现在它是 **0.95** ⇒ 那句前提作废（已登记进 `docs/结论台账.md`）。
   * 这条断言守住这个**口径变化**：谁把它改回 1.0，都会在这里红。
   */
  assert.ok(
    planned[8]! < 1,
    'planned[8] 必须 < 1 —— M2.35 起 9→8 也吃高序列惩罚，「序列 9 是标准成功率」这条基线口径已作废',
  );
});

/* ================================================================== *
 * 四·补、前置项二：三层货币组合格式
 * ================================================================== */

test('M2.6 前置项二：组合格式报价的比例接近 30%，penny 值由解析器现算', () => {
  const total = 2000;
  let combo = 0;
  for (let index = 0; index < total; index += 1) {
    const price = tradePriceToken(createSeededRng(seedFrom(['combo-rate', index])), 5);
    if (price.combo) {
      combo += 1;
      assert.ok(
        (TRADE_PRICE_MODEL.comboSamples as readonly string[]).includes(price.token),
        '组合格式必须来自配置里的样本：' + price.token,
      );
      assert.equal(price.penny, parseCurrency(price.token), 'penny 必须由 parseCurrency 现算');
      assert.ok(price.penny >= 1);
    } else {
      assert.equal(price.token, '5');
      assert.equal(price.penny, 5);
    }
  }
  const rate = combo / total;
  assert.ok(rate > 0.25 && rate < 0.35, '组合格式比例应当接近 30%，实测 ' + (rate * 100).toFixed(1) + '%');
});

test('M2.6 前置项二：组合格式的抽样必须与"目标选择"解耦（否则 30% 会失真）', () => {
  // 复现曾经的 bug：价格随机源与 otherUserId 共用 rngFor(ctx)（种子只含 day/step），
  // 同一个 step 上第一个随机数恒定 —— 组合格式变成"按 step 固定"，实测占比掉到 22%。
  const seeds = (login: number, step: number, itemId: string) =>
    seedFrom(['p1', 'trade-price', 0, login, step, itemId]);
  const first = (seed: string): number => createSeededRng(seed).next();
  // 同一个 step，不同登录 → 必须是不同的值（旧写法这里会完全相同）
  assert.notEqual(first(seeds(0, 5, '银粉')), first(seeds(1, 5, '银粉')));
  // 同一个 step 同一个登录，不同物品 → 也应当不同
  assert.notEqual(first(seeds(0, 5, '银粉')), first(seeds(0, 5, '圣盐')));

  let combo = 0;
  for (let step = 0; step < 400; step += 1) {
    if (tradePriceToken(createSeededRng(seeds(step % 3, step, 'items')), 5).combo) combo += 1;
  }
  const rate = combo / 400;
  assert.ok(rate > 0.23 && rate < 0.37, '解耦后的占比应当接近 30%，实测 ' + (rate * 100).toFixed(1) + '%');
});

test('M2.6 前置项二：金额比对只认自己这条回执（别人的交易通知排在前面也不能抓错）', () => {
  // 复现 200×14 分片里那 4 笔"金额不符"：回执的第一段其实是**别人发来的**交易通知，
  // 里面也有一个"价格："。不加锚点就会抓到别人的报价，把 303 对成 6。
  const stats = collectCurrencyCombo([
    {
      playerId: 1,
      persona: 'steady',
      goal: 'social',
      day: 0,
      login: 0,
      step: 0,
      virtualNow: 0,
      intervalSec: 12,
      command: '.交易 @700017 主材料·夜之瞳 1 1g5s3p',
      reason: '覆盖率',
      status: 200,
      costMs: 10,
      replies: 1,
      replyTexts: [
        '有人在暗处对你动了手，但扑了个空。\n激进者11 想和你交易：\n单号：F7AFAB\n物品：主材料·夜之瞳 × 1\n' +
          '价格：6 便士（税 0 便士，卖家到手 6 便士）\n\n发送 .确认 F7AFAB 接受。\n' +
          '交易单已创建，物品已冻结。\n单号：1BF3EE\n物品：主材料·夜之瞳 × 1\n' +
          '价格：1 金镑 5 苏勒 3 便士（税 1 苏勒 3 便士，卖家到手 1 金镑 4 苏勒）\n',
      ],
    },
  ]);
  assert.equal(stats.attempts, 1);
  assert.equal(stats.mismatched, 0, '不能被别人那笔的"价格：6 便士"带偏');
  assert.equal(stats.samples[0]?.expectedPenny, 303);
  assert.equal(stats.samples[0]?.actualPenny, 303);
  assert.equal(stats.samples[0]?.ok, true);
});

test('M2.6 前置项二：真实链路上 1g5s3p 能建单，回执复述的金额按便士一致', async () => {
  const h = createHarness();
  try {
    await h.createCharacter('30071', '卖方');
    await h.createCharacter('30072', '买方');
    // 给卖方一件非绑定物品（探索掉落是随机的，这里直接用仓储塞一件，专注验货币链路）
    const item = h.repos.items.all().find((entry) => entry.kind !== 'currency');
    assert.ok(item);
    h.repos.inventory.add(h.repos.characters.findByUserId('30071')!.id, item!.id, 2, 'unbound', h.now());

    const messages = await h.send({ rawText: '.交易 @30072 ' + item!.id + ' 1 1g5s3p', userId: '30071' });
    const texts = messages.map((message) => message.text).join('\n');
    assert.ok(texts.includes('交易单已创建'), '组合格式必须能建单，实际：' + texts.slice(0, 240));
    // 1 金镑 5 苏勒 3 便士 = 240 + 60 + 3 = 303
    assert.equal(parseCurrency('1g5s3p'), 303);
    assert.ok(texts.includes('价格：1 金镑 5 苏勒 3 便士'), '回执复述的金额不对：' + texts.slice(0, 240));

    // 再用分析器的口径跑一遍闭环（发出 → 解析 → 回执复述 → 再解析）
    const stats = collectCurrencyCombo([
      {
        playerId: 1,
        persona: 'steady',
        goal: 'social',
        day: 0,
        login: 0,
        step: 0,
        virtualNow: h.now(),
        intervalSec: 12,
        command: '.交易 @30072 ' + item!.id + ' 1 1g5s3p',
        reason: '覆盖率',
        status: 200,
        costMs: 10,
        replies: messages.length,
        replyTexts: messages.map((message) => message.text),
      },
    ]);
    assert.equal(stats.attempts, 1);
    assert.equal(stats.created, 1);
    assert.equal(stats.mismatched, 0);
    assert.equal(stats.byToken['1g5s3p']?.penny, 303);
    assert.equal(stats.plainAttempts, 0);
  } finally {
    h.app.close();
  }
});

/* ================================================================== *
 * 五、集成（HTTP 链路 + 真实库）
 * ================================================================== */

test('M2.6 集成：迁移 0013 建表并播种四家势力', () => {
  const h = createHarness();
  try {
    assert.equal(h.repos.factions.count(), 4);
    const police = h.repos.factions.get('police');
    assert.ok(police);
    assert.equal(police!.name, '警察厅');
    // M2.7：警察厅在每座新城市都有分部（城区与市场归它管）
    // M2.39 批次 B：封存的军械库（序列 3 的产出点）归它
    // M2.85：同上 —— 关键分部还在，数量只增不减（严格性由 coverage 判据承担）
    for (const key of ['tingen', 'backlund', 'steam_station', 'backlund_bridge', 'pritz', 'fish_market', 'trier', 'foreign_quarter', 'byron']) {
      assert.ok(police!.territory.includes(key), '警察厅的地盘少了：' + key);
    }
    assert.ok(police!.territory.length >= 10, '警察厅的地盘只增不减，实际 ' + police!.territory.length);


    const tables = h.app.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = tables.map((row) => row.name);
    for (const table of ['factions', 'wanted_states', 'bounty_claims']) {
      assert.ok(names.includes(table), '缺表：' + table);
    }
  } finally {
    h.app.close();
  }
});

test('M2.6 集成：.袭击 重伤他人 → 攻击者吃 1 级通缉，判定 seed 落进 domain_events', async () => {
  const h = createHarness();
  try {
    const attacker = await h.createCharacter('30001', '袭击者');
    const victim = await h.createCharacter('30002', '受害者');

    const before = h.repos.characters.findById(victim.id)!;
    assert.equal(before.hp, 100);
    await assaultUntilWanted(h, '30001', '30002');
    const after = h.repos.characters.findById(victim.id)!;
    assert.ok(after.hp < 100, '命中的那一次必须掉血：100 → ' + after.hp);

    const wanted = h.repos.wanted.listActiveOf(attacker.id, h.now());
    assert.equal(wanted.length, 1);
    assert.equal(wanted[0]!.level, 1);
    assert.equal(wanted[0]!.factionId, 'police', '新号默认在廷根市，归警察厅管');
    assert.ok(wanted[0]!.reason.includes('受害者'));

    const events = h.repos.characters.eventsOf(attacker.id);
    const issued = events.find((event) => event.type === 'wanted_issued');
    assert.ok(issued, '缺少 wanted_issued 事件');
    assert.ok(issued!.seed, '判定 seed 必须写进 domain_events（任务书 §二硬约束）');
    assert.equal(issued!.payload.level, 1);
  } finally {
    h.app.close();
  }
});

test('M2.6 集成：通缉犯在势力范围内行动会被找上门，逃到无主地点就安全', async () => {
  const h = createHarness();
  try {
    const attacker = await h.createCharacter('30011', '通缉犯');
    await h.createCharacter('30012', '受害者');

    await assaultUntilWanted(h, '30011', '30012');
    assert.equal(h.repos.wanted.listActiveOf(attacker.id, h.now()).length, 1, '应当已经被通缉');

    const countEncounters = () => countEvents(h, attacker.id, 'wanted_encounter');

    // 补齐 AP：本用例要连续跑好几个会消耗 AP 的动作，AP 不足会变成"什么都没发生"
    const refill = () => {
      const state = h.repos.characters.findById(attacker.id)!;
      h.repos.characters.update({ ...state, updatedAt: h.now() });
      return state;
    };

    // 1) 逃到无主地点：墓园小径
    refill();
    const beforeSafe = countEncounters();
    await h.send({ rawText: '.探索 墓园小径', userId: '30011' });
    assert.equal(
      h.repos.flags.value(attacker.id, 'loc'),
      'graveyard_path',
      '探索=移动到该地点，位置必须落库',
    );
    const afterSafe = countEncounters();
    assert.equal(afterSafe, beforeSafe, '无主地点不该产生任何通缉遭遇');

    // 2) 再逃几步也不该出事
    for (const wild of ['封存档案室', '迷雾街区']) {
      refill();
      const before = countEncounters();
      await h.send({ rawText: '.探索 ' + wild, userId: '30011' });
      assert.equal(countEncounters(), before, wild + ' 是无主地点，不该被追捕');
    }

    // 3) 走回势力范围：廷根市
    refill();
    const beforeBack = countEncounters();
    await h.send({ rawText: '.探索 廷根市', userId: '30011' });
    assert.ok(
      countEncounters() > beforeBack,
      '回到警察厅的地盘必须产生一次遭遇判定（落库带 seed）',
    );
  } finally {
    h.app.close();
  }
});

test('M2.6 集成：.举报 成功领赏并全服播报「通缉犯落网」', async () => {
  const h = createHarness();
  try {
    const criminal = await h.createCharacter('30021', '被通缉者');
    await h.createCharacter('30022', '受害者');
    const hunter = await h.createCharacter('30023', '情报贩子');

    await assaultUntilWanted(h, '30021', '30022');
    assert.equal(h.repos.wanted.listActiveOf(criminal.id, h.now()).length, 1);

    const before = h.repos.inventory.count(hunter.id, '便士');
    const messages = await h.send({ rawText: '.举报 @30021', userId: '30023', scene: 'group' });
    const texts = messages.map((message) => message.text).join('\n');

    assert.ok(texts.includes('通缉犯落网'), '群播报必须出现「通缉犯落网」，实际：' + texts.slice(0, 200));
    const after = h.repos.inventory.count(hunter.id, '便士');
    assert.equal(after - before, NUMERIC.wanted.bounty[1], '赏金按 1 级发放');

    const claims = h.repos.wanted.claimsOfWork(hunter.id);
    assert.equal(claims.length, 1);
    assert.equal(claims[0]!.rewardPenny, NUMERIC.wanted.bounty[1]);

    const events = h.repos.characters.eventsOf(hunter.id);
    assert.ok(events.some((event) => event.type === 'bounty_claimed'));

    // 同一个人对同一条通缉令只能领一次
    h.advance(10_000);
    const again = h.repos.inventory.count(hunter.id, '便士');
    const messages2 = await h.send({ rawText: '.举报 @30021', userId: '30023' });
    assert.equal(h.repos.inventory.count(hunter.id, '便士'), again, '不该重复发赏金');
    assert.ok(
      messages2.some((message) => message.text.includes('这个案子你已经报过了')),
      '重复举报要给出明确说明',
    );
  } finally {
    h.app.close();
  }
});

test('M2.6 集成：.举报 失败路径 —— 对方没被通缉，信誉 -5', async () => {
  const h = createHarness();
  try {
    await h.createCharacter('30031', '举报人');
    await h.createCharacter('30032', '无辜路人');

    const messages = await h.send({ rawText: '.举报 @30032', userId: '30031' });
    const texts = messages.map((message) => message.text).join('\n');
    assert.ok(texts.includes('没有被通缉'), '实际回执：' + texts.slice(0, 200));
    assert.equal(
      h.repos.flags.value(h.repos.characters.findByUserId('30031')!.id, 'reputation'),
      String(NUMERIC.wanted.reportFailReputation),
    );
    assert.equal(h.repos.wanted.countClaims(), 0, '失败不该留下赏金流水');
  } finally {
    h.app.close();
  }
});

test('M2.6 集成：在无主地点动手不会产生通缉（安全区的另一面）', async () => {
  const h = createHarness();
  try {
    const attacker = await h.createCharacter('30041', '野地里的人');
    await h.createCharacter('30042', '受害者');
    // 受害者先躲到无主地点
    await h.send({ rawText: '.探索 封存档案室', userId: '30042' });

    // 反复动手直到**至少命中一次**，否则"没产生通缉"可能只是因为一次都没打中，测试就空了
    let landed = 0;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const me = h.repos.characters.findByUserId('30041')!;
      const victim = h.repos.characters.findByUserId('30042')!;
      h.repos.characters.update({ ...me, updatedAt: h.now() });
      h.repos.characters.update({ ...victim, hp: 100, status: 'active', updatedAt: h.now() });
      await h.send({ rawText: '.袭击 @30042', userId: '30041' });
      h.advance(31 * 60 * 1000);
      landed = (
        h.app.db
          .prepare(
            "SELECT COUNT(*) AS n FROM domain_events WHERE character_id = ? AND type = 'assault_resolved' AND payload LIKE '%\"hit\":true%'",
          )
          .get(attacker.id) as { n: number }
      ).n;
      if (landed > 0) break;
    }
    assert.ok(landed > 0, '12 次里一次都没命中，这条测试就没有意义了');
    assert.equal(
      h.repos.wanted.listActiveOf(attacker.id, h.now()).length,
      0,
      '无主地点没有人管，重伤别人也不会有衙门来通缉',
    );
  } finally {
    h.app.close();
  }
});

test('M2.6 集成：通缉到期自动解除（不需要任何后台任务）', async () => {
  const h = createHarness();
  try {
    const attacker = await h.createCharacter('30051', '短期通缉');
    await h.createCharacter('30052', '受害者');
    await assaultUntilWanted(h, '30051', '30052');
    assert.equal(h.repos.wanted.listActiveOf(attacker.id, h.now()).length, 1);

    h.advance(3 * DAY + 1000);
    assert.equal(h.repos.wanted.listActiveOf(attacker.id, h.now()).length, 0);
    assert.equal(h.repos.wanted.countActive(h.now()), 0);
    // 历史记录还在（报告口径要能看见"一共签发过多少条"）
    assert.ok(h.repos.wanted.listAll().length >= 1);
  } finally {
    h.app.close();
  }
});

test('M2.6 集成：.状态 里有通缉行，且内部标记不泄漏给玩家', async () => {
  const h = createHarness();
  try {
    await h.createCharacter('30061', '通缉犯');
    await h.createCharacter('30062', '受害者');
    await assaultUntilWanted(h, '30061', '30062');

    const messages = await h.send({ rawText: '.状态', userId: '30061' });
    const texts = messages.map((message) => message.text).join('\n');
    assert.ok(texts.includes('通缉：1 级'), '状态面板要有通缉行：' + texts.slice(0, 200));
    assert.ok(!texts.includes('loc'), '内部标记不该出现在玩家的标记清单里');
  } finally {
    h.app.close();
  }
});
