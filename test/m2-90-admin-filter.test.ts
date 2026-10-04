/**
 * **后台列表页顶部的分类栏（M2.90）** —— 用户明确提的那一项。
 *
 * 原话是「物品类别顶部的分类栏」：948 件物品 / 5 个类别，而列表页只能从头翻到尾
 * （在那之前，`console.js` 里的 filter 全是数组过滤，界面上一个控件都没有）。
 *
 * 这份测试守三件事：
 *   ① 分类是**派生**的（字段表里 key 恰好是 kind 的那个枚举字段），不是一份写死的清单；
 *   ② 服务端每条记录真的带 tag，而且每个 tag 都有中文名（不许把英文 id 摆给运营看）；
 *   ③ 前端那两下点击（筛选 / 取消）真的会改列表 —— 用假 document 跑一遍**真代码**。
 *
 * ⚠️ 为什么第 ③ 条要费劲搭一个假 document：editor.js 不经过 TS 编译，
 * 只有 `new Function` 查得了语法。把判据留在「人点一下看看」上的话，
 * 「筛选点了没反应」这种半坏状态可以一直躺着 —— 而这个仓库里最贵的 bug 就是不报错的那种。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { listEntity } from '../src/admin/data.ts';
import { ENTITIES, entityById, entityMeta, tagFieldOf, type EntitySpec, type FieldSpec } from '../src/admin/schema.ts';

const ROOT = process.cwd();
const EDITOR = readFileSync('src/admin/editor.js', 'utf8');
const ITEMS = entityById('items')!;

/* ═══════════ 1. 分类字段是派生的 ═══════════ */

test('分类字段派生自字段表：加了带 kind 的表，筛选栏自己出现', () => {
  const fake = (fields: FieldSpec[]): EntitySpec =>
    ({ id: 'fake', label: '假表', group: 'g', file: 'f.yaml', rootKey: 'k', idKey: 'id', titleKey: 'name', fields }) as EntitySpec;
  const enumKind: FieldSpec = { key: 'kind', label: '类别', type: 'enum', enumMap: { a: '甲', b: '乙' } };
  const textKind: FieldSpec = { key: 'kind', label: '类别', type: 'text' };
  assert.equal(tagFieldOf(fake([enumKind]))?.key, 'kind', '带 kind 枚举的表该有筛选栏');
  assert.equal(tagFieldOf(fake([textKind])), null, '自由文本的 kind 不画筛选栏（值域开放，会碎成一屏）');
  assert.equal(tagFieldOf(fake([{ key: 'name', label: '名', type: 'text' }])), null, '没有 kind 就不画');
  // 真数据：物品表的筛选栏来自它自己的字段表，不来自任何一份手写清单
  assert.equal(entityMeta(ITEMS).tagKey, 'kind');
  assert.equal(entityMeta(ITEMS).tagKey, tagFieldOf(ITEMS)?.key, 'entityMeta 与 tagFieldOf 必须是同一个判据');
});

/* ═══════════ 2. 真数据：每条都有分类，且都有中文名 ═══════════ */

test('服务端：948 件物品每一条都带分类，五个类别的条数与映射都对得上', () => {
  const rows = listEntity(ROOT, ITEMS);
  /*
   * 948 是**写死的**（AGENTS §3.5）：这个数字动了就说明内容变过 ——
   * 那时候回来看一眼筛选栏和分类映射，而不是让判据跟着内容一起悄悄变。
   */
  assert.equal(rows.length, 948, '物品总数变了 —— 确认是加了内容，而不是读不到记录');
  const noTag = rows.filter((r) => r.tag === undefined);
  assert.equal(noTag.length, 0, '有 ' + noTag.length + ' 条没有分类：' + noTag.slice(0, 3).map((r) => r.id).join('、'));
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.tag!] = (counts[r.tag!] ?? 0) + 1;
  assert.deepEqual(counts, { currency: 1, material: 744, consumable: 10, potion: 176, trinket: 17 },
    '五个类别的条数变了 —— 逐类核对一遍，别让筛选栏显示一个不存在的数');
  const map = ITEMS.fields.find((f) => f.key === 'kind')!.enumMap!;
  for (const t of Object.keys(counts)) {
    assert.ok(map[t] !== undefined, '分类 ' + t + ' 没有中文名 —— 界面上会显示英文 id');
  }
});

test('服务端：每一张有筛选栏的表，真数据里的分类都有中文名', () => {
  const withTag = ENTITIES.filter((e) => tagFieldOf(e) !== null);
  assert.ok(withTag.length >= 6, '有分类的表少于 6 张 —— 派生逻辑是不是坏了？实际 ' + withTag.length);
  for (const e of withTag) {
    const map = tagFieldOf(e)!.enumMap!;
    for (const r of listEntity(ROOT, e)) {
      if (r.tag === undefined) continue;
      assert.ok(map[r.tag] !== undefined, e.id + ' 的 ' + r.id + ' 分类是 ' + r.tag + '，却没有中文名');
    }
  }
});

/* ═══════════ 3. 前端：筛选是真的会改列表 ═══════════ */

interface FakeChip { dataset: { tag: string }; onclick: null | (() => void) }

/** 假 document：只实现 editor.js 用到的那几个方法（innerHTML / chips 解析） */
function fakeDoc() {
  let html = '';
  let chipsCache: FakeChip[] | null = null;
  const el: { innerHTML: string } = { innerHTML: '' };
  Object.defineProperty(el, 'innerHTML', {
    get: () => html,
    set: (v: string) => { html = v; chipsCache = null; },
  });
  const parseChips = (): FakeChip[] => {
    const out: FakeChip[] = [];
    const re = /<a class="chip[^"]*" data-tag="([^"]*)"/g;
    let m = re.exec(html);
    while (m !== null) {
      out.push({ dataset: { tag: m[1] ?? '' }, onclick: null });
      m = re.exec(html);
    }
    return out;
  };
  return {
    doc: {
      querySelector: (sel: string) => (sel === '#dataList' ? el : null),
      querySelectorAll: (sel: string) => {
        if (sel !== '#tagChips .chip') return [];
        if (chipsCache === null) chipsCache = parseChips();
        return chipsCache;
      },
    },
    html: () => html,
    chips: () => {
      if (chipsCache === null) chipsCache = parseChips();
      return chipsCache;
    },
    rows: () => html.split('class="drow"').length - 1,
  };
}

/** 把 editor.js 装进一个 Function 里跑 —— 那段 JS 不经过 TS 编译，只能这样验 */
function editorApi(extra: string, doc: unknown): Record<string, any> {
  return new Function('document', EDITOR + String.fromCharCode(10) + extra)(doc);
}

test('editor.js：语法合法，筛选是纯函数（不靠 DOM 也验得了）', () => {
  assert.doesNotThrow(() => new Function(EDITOR), 'editor.js 有语法错误');
  const api = editorApi('return { rowsForTag: rowsForTag, tagChipsHtml: tagChipsHtml };', {});
  const rows = [
    { id: 'a', title: 'A', tag: 'material' },
    { id: 'b', title: 'B', tag: 'potion' },
    { id: 'c', title: 'C', tag: 'material' },
    { id: 'd', title: 'D' },
  ];
  assert.equal(api.rowsForTag(rows, '').length, 4, '不选分类 = 全部');
  assert.deepEqual(api.rowsForTag(rows, 'material').map((r: { id: string }) => r.id), ['a', 'c']);
  /*
   * 只有一类（或压根没有分类）时**不画** chips：
   * 那时候点它等于什么都不做，而一个点了没反应的按钮比不画更糟（M2.51 的教训）。
   */
  assert.equal(api.tagChipsHtml({ enumMap: { material: '材料' } }, [rows[0]], ''), '');
});

test('分类栏：点一个分类只剩那类，再点一次取消（假 document 跑真渲染）', () => {
  const fake = fakeDoc();
  const api = editorApi(
    'return { render: renderDataList, setRows: function (v) { ROWS = v; }, setCur: function (v) { CUR = v; } };',
    fake.doc,
  );
  api.setCur(entityMeta(ITEMS));
  api.setRows(listEntity(ROOT, ITEMS));
  api.render();
  assert.equal(fake.rows(), 948, '默认该显示全部');
  assert.ok(fake.html().includes('材料（744）'), 'chips 上该有中文名与条数：' + fake.html().slice(0, 240));
  assert.ok(fake.html().includes('全部（948）'), 'chips 里该有「全部」那一项');
  assert.equal(fake.chips().length, 6, '「全部」+ 5 个类别');

  fake.chips().find((c) => c.dataset.tag === 'material')!.onclick!();
  assert.equal(fake.rows(), 744, '点了「材料」之后列表里只剩材料：' + fake.rows() + ' 行');

  // 再点一次同一个 = 取消（用户要的判据：点某类别只剩那类；再点取消）
  fake.chips().find((c) => c.dataset.tag === 'material')!.onclick!();
  assert.equal(fake.rows(), 948, '再点一次该回到全部');

  // 换一个类别：只看魔药
  fake.chips().find((c) => c.dataset.tag === 'potion')!.onclick!();
  assert.equal(fake.rows(), 176, '点了「魔药」之后只剩魔药：' + fake.rows() + ' 行');
});
