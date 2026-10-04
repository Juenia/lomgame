/**
 * M2.15 正神教会骨架的验收（任务 A）。
 *
 * 这一轮只做**骨架**：内容表 + schema + 交叉校验 + 只读索引。
 * 入教 / 贡献 / 教义 flag / 技能树是 M2.16，教会之间的争夺是 M2.17，组织创建是 M2.18 ——
 * 本文件里**没有**任何一条断言在测那些东西。
 *
 * 分节：
 *   §A 正神教会内容表（七正神 / 途径绑定 / 交叉校验 / ChurchIndex）
 *   §B 动态据点（任务 B，见文件后半）
 *   §C 教会间关系（任务 C）
 *   §D 灾厄的 locationId 兼容性（任务 D）
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import { NUMERIC } from '../src/config/numeric.ts';
import { loadChurches, loadContent, validateChurches } from '../src/data/loader.ts';
import {
  ChurchIndex,
  churchTerritoryAt,
  churchTerritoryBucketOf,
  parseChurch,
  type ChurchDef,
} from '../src/domain/church/index.ts';
import { calamityAt } from '../src/domain/world/calamity.ts';
import { dayStartOf } from '../src/domain/world/clock.ts';

const content = loadContent();
const churches = content.churches;
// 与 main.ts 同一份装配：seats（城市）→ cities.center（地点）的映射与地点邻接图都在构造时建好
const index = new ChurchIndex(churches, content.cities, content.locations);

/** 临时目录用完就删（与 test/m21-evidence.test.ts 一个手法） */
const tempDirs: string[] = [];
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function writeChurchesYaml(entries: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'm215-churches-'));
  tempDirs.push(dir);
  const file = join(dir, 'churches.yaml');
  writeFileSync(file, stringifyYaml({ churches: entries }), 'utf8');
  return file;
}

function churchOf(id: string): ChurchDef {
  const church = index.byId(id);
  assert.ok(church, `内容表里没有 ${id}`);
  return church;
}

/** 拿一份真实内容的深拷贝当模板，只改要测的那一处（负例测试的标准手法） */
function templateOf(id: string): ChurchDef {
  return structuredClone(churchOf(id));
}

/* ==================== §A 内容表 ==================== */

test('M2.15-A：churches.yaml 通过全部交叉校验（0 error）', () => {
  const errors = content.issues.filter((issue) => issue.level === 'error');
  assert.deepEqual(errors, [], '内容表有 error 级问题：' + JSON.stringify(errors));
});

test('M2.15-A：七正神都在内容表里，途径绑定按本轮拍板', () => {
  assert.equal(churches.length, 7, '七正神应当是七家');
  assert.deepEqual(
    churches.map((church) => church.id).sort(),
    [
      'earth_mother',
      'eternal_blazing_sun',
      'god_of_knowledge',
      'god_of_steam',
      'god_of_war',
      'night_goddess',
      'storm_lord',
    ],
    '七正神的 id 是 M2.16 / M2.17 / M2.18 会引用的键，不能改名',
  );

  /*
   * 能绑上的有**三家**（M2.19 之前是两家，那时 sailor 还没实现）：
   *   黑夜女神 ← 不眠者 · 战神 ← 战士 · **风暴之主 ← 水手（M2.19 接入）**
   */
  assert.equal(index.ofPathway('sleepless')?.id, 'night_goddess');
  assert.equal(index.ofPathway('warrior')?.id, 'god_of_war');
  /*
   * ⚠️ 这条断言是**故意**的：seer（占卜家 / 愚者）不属于七正神
   * （愚者是独立于七正神的隐秘存在），所以它在正神教会里**没有落点**。
   * 后人若把「知识与智慧之神 → seer」这条硬绑上去，这里会红。
   */
  assert.equal(index.ofPathway('seer'), null, 'seer（愚者）不是七正神中的任何一位，不许硬绑');
  // M2.19：sailor 落地之后，风暴之主从「待定」搬进了绑定那一栏
  assert.equal(index.ofPathway('sailor')?.id, 'storm_lord', '风暴之主 ← 水手（M2.19 接入）');
});

test('M2.15-A：**没有一家再是待定的** —— 22 条正途径全落地后，七正神全部绑上了途径', () => {
  /*
   * M2.26 的注释逐个移出过 god_of_steam → god_of_knowledge → earth_mother，
   * 当时写的是「七正神里只剩永恒烈阳还没实现」。
   * **M2.76：太阳途径也落地了**（22 条正途径全部实现）⇒ 待定集合**空了**。
   *
   * 这条用例因此从「逐家检查待定项」变成「断言待定项为空」——
   * 它仍然是一个有用的守卫：哪一天有人把一家教会改回 plannedPathway，这里会红。
   */
  assert.deepEqual(index.pending().map((church) => church.id).sort(), [], '不应再有任何待定的正神教会');
  for (const id of ['eternal_blazing_sun']) {
    const church = churchOf(id);
    assert.notEqual(church.pathway, null, `${id}: 太阳途径已落地，必须真的绑上`);
    assert.equal(church.plannedPathway, null, `${id}: 绑上之后待办标记必须归 null`);
  }
  assert.deepEqual(
    index.bound().map((church) => church.id).sort(),
    // M2.26：第一批 +god_of_steam、第二批 +god_of_knowledge、第三批 +earth_mother（.sort() 是字典序）
    // M2.76：+eternal_blazing_sun（太阳途径落地）⇒ 七家全部绑上
    ['earth_mother', 'eternal_blazing_sun', 'god_of_knowledge', 'god_of_steam', 'god_of_war', 'night_goddess', 'storm_lord'],
    '🔒 途径已实现的六家（七正神里只剩永恒烈阳待定）—— M2.16 的入教只会看到这一批',
  );
});

test('M2.15-A：每家教会的骨架字段都完整（type / 教义 / 禁忌 / 等级 / 据点 / 关系）', () => {
  for (const church of churches) {
    assert.equal(church.type, 'church', `${church.id}: M2.15 只做正神教会`);
    assert.ok(church.dogma.length > 0, `${church.id}: 缺教义`);
    assert.ok(church.taboos.length >= 1, `${church.id}: 禁忌清单是空的`);
    assert.ok(church.ranks.length >= 4, `${church.id}: 等级阶梯太短（信徒→…→主教的骨架至少要 4 级）`);
    assert.ok(church.seats.length >= 1, `${church.id}: 没有据点城市`);
    // 等级 id 在**同一家教会内**唯一（不同教会共用同一套 id 骨架是设计如此）
    const rankIds = church.ranks.map((rank) => rank.id);
    assert.equal(new Set(rankIds).size, rankIds.length, `${church.id}: 等级 id 重复`);
  }
  // 据点城市必须是真实城市（交叉校验已覆盖，这里再钉一次 tb 级的可见性）
  const cityIds = new Set(content.cities.map((city) => city.id));
  for (const church of churches) {
    for (const seat of church.seats) assert.ok(cityIds.has(seat), `${church.id}: 据点 ${seat} 不是登记过的城市`);
  }
});

test('M2.15-A：教会间关系是自洽的（对称 + 自反中立 + 只写非中立）', () => {
  const ids = new Set(churches.map((church) => church.id));
  for (const church of churches) {
    for (const [otherId, relation] of Object.entries(church.relations)) {
      assert.ok(ids.has(otherId), `${church.id}: 关系指向未登记的教会 ${otherId}`);
      assert.notEqual(otherId, church.id, `${church.id}: 不该声明与自己的关系（自反恒为 neutral）`);
      const back = churchOf(otherId).relations[church.id] ?? 'neutral';
      assert.equal(back, relation, `关系不对称：${church.id}→${otherId} 是 ${relation}，反向是 ${back}`);
    }
  }
  // 至少有一对敌对：一份全是同盟的关系表说明内容还没写（M2.17 的势力争夺要有敌人才成立）
  const hostile = churches.some((church) =>
    Object.values(church.relations).some((relation) => relation === 'hostile'),
  );
  assert.ok(hostile, '七正神之间至少要有一对敌对关系');
});

test('M2.15-A：ChurchIndex 的四个查询都按预期工作', () => {
  assert.equal(index.count(), 7);
  assert.equal(index.byId('night_goddess')?.name, '黑夜女神');
  assert.equal(index.byId('不存在的教会'), null);
  // 据点查询：廷根市只有黑夜女神
  assert.deepEqual(
    index.churchesOfCity('tingen').map((church) => church.id),
    ['night_goddess'],
  );
  assert.deepEqual(index.churchesOfCity(null), [], '没有城市就没有教会');
  assert.deepEqual(index.churchesOfCity('不存在'), []);
  // 全量顺序 = 内容表顺序（同一份内容跑两遍得到同一个世界）
  assert.deepEqual(index.all().map((church) => church.id), churches.map((church) => church.id));
});

/* ==================== §A 负例：校验真的能挡住坏内容 ==================== */

test('M2.15-A 负例：途径 id 不存在 → 内容表报错（不硬绑、也不放过错字）', () => {
  const file = writeChurchesYaml([
    {
      /*
       * M2.76：**22 条正途径全部落地**，所以「用一个还没实现的途径 id 来构造负例」
       * 这件事本身不成立了 —— `pathway` 与 `plannedPathway` 加起来已经覆盖 22 + 10 条，
       * 剩下能触发「解析失败」的只有**真的不存在的 id**。
       * 这比原来更贴这条用例的名字（「途径 id 不存在 → 内容表报错」）。
       */
      id: 'eternal_blazing_sun',
      name: '永恒烈阳',
      type: 'church',
      pathway: 'not_a_pathway',
      dogma: '太阳照见每一处阴影。',
      ranks: [{ id: 'believer', name: '信徒' }],
      seats: ['backlund'],
    },
  ]);
  const parsed = loadChurches(file);
  assert.equal(parsed.churches.length, 0, '途径 id 不存在时不该解析出教会');
  assert.ok(parsed.issues.some((issue) => issue.level === 'error'));
});

test('M2.15-A 负例：type 不是 church / 途径与待办标记的四种组合', () => {
  const cities = content.cities;

  const order = templateOf('god_of_war');
  order.type = 'order';
  assert.ok(
    validateChurches([order], cities).some((issue) => issue.message.includes('只做正神教会')),
    'order / cult 是 M2.18 的预留值，M2.15 一旦出现就该报错',
  );

  /*
   * M2.76：**七家教会全部绑上了途径**（22 条正途径全落地，没有「待定」的了），
   * 所以「两个都空」这个负例只能**手工构造**：取任何一家，把两栏一起置空。
   * 原来那种「找一家还没绑的」写法在 22 途径下落不了地 —— 一家都不剩。
   */
  const bothEmpty = templateOf('storm_lord');
  bothEmpty.pathway = null;
  bothEmpty.plannedPathway = null;
  assert.ok(validateChurches([bothEmpty], cities).some((issue) => issue.message.includes('恰有一个非空')));

  const bothFilled = templateOf('night_goddess');
  // M2.76：22 条正途径全部落地，所以 `plannedPathway` 的合法取值只剩
  // 《宿命之环》那 10 条外神途径 —— 这里取 astronomer（致密者）。
  bothFilled.plannedPathway = 'astronomer';
  assert.ok(validateChurches([bothFilled], cities).some((issue) => issue.message.includes('恰有一个非空')));
});

test('M2.15-A 负例：途径被两家绑 / 据点城市不存在', () => {
  const cities = content.cities;

  const doubleBound = templateOf('storm_lord');
  doubleBound.pathway = 'warrior'; // 已经绑给战神了
  doubleBound.plannedPathway = null;
  assert.ok(validateChurches([doubleBound, templateOf('god_of_war')], cities).some((issue) => issue.message.includes('已经绑给')));

  const ghostCity = templateOf('night_goddess');
  ghostCity.seats = ['tingen', 'atlantis'];
  assert.ok(validateChurches([ghostCity], cities).some((issue) => issue.message.includes('未登记的城市 atlantis')));
});

test('M2.15-A 负例：关系指向自己 / 指向未登记的教会 / 不对称', () => {
  const cities = content.cities;

  const selfRef = templateOf('god_of_knowledge');
  selfRef.relations = { god_of_knowledge: 'ally' };
  assert.ok(validateChurches([selfRef], cities).some((issue) => issue.message.includes('指向了自己')));

  const ghostChurch = templateOf('god_of_knowledge');
  ghostChurch.relations = { nonexistent_church: 'hostile' };
  assert.ok(validateChurches([ghostChurch], cities).some((issue) => issue.message.includes('未登记的教会')));

  /*
   * 非对称：真实内容里女神与烈阳是 hostile，这里把烈阳那一侧改成 ally。
   * 这一条是任务书点名要的（「非对称是设计错误」）。
   */
  const oneWay = templateOf('eternal_blazing_sun');
  oneWay.relations = { night_goddess: 'ally' };
  const issues = validateChurches([oneWay, templateOf('night_goddess')], cities);
  assert.ok(issues.some((issue) => issue.message.includes('关系必须对称')));
});

test('M2.15-A 负例：绑了途径却没有任何据点城市开放它 → warn（不是 error）', () => {
  const cities = content.cities;
  const nowhere = templateOf('god_of_war');
  nowhere.seats = ['byron']; // 拜朗不开放 warrior
  const issues = validateChurches([nowhere], cities);
  const warn = issues.find((issue) => issue.message.includes('都不开放'));
  assert.ok(warn, '应当报出来');
  assert.equal(warn.level, 'warn', '入教（M2.16）还没做，所以它是 warn 而不是 error');
});

test('M2.15-A 负例：教会 id 重复 / 一张表都没有教会', () => {
  const duplicated = writeChurchesYaml([
    { id: 'night_goddess', name: '黑夜女神', type: 'church', pathway: 'sleepless', dogma: 'x', ranks: [{ id: 'a', name: 'A' }], seats: ['tingen'] },
    // M2.76：`plannedPathway` 的合法取值只剩《宿命之环》那 10 条（正途径全部已实现）
    { id: 'night_goddess', name: '黑夜女神（重复）', type: 'church', pathway: null, plannedPathway: 'astronomer', dogma: 'y', ranks: [{ id: 'a', name: 'A' }], seats: ['tingen'] },
  ]);
  const parsed = loadChurches(duplicated);
  assert.equal(parsed.churches.length, 2);
  assert.ok(parsed.issues.some((issue) => issue.message.includes('教会 id 重复')));

  const empty = writeChurchesYaml([]);
  assert.ok(loadChurches(empty).issues.some((issue) => issue.message.includes('一家教会都没有')));
});

test('M2.15-A：parseChurch 对缺字段的条目报错并指出路径', () => {
  const result = parseChurch({ id: 'x', name: '某教会' });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.issues.some((issue) => issue.startsWith('dogma')), '缺 dogma 应当被指出来：' + result.issues.join('；'));
  }
});
/* ==================== §B 动态据点（任务 B） ==================== */

const HOUR_MS = 60 * 60 * 1000;
/** 一个稳定的基准时刻；窗口取样一律走 noonOfWindow，不写死日期 */
const T0 = 1_700_000_000_000;
const WINDOW_DAYS = NUMERIC.church.territoryIntervalDays;

/** 第 n 个窗口的正午：窗口整天对齐，所以正午必然落在窗口内，与系统时区无关 */
function noonOfWindow(n: number): number {
  return dayStartOf(n * WINDOW_DAYS) + 12 * HOUR_MS;
}

/** 测试自己建一份邻接图（无向）：与 ChurchIndex 内部那一份独立，用来核对「扩张只能落在邻居上」 */
const adjacency = new Map<string, string[]>();
for (const location of content.locations) {
  for (const next of location.adjacent) {
    const forward = adjacency.get(location.id) ?? [];
    if (!forward.includes(next)) forward.push(next);
    adjacency.set(location.id, forward);
    const backward = adjacency.get(next) ?? [];
    if (!backward.includes(location.id)) backward.push(location.id);
    adjacency.set(next, backward);
  }
}

function neighborsOfBase(base: readonly string[]): Set<string> {
  const found = new Set<string>();
  for (const id of base) for (const next of adjacency.get(id) ?? []) found.add(next);
  return found;
}

test('M2.15-B：静态据点 = seats（城市）经 cities.center 映射成的地点', () => {
  assert.deepEqual(
    index.baseLocationsOf('night_goddess'),
    ['backlund', 'byron', 'pritz', 'tingen'],
    '女神教会的四座城市正好都以自己为城区地点',
  );
  assert.deepEqual(index.baseLocationsOf('god_of_war'), ['backlund', 'pritz', 'trier']);
  assert.deepEqual(index.baseLocationsOf('不存在的教会'), []);
  const base = index.baseLocationsOf('night_goddess');
  const territory = index.territoryAt('world', T0, 'night_goddess');
  assert.ok(territory.every((id) => base.includes(id) || neighborsOfBase(base).has(id)));
});

test('M2.15-B：同 seed 同 t 同结果（纯函数），且同窗口内任何时刻都相同', () => {
  const bucket = churchTerritoryBucketOf(T0);
  const windowStart = dayStartOf(bucket * WINDOW_DAYS);
  const windowEnd = dayStartOf((bucket + 1) * WINDOW_DAYS) - 1;
  for (const church of churches) {
    const first = index.territoryAt('world', windowStart, church.id);
    assert.deepEqual(index.territoryAt('world', windowStart, church.id), first, '同参数两次调用必须一致');
    assert.deepEqual(index.territoryAt('world', windowEnd, church.id), first, '同一个窗口的首尾必须一致');
    assert.deepEqual(
      index.territoryAt('world', windowStart + 3 * HOUR_MS, church.id),
      first,
      '窗口中间任意时刻也必须一致 —— 这一层不读 t 的绝对值，只读窗口号',
    );
  }
  assert.notDeepEqual(index.territoryAt('world', T0, 'night_goddess'), index.territoryAt('world', T0, 'storm_lord'));
});

test('M2.15-B：不跨窗口累积 —— 相对静态据点至多 +1（跨窗口断言）', () => {
  let expanded = 0;
  let unchanged = 0;
  for (const church of churches) {
    const base = index.baseLocationsOf(church.id);
    for (let n = 20_000; n < 20_300; n += 1) {
      const territory = index.territoryAt('world', noonOfWindow(n), church.id);
      const added = territory.filter((id) => !base.includes(id));
      const removed = base.filter((id) => !territory.includes(id));
      assert.ok(
        added.length <= 1 && removed.length === 0,
        `${church.id} 在第 ${n} 个窗口出现了「累积式」的据点：多 ${added.length} 个、少 ${removed.length} 个`,
      );
      /*
       * 静态据点一个都不能少 —— 这不是重复：**本轮没有收缩**（M2.16 前置把三区间降成两区间，
       * 理由见 docs/M2.15-交付说明.md §3.2）。谁把收缩加回来，这里会先红。
       */
      assert.ok(
        base.every((id) => territory.includes(id)),
        `${church.id} 少了一个静态据点：${base.filter((id) => !territory.includes(id)).join(',')}`,
      );
      for (const id of added) {
        assert.ok(neighborsOfBase(base).has(id), `${church.id} 扩张到了不相邻的地点 ${id}`);
      }
      if (added.length > 0) expanded += 1;
      else unchanged += 1;
    }
  }
  const total = expanded + unchanged;
  assert.ok(expanded > 0 && unchanged > 0, '两条分支都该被掷到');
  // 粗口径核对参数真的生效（2100 个样本，容差给得很宽）
  assert.ok(expanded / total > 0.2 && expanded / total < 0.4, `扩张比例 ${(expanded / total).toFixed(3)} 偏离 0.3 太多`);
});

test('M2.15-B：没有邻接图 → 扩张池恒为空，结果永远是静态那一份', () => {
  for (let n = 0; n < 200; n += 1) {
    assert.deepEqual(churchTerritoryAt('world', noonOfWindow(n), 'single', ['tingen']), ['tingen']);
    assert.deepEqual(churchTerritoryAt('world', noonOfWindow(n), 'pair', ['tingen', 'old_dock']), [
      'old_dock',
      'tingen',
    ]);
  }
});

test('M2.15-B：结果与入参顺序无关；没有邻接图时不扩张', () => {
  const sorted = churchTerritoryAt('world', T0, 'night_goddess', ['byron', 'pritz', 'tingen'], adjacency);
  const shuffled = churchTerritoryAt('world', T0, 'night_goddess', ['tingen', 'byron', 'pritz', 'tingen'], adjacency);
  assert.deepEqual(shuffled, sorted, '去重排序之后必须落到同一个结果');
  assert.deepEqual(churchTerritoryAt('world', T0, 'night_goddess', ['tingen', 'byron']), ['byron', 'tingen']);
});

test('M2.15-B：ChurchIndex.territoryAt 就是纯函数那一层（薄封装）', () => {
  for (const church of churches) {
    const base = index.baseLocationsOf(church.id);
    assert.deepEqual(
      index.territoryAt('world', T0, church.id),
      churchTerritoryAt('world', T0, church.id, base, adjacency),
    );
  }
  assert.deepEqual(index.territoryAt('world', T0, '不存在的教会'), []);
});

/* ==================== §C 教会间关系（任务 C） ==================== */

test('M2.15-C：静态关系可查、对称、自反中立、未声明即中立', () => {
  assert.equal(index.relationOf('night_goddess', 'eternal_blazing_sun'), 'hostile');
  assert.equal(index.relationOf('night_goddess', 'god_of_war'), 'hostile');
  // M2.19：这一对由 ally 改成 hostile（理由见 churches.yaml 顶部「风暴—女神 这一对为什么改了」）
  assert.equal(index.relationOf('night_goddess', 'storm_lord'), 'hostile');
  assert.equal(index.relationOf('storm_lord', 'god_of_steam'), 'ally');
  assert.equal(index.relationOf('earth_mother', 'night_goddess'), 'ally');
  assert.equal(index.relationOf('god_of_knowledge', 'night_goddess'), 'neutral');
  assert.equal(index.relationOf('god_of_knowledge', 'god_of_knowledge'), 'neutral');

  for (const a of churches) {
    assert.equal(index.relationOf(a.id, a.id), 'neutral', `${a.id} 对自己的关系必须是中立`);
    for (const b of churches) {
      assert.equal(
        index.relationOf(a.id, b.id),
        index.relationOf(b.id, a.id),
        `关系不对称：${a.id} ↔ ${b.id}`,
      );
    }
  }
  assert.equal(index.relationOf('night_goddess', '不存在的教会'), 'neutral');
});

test('M2.15-C：关系表的规范化 key —— 一对只存一份', () => {
  const entries = index.relationEntries();
  /*
   * M2.19：风暴之主多了两条敌对边（女神 / 战神），同时少了一条同盟边（女神）—— 6 → 7。
   * M2.26：第一批（蒸汽）加 2 对（蒸汽↔知识、蒸汽↔战神）⇒ 9 对。
   *
   * ⚠️ **本批（第二批 / 知识）一对都没加** —— 那是审查过的：
   *   总账 §一 明写「god_of_knowledge 全中立保持，只加蒸汽这一条」，
   *   6 对 hostile 是**拍板数字**，多一对就变成 7 对。
   *   （我在施工中一度自己加了「知识↔母神」，跑完批才发现与设计不符并撤销 —— 见交付说明。）
   * 第三批（母神）落地后才变 10 对（3 同盟 + 7 敌对：+ 母神↔战神）。
   */
  /*
   * M2.26：第一批（蒸汽）+2 对 ⇒ 9 对；第二批（知识）**一对都没加**；
   * 第三批（母神）+1 对（母神↔战神）⇒ 10 对（3 同盟 + 7 敌对）。
   * ⚠️ 母神↔风暴**保持 neutral** —— 设计 §五 / 总账 §三 明写（她再加一条会变成最活跃的争夺方）。
   */
  assert.equal(entries.size, 10, '内容表里声明的非中立对共 10 对（3 同盟 + 7 敌对）');
  for (const key of entries.keys()) {
    const [a, b] = key.split('|');
    assert.ok(a! < b!, `key 必须是排序后的形式：${key}`);
  }
  assert.equal(entries.get('eternal_blazing_sun|night_goddess'), 'hostile');
  assert.equal(entries.get('god_of_steam|storm_lord'), 'ally');
});

/* ==================== §D 灾厄的 locationId（任务 D） ==================== */

test('M2.15-D：不传第三参 vs 传 null vs 传 undefined —— 逐位相同（M2.14 行为不变）', () => {
  let calamities = 0;
  for (let i = 0; i < 400; i += 1) {
    const t = T0 + i * 7 * HOUR_MS;
    const plain = calamityAt('world', t);
    assert.deepEqual(calamityAt('world', t, null), plain, '传 null 必须与不传逐位相同');
    assert.deepEqual(calamityAt('world', t, undefined), plain, '传 undefined 必须与不传逐位相同');
    if (plain) {
      calamities += 1;
      assert.equal(plain.locationId, null, '全服查询的 locationId 恒为 null');
    }
  }
  assert.ok(calamities > 0, '这段区间里一次灾厄都没有 —— 这条断言什么都没测到');
});

test('M2.15-D：传地点 id —— 除了 locationId 字段之外与全服逐位相同', () => {
  const places = ['tingen', 'above_grey_fog', 'coral_reef', 'backlund_cathedral'];
  let hits = 0;
  for (let i = 0; i < 400; i += 1) {
    const t = T0 + i * 7 * HOUR_MS;
    const global = calamityAt('world', t);
    for (const locationId of places) {
      const local = calamityAt('world', t, locationId);
      if (!global) {
        assert.equal(local, null, '全服没有灾厄时，任何地点都没有');
        continue;
      }
      assert.ok(local, 'scopeChance = 1 时任何地点都在范围内');
      hits += 1;
      assert.equal(local.locationId, locationId);
      assert.deepEqual({ ...local, locationId: null }, global, '灾厄本身（等级 / 起止 / 强度）必须是同一份');
    }
  }
  assert.ok(hits > 0, '一次都没有生成过灾厄 —— 这条断言什么都没测到');
});

test('M2.15-D：地点级答案在同一个窗口内稳定', () => {
  for (let i = 0; i < 24; i += 1) {
    const a = T0 + i * HOUR_MS;
    const b = a + HOUR_MS;
    for (const locationId of ['tingen', 'coral_reef']) {
      assert.equal(
        calamityAt('world', a, locationId) === null,
        calamityAt('world', b, locationId) === null,
        '同一小时窗口内，同一个地点的「有没有灾厄」必须一致',
      );
    }
  }
});

test('M2.15-D：范围判据是单一来源（NUMERIC.calamity.scopeChance），当前 = 1', () => {
  assert.equal(NUMERIC.calamity.scopeChance, 1, '1 = 全部地点都覆盖，与「灾厄是全服的」这条 v1 口径一致');
  assert.equal(NUMERIC.calamity.enabled, true);
});

