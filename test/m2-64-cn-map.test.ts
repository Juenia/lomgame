/**
 * M2.64：数据编辑器里的 id → 中文名映射。
 *
 * 用户的原话是「数据编辑器的地点和物品那些显示 ID 的，全部做中文映射」。
 * 这一份守四件事：
 *
 *   1. **引用选项表里有中文名**（后端 /admin/api/data 的 options）；
 *   2. **strlist 字段声明了 itemRef** —— 没声明就还是纯文本框，界面上是生 id；
 *   3. **itemRef 指向的实体必须真实存在**（指错 = 一个永远空的下拉）；
 *   4. **列表行同时给出 id 与中文名** —— 只给中文名就没法引用，只给 id 就认不出。
 *
 * 第 3 条与 admin.test.ts 里那条 ref/mapRef 检查同源，这里补上 itemRef。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';

import { ENTITIES, entityById, refTargetsOf, type FieldSpec } from '../src/admin/schema.ts';

/* ================================================================== *
 * 一、itemRef 元数据
 * ================================================================== */

test('M2.64 中文映射：itemRef 都指向真实存在的实体', () => {
  const ids = new Set(ENTITIES.map((e) => e.id));
  const bad: string[] = [];
  const walk = (fields: typeof ENTITIES[number]['fields'], owner: string): void => {
    for (const f of fields) {
      if (f.itemRef !== undefined && !ids.has(f.itemRef)) {
        bad.push(owner + '.' + f.key + ' 的 itemRef 指向不存在的实体：' + f.itemRef);
      }
      walk(f.rowFields ?? [], owner + '.' + f.key);
    }
  };
  for (const e of ENTITIES) walk(e.fields, e.id);
  assert.deepEqual(bad, [], '指错的 itemRef 会渲染成一个永远空的下拉');
});

test('M2.64 中文映射：itemRef 只用在 strlist 上（别的类型有各自的引用字段）', () => {
  const wrong: string[] = [];
  const walk = (fields: typeof ENTITIES[number]['fields'], owner: string): void => {
    for (const f of fields) {
      if (f.itemRef !== undefined && f.type !== 'strlist') {
        wrong.push(owner + '.' + f.key + ' 是 ' + f.type + ' 却声明了 itemRef');
      }
      walk(f.rowFields ?? [], owner + '.' + f.key);
    }
  };
  for (const e of ENTITIES) walk(e.fields, e.id);
  assert.deepEqual(wrong, [], 'itemRef 只对 strlist 有意义');
});

test('M2.64 中文映射：装 id 的 strlist 字段都声明了 itemRef', () => {
  /*
   * 这一条是「全部做中文映射」的兜底：把当前**已经知道装 id** 的那几个字段钉住。
   * 漏声明的话界面上就是生 id，而那种事在页面上看不出来「本该是中文」。
   */
  const expect: Array<[string, string, string]> = [
    ['zones', 'locations', 'locations'],
    ['history', 'locations', 'locations'],
    ['history', 'parties', 'powers'],
  ];
  for (const [entityId, key, ref] of expect) {
    const field = entityById(entityId)?.fields.find((f) => f.key === key);
    assert.ok(field !== undefined, entityId + ' 没有字段 ' + key);
    assert.equal(field.itemRef, ref, entityId + '.' + key + ' 应当声明 itemRef: ' + ref);
  }
});

test('M2.64 中文映射：物品与地点是引用目标（下拉里才有中文名可显示）', () => {
  /*
   * itemRef 指向的实体必须能被列出来 —— 否则 options 是空的，下拉里什么都没有。
   * 这两个是用户点名的那两个（「地点和物品那些显示 ID 的」）。
   */
  for (const id of ['locations', 'items', 'powers', 'regions']) {
    const spec = entityById(id);
    assert.ok(spec !== undefined, '没有这个可编辑实体：' + id);
    assert.ok((spec.titleKey ?? '').length > 0, id + ' 没有 titleKey —— 取不出中文名');
  }
  // 地点与物品的 titleKey 是中文名字段（不是 id 本身）
  assert.equal(entityById('locations')!.titleKey, 'name');
  assert.equal(entityById('items')!.titleKey, 'name');
});

/* ================================================================== *
 * 二、LOCATIONS / ITEMS 的选项表内容
 * ================================================================== */

test('M2.64 中文映射：地点与物品都能列出「id + 中文名」', async () => {
  const { listEntity } = await import('../src/admin/data.ts');
  const root = process.cwd();

  /*
   * ⚠️ 判据是「**英文 id 必须配中文名**」，不是「id 与名字必须不同」——
   * 有些条目的 id 本身就是中文（`便士` / `夜香草`），
   * 拿「两者不同」当判据会把它们误判成没映射。
   */
  const looksEnglishId = (s: string): boolean => /^[a-z0-9_.-]+$/.test(s);

  const locations = listEntity(root, entityById('locations')!);
  assert.ok(locations.length > 0, '地点一条都列不出来');
  let locEnglish = 0;
  for (const row of locations) {
    assert.ok(row.id.length > 0, '有地点没有 id');
    assert.ok(row.title.length > 0, row.id + ' 没有中文名');
    if (looksEnglishId(row.id)) {
      locEnglish += 1;
      assert.notEqual(row.title, row.id, row.id + ' 是英文 id 却没有中文名（等于没映射）');
    }
  }
  assert.ok(locEnglish > 0, '一个英文 id 的地点都没有？那这条用例什么都没测');

  const items = listEntity(root, entityById('items')!);
  assert.ok(items.length > 0, '物品一条都列不出来');
  let itemEnglish = 0;
  for (const row of items) {
    assert.ok(row.title.length > 0, row.id + ' 没有中文名');
    if (looksEnglishId(row.id)) {
      itemEnglish += 1;
      assert.notEqual(row.title, row.id, row.id + ' 是英文 id 却没有中文名（等于没映射）');
    }
  }
  assert.ok(itemEnglish > 0, '一个英文 id 的物品都没有？那这条用例什么都没测');
});

test('M2.64 中文映射：列表行里 id 与中文名是分开的两样东西', async () => {
  /*
   * 列表那一列要拼成「中文名（id）」：
   *   只给中文名 -> 内容同学没法拿 id 去别处引用；
   *   只给 id     -> 一屏 old_dock / fish_market 认不出谁是谁。
   * 所以 DataRow 必须同时给出这两个。
   */
  const { listEntity } = await import('../src/admin/data.ts');
  const root = process.cwd();
  const rows = listEntity(root, entityById('locations')!);
  const row = rows[0]!;
  assert.ok(typeof row.id === 'string' && row.id.length > 0, '缺 id');
  assert.ok(typeof row.title === 'string' && row.title.length > 0, '缺 title');
  assert.ok('summary' in row, '缺 summary');
});

test('M2.64 中文映射：titleKey 就是 id 的实体，id 与中文名相同（前端要判重）', async () => {
  /*
   * routes / recipes 这类表没有单独的中文名字段，titleKey 就是 id。
   * 前端拼「中文名（id）」时必须判重，否则显示成 `xxx（xxx）`。
   * 这一条把「哪些实体是这种情况」钉住，免得前端改成一刀切。
   */
  const { listEntity } = await import('../src/admin/data.ts');
  const root = process.cwd();
  const recipes = listEntity(root, entityById('recipes')!);
  assert.ok(recipes.length > 0, '配方一条都列不出来');
  const sameCount = recipes.filter((r) => r.title === r.id).length;
  assert.equal(sameCount, recipes.length, '配方的 titleKey 是 id，两者应当相同');
});

test('M2.64 中文映射：装地点 id 的 strlist 字段一个都不能漏', () => {
  /*
   * 这一条是「全部做中文映射」的**兜底清单**。
   *
   * 前面那条只钉了三个字段；这一条把审计出来的**全部**装地点 id 的 strlist 钉住 ——
   * 漏一个的后果是那一栏在界面上显示成 old_dock / fish_market 这种生 id，
   * 而页面上看不出「它本该是中文」。
   */
  const expectLocations: Array<[string, string]> = [
    ['zones', 'locations'],
    ['history', 'locations'],
    ['cities', 'locations'],
    ['creatures', 'habitat'],
  ];
  for (const [entityId, key] of expectLocations) {
    const field = entityById(entityId)?.fields.find((f) => f.key === key);
    assert.ok(field !== undefined, entityId + ' 没有字段 ' + key);
    assert.equal(field.itemRef, 'locations', entityId + '.' + key + ' 应当 itemRef: locations');
  }
});

test('M2.64 中文映射：装城市 / 势力 id 的 strlist 字段也一个都不能漏', () => {
  const expect: Array<[string, string, string]> = [
    ['regions', 'cities', 'cities'],
    ['churches', 'seats', 'cities'],
    ['cities', 'factions', 'powers'],
    ['history', 'parties', 'powers'],
  ];
  for (const [entityId, key, ref] of expect) {
    const field = entityById(entityId)?.fields.find((f) => f.key === key);
    assert.ok(field !== undefined, entityId + ' 没有字段 ' + key);
    assert.equal(field.itemRef, ref, entityId + '.' + key + ' 应当 itemRef: ' + ref);
  }
});

test('M2.64 中文映射：itemRef 指向的实体都要能在 options 里出中文名', async () => {
  /*
   * itemRef 只解决「怎么渲染」，中文名还得靠 options 那份表 ——
   * 而 options 只为**被引用到的**实体生成（index.ts 的 allRefs）。
   * 所以 itemRef 必须进 allRefs，否则下拉是空的。
   */
  const { listEntity } = await import('../src/admin/data.ts');
  const root = process.cwd();
  const targets = new Set<string>();
  for (const e of ENTITIES) {
    for (const f of e.fields) if (f.itemRef) targets.add(f.itemRef);
  }
  assert.ok(targets.size > 0, '一个 itemRef 都没有？');
  for (const id of targets) {
    const spec = entityById(id);
    assert.ok(spec !== undefined, 'itemRef 指向不存在的实体：' + id);
    const rows = listEntity(root, spec);
    assert.ok(rows.length > 0, id + ' 一条都列不出来（下拉会是空的）');
    assert.ok(rows.every((r) => r.title.length > 0), id + ' 有行没有中文名');
  }
});

test('M2.64 中文映射：每条 strlist 都要么有中文映射、要么本来就不是 id', () => {
  /*
   * 每个 strlist 字段都必须说得清它的值在界面上长什么样：
   *   itemRef  —— 值是**一个**实体的 id，去那张表里查中文名（地点 / 物品 / 城市）；
   *   itemRefs —— 值来自**好几个**实体，取它们的并集（事件卡分三类，一个池子里三类都有）；
   *   valueMap —— 值是一个**封闭枚举**，中文名就写在字段自己身上（途径 / 输入类型 / 习性）；
   *   两者都没有 —— 必须在这份「有意不映射」的清单里，并写清为什么。
   *
   * ⚠️ M2.77 之前，途径类的四个字段（cities.pathways / regions.pathways /
   * creatures.pathwayAffinity / cities.planned_pathways）正好卡在中间：值是英文枚举，
   * 却没有 valueMap，界面上一律显示 seer / migrant 这种 id —— 而这条用例当时把它们
   * 记在「有意不映射」里，**等于给一个缺口盖了章**。清单越长越要警惕这件事：
   * 它记的应该只是「确实不该映射」，不是「暂时没做」。
   */
  const onPurpose = new Set([
    'powers.goals',
    'lost-control.texts', 'fragments.texts',
    'registry.flags',
    'community-rules.rules', 'community-rules.punishment',
    'beta-info.schedule', 'beta-info.scope', 'beta-info.not_included', 'beta-info.service',
    /*
     * M2.85 内容填充 P1（塔罗）：`organizations` 是**原作数据里的组织名自由文本**
     * （「安提哥努斯家族」「密修会」），项目里还没有组织表可指。
     * ⚠️ 这不是「暂时没做」而是「要先有 organizations.yaml」—— P1 后续批次建表之后，
     * 这个字段应当改成 `itemRefs` 并把这行从清单里删掉（清单只该记「确实不该映射」）。
     */
    'tarot.organizations',
    /*
     * M2.85 内容填充 P1（神明）：这五项都是**原作数据里的自由文本** ——
     * 途径名（原作口径）、别名、尊名、象征、信仰组织，项目里没有对应的实体表可指，
     * 也不是封闭枚举（它们本来就是一段一段的设定文字）。
     * ⚠️ 与 tarot.organizations 同理：等 organizations.yaml / pathways 中文字典建成后，
     * 应当把能指向实体的那几项改成 itemRefs 并从这里删掉。
     */
    'pantheon.pathwayNames', 'pantheon.aliases', 'pantheon.godNameFull', 'pantheon.symbols', 'pantheon.beliefOrgs',
    'pantheon.essence', 'pantheon.appearance', 'pantheon.nature',
    // 原作「相关地点」是口语地名（不是项目 location id）—— 要指向实体得先有一份地名对照表
    'pantheon.relatedLocations',
    /*
     * M2.85 内容填充 P1（组织）：同样是原作自由文本 —— 组织结构 / 教义 / 成员 / 原作途径名 / 注记 / 来源 URL。
     * ⚠️ 与前几项同理：等 organizations / pathways / locations 的对照表建起来后，
     * 能指向实体的那几项应当改成 itemRef(s) 并从这份清单里删掉。
     */
    'organizations.structure', 'organizations.doctrine', 'organizations.members',
    'organizations.pathwayNames', 'organizations.note', 'organizations.sources',
    /* M2.85 内容填充 P1（人物）：别名 / 原作途径名 / 所属组织 / 注记 / 来源 URL —— 全是原作自由文本 */
    'figures.aliases', 'figures.pathwayNames', 'figures.organization', 'figures.note', 'figures.sources',
    /* M2.85 内容填充 P1（生物名录）：材料与配方引用是**原文串**（「X 的尖牙（主材料 · 用在 criminal:7）」），
       不是实体 id；栖息地/外形是原作自由文本。 */
    'bestiary.aliases', 'bestiary.pathwayNames', 'bestiary.materials', 'bestiary.usedIn', 'bestiary.note', 'bestiary.sources',
    /*
     * M2.85 内容填充 P2（城市）：原作的城市档案是**自由文本**（别名 / 特征 / 地标 / 来源 URL）——
     * 它们不是项目实体 id，也不是封闭枚举。⚠️ 但它们**都有执行点**（.世界 城市 <名或别名>），
     * 与「只写着没人读」是两件事。
     */
    'cities.aliases', 'cities.features', 'cities.notable_places', 'cities.sources',
    /* M2.85 内容填充 P2（区域）：国教是**神名自由文本**（不是途径 id），来源是 URL */
    'regions.state_religion', 'regions.sources',
    /* M2.85 内容填充 P2（地点）：在此发生的事是**叙事文本**，来源是 URL —— 都不是实体 id */
    'locations.notable_events', 'locations.sources',
    /* M2.85 内容填充 P4（原作材料）：被需求的配方位置（`途径:序列:类别`）、用量写法、原文写法都是**自由文本** */
    'original-materials.usedIn', 'original-materials.quantitySamples', 'original-materials.rawForms',
    /*
     * M2.85 RPG 化 B（重做）：装备 = **非凡物品**，这两项都是**原著的叙事文本** ——
     *   abilities        这件东西能做什么（如「最多可『放牧』五个灵魂」）
     *   negativeEffects  代价（如「每隔一天就必须用一个活人的灵魂和血肉满足它」）
     * 它们是内容，不是别的实体的 id，所以不映射。
     */
    'equipment.abilities', 'equipment.negativeEffects',
    /*
     * M2.164（世界人物名册）：tags 是**中文自由标签** —— 「可被收买」「知道港口的事」
     * 这类「这个人能做什么、知道什么」的内容描述。它不是实体 id，也不是封闭枚举，
     * 所以既不 itemRef 也不 valueMap。机制按标签筛选（NpcRoster.withTag）。
     */
    'npc-cast.tags',
  ]);
  const missing: string[] = [];
  for (const e of ENTITIES) {
    for (const f of e.fields) {
      if (f.type !== 'strlist' || f.itemRef !== undefined || f.itemRefs !== undefined ||
        f.valueMap !== undefined) continue;
      const key = e.id + '.' + f.key;
      if (!onPurpose.has(key)) missing.push(key);
    }
  }
  assert.deepEqual(
    missing,
    [],
    '这些 strlist 既没有 itemRef 也没有 valueMap，也不在「有意不映射」的清单里',
  );
});

test('M2.64 中文映射：引用目标要递归到 object / rows 里（否则那些下拉是空的）', () => {
  /*
   * 这条守的是一个**还没发生**的缺口。
   *
   * 后台的 `/admin/api/data` 要把「被引用实体」的 id + 中文名一起发给前端，
   * 那份清单原来写在 index.ts 里，**只递归了 rowFields**，没递归 objectFields ——
   * 于是「给卡片的 trigger 加一个引用字段」时，那个下拉会是空的，而且不报错：
   * 一个没有选项的选择框，保存时读到空值。
   *
   * 现在恰好还没有「嵌套对象里的引用」这种字段，所以拿**构造出来的字段**钉住递归本身，
   * 不依赖内容里有没有现成例子。
   */
  const fake: FieldSpec[] = [
    { key: 'a', label: 'a', type: 'ref', ref: 'items' },
    { key: 'b', label: 'b', type: 'rows', rowFields: [{ key: 'c', label: 'c', type: 'ref', ref: 'cities' }] },
    {
      key: 'd', label: 'd', type: 'object',
      objectFields: [
        { key: 'e', label: 'e', type: 'ref', ref: 'locations' },
        { key: 'f', label: 'f', type: 'strlist', itemRef: 'creatures' },
      ],
    },
  ];
  assert.deepEqual(refTargetsOf(fake).sort(), ['cities', 'creatures', 'items', 'locations']);

  // 真实元数据里的每一个引用目标都得是存在的实体（指错 = 一个永远空的下拉）
  for (const e of ENTITIES) {
    for (const id of refTargetsOf(e.fields)) {
      assert.ok(entityById(id) !== undefined, e.id + ' 的字段引用了不存在的实体：' + id);
    }
  }
});

test('M2.64 中文映射：每个 enum 字段的中文映射必须覆盖真实数据里的全部取值', () => {
  /*
   * 这是「清单副本」这类 bug 的**通用判据**（AGENTS.md §3.1）——
   * 手抄一份枚举，代价是静默少一项：
   *   · cities.region_id 写过四个区域，而 regions.yaml 有六个 ——
   *     迷雾海和狂暴海在后台**根本选不到**；
   *   · creatures.tickRate 只写了 hourly，而 daily 那几只显示的是英文。
   * 两处都不报错，界面看着都正常。
   *
   * 这条用例反过来做：拿**真数据**里出现过的取值去查映射表。
   * 内容里出现一个新取值而没补中文名，这里就红。
   *
   * ⚠️ 只扫顶层字段。卡片（dir 模式）的 trigger.type 在 objectFields 里，
   * 它的中文名由 `Record<TriggerType, string>` 的**编译期**检查兜住 ——
   * 那种场合 tsc 比这里更早、也更准。
   */
  const missing: string[] = [];
  for (const e of ENTITIES) {
    // single / map / dir 的记录不在这一个文件里，取值集合没法这样扫
    if (e.rootMode !== undefined && e.rootMode !== 'seq') continue;
    const raw = parse(readFileSync(join(process.cwd(), e.file), 'utf8')) as Record<string, unknown>;
    const arr = raw[e.rootKey ?? ''];
    if (!Array.isArray(arr)) continue;
    for (const f of e.fields) {
      if (f.type !== 'enum' || f.enumMap === undefined) continue;
      const seen = new Set<string>();
      for (const row of arr as Record<string, unknown>[]) {
        const v = row[f.key];
        if (typeof v === 'string' && v !== '') seen.add(v);
      }
      for (const v of seen) {
        if (!(v in f.enumMap)) missing.push(e.id + '.' + f.key + ' 的「' + v + '」');
      }
    }
  }
  assert.deepEqual(missing, [], '这些取值在真实数据里有，但中文映射表里没有（界面上会显示英文）');
});

test('M2.64 中文映射：valueMap 里不能有空的、或和英文键一样的中文名', () => {
  /*
   * 一张写成 { ay: 'ay' } 的映射表，在界面上和没有映射**完全一样**，
   * 但它会让上面那条用例放行 —— 缺口就这样被盖住了。这条专门盯它。
   */
  let seen = 0;
  for (const e of ENTITIES) {
    for (const f of e.fields) {
      if (f.valueMap === undefined) continue;
      const entries = Object.entries(f.valueMap);
      assert.ok(entries.length > 0, e.id + '.' + f.key + ' 的 valueMap 是空的');
      for (const [k, v] of entries) {
        assert.ok(v.length > 0, e.id + '.' + f.key + ' 的「' + k + '」没有中文名');
        assert.notEqual(v, k, e.id + '.' + f.key + ' 的「' + k + '」中文名和英文键一模一样');
        assert.ok(/[^\x00-\x7F]/.test(v), e.id + '.' + f.key + ' 的「' + k + '」不是中文：' + v);
      }
      seen += 1;
    }
  }
  assert.ok(seen >= 5, '带 valueMap 的字段少于 5 个？是不是被谁删了（实际 ' + seen + ' 个）');
});
