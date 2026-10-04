/**
 * M2.18 任务 B：势力层争夺（地点粒度）。
 *
 * 三段：
 *   §A 纯函数（单一归属 / 平局 / 阈值 / 衰减作用域）
 *   §B 内容与配置（contestedLocations 全部合法、参数自洽）
 *   §C 增量表的读写与归属合成（repo + 纯函数）
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NUMERIC } from '../src/config/numeric.ts';
import { loadContent } from '../src/data/loader.ts';
import {
  contestedOwnerAt,
  contestTally,
  decayEntries,
  ownerAt,
  territoryOwners,
  type ContestRow,
} from '../src/domain/church/conflict.ts';

const row = (locationId: string, winnerChurchId: string, delta = 1): ContestRow => ({
  locationId,
  winnerChurchId,
  delta,
});

/* ==================== §A 纯函数 ==================== */

test('M2.18-B-A1：单一归属 —— Σ 最高且达阈值才翻转，平局维持底图', () => {
  const threshold = 5;
  // 5 分：达标，唯一 → 翻转
  const five = Array.from({ length: 5 }, () => row('pritz', 'god_of_war'));
  assert.deepEqual(contestedOwnerAt('pritz', five, threshold), { locationId: 'pritz', churchId: 'god_of_war', score: 5 });
  // 4 分：没到阈值 → 维持底图
  assert.equal(contestedOwnerAt('pritz', five.slice(0, 4), threshold), null);
  // 5:5 平局 → 不给答案（否则「这里归谁」取决于遍历顺序）
  assert.equal(
    contestedOwnerAt('pritz', [...five, ...Array.from({ length: 5 }, () => row('pritz', 'night_goddess'))], threshold),
    null,
  );
  // 6:5 → 领先者拿下
  assert.equal(
    contestedOwnerAt('pritz', [...five, row('pritz', 'god_of_war'), ...Array.from({ length: 5 }, () => row('pritz', 'night_goddess'))], threshold)?.churchId,
    'god_of_war',
  );
});

test('M2.18-B-A2：只记胜者 —— 输家不出现，所以翻身只需要赢回来', () => {
  const contests = [row('pritz', 'god_of_war'), row('pritz', 'god_of_war'), row('pritz', 'night_goddess')];
  assert.deepEqual(contestTally(contests), [
    { churchId: 'god_of_war', score: 2 },
    { churchId: 'night_goddess', score: 1 },
  ]);
  // 没有负分：「输了就是没赢」，B 想翻身只要再赢两场
  assert.ok(contestTally(contests).every((entry) => entry.score > 0));
});

test('M2.18-B-A3：衰减作用域是**所有** Σ > 0 的教会（含已翻转的）', () => {
  const contests = [row('pritz', 'god_of_war'), row('pritz', 'god_of_war'), row('backlund', 'night_goddess')];
  assert.deepEqual(decayEntries(contests, NUMERIC.church.conflict.decayPerDay), [
    { locationId: 'pritz', winnerChurchId: 'god_of_war', delta: -NUMERIC.church.conflict.decayPerDay },
    { locationId: 'backlund', winnerChurchId: 'night_goddess', delta: -NUMERIC.church.conflict.decayPerDay },
  ]);
});

test('M2.18-B-A4：territoryOwners 只返回真的有归属的地点（ownerAt 走 NUMERIC 的阈值）', () => {
  const threshold = NUMERIC.church.conflict.dominanceThreshold;
  const few = [row('pritz', 'god_of_war')];
  assert.deepEqual(territoryOwners(few, threshold), []);
  assert.equal(ownerAt('pritz', few), null);
  const enough = Array.from({ length: threshold }, () => row('pritz', 'god_of_war'));
  assert.equal(ownerAt('pritz', enough)?.churchId, 'god_of_war');
  assert.equal(territoryOwners(enough, threshold).length, 1);
});

/* ==================== §B 内容与配置 ==================== */

test('M2.18-B-B1：contestedLocations 的每一个 id 都是合法地点，且覆盖玩家活动密集区', () => {
  const content = loadContent();
  const locationIds = new Set(content.locations.map((location) => location.id));
  const list = NUMERIC.church.conflict.contestedLocations;
  assert.ok(list.length >= 20, '至少 20 个（Top 20 ∪ 现有 6）');
  assert.equal(new Set(list).size, list.length, '不能有重复');
  for (const id of list) assert.ok(locationIds.has(id), id + ' 必须是 locations.yaml 里的地点');
  // 探索 Top 3 必须在里面（否则「争夺覆盖 85% 活动」这条就不成立）
  for (const id of ['pritz_harbor', 'pritz', 'backlund_slum']) assert.ok(list.includes(id), id + ' 该在可争夺集里');
});

test('M2.18-B-B2：争夺参数自洽', () => {
  const conflict = NUMERIC.church.conflict;
  assert.equal(conflict.pvpWinDelta, 1);
  // C+D 之后 delta 是 REAL（迁移 0024）：**允许小数衰减**，参数空间不再被整化切碎
  assert.ok(conflict.decayPerDay > 0, '衰减必须为正');
  assert.ok(conflict.dominanceThreshold > conflict.decayPerDay, '阈值要高于一天的自然衰减，否则永远翻不了');
});

/* ==================== §C 增量表与归属合成 ==================== */

test('M2.18-B-C1：增量落库 → 归属合成了（repo + 纯函数，与运行期同一条链）', async () => {
  const { createHarness } = await import('./helpers/app.ts');
  const h = createHarness({ deterministicIds: true });
  const repo = h.repos.churchConflict;
  assert.equal(repo.count(), 0, '起手是空的');
  for (let i = 0; i < NUMERIC.church.conflict.dominanceThreshold; i += 1) {
    repo.record({ locationId: 'pritz_harbor', winnerChurchId: 'god_of_war', delta: 1, now: h.now() });
  }
  assert.equal(repo.count(), NUMERIC.church.conflict.dominanceThreshold);
  assert.equal(repo.ofLocation('pritz_harbor').length, NUMERIC.church.conflict.dominanceThreshold);
  assert.equal(ownerAt('pritz_harbor', repo.ofLocation('pritz_harbor'))?.churchId, 'god_of_war');
  assert.equal(ownerAt('pritz', repo.ofLocation('pritz')), null, '没被争过的地点维持 seed 底图');
  h.app.close();
});
