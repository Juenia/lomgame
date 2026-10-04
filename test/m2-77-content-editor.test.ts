/**
 * M2.77：后台把**全部内容**纳进来之后，守住几件只有真数据才能暴露的事。
 *
 * 这一轮之前，后台能编的只有 src/data/*.yaml 里那些「一个文件多条记录」的表。
 * 事件卡（137 张，内容主体）、失控文本池、卡片片段、群规则、封测公告、内容注册表
 * **一条都编不了** —— 改一个字要改文件、跑 lint、重新部署。
 *
 * 补上之后新增了三种根形状（map / single / dir）和两个字段类型（object / maplist）。
 * 它们有个共同点：**坏了不报错**。列表少一半、正文末尾悄悄少一个换行、
 * effect 的键拼错一个字母 —— 界面上全都「看起来正常」。
 *
 * 所以下面的断言一律拿**真文件**跑；凡是要写的一律落进临时目录（不碰仓库）。
 */

import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';
import { ENTITIES, entityById } from '../src/admin/schema.ts';
import { listEntity, readEntity, writeEntity } from '../src/admin/data.ts';

const ROOT = process.cwd();

/** 一份可以随便写的副本；调用方负责 rmSync */
function scratch(...paths: string[]): string {
  const t = mkdtempSync(join(tmpdir(), 'm277-'));
  for (const p of paths) {
    const dest = join(t, p);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(join(ROOT, p), dest, { recursive: true });
  }
  return t;
}

function spec(id: string) {
  const s = entityById(id);
  assert.ok(s !== undefined, '没有这个可编辑实体：' + id);
  return s;
}

const asRec = (v: unknown): Record<string, unknown> => v as Record<string, unknown>;

test('M2.77 事件卡：三类卡一张不少，每张都有中文名', () => {
  /*
   * 张数是**写死的 G 表**（AGENTS.md §3.5）：内容一变就要变红，提醒人来看一眼。
   * 「哪三个实体」也写死 —— 这一条恰恰该写死，它就是「三类卡都在」本身。
   */
  /*
   * ⚠️ M2.90 更新：每日卡 51 → **63**（`src/cards/daily` 目录里确实有 63 个 yaml，
   * 逐张都读得出中文名）。这是 G 表该有的反应 —— 内容加了、数字跟着改，
   * 而不是让断言永远停在旧数上、从此没人再信它。
   */
  const expect: Record<string, number> = { 'cards-daily': 63, 'cards-mortal': 14, 'cards-pathway': 72 };
  let total = 0;
  for (const [id, n] of Object.entries(expect)) {
    const rows = listEntity(ROOT, spec(id));
    assert.equal(rows.length, n, id + ' 列出来的张数不对（内容加了就要改这个数字）');
    assert.deepEqual(rows.filter((r) => r.title.length === 0).map((r) => r.id), [],
      id + ' 有卡读不出名字 —— 列表页会是一片空白');
    assert.deepEqual(rows.filter((r) => !/[^\x00-\x7F]/.test(r.title)).map((r) => r.id).slice(0, 5), [],
      id + ' 有卡的标题不是中文');
    total += rows.length;
  }
  assert.equal(total, 149, '全部事件卡的总数不对');
});

test('M2.77 事件卡：嵌套的 trigger / texts 与 effects 都读得出来', () => {
  const row = readEntity(ROOT, spec('cards-daily'), 'daily_001');
  assert.ok(row !== null, 'daily_001 读不出来');
  const r = asRec(row);
  assert.equal(typeof r['name'], 'string');
  const tr = asRec(r['trigger']);
  assert.equal(tr['type'], 'daily', 'trigger.type 没读出来（object 字段掉了）');
  assert.equal(typeof tr['weight'], 'number');
  assert.ok(Array.isArray(tr['cond']), 'trigger.cond 应该是数组 —— 它决定这张卡进哪个池子');
  const fx = r['effects'] as Record<string, unknown>[];
  assert.ok(Array.isArray(fx) && fx.length > 0, 'effects 没读出来（maplist 字段掉了）');
  assert.ok(fx.some((e) => 'item' in e), 'daily_001 有一条「给物品」，读不到说明多键的那一条被拆坏了');
  const tx = asRec(r['texts']);
  assert.ok(typeof tx['priv'] === 'string' && (tx['priv'] as string).length > 10, '正文读不出来');
});

test('M2.77 事件卡：三层结构写回去，别的卡一个字不动', () => {
  const t = scratch('src/cards');
  try {
    const s = spec('cards-daily');
    const other = readEntity(t, s, 'daily_002');
    const wr = writeEntity(t, s, 'daily_001', {
      trigger: { type: 'random', weight: 7, cond: ['pathway:seer'] },
      effects: [{ dig: 2 }, { item: '夜香草', n: 1 }],
      texts: { priv: '第一段\n\n第二段', group: '群里那一句' },
    });
    assert.equal(wr.changed.length, 3, '改了三个字段，changed 应该正好三条：' + JSON.stringify(wr.changed));
    assert.ok(wr.backup.length > 0, '写入没有留备份');
    const back = asRec(readEntity(t, s, 'daily_001'));
    assert.deepEqual(back['effects'], [{ dig: 2 }, { item: '夜香草', n: 1 }]);
    assert.equal(asRec(back['texts'])['priv'], '第一段\n\n第二段\n',
      '正文末尾的换行要跟着原值留着 —— 丢了它每次保存都会把 | 改成 |-');
    assert.deepEqual(readEntity(t, s, 'daily_002'), other, '改一张卡碰到了另一张');
  } finally { rmSync(t, { recursive: true, force: true }); }
});

test('M2.77 数据编辑：只改一个字段，文件里只能动那一行', () => {
  /*
   * 这条盯的是「保存一次、整段重排」：yaml 的 toString 会把块标量重新缩进、
   * 把 | 换成 |-、把注释挪位。只要有一处，diff 就没法看了 ——
   * 而这个仓库的文件里，注释本身就是设计记录。
   */
  const t = scratch('src/cards');
  try {
    const s = spec('cards-daily');
    const orig = readFileSync(join(ROOT, 'src/cards/daily/daily_001.yaml'), 'utf8');
    const before = asRec(readEntity(t, s, 'daily_001'));
    writeEntity(t, s, 'daily_001', { ...before, name: '换个名字' });
    const after = readFileSync(join(t, 'src/cards/daily/daily_001.yaml'), 'utf8');
    const a = orig.split('\n'); const b = after.split('\n');
    const diff: string[] = [];
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
      if (a[i] !== b[i]) diff.push('第 ' + (i + 1) + ' 行');
    }
    assert.deepEqual(diff, ['第 2 行'], '改了名字却动了别的行：' + JSON.stringify(diff));
    assert.ok(after.includes('priv: |'), '正文的块标量写法被改掉了');
  } finally { rmSync(t, { recursive: true, force: true }); }
});

test('M2.77 数据编辑：同一条存两次，文件必须逐字节一样', () => {
  /*
   * 这条抓的是一个真发生过的 bug：写文件时用的是 doc.toString() + '\n'，
   * 而 yaml 的 toString **已经**补了换行 —— 于是每保存一次就多一个空行。
   * 一次两次看不出来，几十次之后每个文件的结尾都拖着几个空行。
   */
  const t = scratch('src/cards');
  try {
    const s = spec('cards-daily');
    const p = join(t, 'src/cards/daily/daily_003.yaml');
    writeEntity(t, s, 'daily_003', asRec(readEntity(t, s, 'daily_003')));
    const once = readFileSync(p, 'utf8');
    writeEntity(t, s, 'daily_003', asRec(readEntity(t, s, 'daily_003')));
    const twice = readFileSync(p, 'utf8');
    assert.equal(once, twice, '第二次保存又动了文件');
    assert.ok(!once.endsWith('\n\n'), '文件结尾多出了空行');
  } finally { rmSync(t, { recursive: true, force: true }); }
});

test('M2.77 事件卡：拼错的键、类型不对的值，当场拦住而不是写进文件', () => {
  const t = scratch('src/cards');
  try {
    const s = spec('cards-daily');
    const p = join(t, 'src/cards/daily/daily_004.yaml');
    const orig = readFileSync(p, 'utf8');
    const cases: [string, Record<string, unknown>, RegExp][] = [
      ['effect 的键拼错（判定层会静默跳过这一条）', { effects: [{ digg: 2 }] }, /digg/],
      ['item 的值给了数字（写进去是个空值）', { effects: [{ item: 5 }] }, /item/],
      ['trigger 里没声明的子字段（加载期会被 zod 剥掉）', { trigger: { type: 'daily', nope: 3 } }, /nope/],
      ['触发方式给了不存在的值', { trigger: { type: '周刊' } }, /触发方式/],
    ];
    for (const [label, patch, re] of cases) {
      assert.throws(() => writeEntity(t, s, 'daily_004', patch), re, label + ' —— 没被拦住');
    }
    assert.equal(readFileSync(p, 'utf8'), orig, '被拦住的写入还是把文件改了');
  } finally { rmSync(t, { recursive: true, force: true }); }
});

test('M2.77 单例文件：整份文件就是一条记录，改一个字段不动别的', () => {
  const t = scratch('src/data/beta-info.yaml', 'src/data/community-rules.yaml');
  try {
    const s = spec('beta-info');
    const rows = listEntity(t, s);
    assert.equal(rows.length, 1, '单例应该只列出一条');
    assert.equal(rows[0]!.title, '封测公告', '单例的标题要回退到实体中文名，不能显示英文 id');
    const before = asRec(readEntity(t, s, 'beta-info'));
    assert.ok(Array.isArray(before['scope']), 'scope 没读出来');
    const wr = writeEntity(t, s, 'beta-info', { phase: '第二阶段封测（W7）' });
    assert.deepEqual(wr.changed, ['阶段']);
    const back = asRec(readEntity(t, s, 'beta-info'));
    assert.equal(back['phase'], '第二阶段封测（W7）');
    assert.deepEqual(back['schedule'], before['schedule'], '改顶部一个字段碰到了下面的列表');

    // 群规则同理：它是玩家会照着做的那一页
    const cr = asRec(readEntity(t, spec('community-rules'), 'community-rules'));
    assert.ok(Array.isArray(cr['rules']) && (cr['rules'] as unknown[]).length >= 3, '群规则读不出来');
  } finally { rmSync(t, { recursive: true, force: true }); }
});

test('M2.77 文案池：改一组的文本，别的组和注释都不动', () => {
  const t = scratch('src/cards/lost-control.yaml', 'src/cards/fragments.yaml');
  try {
    const lc = spec('lost-control');
    const rows = listEntity(t, lc);
    assert.equal(rows.length, 22, '失控文本池应该按途径分 22 组');
    assert.ok(rows.every((r) => /[^\x00-\x7F]/.test(r.title)), '失控池的标题要显示中文途径名');
    const orig = readFileSync(join(t, 'src/cards/lost-control.yaml'), 'utf8');
    writeEntity(t, lc, 'seer', { texts: ['测试甲', '测试乙'] });
    const after = readFileSync(join(t, 'src/cards/lost-control.yaml'), 'utf8');
    assert.ok(after.includes('# 愚者途径'), '注释被冲掉了');
    assert.ok(/^  warrior:/m.test(after), '改一条途径碰到了别的途径');
    assert.notEqual(orig, after);

    const fr = spec('fragments');
    const frRows = listEntity(t, fr);
    assert.ok(frRows.length > 0, '片段池读不出来');
    assert.ok(frRows.every((r) => r.title.length > 0));
  } finally { rmSync(t, { recursive: true, force: true }); }
});

test('M2.77 内容注册表：flag 清单读得出来（拼错一个标记名不报错，只会让卡永远不出）', () => {
  const rows = listEntity(ROOT, spec('registry'));
  assert.equal(rows.length, 1);
  const r = asRec(readEntity(ROOT, spec('registry'), 'registry'));
  const flags = r['flags'] as string[];
  assert.ok(Array.isArray(flags) && flags.length >= 16, 'flag 清单读不出来');
  assert.ok(flags.includes('met_mentor'), 'flag 清单少了一条已知的');
});

/**
 * **有意不上后台**的字段 —— 每一项都要写清理由。
 *
 * ⚠️ 这份清单会掩盖缺口（AGENTS §3.8 的原话），所以它受三条约束，测试逐条守着：
 *   ① 每一项必须有理由（空理由的清单项就是借口）；
 *   ② 清单里的每一项都必须在**真数据里真的存在**（过期的项会红 —— 否则清单只会越积越长）；
 *   ③ 凡是不在这份清单里的字段，必须在编辑器元数据里声明。
 *
 * 判据：**出处、可信度、校对注记、建设期索引 → 不上后台；
 * 任何改变游戏判定的字段 → 必须上。**
 *
 * ⚠️ 这条判据在 M2.90 抓到一个真的缺口：`authorities.effects` —— 权柄的四个改写维度
 * （禁令 / 理智 / 物价 / 遭遇）上一轮做完了全链路，而编辑器里**一个字段都没有**：
 * 运营既看不见也改不了（AGENTS §3.4 要求新内容表必须在后台可编辑）。它已经补上，
 * 同一批补的还有 `shops.note`（与 items.note / prices.note 同一个口径）。
 */
const HIDDEN_WITH_REASON: Record<string, string> = {
  /* ---- 出处与可信度（21 处）：改了不改变任何判定，只会让下一次校对失去依据 ---- */
  'locations.sources': '出处（校对用）',
  'locations.confidence': '可信度（校对用）',
  'cities.sources': '出处（校对用）',
  'cities.confidence': '可信度（校对用）',
  'regions.sources': '出处（校对用）',
  'regions.confidence': '可信度（校对用）',
  'equipment.source': '出处（校对用）',
  'equipment.confidence': '可信度（校对用）',
  'advancement-rites.source': '出处（校对用）',
  'advancement-rites.confidence': '可信度（校对用）',
  'figures.sources': '出处（校对用）',
  'figures.confidence': '可信度（校对用）',
  'organizations.sources': '出处（校对用）',
  'organizations.source': '出处（校对用）',
  'organizations.confidence': '可信度（校对用）',
  'pantheon.source': '出处（校对用）',
  'pantheon.confidence': '可信度（校对用）',
  'tarot.confidence': '可信度（校对用）',
  'battle-skills.source': '出处（校对用）',
  'bestiary.sources': '出处（校对用）',
  'bestiary.confidence': '可信度（校对用）',
  /* ---- 校对注记（4 处）：记的是「原作里叫什么」，不是给玩家看的内容 ---- */
  'locations.name_note': '原作名注记（校对用）',
  'figures.note': '未映射的原作字段暂存（校对用）',
  'bestiary.pathwayNames': '原作里的途径叫法（校对用）',
  'bestiary.note': '未映射的原作字段暂存（校对用）',
  /* ---- 建设期索引（2 处）---- */
  'bestiary.usedIn': '建设期的反向索引：建表时用来对齐配方，游戏里不读它',
  'bestiary.materials': '原作素材原样文本：.图鉴 生物 读它当「产出材料」显示，但它是脚本产物 —— 手改只会把格式改坏，该由脚本重建',
};

test('M2.77 内容表里的每一个顶层字段都要在编辑器元数据里声明（除写明理由的）', () => {
  /*
   * 「文件都进了后台」**不等于**「字段都能编」——
   * 一个文件可以被登记了，但里面的某个键没进 fields，于是它看不见也改不了，
   * 而且没有任何东西会提醒你。
   *
   * 第一次跑这条时抓到 **11 处**，其中三处很要命：
   *   · items.pathway / items.seq —— **176 件魔药**靠它们挂在途径与序列上；
   *   · locations.events / routes.events —— 地点与航线的事件卡池（58 + 14 条，**全都有**）；
   *   · creatures.relations —— 生态关系网（19 个物种，决定谁吃谁）。
   *
   * ⚠️ M2.90：这条判据现在承认一类例外 —— **写明理由的有意不上后台**（见上面那张表）。
   * 上一轮把 22 处出处 / 可信度字段移出编辑器时没有同步这里，于是这条用例一直红着，
   * 而红着的判据等于没有判据。现在是「要么声明、要么写明理由」。
   * 例外越小越安全，所以另外两条断言盯着那张表本身：理由不能空、清单不能过期。
   *
   * ⚠️ 只扫 seq 模式的实体：single / map / dir 的记录不在这一个文件里，
   * 拿顶层键去比只会得到一堆假阳性。
   */
  const missing: string[] = [];
  const hit = new Set<string>();
  for (const e of ENTITIES) {
    if (e.rootMode !== undefined && e.rootMode !== 'seq') continue;
    const raw = parse(readFileSync(join(ROOT, e.file), 'utf8')) as Record<string, unknown>;
    const arr = raw[e.rootKey ?? ''];
    if (!Array.isArray(arr)) continue;
    const declared = new Set(e.fields.map((f) => f.key));
    const seen = new Map<string, number>();
    for (const row of arr as Record<string, unknown>[]) {
      for (const k of Object.keys(row)) {
        if (declared.has(k)) continue;
        const full = e.id + '.' + k;
        seen.set(full, (seen.get(full) ?? 0) + 1);
        if (HIDDEN_WITH_REASON[full] !== undefined) hit.add(full);
      }
    }
    for (const [k, n] of seen) {
      if (HIDDEN_WITH_REASON[k] !== undefined) continue;
      missing.push(k + '（' + n + ' 行有它）');
    }
  }
  assert.deepEqual(missing, [], '这些字段在内容里存在，但编辑器元数据里没声明 —— 后台看不见也改不了');
  // ① 理由不能空：空理由的清单项就是借口
  const noReason = Object.entries(HIDDEN_WITH_REASON).filter(([, why]) => why.trim().length < 4).map(([k]) => k);
  assert.deepEqual(noReason, [], '这些「有意不上后台」的字段没写理由');
  // ② 清单不许过期：字段删了、或已经上了后台，都要把它删掉
  const stale = Object.keys(HIDDEN_WITH_REASON).filter((k) => !hit.has(k)).sort();
  assert.deepEqual(stale, [], '这些清单项在真数据里已经不存在了 —— 删掉它，别让清单变成借口堆');
  // ③ 数量写死（G 表）：多一处没声明，就回来看一眼
  assert.equal(Object.keys(HIDDEN_WITH_REASON).length, 27, '有意不上后台的字段数变了');
});

test('M2.77 每个可编辑实体都能列出来、点得进去（29 个逐个走一遍）', () => {
  /*
   * 这条守的是**闭环**：列表页给出的 id，必须能在同一个实体里读回来。
   *
   * 「列表页看得到、点进去打不开」是加新根形状时最容易出的一种半坏状态 ——
   * 两个方向各用一套查找逻辑，漂移之后一边能走、另一边不行，而且不报错。
   * 本轮 listEntity / readEntity / writeEntity 都改走同一个 scanRecords 就是为它。
   */
  assert.ok(ENTITIES.length >= 29, '实体少了？现在是 ' + ENTITIES.length + ' 个');
  for (const e of ENTITIES) {
    const rows = listEntity(ROOT, e);
    assert.ok(rows.length > 0, e.id + ' 一条都列不出来');
    assert.deepEqual(rows.filter((r) => r.id.length === 0).map(() => e.id), [], e.id + ' 有行没有 id');
    assert.deepEqual(rows.filter((r) => r.title.length === 0).map((r) => r.id).slice(0, 3), [],
      e.id + ' 有行没有中文名（列表页会是空白）');
    const first = readEntity(ROOT, e, rows[0]!.id);
    assert.ok(first !== null, e.id + ' 列表里的第一条读不出来：' + rows[0]!.id);
    assert.ok(Object.keys(first).length > 0, e.id + ' 第一条一个字段都没有');
    // 最后一条也要能读 —— 数量多的时候，只有头几条正常是很常见的一种坏法
    const last = readEntity(ROOT, e, rows[rows.length - 1]!.id);
    assert.ok(last !== null, e.id + ' 列表里的最后一条读不出来：' + rows[rows.length - 1]!.id);
  }
});
