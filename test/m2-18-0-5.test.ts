/**
 * M2.18 第 0.5 步：两件前置修。
 *
 *   A  vplayer 的上限检查器补上**第二层能力**（教会技能）—— A2 找到的那条潜伏 P0
 *   B  `pvp_challenge` 的 locationId 到底是不是「混着城市与地点」—— 取证结论：不是，无需改代码
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NUMERIC } from '../src/config/numeric.ts';
import { loadContent } from '../src/data/loader.ts';
import { readStatCaps } from '../src/vplayer/session.ts';
import { createHarness, DEFAULT_USER, type Harness } from './helpers/app.ts';

const content = loadContent();

async function say(h: Harness, text: string, userId = DEFAULT_USER): Promise<string> {
  const messages = await h.send({ rawText: text, scene: 'private', userId });
  return messages.map((message) => message.text).join('\n');
}

test('M2.18-0.5-A：战神 rank 3 信徒的上限 = 125，HP 120 不再被判越界', async () => {
  const h = createHarness({ deterministicIds: true });
  const created = await h.createCharacter(DEFAULT_USER, '克莱恩', 'warrior');
  const base = h.repos.characters.findById(created.id)!;
  h.repos.characters.update({ ...base, currentCityId: 'backlund', updatedAt: h.now() });
  const joined = await say(h, '.加入教会 god_of_war');
  assert.match(joined, /【入教 · 战神】/, '先确认入教成功');

  // 途径能力：warrior_8 给 +10 HP（写成 flag 就是「服下了那瓶魔药」）
  h.repos.flags.set(created.id, 'ability_warrior_8', h.now());
  /*
   * 教内档位：rank 3 需要「贡献 >= 125 点」且「序列 <= 8」（双门槛，见 NUMERIC.church.ranks）。
   * rank 1 / 2 / 3 各给一条技能：+5 HP、+1 先攻、+10 HP。
   */
  const member = h.repos.characters.findById(created.id)!;
  h.repos.characters.update({
    ...member,
    sequence: 8,
    churchContribution: NUMERIC.church.ranks.contributionThreshold[3] ?? 125,
    updatedAt: h.now(),
  });

  const caps = readStatCaps(h.app.db, created.id, 'warrior');
  assert.deepEqual(caps.hp, [0, 130], '100 + 10（途径 warrior_8）+ 5 + 5（教会 rank 1 / 2）+ 10（rank 3）');
  /*
   * 这一条就是 A2 那条潜伏 P0 的回归测试：修之前 caps.hp 是 [0,110]，
   * 于是 HP 120 会被 checkSnapshotConsistency 判成越界；修之后 120 落在上限内。
   */
  assert.ok(120 <= (caps.hp?.[1] ?? 100), 'HP 120 在检查器认可的上限内 → 不会被误报 P0');
  h.app.close();
});

test('M2.18-0.5-B：未入教的战士上限仍是 110（教会技能不参与）', async () => {
  const h = createHarness({ deterministicIds: true });
  const created = await h.createCharacter(DEFAULT_USER, '克莱恩', 'warrior');
  h.repos.flags.set(created.id, 'ability_warrior_8', h.now());
  const caps = readStatCaps(h.app.db, created.id, 'warrior');
  assert.deepEqual(caps.hp, [0, 110], '只有途径能力那 +10');
  h.app.close();
});

test('M2.18-0.5-B2：入了教但只在 rank 0 的战士，上限也还是 110（档位不够就没技能）', async () => {
  const h = createHarness({ deterministicIds: true });
  const created = await h.createCharacter(DEFAULT_USER, '克莱恩', 'warrior');
  const base = h.repos.characters.findById(created.id)!;
  h.repos.characters.update({ ...base, currentCityId: 'backlund', updatedAt: h.now() });
  await say(h, '.加入教会 god_of_war');
  h.repos.flags.set(created.id, 'ability_warrior_8', h.now());
  const caps = readStatCaps(h.app.db, created.id, 'warrior');
  assert.deepEqual(caps.hp, [0, 110]);
  h.app.close();
});

test('M2.18-0.5-C：pvp 的 locationId 是**地点 id** —— A3 的「混用城市」判断不成立', () => {
  const locationIds = new Set(content.locations.map((location) => location.id));
  /*
   * 每座城市都有一个**同名的中心地点**（cities.yaml 的 center 指向它）。
   * 所以事件里出现 locationId: 'pritz' / 'backlund' 是**合法的地点 id**，
   * 不是「混进了城市 id」—— A3 报告的 §二 那句话是误判，这里把依据钉住。
   */
  for (const city of content.cities) {
    assert.ok(
      locationIds.has(city.center),
      city.id + ' 的中心地点 ' + city.center + ' 必须在 locations.yaml 里（pritz / backlund 这类 locationId 就是它）',
    );
  }
  // 反向：A3 里被当成「地点」的那几个，也都在同一张表里
  for (const id of ['pritz_harbor', 'backlund_slum', 'backlund_cathedral']) {
    assert.ok(locationIds.has(id), id + ' 是地点 id');
  }
});

test('M2.18-0.5-D：教会技能确实叠在同一个数上（两源合并的口径一致）', () => {
  const war = content.churchAbilities.filter((ability) => ability.churchId === 'god_of_war');
  const sum = war.reduce((acc, ability) => acc + (ability.effect.maxHpBonus ?? 0), 0);
  assert.equal(sum, 20, '战神三条技能的 maxHpBonus 合计 20（rank 1 的 +5、rank 2 换字段后的 +5、rank 3 的 +10）');
});
