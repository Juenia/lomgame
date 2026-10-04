/**
 * **神座与神明决策**（M2.97）—— 用户两条硬要求的判据：
 *   ① 神明不是随随便便就显现的（邪神也一样）
 *   ② 神明拥有高度的智能（底层代码要做到）
 *
 * 稀有性不能靠「概率写小一点」的口头承诺 —— 必须跑出来看。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { DivineThroneFileSchema, type DivineThrone } from '../src/domain/world/divine-throne.ts';
import { divineGaze, divineStance, divineUrge, BASE_URGE_PER_HOUR, SILENCE_AFTER_ACT, type WorldSituation } from '../src/domain/world/divine-decide.ts';

const FILE = new URL('../src/data/divine-thrones.yaml', import.meta.url);
function loadThrones(): DivineThrone[] {
  const parsed = DivineThroneFileSchema.safeParse(parse(readFileSync(FILE, 'utf8')));
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues?.slice(0, 2)));
  return parsed.data.divine_thrones;
}

function seededRng(seed: number): { next(): number } {
  let s = seed >>> 0;
  return { next(): number { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; } };
}

const QUIET: WorldSituation = { keys: [], playerKeys: [], playerCity: 'tingen', playerSequence: 9 };

test('M2.97 神座表：22 条途径一个不缺，状态分布写死', () => {
  const thrones = loadThrones();
  assert.equal(thrones.length, 22, '22 条途径的序列 0 都要有交代');
  assert.equal(new Set(thrones.map((t) => t.pathway)).size, 22, '途径不许重复');
  const byState: Record<string, number> = { occupied: 0, vacant: 0, contested: 0, sealed: 0 };
  for (const t of thrones) byState[t.state] = (byState[t.state] ?? 0) + 1;
  assert.equal(byState.occupied, 12, '在位 ' + JSON.stringify(byState));
  assert.equal(byState.vacant, 5, '空位 5 个（战神 / 死神 / 审判者 / 黑皇帝 / 红祭司）—— 空位是这一层的信息量');
  assert.equal(byState.contested, 4, '争夺中 4 个（愚者 / 门 / 错误 / 隐者）');
  assert.equal(byState.sealed, 1, '占而不得 1 个（被缚之神）');
  for (const t of thrones) {
    assert.ok(t.seat.length > 0, t.pathway + ' 要写清座位上是誰（空位就写上一任）');
    assert.ok(t.methods.length >= 1, t.pathway + ' 一条手段都没有');
    assert.ok(t.gaze.length >= 1, t.pathway + ' 没有「看向玩家」的分支');
    for (const g of t.gaze) {
      assert.ok(g.text.length > 10, t.pathway + ' 的注视文本太短（那是第一人称遭遇，不是标签）');
    }
  }
});

test('M2.97 ⚠️ 神不随随便便显现：一万小时里每位神出手不到 25 次', () => {
  const thrones = loadThrones();
  const HOURS = 10_000;
  let totalActs = 0;
  let totalManifests = 0;
  for (const throne of thrones) {
    const rng = seededRng(throne.pathway.length * 7919 + 13);
    let acts = 0;
    let manifests = 0;
    let since = 1e9;
    for (let h = 0; h < HOURS; h += 1) {
      const stance = divineStance({ throne, situation: QUIET, hoursSinceLastAct: since, now: h * 3_600_000, rng });
      since += 1;
      if (stance.method !== null) { acts += 1; if (stance.manifest) manifests += 1; since = 0; }
    }
    totalActs += acts;
    totalManifests += manifests;
    assert.ok(acts < 25, throne.pathway + ' 一万小时出手 ' + acts + ' 次 —— 太频繁了');
    if (throne.state === 'vacant') assert.ok(acts <= 6, throne.pathway + ' 是空位（只剩后手），却出手 ' + acts + ' 次');
  }
  const perHour = totalActs / HOURS;
  assert.ok(perHour < 0.06, '平均每小时 ' + perHour.toFixed(4) + ' 次神明行动 —— 世界太吵');
  const manifestRate = totalManifests / Math.max(1, totalActs);
  assert.ok(manifestRate < 0.08, '显现占比 ' + manifestRate.toFixed(3) + ' 太高（亲自下场是几十次里一次的事）');
  /*
   * ⚠️ **而且它必须大于 0**。
   *
   * 第一版把显现门槛拍成 0.05，而 urge 的上限只有 0.0084 ⇒ 那条分支是**死代码**，
   * 而「显现率 < 8%」这条断言照样绿（0 也小于 8%）。
   * 死分支必须有判据看着 —— 否则它只是看起来存在。
   */
  /*
   * ⚠️ 而它必须**在局势紧张时**发生 —— 平静世界里一次都不该有（那是对的设计）。
   * 所以这一条用「玩家正在挖封印物 + 就在他眼皮底下」的局势单独跑一轮。
   */
  let tenseActs = 0;
  let tenseManifests = 0;
  for (const throne of thrones) {
    const city = throne.resources.reach[0] ?? 'tingen';
    const rng = seededRng(throne.pathway.length * 31337 + 5);
    let since = 1e9;
    for (let h = 0; h < HOURS; h += 1) {
      const st = divineStance({
        throne,
        situation: { keys: ['player_digs_sealed'], playerKeys: [], playerCity: city, playerSequence: 1 },
        hoursSinceLastAct: since,
        now: h * 3_600_000,
        rng,
      });
      since += 1;
      if (st.method !== null) { tenseActs += 1; if (st.manifest) tenseManifests += 1; since = 0; }
    }
  }
  assert.ok(tenseActs > 0, '局势拉满时也一次都不动 —— 引擎没接上');
  assert.ok(tenseManifests > 0, '局势拉满时一次「亲自显现」都没有 —— 那条分支是死的（门槛高过 urge 的上限）');
  assert.ok(tenseManifests / tenseActs < 0.2, '显现占比 ' + (tenseManifests / tenseActs).toFixed(3) + ' 太高');
});

test('M2.97 智能：局势命中时欲望 ×4，够得到的城市更容易被看见', () => {
  const thrones = loadThrones();
  const god = thrones.find((t) => t.pathway === 'sleepless')!;
  const quiet = divineUrge(god, QUIET, 1e9);
  const hit = divineUrge(god, { ...QUIET, keys: ['player_digs_sealed'] }, 1e9);
  assert.ok(hit.urge > quiet.urge * 3, '局势命中要明显放大：' + quiet.urge + ' → ' + hit.urge);
  assert.ok(hit.reasons.some((r) => r.includes('局势命中')), '理由要写清为什么：' + hit.reasons.join(' / '));
  const seer = thrones.find((t) => t.pathway === 'mystery_pryer')!;
  const near = divineUrge(seer, { ...QUIET, playerCity: 'backlund' }, 1e9);
  const far = divineUrge(seer, { ...QUIET, playerCity: 'byron' }, 1e9);
  assert.ok(near.urge > far.urge, '够得到的城市更容易被看见：' + far.urge + ' → ' + near.urge);
});

test('M2.97 沉寂：刚出手过的神在沉寂期内一次都不动', () => {
  const thrones = loadThrones();
  const god = thrones.find((t) => t.pathway === 'sun')!;
  for (const hours of [0, 6, 12, 24, SILENCE_AFTER_ACT - 1]) {
    const st = divineStance({ throne: god, situation: { ...QUIET, keys: ['pollution_spreads'] }, hoursSinceLastAct: hours, now: 0, rng: seededRng(1) });
    assert.equal(st.urge, 0, hours + ' 小时前刚出手，欲望必须是 0');
    assert.equal(st.method, null, '沉寂期不许出手');
  }
});

test('M2.97 手段受资源与冷却约束（没有教会就派不出主教）', () => {
  const thrones = loadThrones();
  const god = thrones.find((t) => t.pathway === 'sleepless')!;
  const goals = new Set(god.goals.map((g) => g.id));
  for (const m of god.methods) assert.ok(m.goal === '' || goals.has(m.goal), m.id + ' 的目标不在 goals 里');
  const churchMethod = god.methods.find((m) => m.needs.includes('church'))!;
  const noChurch: DivineThrone = { ...god, resources: { ...god.resources, churches: [] } };
  const rng = seededRng(99);
  let seen = 0;
  let cooled = 0;
  const now = Date.now();
  for (let i = 0; i < 300; i += 1) {
    const a = divineStance({ throne: noChurch, situation: { ...QUIET, keys: ['player_digs_sealed'] }, hoursSinceLastAct: 1e9, now: 0, rng });
    if (a.method?.id === churchMethod.id) seen += 1;
    const b = divineStance({ throne: god, situation: { ...QUIET, keys: ['player_digs_sealed'] }, hoursSinceLastAct: 1e9, methodUsedAt: { [churchMethod.id]: now }, now, rng });
    if (b.method?.id === churchMethod.id) cooled += 1;
  }
  assert.equal(seen, 0, '没有教会却派出了主教');
  assert.equal(cooled, 0, '冷却中的手段被选中了');
});

test('M2.97 注视玩家：够不到就看不见，序列越高越显眼', () => {
  const thrones = loadThrones();
  const god = thrones.find((t) => t.pathway === 'sleepless')!;
  const rng = seededRng(5);
  for (let i = 0; i < 300; i += 1) {
    const g = divineGaze({ throne: god, situation: { keys: [], playerKeys: ['player_digs_sealed'], playerCity: 'byron', playerSequence: 9 }, hoursSinceLastAct: 1e9, now: 0, rng });
    assert.equal(g, null, '玩家不在祂够得到的地方，不该被看见');
  }
  const count = (seq: number): number => {
    const r = seededRng(11);
    let n = 0;
    for (let i = 0; i < 4000; i += 1) {
      if (divineGaze({ throne: god, situation: { keys: [], playerKeys: ['player_digs_sealed'], playerCity: 'tingen', playerSequence: seq }, hoursSinceLastAct: 1e9, now: 0, rng: r }) !== null) n += 1;
    }
    return n;
  };
  const low = count(9);
  const high = count(1);
  assert.ok(high > low, '序列 1 应当比序列 9 更容易被看见：' + low + ' → ' + high);
  assert.ok(high < 4000, '注视本身也要稀有：序列 1 在 4000 次里被看了 ' + high + ' 次');
});

test('M2.97 稀有性的两个基数写死：改它们等于改掉上面所有结论', () => {
  assert.equal(BASE_URGE_PER_HOUR, 0.001, '每小时 0.1%');
  assert.equal(SILENCE_AFTER_ACT, 48, '出手之后 48 小时沉寂');
});
