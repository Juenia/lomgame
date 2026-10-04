/**
 * M2.61：初始历史（世界不是白板）。
 *
 * 这一份守的是「历史**生成现在**」这件事 —— 用户的原话是
 * 「初始历史应生成当前势力关系和区域状态，而不是只当背景文本」。
 *
 *   1. 内容表：13 个事件，四条后果的引用全部指向真实实体；
 *   2. **势力旧仇真的进了关系表**（历史优先于 powers.yaml 的默认底图）；
 *   3. **地点伤痕真的改了生态参数**（叠在域参数上、夹在 0—1）；
 *   4. **地点伤痕真的改了危险度**（夹在 0—5）；
 *   5. 多条伤痕**相加**、同一对势力的关系**后者胜**（两条合并规则）；
 *   6. 按地点 / 按势力查得到历史；
 *   7. 空历史表 = 世界没有过去，且与加这一层之前逐位相同。
 *
 * 第 2、3、4 三条是这一层的全部意义：只有 1 的话，
 * 它就只是一张好看的背景表，而那种东西在报告里和「真的接进了判定」长得一样。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadContent, loadHistory } from '../src/data/loader.ts';
import {
  HistoryIndex,
  HistoryEventSchema,
  historyEffects,
  mergeWithDeclaredRelations,
  type HistoryEvent,
} from '../src/domain/world/history.ts';
import { ZoneIndex, resolveEcologyParams } from '../src/domain/world/zone.ts';

const CONTENT = loadContent();
const HISTORY = CONTENT.history;
const INDEX = new HistoryIndex(HISTORY);
const FACTS = historyEffects(HISTORY);

const POWER_IDS = new Set(CONTENT.powers.map((power) => power.id));
const LOCATION_IDS = new Set(CONTENT.locations.map((location) => location.id));
const REGION_IDS = new Set(CONTENT.regions.map((region) => region.id));

/* ================================================================== *
 * 一、内容表
 * ================================================================== */

test('M2.61 历史：事件的四条后果引用全部指向真实实体', () => {
  /*
   * M2.85 内容填充 P6：历史事件 13 → 20（原作年表 06-历史/世界大事年表.md 逐字取材）。
   * 条数不再写死 —— 这条判据守的是**四条后果的引用完整性**
   * （power_relations / location_scars / sealed / taboo_knowledge 必须指向真实实体），那件事没变。
   */
  assert.ok(HISTORY.length >= 13, '历史事件至少 13 个');
  const ids = HISTORY.map((event) => event.id);
  assert.equal(ids.length, new Set(ids).size, '事件 id 不能重复');
  const bad: string[] = [];
  for (const event of HISTORY) {
    for (const id of event.parties) {
      if (!POWER_IDS.has(id)) bad.push(event.id + '.parties -> ' + id);
    }
    for (const id of event.locations) {
      if (!LOCATION_IDS.has(id)) bad.push(event.id + '.locations -> ' + id);
    }
    for (const relation of event.effects.power_relations) {
      if (!POWER_IDS.has(relation.from)) bad.push(event.id + '.from -> ' + relation.from);
      if (!POWER_IDS.has(relation.to)) bad.push(event.id + '.to -> ' + relation.to);
      if (relation.from === relation.to) bad.push(event.id + ' 自引用 ' + relation.from);
    }
    for (const scar of event.effects.location_scars) {
      if (!LOCATION_IDS.has(scar.location)) bad.push(event.id + '.scar -> ' + scar.location);
    }
    for (const item of event.effects.sealed) {
      if (!LOCATION_IDS.has(item.location)) bad.push(event.id + '.sealed -> ' + item.location);
    }
    for (const item of event.effects.taboo_knowledge) {
      if (!REGION_IDS.has(item.scope) && !LOCATION_IDS.has(item.scope)) {
        bad.push(event.id + '.taboo.scope -> ' + item.scope);
      }
      if (!POWER_IDS.has(item.holder)) bad.push(event.id + '.taboo.holder -> ' + item.holder);
    }
  }
  assert.deepEqual(bad, [], '历史里的每一条引用都必须指向真实实体');
});

test('M2.61 历史：loader 在真实内容上不报历史相关的错', () => {
  const related = CONTENT.issues.filter((issue) => /历史 /.test(issue.message));
  assert.deepEqual(related.map((issue) => issue.message), [], '真实内容上历史校验不该报任何东西');
});

test('M2.61 历史：schema 拦住越界的年份、危险度与关系类型', () => {
  const base = { id: 'x', name: 'x', type: 'war', year: 1, result: 'r' };
  assert.equal(HistoryEventSchema.safeParse(base).success, true);
  assert.equal(HistoryEventSchema.safeParse({ ...base, year: -1 }).success, false, '年份不能为负');
  assert.equal(HistoryEventSchema.safeParse({ ...base, type: '不存在的类型' }).success, false);
  // 危险度加成上限 3 —— 它叠在 locations.yaml 的 danger 上（后者 0—5）
  assert.equal(
    HistoryEventSchema.safeParse({
      ...base,
      effects: { location_scars: [{ location: 'l', danger_bonus: 9 }] },
    }).success,
    false,
  );
  // 关系类型是枚举
  assert.equal(
    HistoryEventSchema.safeParse({
      ...base,
      effects: { power_relations: [{ from: 'a', to: 'b', kind: '不认识' }] },
    }).success,
    false,
  );
});

/* ================================================================== *
 * 二、历史 → 势力关系（真的进了关系表）
 * ================================================================== */

test('M2.61 历史：势力旧仇真的进了关系表，且优先于默认底图', () => {
  assert.ok(FACTS.relations.length > 0, '历史必须产生势力关系 —— 否则它只是背景文本');
  const declared = CONTENT.powers.flatMap((power) =>
    power.relations.map((relation) => ({ from: power.id, to: relation.to, kind: relation.kind })),
  );
  const merged = mergeWithDeclaredRelations(declared, FACTS.relations);
  assert.ok(merged.length >= declared.length, '合并只该加边或覆盖，不该丢边');
  // 历史里的每一条都必须在合并结果里
  for (const relation of FACTS.relations) {
    const found = merged.find((entry) => entry.from === relation.from && entry.to === relation.to);
    assert.ok(found, '历史关系没进合并结果：' + relation.from + ' -> ' + relation.to);
    assert.equal(found.kind, relation.kind, '历史应当覆盖默认底图的同一对关系');
  }
});

test('M2.61 历史：每一对势力只有一条关系（历史覆盖默认，不并列）', () => {
  const declared = CONTENT.powers.flatMap((power) =>
    power.relations.map((relation) => ({ from: power.id, to: relation.to, kind: relation.kind })),
  );
  const merged = mergeWithDeclaredRelations(declared, FACTS.relations);
  const keys = merged.map((entry) => entry.from + '->' + entry.to);
  assert.equal(keys.length, new Set(keys).size, '同一对势力不能同时有两条关系');
});

test('M2.61 历史：正神教会之间真的有旧仇（不是一句背景话）', () => {
  const ids = new Set(FACTS.relations.map((relation) => relation.from + '->' + relation.to));
  assert.ok(
    ids.has('night_goddess->eternal_blazing_sun') || ids.has('eternal_blazing_sun->night_goddess'),
    '诸神黄昏之战必须留下一条敌对关系',
  );
  assert.ok(ids.has('earth_mother->crown'), '南大陆的开拓必须让大地母神与王室结仇');
  assert.ok(ids.has('god_of_steam->god_of_war'), '铁路与教堂之争必须留下关系');
});

/* ================================================================== *
 * 三、历史 → 生态参数与危险度（地点伤痕真的生效）
 * ================================================================== */

test('M2.61 历史：地点伤痕真的改了生态参数（叠在域参数上、夹在 0—1）', () => {
  const patches = new Map(FACTS.scars.map((scar) => [scar.location, scar.zonePatch]));
  const withScar = new ZoneIndex(CONTENT.zones, patches);
  const without = new ZoneIndex(CONTENT.zones);
  const scarred = FACTS.scars.find((scar) => (scar.zonePatch.spirituality ?? 0) > 0);
  assert.ok(scarred, '至少要有一处伤痕抬高灵性浓度，否则这条用例没东西可测');
  const before = without.paramsOf(scarred.location);
  const after = withScar.paramsOf(scarred.location);
  assert.ok(
    after.spirituality > before.spirituality,
    '伤痕必须真的抬高频灵性：' + before.spirituality + ' -> ' + after.spirituality,
  );
  assert.ok(after.spirituality <= 1, '夹在 0—1 内');
  // 没被伤过的地方必须与之前完全一致
  const clean = CONTENT.locations.find((location) => !patches.has(location.id));
  if (clean !== undefined) {
    assert.deepEqual(
      withScar.paramsOf(clean.id),
      without.paramsOf(clean.id),
      '没被历史伤过的地方必须逐位不变',
    );
  }
});

test('M2.61 历史：同一个地点被多场灾难伤过时，偏移是相加的', () => {
  // 人工造两场灾难打同一个地点
  const a: HistoryEvent = {
    id: 'a', name: '灾A', type: 'disaster', year: 10, result: 'r', region: '',
    locations: [], parties: [],
    effects: {
      power_relations: [],
      location_scars: [{ location: 'loc', danger_bonus: 1, zone_patch: { pollution: 0.1 } }],
      sealed: [], taboo_knowledge: [],
    },
  };
  const b: HistoryEvent = {
    ...a, id: 'b', name: '灾B', year: 5,
    effects: {
      power_relations: [],
      location_scars: [{ location: 'loc', danger_bonus: 2, zone_patch: { pollution: 0.2 } }],
      sealed: [], taboo_knowledge: [],
    },
  };
  const facts = historyEffects([a, b]);
  assert.equal(facts.scars.length, 1, '同一个地点只该有一条合并后的伤痕');
  assert.equal(facts.scars[0]!.dangerBonus, 3, '危险度相加');
  assert.ok(Math.abs((facts.scars[0]!.zonePatch.pollution ?? 0) - 0.3) < 1e-9, '参数偏移相加');
  assert.ok(facts.scars[0]!.because.includes('灾A') && facts.scars[0]!.because.includes('灾B'), '来处要写全');
});

test('M2.61 历史：同一对势力的关系由距今最近的那件事决定', () => {
  const old: HistoryEvent = {
    id: 'old', name: '旧仗', type: 'war', year: 100, result: 'r', region: '', locations: [], parties: [],
    effects: {
      power_relations: [{ from: 'a', to: 'b', kind: 'hostile' }],
      location_scars: [], sealed: [], taboo_knowledge: [],
    },
  };
  const recent: HistoryEvent = {
    ...old, id: 'recent', name: '后来和好了', year: 5,
    effects: {
      power_relations: [{ from: 'a', to: 'b', kind: 'ally' }],
      location_scars: [], sealed: [], taboo_knowledge: [],
    },
  };
  const facts = historyEffects([old, recent]);
  assert.equal(facts.relations.length, 1, '同一对势力只该有一条关系');
  assert.equal(facts.relations[0]!.kind, 'ally', '距今更近的那件事说了算');
  assert.equal(facts.relations[0]!.because, '后来和好了');
});

/* ================================================================== *
 * 四、索引与兜底
 * ================================================================== */

test('M2.61 历史：按地点与按势力都查得到历史', () => {
  const atMist = INDEX.ofLocation('mist_street');
  assert.ok(atMist.length > 0, '大雾灾发生在迷雾街区，那里必须查得到');
  assert.ok(atMist.some((event) => event.id === 'great_fog'));
  const ofChurch = INDEX.ofPower('night_goddess');
  assert.ok(ofChurch.length >= 2, '黑夜女神卷进过不止一件事：' + ofChurch.length);
  assert.ok(INDEX.byId('war_of_gods') !== undefined);
  assert.equal(INDEX.byId('不存在'), undefined);
  // 新→旧：距今小的在前
  const sorted = INDEX.ofLocation('above_grey_fog');
  for (let i = 1; i < sorted.length; i += 1) {
    assert.ok(sorted[i - 1]!.year <= sorted[i]!.year, '按距今升序');
  }
});

test('M2.61 历史：空历史表 = 世界没有过去，且生态逐位不变', () => {
  const empty = new HistoryIndex([]);
  assert.equal(empty.size, 0);
  assert.deepEqual(empty.ofLocation('mist_street'), []);
  assert.deepEqual(empty.ofPower('church'), []);
  const facts = historyEffects([]);
  assert.deepEqual(facts, { relations: [], scars: [], sealed: [], taboos: [] });
  // 空伤痕表建出来的 ZoneIndex 与只有域表时逐位相同
  const bare = new ZoneIndex(CONTENT.zones);
  const withEmpty = new ZoneIndex(CONTENT.zones, new Map());
  for (const location of CONTENT.locations) {
    assert.deepEqual(withEmpty.paramsOf(location.id), bare.paramsOf(location.id));
  }
  assert.deepEqual(resolveEcologyParams(undefined).fear, 0);
});

test('M2.61 历史：读不到 history 文件时报问题而不是抛异常', () => {
  const result = loadHistory('不存在的文件.yaml', {
    powers: POWER_IDS, locations: LOCATION_IDS, regions: REGION_IDS,
  });
  assert.ok(result.issues.length > 0, '读不出文件时要报问题，不能静默返回空表');
  assert.equal(result.history.length, 0);
});

test('M2.61 历史：纪元事件描述的是当前纪元（NUMERIC.epoch 的兑现）', () => {
  /*
   * NUMERIC.epoch 从落地起就自陈「本版没有任何代码读它」。
   * 历史层是它第一次被用上：纪元不是背景，它是「这个世界还有多久到下一个转折点」。
   */
  const epochs = HISTORY.filter((event) => event.type === 'epoch');
  assert.ok(epochs.length >= 1, '至少要有一条纪元记录');
  assert.ok(
    epochs.some((event) => event.id === 'epoch_current'),
    '当前纪元必须在历史表里 —— 那是「现在」在历史里的位置',
  );
});
