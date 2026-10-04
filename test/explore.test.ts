import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NUMERIC, rarityLabel } from '../src/config/numeric.ts';
import {
  dangerLabel,
  resolveExplore,
  rollDanger,
  rollDrop,
} from '../src/domain/explore/explore.ts';
import { lostDayCandidates } from '../src/domain/explore/location.ts';
import { loadLocations } from '../src/data/loader.ts';
import { dateKey } from '../src/infra/date.ts';
import { createHarness } from './helpers/app.ts';
import { LostControlRepo } from '../src/infra/db/lost-control-events.ts';
import { createSeededRng } from '../src/domain/rng.ts';
import type { CharacterState } from '../src/domain/character/types.ts';

const { locations } = loadLocations();
const tingen = locations.find((l) => l.id === 'tingen')!;
const greyFog = locations.find((l) => l.id === 'above_grey_fog')!;

function makeState(overrides: Partial<CharacterState> = {}): CharacterState {
  return {
    id: 'char-1', userId: 'u1', name: '克莱恩', pathway: 'seer', pathwayStatus: 'initiated', gender: 'male', sequence: 9,
    hp: 100, mp: 100, mad: 0, cor: 0, dig: 0, dp: 0,
    status: 'active', promotionFails: 0, createdAt: 0, updatedAt: 0,
    ...overrides,
  };
}

/** 固定序列的假 rng，用于把随机路径钉死 */
function scriptedRng(values: number[]): { next(): number } {
  let index = 0;
  return {
    next: () => {
      const value = values[index % values.length] ?? 0;
      index += 1;
      return value;
    },
  };
}

test('数据文件：地点数量、危险度、掉落表都在合理范围', () => {
  assert.ok(locations.length >= 10, `地点至少 10 个，当前 ${locations.length}`);
  for (const location of locations) {
    assert.ok(location.loot.length >= 1, `${location.id} 必须有掉落表`);
    assert.ok(location.danger >= 0 && location.danger <= 5);
    for (const loot of location.loot) {
      assert.ok(loot.weight > 0);
      assert.ok(loot.minQty >= 1 && loot.maxQty >= loot.minQty);
      assert.ok(loot.bindType === 'bound' || loot.bindType === 'unbound');
    }
  }
});

test('掉落：按权重选条目，数量在 minQty—maxQty 之间', () => {
  // rollDrop 依次消耗三次抽样：权重选择 → 留档 roll → 数量
  const highest = [...tingen.loot].sort((a, b) => b.weight - a.weight)[0]!;
  const top = rollDrop(tingen, scriptedRng([0, 0.5, 0.999]));
  assert.equal(top.drop.itemId, highest.itemId, 'roll=0 必中权重最高的条目');
  assert.equal(top.drop.quantity, highest.maxQty, '数量抽样 0.999 → 取上限');
  assert.equal(top.drop.bindType, highest.bindType);
  assert.equal(top.drop.rarity, rarityLabel(highest.weight));

  const bottom = rollDrop(tingen, scriptedRng([0, 0.5, 0]));
  assert.equal(bottom.drop.quantity, highest.minQty, '数量抽样 0 → 取下限');
});

test('掉落：权重最低的稀有物品只在抽样落进它的区间时出现', () => {
  /*
   * M2.76：**判据改成「数组最后一项」而不是「权重最低的那一项」**。
   *
   * `rollDrop` 是按数组顺序**累减权重**的，所以「抽到哪一项」取决于**数组顺序**，
   * 与「谁权重最低」是两件事 —— 原来两者恰好重合（tingen 的掉落表里最低权重的
   * 那一项正好排在最后），M2.76 往表里加了材料之后它们不再重合。
   *
   * 这条用例要守的是「**最后一段区间**只对应最后一项」，所以取最后一项才对。
   */
  const last = tingen.loot[tingen.loot.length - 1]!;
  const total = tingen.loot.reduce((sum, loot) => sum + loot.weight, 0);
  const lastStart = (total - last.weight) / total;
  const probe = Math.min(lastStart + 0.0001, 0.9999);
  const { drop } = rollDrop(tingen, scriptedRng([probe, 0.5]));
  assert.equal(drop.itemId, last.itemId, '落在最后一段区间应当抽到最后一项');
});

test('危险判定：概率 = dangerTriggerBase × danger', () => {
  const chance = NUMERIC.explore.dangerTriggerBase * tingen.danger;
  assert.equal(rollDanger(tingen, scriptedRng([chance - 0.001])).triggered, true);
  assert.equal(rollDanger(tingen, scriptedRng([chance + 0.001])).triggered, false);

  const hit = rollDanger(greyFog, scriptedRng([0]));
  assert.equal(hit.hp, -NUMERIC.explore.hpPerDanger * greyFog.danger);
  assert.equal(hit.mad, NUMERIC.explore.madPerDanger * greyFog.danger);
});

test('resolveExplore：同 seed 完全复现，不同 seed 结果不同', () => {
  const input = {
    state: makeState(),
    location: tingen,
    seed: 'seed-A',
    todayCount: 0,
    candidateEventIds: ['daily_001', 'daily_013', 'daily_016'],
  };
  const first = resolveExplore({ ...input, rng: createSeededRng(input.seed) });
  const again = resolveExplore({ ...input, rng: createSeededRng(input.seed) });
  assert.deepEqual(first, again);

  const other = resolveExplore({ ...input, seed: 'seed-B', rng: createSeededRng('seed-B') });
  assert.notDeepEqual(other, first);
});

test('resolveExplore：额外掉落由 bonusDropChance 控制', () => {
  const base = {
    state: makeState(),
    location: tingen,
    seed: 's',
    todayCount: 0,
  };
  // 抽样顺序：掉落(权重/roll/数量) → bonus → 危险 → 事件
  const withBonus = resolveExplore({
    ...base,
    rng: scriptedRng([0.1, 0.5, 0.5, NUMERIC.explore.bonusDropChance / 2, 0.1, 0.5, 0.5, 0.9, 0.5]),
  });
  const noBonus = resolveExplore({ ...base, rng: scriptedRng([0.1, 0.5, 0.5, 0.9, 0.9, 0.5]) });
  assert.equal(withBonus.ok && withBonus.drops.length, 2);
  assert.equal(noBonus.ok && noBonus.drops.length, 1);
});

test('resolveExplore：**软上限不拒绝**（越刷越亏，但不挡人）', () => {
  /*
   * ⚠️ 这条断言在 M2.85 反了过来。
   *
   * 原来断言「超过每日上限直接拒绝」，理由是「不让刷」。
   * 用户拍板后改了：「探索每日三次是不合理的机制，起码在 QQ 群文字游戏里」——
   * QQ 群是异步的，玩家想起来发一句不该被配额挡回去。
   * 现在超软上限**照样能探**，只是收益递减、危险上涨；到 hardCap 才真的拒绝。
   */
  const overSoft = resolveExplore({
    state: makeState(),
    location: tingen,
    rng: createSeededRng('s'),
    seed: 's',
    todayCount: NUMERIC.explore.dailyCapPerLocation + 1,
  });
  assert.equal(overSoft.ok, true, '超过软上限也该能探（只是越刷越亏）');

  const atHard = resolveExplore({
    state: makeState(),
    location: tingen,
    rng: createSeededRng('s'),
    seed: 's',
    todayCount: NUMERIC.explore.hardCapPerLocation,
  });
  assert.equal(atHard.ok, false, '到硬上限才真的拒绝（防脚本）');
  assert.match(atHard.ok ? '' : atHard.reason, /都翻遍了/);
});

test('resolveExplore：序列不够的地点拒绝进入（灰雾之上要求序列 8 及以上）', () => {
  const result = resolveExplore({
    state: makeState({ sequence: 9 }),
    location: greyFog,
    rng: createSeededRng('s'),
    seed: 's',
    todayCount: 0,
  });
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.reason, /不是序列 9 能去的地方/);

  const allowed = resolveExplore({
    state: makeState({ sequence: 8 }),
    location: greyFog,
    rng: createSeededRng('s'),
    seed: 's',
    todayCount: 0,
  });
  assert.equal(allowed.ok, true);
});

test('resolveExplore：事件卡候选为空时不抽事件', () => {
  const result = resolveExplore({
    state: makeState(),
    location: tingen,
    rng: createSeededRng('s'),
    seed: 's',
    todayCount: 0,
    candidateEventIds: [],
  });
  assert.equal(result.ok && result.eventCardId, null);
  assert.equal(result.ok && result.rolls.event, null);
});

test('resolveExplore：危险触发时产生 hp/mad 的 delta', () => {
  // 抽样顺序：掉落(0.1/0.5/0.5) → bonus(0.9 不触发) → 危险(0 必触发)
  const result = resolveExplore({
    state: makeState({ sequence: 8 }),
    location: greyFog,
    rng: scriptedRng([0.1, 0.5, 0.5, 0.9, 0]),
    seed: 's',
    todayCount: 0,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.danger.triggered, true);
  assert.deepEqual(result.deltas, [
    { type: 'hp', value: -NUMERIC.explore.hpPerDanger * greyFog.danger },
    { type: 'mad', value: NUMERIC.explore.madPerDanger * greyFog.danger },
  ]);
});

test('危险度文案分档', () => {
  assert.equal(dangerLabel(0), '安全');
  assert.equal(dangerLabel(1), '尚可');
  assert.equal(dangerLabel(2), '不安');
  assert.equal(dangerLabel(3), '危险');
  assert.equal(dangerLabel(5), '极危险');
});

test('方案 E：失控当天的探索候选 = 普通卡 + 该地点的 lost_*；没失控过一张都不多', () => {
  const { locations } = loadLocations();
  const greyFog = locations.find((entry) => entry.id === 'above_grey_fog')!;
  const oldDock = locations.find((entry) => entry.id === 'old_dock')!;

  assert.deepEqual(lostDayCandidates(greyFog, false), [], '没失控过时不许往里塞任何卡');
  assert.deepEqual(lostDayCandidates(greyFog, true), ['lost_002', 'lost_004']);
  assert.deepEqual(lostDayCandidates(oldDock, true), ['lost_002', 'lost_003']);

  // 塞进去的必须真的挂在这个地点名下（内容配置驱动，不是代码里写死清单）
  for (const location of locations) {
    for (const id of lostDayCandidates(location, true)) {
      assert.ok(location.events.includes(id), `${location.id} 的 ${id} 必须来自它自己的 events 名单`);
      assert.ok(id.startsWith('lost_'), `${id} 不该出现在失控日候选里`);
    }
  }
});

test('方案 E：判据是「今天失控过」而不是「此刻是否失控」（净化之后照样算）', async () => {
  const h = createHarness();
  const character = await h.createCharacter('30001', '克莱恩');
  const date = dateKey(h.now());
  const lostControl = new LostControlRepo(h.app.db);
  assert.equal(lostControl.hasOn(character.id, date), false);

  lostControl.record({
    characterId: character.id,
    date,
    pathway: 'seer',
    text: '失控文本',
    hpLoss: 10,
    madGain: 5,
    form: null,
    source: 'tick',
    createdAt: h.now(),
  });
  assert.equal(lostControl.hasOn(character.id, date), true, '失控留档之后当天都算');
  assert.equal(lostControl.hasOn(character.id, '2026-12-31'), false, '别的日子不算');
  h.app.close();
});
test('方案 E：失控当天探索无光地下室，真的会把失控卡抽出来（端到端）', async () => {
  const h = createHarness();
  const character = await h.createCharacter('30002', '克莱恩');
  const lostControl = new LostControlRepo(h.app.db);
  let hit: string | null = null;

  for (let day = 0; day < 6 && !hit; day += 1) {
    if (day > 0) h.advance(24 * 60 * 60 * 1000);
    const date = dateKey(h.now());
    lostControl.record({
      characterId: character.id,
      date,
      pathway: 'seer',
      text: '失控文本',
      hpLoss: 10,
      madGain: 5,
      form: null,
      source: 'tick',
      createdAt: h.now(),
    });
    for (let i = 0; i < 3 && !hit; i += 1) {
      const messages = await h.send({ rawText: '.探索 无光地下室', userId: '30002', messageId: 'e:' + day + ':' + i });
      /*
       * M2.40：群里的标题念**显示名**，从文案里认不出「这是不是失控卡」——
       * 而这件事本来就该锚在**账本**上（`event_triggers`），不是锚在文案上。
       */
      void messages;
      const row = h.app.db
        .prepare("SELECT event_id FROM event_triggers WHERE character_id = ? AND event_id LIKE 'lost_%' LIMIT 1")
        .get(character.id) as { event_id: string } | undefined;
      if (row) hit = row.event_id;
    }
  }
  assert.ok(hit, '失控当天在无光地下室探索 3 次 × 6 天，至少该抽到一张失控卡');

  // 没失控过的角色在同一地点、同一批 seed 下抽不到失控卡（普通日卡池没被污染）
  await h.createCharacter('30003', '奥黛丽');
  const normalTexts: string[] = [];
  for (let i = 0; i < 3; i += 1) {
    const messages = await h.send({ rawText: '.探索 无光地下室', userId: '30003', messageId: 'n:0:' + i });
    normalTexts.push(messages.map((m) => m.text).join(String.fromCharCode(10)));
  }
  // M2.40：同上 —— 判据锚在账本上，不锚在文案上
  void normalTexts;
  const normalLost = h.app.db
    .prepare(
      'SELECT COUNT(*) AS n FROM event_triggers e JOIN characters c ON c.id = e.character_id ' +
        "WHERE c.user_id = ? AND e.event_id LIKE 'lost_%'",
    )
    .get('30003') as { n: number };
  assert.equal(normalLost.n, 0, '没失控过的角色不该抽到失控卡');
  h.app.close();
});
