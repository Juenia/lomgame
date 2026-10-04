import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadCards } from '../src/cards/loader.ts';
import { DAILY_DIR, PATHWAY_DIR } from '../src/cards/paths.ts';
import { isMortalCard } from '../src/domain/initiation/index.ts';
import {
  COLUMN_TITLE,
  LOST_CONTROL_ACCEPTANCE_IDS,
  classifyCards,
  flatten,
  natureOf,
  parseGateTable,
  parseVerdictLine,
  renderGateTable,
  renderVerdictLine,
  subsection,
  verdictOf,
  type CardMeta,
  type Gate,
  type GateSet,
} from '../src/vplayer/acceptance.ts';

function metas(): CardMeta[] {
  /*
   * ⚠️ M2.90：**只读 daily/ 与 pathway/ 两个池子。**
   *
   * M2.87 加了第三个池子 `seq/`（序列专属，511 张卡），而这里的 CARD_COUNT
   * 守的是「daily 池 + 途径池」的分类口径 —— 把 seq 一起读进来，
   * 这个数字会从 123 变成 646，一个数字同时表达三件事（paths.ts 的注释里
   * 就是这么说的：分开正是为了别让数字同时表达两件事）。
   */
  return loadCards([DAILY_DIR, PATHWAY_DIR])
    .cards
    /*
     * M2.7.6：mortal_* 是**另一个池子**（普通人专属，未入途径才抽得到）。
     * 这里的分类门守的是 daily 池的条件设计，所以把它们排除在外 ——
     * 它们的数量与口径由 test/m2-7-6.test.ts 单独守着。
     */
    .filter((card) => !isMortalCard(card.id))
    .map((card) => ({
    id: card.id,
    conds: card.trigger.cond ?? [],
    minSeq: card.trigger.min_seq,
    maxSeq: card.trigger.max_seq,
  }));
}

/*
 * M2.12：序列 7 的 6 张条件卡上线，45 → 51。
 * M2.76：**途径专属池**（src/cards/pathway/，7 途径 × 6 张）上线，51 → 93。
 *
 * ⚠️ 这 42 张卡走的是 `cond: pathway:<id>`（M2.76 新增的条件种类），
 * 它们在 natureOf() 里落 **`other`**（既不是 plain 也不是 numeric）——
 * 所以下面那两条「plain 12 / numeric 16」的断言**一个数都没动**。
 * 那正是把途径卡单开一个目录的理由：它不该稀释 daily 池的分类口径。
 * 若哪一天有人把途径卡塞进 daily/，这两条断言会同时红 —— 这是有意的。
 */
// M2.76 第二批：15 条新途径各补 2 张专属卡（+30）—— 93 → 123。
/*
 * ⚠️ M2.90：123 → **135**。
 * 这个数字只数 daily/ + pathway/ 两个池子（见 metas()），而 daily 池
 * 后来从 51 涨到 63（+12 张），所以 51 + 72 + 12 = 135。
 * 它与 test/m2-77-content-editor.test.ts 的 63 是**同一件事的两处读数**：
 * 两处一起改，才不会出现「一边 63、一边还在按 51 算」。
 */
const CARD_COUNT = 135;

test('M2.0 卡片三分类：W8 未触发的 12 张各自归位', () => {
  const groups = classifyCards(metas());
  const byNature = new Map(groups.map((group) => [group.nature, group.ids]));
  const total = groups.reduce((sum, group) => sum + group.ids.length, 0);
  assert.equal(total, CARD_COUNT, '分类不能漏卡或多卡');

  // 失控状态门：7 张 lost_*（M2.1 方案 D 把 lost_001/005 改独狼版，另加两张队伍版 lost_006/007）
  assert.deepEqual(byNature.get('status'), [
    'lost_001',
    'lost_002',
    'lost_003',
    'lost_004',
    'lost_005',
    'lost_006',
    'lost_007',
  ]);
  // 数值阈值门：W8 未触发的 3 张高阈值卡必须落在这里
  for (const id of ['daily_020', 'daily_023', 'daily_029']) {
    assert.equal(byNature.get('numeric')?.includes(id), true, id + ' 应该是数值阈值门');
  }
  // flag 链：W8 未触发的 4 张
  for (const id of ['daily_002', 'daily_004', 'daily_014', 'daily_019']) {
    assert.equal(byNature.get('flag')?.includes(id), true, id + ' 应该是 flag 链');
  }
  /*
   * 无条件卡：内容栏硬门压的就是这一档。
   * M2.90：12 → **18** —— daily 池后来加了 12 张卡，其中 6 张没有 cond，
   * 于是落在这一档（另外 6 张各自进了 numeric / flag）。
   * 这个数变了就该回来看一眼：它守的是「哪一档有多少张」。
   */
  assert.equal(byNature.get('plain')?.length, 18);
  /*
   * 数值阈值门：M2.90 从 16 → **22**（daily 池新增的 12 张卡里有 6 张是数值门）。
   * 它与上一行的 18（无条件卡）加起来正好是新增的那 12 张 —— 两处一起改。
   */
  assert.equal(byNature.get('numeric')?.length, 22);
});

test('M2.1 验收对象的 8 张卡与分类一致（清单写死也不许漂）', () => {
  const cards = metas();
  assert.equal(LOST_CONTROL_ACCEPTANCE_IDS.length, 8);
  const statusCount = LOST_CONTROL_ACCEPTANCE_IDS.filter(
    (id) => natureOf(cards.find((card) => card.id === id) ?? { id, conds: [] }) === 'status',
  ).length;
  const numericCount = LOST_CONTROL_ACCEPTANCE_IDS.filter(
    (id) => natureOf(cards.find((card) => card.id === id) ?? { id, conds: [] }) === 'numeric',
  ).length;
  assert.equal(statusCount, 5, '验收对象里应有 5 张失控状态门（lost_*）');
  assert.equal(numericCount, 3, '验收对象里应有 3 张 MAD 高阈值门');
});

test('M2.0 判定：红 > 黄 > 绿，计数与结论一一对应', () => {
  const gate = (status: Gate['status']): Gate => ({ name: 'x', actual: '1', requirement: '1', status });
  assert.equal(verdictOf([gate('green'), gate('green')]).level, 'green');
  assert.equal(verdictOf([gate('green'), gate('yellow')]).level, 'yellow');
  assert.equal(verdictOf([gate('yellow'), gate('red')]).level, 'red');
  const mixed = verdictOf([gate('green'), gate('green'), gate('yellow'), gate('red'), gate('red')]);
  assert.deepEqual([mixed.reds, mixed.yellows, mixed.greens, mixed.total], [2, 1, 2, 5]);
});

test('M2.0 判定行可解析，且与三栏重算结果一致', () => {
  const gates: GateSet = {
    system: [{ name: 'P0 异常', actual: '0 条', requirement: '0', status: 'green', tier: 'smoke' }],
    // M2.7：地点从 11 涨到 36
    content: [{ name: '地点覆盖', actual: '36 / 36', requirement: '100%', status: 'green', tier: 'diagnostic' }],
    numeric: [{ name: '失控触发', actual: '0 次', requirement: '14 天内可见', status: 'yellow', tier: 'diagnostic' }],
  };
  const body = [
    '# 测试报告',
    '',
    renderVerdictLine(verdictOf(flatten(gates))),
    '',
    '### 1. ' + COLUMN_TITLE.system,
    '',
    ...renderGateTable(gates.system),
    '',
    '### 2. ' + COLUMN_TITLE.content,
    '',
    ...renderGateTable(gates.content),
    '',
    '### 3. ' + COLUMN_TITLE.numeric,
    '',
    ...renderGateTable(gates.numeric),
    '',
  ].join(String.fromCharCode(10));

  const parsed = {
    system: parseGateTable(subsection(body, '### 1. ' + COLUMN_TITLE.system)),
    content: parseGateTable(subsection(body, '### 2. ' + COLUMN_TITLE.content)),
    numeric: parseGateTable(subsection(body, '### 3. ' + COLUMN_TITLE.numeric)),
  };
  assert.equal(parsed.system.length, 1);
  assert.equal(parsed.content[0]?.status, 'green');
  assert.equal(parsed.numeric[0]?.status, 'yellow');

  const stated = parseVerdictLine(body);
  const computed = verdictOf(flatten(parsed));
  assert.ok(stated);
  assert.equal(stated.verdict, computed.verdict);
  assert.deepEqual(
    [stated.reds, stated.yellows, stated.greens],
    [computed.reds, computed.yellows, computed.greens],
  );
  assert.equal(computed.level, 'yellow');
});

test('M2.0 一致性守卫：判定行被改过就必须能查出来', () => {
  const gates: GateSet = {
    system: [],
    content: [],
    numeric: [{ name: '失控触发', actual: '0 次', requirement: '14 天内可见', status: 'yellow', tier: 'diagnostic' }],
  };
  const body = [
    '**判定：绿灯：可进下一阶段**（红 0 / 黄 0 / 绿 1，共 1 项）',
    '',
    '### 3. ' + COLUMN_TITLE.numeric,
    '',
    ...renderGateTable(gates.numeric),
    '',
  ].join(String.fromCharCode(10));
  const stated = parseVerdictLine(body);
  const computed = verdictOf(parseGateTable(subsection(body, '### 3. ' + COLUMN_TITLE.numeric)));
  assert.ok(stated);
  assert.notEqual(stated.verdict, computed.verdict, '判定行与表格矛盾时必须能查出来');
  assert.notEqual(stated.yellows, computed.yellows);
});
