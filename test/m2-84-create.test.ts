/**
 * M2.84：数据编辑的「新增」。
 *
 * 在此之前编辑器只能改已有的记录 —— 加一件物品、加一张事件卡、加一个地点，
 * 都得去改文件再重启。而 AGENTS.md §3.4 要的是「让运营能自己**加**、自己改」：
 * 「改」这一半一直在，「加」这一半直到这里才补上。
 *
 * 这一份守四件事：
 *   1. 四种根形状各有各的加法（single 没有）；
 *   2. **id 会变成文件名**（dir 模式），所以它必须挡住目录穿越；
 *   3. 新建走的校验与「改一条」**完全一样**（少一条就是「新建能绕过约束」）；
 *   4. 新建的记录要能被原样读回来。
 */

import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { entityById } from '../src/admin/schema.ts';
import { createEntity, listEntity, readEntity } from '../src/admin/data.ts';

const ROOT = process.cwd();

function scratch(...paths: string[]): string {
  const t = mkdtempSync(join(tmpdir(), 'm284-'));
  for (const p of paths) {
    const dest = join(t, p);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(join(ROOT, p), dest, { recursive: true });
  }
  return t;
}

function spec(id: string) {
  const s = entityById(id);
  assert.ok(s !== undefined, '没有这个实体：' + id);
  return s;
}

test('M2.84 新增：seq 模式往数组末尾追加一条，而且读得回来', () => {
  const t = scratch('src/data/items.yaml');
  try {
    const items = spec('items');
    const before = listEntity(t, items).length;
    // items 的必填项不少（可绑定 / 可交易 / 说明 / 使用效果 / 变体），新建时都要给
    const out = createEntity(t, items, 'my_new_item', {
      name: '新东西', kind: 'material', bindable: true, tradeable: true,
      note: '自己加的', effect: {}, variants: [],
    });
    assert.ok(out.changed.length > 0, 'changed 里没记下新增了什么');
    assert.ok(out.backup.length > 0, '改文件之前没留备份');

    assert.equal(listEntity(t, items).length, before + 1, '条数没变');
    const row = readEntity(t, items, 'my_new_item') as Record<string, unknown>;
    assert.ok(row !== null, '新建的那条读不回来');
    assert.equal(row['name'], '新东西');
    assert.equal(row['kind'], 'material');
    // 原有的内容一个字都不该动
    assert.ok(listEntity(t, items).some((r) => r.id === '便士'), '原有的物品不见了');
  } finally { rmSync(t, { recursive: true, force: true }); }
});

test('M2.84 新增：map 模式加一个键（id 就是键名）', () => {
  const t = scratch('src/cards/fragments.yaml');
  try {
    const fr = spec('fragments');
    const before = listEntity(t, fr).length;
    createEntity(t, fr, '新的片段名', { texts: ['第一条', '第二条'] });
    assert.equal(listEntity(t, fr).length, before + 1);
    const row = readEntity(t, fr, '新的片段名') as Record<string, unknown>;
    assert.deepEqual(row['texts'], ['第一条', '第二条']);
    assert.ok(listEntity(t, fr).some((r) => r.id === '气味'), '原有的片段组不见了');
  } finally { rmSync(t, { recursive: true, force: true }); }
});

test('M2.84 新增：dir 模式写一个新文件，别的卡一个字不动', () => {
  const t = scratch('src/cards');
  try {
    const cards = spec('cards-daily');
    const before = listEntity(t, cards).length;
    createEntity(t, cards, 'daily_900', {
      name: '自己加的卡',
      trigger: { type: 'daily', weight: 5, cond: [] },
      effects: [{ dig: 1 }],
      texts: { priv: '正文', group: '群里那句' },
      daily_limit: 1,
    });
    assert.ok(existsSync(join(t, 'src/cards/daily/daily_900.yaml')), '新文件没写出来');
    assert.equal(listEntity(t, cards).length, before + 1);
    const row = readEntity(t, cards, 'daily_900') as Record<string, unknown>;
    assert.equal(row['name'], '自己加的卡');
    assert.deepEqual(row['effects'], [{ dig: 1 }]);
    // 新文件里要写着 id —— 它是这张卡在文件里的坐标
    assert.match(readFileSync(join(t, 'src/cards/daily/daily_900.yaml'), 'utf8'), /id: daily_900/);
  } finally { rmSync(t, { recursive: true, force: true }); }
});

test('M2.84 新增：单例没有「再加一条」这回事', () => {
  const t = scratch('src/data/beta-info.yaml');
  try {
    assert.throws(() => createEntity(t, spec('beta-info'), 'another', { phase: 'x' }), /单例/);
    assert.equal(readFileSync(join(t, 'src/data/beta-info.yaml'), 'utf8').includes('another'), false);
  } finally { rmSync(t, { recursive: true, force: true }); }
});

test('M2.84 新增：id 挡目录穿越 —— 它会变成文件名', () => {
  /*
   * 这是这一整块里最要紧的一条。`dir` 模式的 id 直接拼进路径
   * （`src/cards/daily/<id>.yaml`），所以 `../` 就是一次**目录穿越**：
   * 填 `../../../src/main` 能把文件写到仓库外面去。
   *
   * 前端那个输入框只是方便 —— 这条防线必须在服务端。
   */
  const t = scratch('src/cards');
  try {
    const cards = spec('cards-daily');
    const evil = ['../../../src/evil', '../evil', 'a/b', 'a\\b', '.hidden', '..', '', 'x'.repeat(80)];
    for (const id of evil) {
      assert.throws(() => createEntity(t, cards, id, { name: 'x' }), /id/,
        '这个 id 竟然被放行了：' + JSON.stringify(id));
    }
    // 仓库外面没有被写出任何东西
    assert.equal(existsSync(join(t, 'src/evil.yaml')), false);
    assert.equal(existsSync(join(t, 'evil.yaml')), false);
  } finally { rmSync(t, { recursive: true, force: true }); }
});

test('M2.84 新增：id 重复与必填缺失都要拦住', () => {
  const t = scratch('src/data/items.yaml');
  try {
    const items = spec('items');
    // 用 ASCII 的 id 测重复：`便士` 那种中文 id 会先被「id 只能用字母数字」拦下，
    // 于是这条断言看着过了，其实测的是另一件事
    assert.throws(() => createEntity(t, items, 'potion_seer_9', { name: 'x' }), /已经有一条/);
    // 必填缺失：schema 那边是 min(1)，空着存下去下一次加载整份内容会报错
    assert.throws(() => createEntity(t, items, 'brand_new', { kind: 'material' }), /还差这些必填项/);
  } finally { rmSync(t, { recursive: true, force: true }); }
});

test('M2.84 新增：引用与条件校验跟改一条走同一套（新建不是后门）', () => {
  const t = scratch('src/cards');
  try {
    const cards = spec('cards-daily');
    assert.throws(
      () => createEntity(t, cards, 'daily_901', {
        name: '条件写错的卡',
        trigger: { type: 'daily', weight: 1, cond: ['city:tingen'] },
        effects: [],
        texts: { priv: 'x' },
        daily_limit: 1,
      }),
      /不是认得的条件写法/,
      '新建竟然绕过了条件校验 —— 那正是最需要约束的入口',
    );
    assert.equal(existsSync(join(t, 'src/cards/daily/daily_901.yaml')), false, '被拦下了却还是写了文件');
  } finally { rmSync(t, { recursive: true, force: true }); }
});

test('M2.84 新增：元数据告诉前端哪些实体能新增', async () => {
  const { ENTITIES, entityMeta } = await import('../src/admin/schema.ts');
  for (const e of ENTITIES) {
    const m = entityMeta(e);
    assert.equal(m.canCreate, e.rootMode !== 'single', e.id + ' 的 canCreate 不对');
  }
  assert.ok(ENTITIES.filter((e) => entityMeta(e).canCreate).length >= 25, '能新增的实体太少');
  // 单例的那几个明确不能新增
  for (const id of ['registry', 'community-rules', 'beta-info']) {
    assert.equal(entityMeta(spec(id)).canCreate, false, id + ' 是单例');
  }
});


test('M2.84 新增：实体自己的 id 约定也要在新建时就说清', () => {
  /*
   * 卡片有一条自己的 id 约定（`cards/lint.ts` 的 `ID_PATTERN`）：全小写 + **至少一个下划线分段**。
   * 它不属于「安全」那一类（大写字母不会写出目录穿越），但违反它的卡会被内容 lint 拒掉 ——
   * 而那是**建完之后**才知道的事（热重载失败）。配在 `EntitySpec.idPattern` 上，
   * 新建时就能当场说清，人还能改。
   */
  const t = scratch('src/cards', 'src/data/items.yaml');
  try {
    const cards = spec('cards-daily');
    const patch = {
      name: 'x', trigger: { type: 'daily', weight: 1, cond: [] },
      effects: [], texts: { priv: 'x' }, daily_limit: 1,
    };
    for (const id of ['My_Card', 'mycard', 'my-card', 'DAILY_999']) {
      assert.throws(() => createEntity(t, cards, id, patch), /小写/, id + ' 违反了卡片 id 约定却没被拦');
    }
    // 合规的放行
    createEntity(t, cards, 'daily_999', patch);

    /*
     * 而**别的实体不该被卡片的约定管到**：物品的 id 不进文件名，
     * 中文 id 是合法的（真实数据里就有「便士」「夜香草」）。
     */
    const items = spec('items');
    createEntity(t, items, '自制小玩意', {
      name: '自制小玩意', kind: 'material', bindable: true, tradeable: true,
      note: 'x', effect: {}, variants: [],
    });
    assert.ok(readEntity(t, items, '自制小玩意') !== null, '中文 id 的物品没建出来');
  } finally { rmSync(t, { recursive: true, force: true }); }
});
