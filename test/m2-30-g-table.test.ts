/**
 * M2.30 任务 1：**G 表守卫** —— G 表的数字与现场读不一致时，测试变红。
 *
 * ## 为什么是断言，不是纪律
 *
 * 这张表在 M2.30 之前**漂了四轮**：
 *
 *   · 曾经同时写着 `G2 === 8` / `G4 === （无）` / `G8 === 12`，而现场读是 `14 / 18 / 21`；
 *   · 本轮开工时**又漂了一次**（写着 `21 / 28 / 14`，实际 `28 / 35 / 21`）；
 *   · `G7` 从来只写「≥ 20」，**没有具体数字**（等于没写）。
 *
 * **没有断言会红，下一个人还会凭记忆写。**
 * 这是 K16 的「**引用而非手抄**」在 G 表上的落地：数字由**现场读**产生，文档只是它的一个投影 ——
 * 而这个投影现在被断言钉住了。
 *
 * ## 覆盖范围（任务书点名六条）
 *
 * **G2 / G3 / G4 / G7 / G8 / G10**。
 * （G1 已改为 `readdirSync`，不再需要同步；G5 / G6 不在本轮范围。）
 *
 * ## 与既有 G 断言的关系
 *
 * `test/ability.test.ts` 那些断言守的是「**加了内容要改断言**」（它们直接写数字）；
 * 本文件守的是「**文档里的那张表也要跟着改**」。两者互补：
 *
 *   内容表 → （既有断言） → 测试文件里的数字
 *   内容表 → （本文件）   → docs/架构铁律.md 的 G 表
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { NUMERIC } from '../src/config/numeric.ts';
import { loadAbilities, loadContent, loadItems, loadRecipes } from '../src/data/loader.ts';
import { ALL_SKILLS } from '../src/domain/battle/index.ts';
import { PATHWAY_ACTIONS } from '../src/domain/menu/pathway-actions.ts';

const DOC = 'docs/架构铁律.md';

/**
 * 从 G 表里读某一条的**声明值**。
 *
 * ⚠️ **读不到就报错，不静默跳过** —— 静默跳过会让「把那一行删了」变成一种通过方式（K14 的形状）。
 */
function declared(lines: readonly string[], id: string): number {
  const line = lines.find((candidate) => new RegExp('^\\| \\*{0,2}' + id + '\\*{0,2} \\|').test(candidate));
  assert.ok(line, 'G 表里找不到 ' + id + ' 这一行 —— 它被删了？改写法了？');
  const matched = /===\s*(\d+)/.exec(line!);
  assert.ok(
    matched,
    id + ' 那一行没有 ``表达式 === N`` 形式的值。本表的格式约定见 docs/架构铁律.md §三·补；' +
      '改写法就要同时改这里，否则守卫会静默失效。实际那一行：' + line!.slice(0, 100),
  );
  return Number(matched![1]);
}

/** 声明值 ←→ 现场读 的对照表（**唯一的清单**，加一条就在这里加一行） */
const ROWS: ReadonlyArray<readonly [string, string, () => number]> = [
  ['G2', 'abilities.length', () => loadAbilities().abilities.length],
  ['G3', 'churches.length', () => loadContent().churches.length],
  ['G4', 'churchAbilities.length', () => loadContent().churchAbilities.length],
  ['G7', 'NUMERIC.church.conflict.contestedLocations.length', () => NUMERIC.church.conflict.contestedLocations.length],
  ['G8', 'ALL_SKILLS.length', () => ALL_SKILLS.length],
  ['G10', 'PATHWAY_ACTIONS.length', () => PATHWAY_ACTIONS.length],
  ['G12', 'recipes.length', () => loadRecipes().recipes.length],
  /*
   * M2.85 审计补的一行：G11 在 M2.76 从 1 变 3（合装件变体落地），
   * 但**文档没有守卫**（本表当时不含 G11）—— 于是 docs/架构铁律.md 停在 `=== 1` 而没人发现。
   * 这正是 K14 说的「抓不住故障的判据是装饰」：代码侧有 m2-31 的 G11_EXPECTED 守着，
   * 文档侧一个守卫都没有。补进来之后，两边再也漂不开。
   */
  ['G11', 'items.filter(baseId !== undefined).length', () => loadItems().items.filter((item) => item.baseId !== undefined).length],
  /*
   * M2.34 追加的两条**门槛**（不是内容条数）——
   * 立它的直接原因：M2.27 把 `toSeq7` 从 25 拍成 15，**那个值从未接进代码**，
   * 于是此后每一轮跑批的准入判定都在用旧值（一个没有守卫的「文档值 vs 代码值」漂移）。
   */
  ['G13', 'NUMERIC.longChain.toSeq8', () => NUMERIC.longChain.toSeq8],
  ['G14', 'NUMERIC.longChain.toSeq7', () => NUMERIC.longChain.toSeq7],
];

test('M2.30 G 表守卫：清单的**声明值**与**现场读**一致', () => {
  const lines = readFileSync(DOC, 'utf8').split('\n');
  for (const [id, expr, actual] of ROWS) {
    const live = actual();
    assert.equal(
      declared(lines, id),
      live,
      id + '（' + expr + '）：G 表写的与现场读不一致 —— ' +
        '改了内容表却忘了同步 docs/架构铁律.md 的那张表。实际 ' + expr + ' = ' + live,
    );
  }
});

test('M2.30 G 表守卫：每一条都在表里（漏一条就是下一个漂的）', () => {
  const lines = readFileSync(DOC, 'utf8').split('\n');
  for (const [id] of ROWS) {
    assert.doesNotThrow(() => declared(lines, id), id + ' 必须在 G 表里且可解析');
  }
});

test('M2.30 G 表守卫（对照侧 · K9）：判据抓得住「表里写了错值」', () => {
  /*
   * **上界必须配对照侧**（K9）：光证明「现在的表是对的」不够 ——
   * 还要证明**这张表被写错时，同一个判据会报出来**。
   * 做法：把文档内容**在内存里篡改**（不动磁盘），喂给同一个 `declared`。
   */
  const lines = readFileSync(DOC, 'utf8').split('\n');
  const tampered = lines.map((line) =>
    /^\| \*{0,2}G2\*{0,2} \|/.test(line) ? line.replace(/===\s*\d+/, '=== 999') : line,
  );
  assert.equal(declared(tampered, 'G2'), 999, '篡改没生效 —— 对照侧本身写错了');
  assert.notEqual(declared(tampered, 'G2'), loadAbilities().abilities.length, '对照侧失败：判据认不出被改错的值');
});

test('M2.30 G 表守卫：六条都必须是「=== N」，不许范围写法（假守卫）', () => {
  /*
   * **范围写法 = 假守卫。**
   *
   * `G7` 原来写的是「可争夺地点集（`≥ 20` 且无重复、Top 3 在列）」——
   * `≥ 20` 对 **25** 和 **250** 都成立 ⇒ **那一条从来没有被「声明值 vs 现场读」守过**。
   * 本轮把它改成了 `contestedLocations.length === 25`。
   *
   * ⇒ 这条用例是**防它回来**的：六条里任何一条出现 `≥` / `>` / `<=` 这类范围符号，直接红。
   */
  const lines = readFileSync(DOC, 'utf8').split('\n');
  for (const [id] of ROWS) {
    const line = lines.find((candidate) => new RegExp('^\\| \\*{0,2}' + id + '\\*{0,2} \\|').test(candidate))!;
    assert.doesNotMatch(
      line,
      /[≥≤]|>=|<=/,
      id + ' 那一行出现了范围写法（≥ / ≤ / >= / <=）—— 范围不是数字，是**假守卫**：' +
        '它对任何更大的值都成立，等于这一条没被守过。写成 ``表达式 === N``。',
    );
  }
});

test('M2.30 G 表守卫：G7 有具体数字（不再只是「≥ 20」）', () => {
  const lines = readFileSync(DOC, 'utf8').split('\n');
  /*
   * G7 原来写的是「≥ 20 且无重复、Top 3 在列」—— **那是判据不是数字**，
   * 等于这一条从来没被「声明值 vs 现场读」守过（`≥ 20` 对 25 和 250 都成立）。
   */
  assert.equal(declared(lines, 'G7'), NUMERIC.church.conflict.contestedLocations.length);
  assert.ok(NUMERIC.church.conflict.contestedLocations.length > 20, '仍然要满足原有的 ≥ 20');
});
