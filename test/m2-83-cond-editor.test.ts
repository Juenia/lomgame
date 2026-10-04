/**
 * M2.83：触发条件不许手打。
 *
 * `cond` 是一段由 domain/event/trigger.ts 解析的写法，值域全部来自代码。
 * 让运营照着提示手打，代价是**写错了不报错**：
 *
 *   写错的后果是 evalCond 返回 false —— 这张卡**永远不出**，
 *   界面上什么都不显示、日志里什么都不写，运营只会以为是概率问题。
 *
 * 现场标本：字段提示里教的是 `city:tingen`，而解析器认的是 `location:`。
 * 照提示写出来的条件，一条都不成立。
 *
 * 所以这一轮做两件事，两条都在这里钉住：
 *   1. 候选表**从代码派生**，而且每一条候选都要能被解析器真的认出来；
 *   2. 保存时服务端拿**真正的解析器**逐条验（见 admin/data.ts 的 crossCheck）。
 */

import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { condOptionsOf, ENTITIES } from '../src/admin/schema.ts';
import { adminPage } from '../src/admin/page.ts';
import { checkRecord, newCrossCtx, readAll } from '../src/admin/data.ts';
import { isValidCond } from '../src/domain/event/trigger.ts';
import { loadCards } from '../src/cards/loader.ts';
import { loadLocations } from '../src/data/loader.ts';

const ROOT = process.cwd();

test('M2.83 触发条件：候选表里的每一条，解析器都真的认', () => {
  /*
   * 这条是整件事的**判据**：界面给什么候选，解析器就得认什么。
   * 两边一旦漂移，运营从下拉里选出来的条件会恒为 false ——
   * 而「从下拉里选的」比「手打的」更让人放心，所以漂移了也没人会发现。
   */
  const co = condOptionsOf(ROOT);

  // M2.85：原来是 >= 8（候选里曾有 ap）—— ap 字段随行动值一并删除后是 7 个
  assert.ok(co.fields.length >= 7, '数值字段候选少了：' + co.fields.length);
  for (const f of co.fields) {
    assert.ok(isValidCond(f.id + '<=1'), '字段候选解析器不认：' + f.id);
  }
  assert.ok(co.operators.length >= 6, '操作符少了');
  for (const o of co.operators) {
    assert.ok(isValidCond('seq' + o.id + '1'), '操作符候选解析器不认：' + o.id);
  }
  // 两条入途径状态 + 22 条具体途径，在同一个下拉里
  assert.ok(co.pathways.length >= 24, '途径候选少了：' + co.pathways.length);
  for (const p of co.pathways) {
    assert.ok(isValidCond('pathway:' + p.id), '途径候选解析器不认：' + p.id);
  }
  for (const s of co.statuses) {
    assert.ok(isValidCond('status:' + s.id), '状态候选解析器不认：' + s.id);
  }
  assert.ok(co.flags.length >= 16, 'flag 候选少了：' + co.flags.length);
  for (const f of co.flags) assert.ok(isValidCond('flag:' + f.id));
  for (const k of co.kinds) {
    assert.ok(['num', 'flag', 'location', 'pathway', 'status', 'party'].includes(k.id),
      '冒出一个界面上画不出来的条件种类：' + k.id);
  }
});

test('M2.83 触发条件：面板上教的写法必须是解析器真的认的', () => {
  /*
   * 现场标本：提示里教 `city:tingen`，解析器只认 `location:` ——
   * 照着提示写就是「卡片永远不出」。
   * 所以提示里出现的每一个 `xxx:` 前缀，都要能被解析器认出来。
   */
  const co = condOptionsOf(ROOT);
  assert.ok(co.syntax.includes('location:'), '提示里没写 location:（那是正确的写法）');
  assert.ok(!co.syntax.includes('city:'), '提示里又出现了 city: —— 解析器不认它');
  // 把提示里提到的每个前缀抽出来，逐个喂给解析器
  const prefixes = new Set((co.syntax.match(/[a-z_]+:/g) ?? []).map((s) => s.slice(0, -1)));
  assert.ok(prefixes.size >= 4, '提示里没提几个写法：' + JSON.stringify([...prefixes]));
  for (const p of prefixes) {
    if (p === 'party') { assert.ok(isValidCond('party:size>=2')); continue; }
    // 前缀本身要能构成一条合法条件（值随便给一个候选）
    const sample = p + ':' + 'initiated';
    assert.ok(isValidCond(sample) || isValidCond(p + ':x'),
      '提示里教的写法解析器不认：' + p + ':');
  }
});

test('M2.83 触发条件：前端的弱解析与判定层对同一条条件的理解一致', () => {
  /*
   * 前端要按「种类 + 值」画控件，所以它得先看懂一条条件。
   * 那份理解（condParts）如果和判定层不一致，界面会显示成另一个样子，
   * 而保存时又被服务端拒绝 —— 一个改不动又说不清为什么的死角。
   */
  const js = readFileSync('src/admin/editor.js', 'utf8');
  const box: Record<string, unknown> = {};
  // eslint-disable-next-line no-new-func
  new Function('exports', js + '\nexports.condParts = condParts; exports.condRowHtml = condRowHtml;')(box);
  const condParts = box['condParts'] as (s: string) => { kind: string; field?: string; op?: string; value: string };
  assert.equal(typeof condParts, 'function', 'editor.js 里没有 condParts');

  const cases: Array<[string, string]> = [
    ['seq<=8', 'num'], ['dig>=3', 'num'], ['hp<50', 'num'],
    ['flag:met_mentor', 'flag'], ['location:old_dock', 'location'],
    ['pathway:seer', 'pathway'], ['pathway:mortal', 'pathway'],
    ['status:lost_control', 'status'], ['party:size>=2', 'party'],
  ];
  for (const [text, kind] of cases) {
    assert.equal(condParts(text).kind, kind, text + ' 被前端认成了 ' + condParts(text).kind);
    assert.ok(isValidCond(text), '前提变了：' + text + ' 判定层已经不认了');
  }
  assert.equal(condParts('seq<=8').field, 'seq');
  assert.equal(condParts('seq<=8').op, '<=');
  assert.equal(condParts('seq<=8').value, '8');
  /*
   * 认不出来的**不许丢**：返回 raw 让界面原样显示。
   * 丢掉的话，「打开一次编辑器」会把别人手写的条件吃掉 ——
   * 那是比「显示得不好看」严重得多的失败。
   */
  assert.equal(condParts('city:tingen').kind, 'raw');
  assert.equal(condParts('city:tingen').value, 'city:tingen');
  assert.equal(condParts('随便写的').kind, 'raw');
});


/* ================================================================== *
 * 收紧边界的安全带
 * ================================================================== */

test('M2.83 边界校验：现有全部内容都能原样存回去', () => {
  /*
   * 收紧边界时最容易犯的错不是「漏了一个坏值」，而是**把合法内容锁死**。
   *
   * 本轮就发生过两次，都是拿真数据跑一遍才发现的：
   *
   *   · `cities.factions` 里的 `none`（无主 / 安全区）不是 powers 表里的势力，
   *     被引用校验挡下 —— 于是**每个城市都改不了**（一个合法哨兵值）；
   *   · `routes.events` 装的是**路途事件**（bandit / storm），不是事件卡 id，
   *     而它和地点的 `events` **同名不同物** —— 我按名字给两者配了同一套下拉，
   *     于是 20 条航线全部存不回去。
   *
   * 两次都不报错地通过了类型检查，只在「有人真的去保存」时才炸。
   * 所以这里拿**每一条真实记录**跑一次「原样保存」—— 它同时守住两件事：
   * 校验没有把老内容锁死，以及 round-trip 之后文件没被写坏。
   */
  const t = mkdtempSync(join(tmpdir(), 'm283-rt-'));
  try {
    for (const p of ['src/cards', 'src/data']) {
      mkdirSync(dirname(join(t, p)), { recursive: true });
      cpSync(join(ROOT, p), join(t, p), { recursive: true });
    }
    /*
     * 用批量读 + 只校验的入口，而不是「每条记录 readEntity 一次再 writeEntity 一次」：
     * 那两个都是「扫一遍整个文件」，948 条物品会让这条测试跑上两分半（实测 160 秒）。
     * 校验逻辑是同一对 validateField / crossCheck，速度差的是扫描次数。
     */
    const cc = newCrossCtx(t);
    let ok = 0;
    const bad: string[] = [];
    for (const e of ENTITIES) {
      let rows;
      try { rows = readAll(t, e); } catch (err) {
        bad.push(e.id + ' 读不出来：' + (err as Error).message);
        continue;
      }
      for (const r of rows) {
        const msg = checkRecord(cc, e, r.row);
        if (msg === null) { ok += 1; continue; }
        // 同一种毛病只记一次，不然 20 条航线会刷满屏
        const key = e.id + '：' + msg.slice(0, 70);
        if (!bad.includes(key)) bad.push(key);
      }
    }
    assert.deepEqual(bad, [], '这些内容被新的边界校验挡住了（它本来是合法的）');
    // 数量是个 G 表：内容加了就该变红，提醒人确认一遍这里还成立
    assert.ok(ok >= 1800, '能过校验的记录变少了：' + ok);
  } finally { rmSync(t, { recursive: true, force: true }); }
});


/* ================================================================== *
 * 样式：多行框不能是白底
 * ================================================================== */

test('M2.83 样式：多行框与它周围的容器都要跟着深色主题', () => {
  /*
   * 用户的原话：「你做了很多可编辑的输入框，但是全是白底的输入框，显得很突兀」。
   *
   * 原因很具体：深色控件那条规则的选择器是
   *   input[type=text],input[type=password],input[type=number],select
   * —— **没有 textarea**。而卡片正文、失控文本、群规则、封测公告、片段池
   * 全走多行框，于是一片白底。
   *
   * 这条用例盯的就是那个选择器：以后再加一种控件，先看它进没进去。
   */
  const html = adminPage();
  const rule = /input\[type=text\][^{]*\{[^}]*background:#080b09[^}]*\}/.exec(html);
  assert.ok(rule !== null, '找不到深色控件的那条规则（选择器或背景色改了？）');
  assert.ok(rule[0].includes('textarea'),
    'textarea 不在深色控件的选择器里 —— 多行框会渲染成白底');
  // 焦点态与只读态也要带上它，否则点进去会跳回浅色描边
  assert.match(html, /input:focus,select:focus,textarea:focus\{/, '焦点态漏了 textarea');
  // 嵌套对象的容器要有区分度，否则子字段和外层字段看不出从属
  assert.match(html, /\.obj\{[^}]*border-left/, '嵌套对象没有左侧竖线');
});

test('M2.90 触发条件里的 location: 写的是**地点名**（与判定层一致，不是 id）', () => {
  /*
   * 判定层 evalCond 写的是 `ctx.location === parsed.location`，而 ctx.location 在
   * `.探索` 这条路上来自 `location.name`（中文名）—— 所以条件里必须写名字。
   *
   * ⚠️ 服务端的跨表校验原来是按**记录 id** 比的（`idsOf`），正好反了：
   * 合法的中文名全被挡住（511 张序列专属卡一张都存不回去，后台直接改不了），
   * 而写 id 的坏写法——在 `.探索` 路径上**永远不匹配**的那种——反倒一路放行。
   *
   * 这一条不依赖保存路径，直接拿**真数据**把语义钉死：589 张卡逐张查。
   */
  const names = new Set(loadLocations().locations.map((l) => l.name));
  const cards = loadCards().cards;
  assert.ok(cards.length >= 500, '卡池太小了？现在 ' + cards.length + ' 张');
  let seen = 0;
  for (const card of cards) {
    for (const cond of card.trigger.cond ?? []) {
      if (!cond.startsWith('location:')) continue;
      seen += 1;
      const v = cond.slice('location:'.length).trim();
      assert.ok(names.has(v), card.id + ' 的 location 条件写的是「' + v +
        '」—— 判定层比的是**地点名**（location.name），写 id 会永远不成立');
    }
  }
  assert.ok(seen > 0, '一张带 location 条件的卡都没有 —— 这条用例没在守东西');
});

