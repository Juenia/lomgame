/**
 * M2.29 任务 2：`PathwayAction` 表 + 统一触发接口 + **G10 断言**。
 *
 * ## 三件同批（这是硬约束）
 *
 * 任务书点名：**行动表 + resolver + G10 断言必须同批**，分两次做第二次必漏 ——
 * 因为那是 **K10（配置有、玩法没有）与 K19（占位与生效分不清）叠加**的形状。
 * 本文件就是那第三件。
 *
 * ## G10 与 K16 的区别（任务书点名的一条）
 *
 * **G10 不是「手抄清单」**：它是**类型守卫覆盖不到的位置** ——
 * `Record<PathwayId, …>` 守得住「加途径」（tsc 会红），**守不住「加行动」**（加一条数组元素 tsc 一声不吭）。
 * 所以在 G10 之前，`PATHWAY_EXPLORE_ACTION` **一条断言都没有**。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NUMERIC } from '../src/config/numeric.ts';
import { OPEN_PATHWAYS } from '../src/domain/character/rules.ts';
import type { PathwayId } from '../src/domain/character/types.ts';
import {
  ACTION_CONTEXTS,
  actionById,
  PATHWAY_ACTIONS,
  pathwayActionFor,
  unlockedActionsFor,
  type PathwayAction,
} from '../src/domain/menu/pathway-actions.ts';

/* ================================================================== *
 * §A G10：行动条数冻结
 * ================================================================== */

test('M2.29 G10：途径专属行动条数冻结（加行动必须同时改断言）', () => {
  // M2.29：迁移时 7 条；批次 A1（序列 6）逐途径 +1 ⇒ **14**
  // 批次 A2（序列 5）逐途径 +1 ⇒ 21
  // M2.39 批次 B（序列 4、3）逐途径 +2 ⇒ **35** = 7 途径 × 5
  // M2.43 批次 C（序列 2）逐途径 +1 ⇒ **42** = 7 途径 × 6
  /*
   * M2.76：42（7 途径 × 6）→ **57** —— 15 条新途径各补 1 条 explore 行动。
   * M2.85：57 → **56** —— perfect.schedule（排程，「消耗一件物品换回本日 1 点行动点」）
   * 随行动值机制一并下线。
   * 口径没变（G10 要的仍是「每条途径在 explore 恰好一条」+「contexts 非空」），
   * 变的只是途径条数。
   */
  // M2.85 内容填充 P3：15 条行动稀薄的途径各补 daily / command 两条 → 86；
  // 再补 battle / pvp 两条（原先 15 条途径只有 3 条、老途径是 6 条）→ 86 + 30 = 116
  assert.equal(PATHWAY_ACTIONS.length, 116, 'G10：行动总条数（加删行动时改这里）');

  for (const pathway of OPEN_PATHWAYS) {
    const list = PATHWAY_ACTIONS.filter((action) => action.pathway === pathway);
    // ⚠️ 这里从「恰好 1 条」改成「至少 1 条」：序列递进之后，一条途径在同一场景可能有多条
    //    （序列 9 一条、序列 6 又一条），断言形状跟着 G10 的口径一起变 —— 见 P12/P15。
    assert.ok(list.length >= 1, 'G10：' + pathway + ' 至少要有 1 条行动');
  }

  // 每条途径都要有 —— 否则「加途径忘了加行动」不会被发现
  const covered = new Set(PATHWAY_ACTIONS.map((action) => action.pathway));
  for (const pathway of OPEN_PATHWAYS) {
    assert.ok(covered.has(pathway), pathway + ' 没有任何专属行动');
  }
});

test('M2.29 G10：每条行动的 id 唯一、contexts 非空且取值合法（P10 声明式）', () => {
  const ids = PATHWAY_ACTIONS.map((action) => action.id);
  assert.equal(new Set(ids).size, ids.length, '行动 id 必须唯一');

  for (const action of PATHWAY_ACTIONS) {
    /*
     * ⚠️ **`contexts` 必须非空** —— 这条断言是 P10 的落地：
     * 「都可触发」不等于「所有场景硬编码都能用」，每个行动**声明**自己在哪些场景可用。
     * 空数组 = 哪个场景都用不了（等于没写），不能放过去。
     */
    assert.ok(action.contexts.length > 0, action.id + ' 必须声明至少一个 context');
    for (const context of action.contexts) {
      assert.ok(
        (ACTION_CONTEXTS as readonly string[]).includes(context),
        action.id + ' 声明了非法 context：' + context,
      );
    }
    // 幂等：同一个 context 不写两遍
    assert.equal(new Set(action.contexts).size, action.contexts.length, action.id + ' 的 contexts 有重复');
  }
});

test('M2.29：`pvp` 与 `battle` 是两个独立的值（P10 追加已定，不合并）', () => {
  assert.ok((ACTION_CONTEXTS as readonly string[]).includes('pvp'));
  assert.ok((ACTION_CONTEXTS as readonly string[]).includes('battle'));
  assert.notEqual(
    (ACTION_CONTEXTS as readonly string[]).indexOf('pvp'),
    (ACTION_CONTEXTS as readonly string[]).indexOf('battle'),
  );
});

/* ================================================================== *
 * §B 零行为变化：7 条现状逐字一致
 * ================================================================== */

test('M2.29：7 条现状行动**逐字一致**（迁移不改任何玩家可见的字）', () => {
  /*
   * 这张期望表是**从迁移前的 `explore-menu.ts` 逐字抄来的**（M2.29 的 diff 就是证据）。
   * 它守住的事：搬迁时抄错一个字 —— 而那种错**跑批看不出来**（只是菜单文案变了）。
   * M2.85：warrior（闯）的 preview 去掉了「行动点 -1 · 」前缀、needs 删掉 'ap' ——
   * 那是本轮有意的改动（行动值下线），不是抄错。
   */
  const LOCATION = '老码头';
  const expected: Array<[PathwayId, string, string, string, 'mp' | undefined]> = [
    ['seer', '占卜一下老码头的底细（愚者专属）', '占卜 我要去老码头，路上会出什么事', '灵性 -' + NUMERIC.divination.mpCost, 'mp'],
    ['warrior', '直接闯进去碰碰运气（战士专属）', '事件 老码头', '先撞一张事件卡', undefined],
    ['sleepless', '先看清今晚的天再进去（不眠者专属）', '世界 老码头', '不消耗行动点 · 看该地点天气与预告', undefined],
    ['sailor', '先看看风从哪边来（水手专属）', '世界 老码头', '不消耗行动点 · 看该地点的天气与预告', undefined],
    ['perfect', '清点一遍随身的东西（完美者专属）', '背包', '不消耗行动点 · 看背包', undefined],
    ['reader', '把已知的东西理一遍（阅读者专属）', '状态', '不消耗行动点 · 看自己现在的状态', undefined],
    ['mother', '看看今天该做什么（母亲专属）', '今日', '不消耗行动点 · 看今天的安排', undefined],
  ];

  for (const [pathway, label, command, preview, needs] of expected) {
    const action = pathwayActionFor(pathway, 9, 'explore');
    assert.ok(action, pathway + ' 在序列 9 的 explore 场景必须有行动（零行为变化）');
    assert.equal(action!.label(LOCATION), label, pathway + ' 的 label 变了');
    assert.equal(action!.command(LOCATION), command, pathway + ' 的 command 变了');
    assert.equal(action!.preview, preview, pathway + ' 的 preview 变了');
    assert.equal(action!.needs, needs, pathway + ' 的 needs 变了');
    assert.equal(action!.seq, 9, pathway + ' 的解锁序列应当是 9（全序列可用）');
    assert.deepEqual([...action!.contexts], ['explore'], pathway + ' 迁移后只声明 explore');
    assert.equal(action!.effect.kind, 'none', pathway + ' 的效果仍在各自 handler 里（kind: none）');
  }
});

/* ================================================================== *
 * §C resolver：每个 context 至少一条用例
 * ================================================================== */

/**
 * 夹具：现有 7 条都只有 `explore`，**光靠它们测不出分发逻辑** ——
 * 所以注入一组覆盖 5 个场景 + 跨序列的假行动（`pathwayActionFor` 的 `actions` 参数就是为此存在的）。
 */
const F: PathwayAction[] = [
  { id: 'f.explore', pathway: 'seer', seq: 9, name: 'e', contexts: ['explore'], label: () => '', command: () => '', preview: '', effect: { kind: 'none' } },
  { id: 'f.daily', pathway: 'seer', seq: 9, name: 'd', contexts: ['daily'], label: () => '', command: () => '', preview: '', effect: { kind: 'none' } },
  { id: 'f.pvp', pathway: 'seer', seq: 9, name: 'p', contexts: ['pvp'], label: () => '', command: () => '', preview: '', effect: { kind: 'none' } },
  { id: 'f.battle', pathway: 'seer', seq: 9, name: 'b', contexts: ['battle'], label: () => '', command: () => '', preview: '', effect: { kind: 'none' } },
  { id: 'f.command', pathway: 'seer', seq: 9, name: 'c', contexts: ['command'], label: () => '', command: () => '', preview: '', effect: { kind: 'none' } },
  // 多场景：warrior 的一条同时能在探索与 PVP 里用（M2.28 设计里的「破绽」就是这个形状）
  { id: 'f.multi', pathway: 'warrior', seq: 9, name: 'm', contexts: ['explore', 'pvp'], label: () => '', command: () => '', preview: '', effect: { kind: 'none' } },
  // 序列递进：seer 在序列 6 解锁的更强行动
  { id: 'f.seq6', pathway: 'seer', seq: 6, name: 's6', contexts: ['explore'], label: () => '', command: () => '', preview: '', effect: { kind: 'none' } },
];

test('M2.29 resolver：5 个 context 各自都能取到行动（每个场景至少一条用例）', () => {
  for (const context of ACTION_CONTEXTS) {
    const action = pathwayActionFor('seer', 9, context, F);
    assert.ok(action, 'context=' + context + ' 取不到行动');
    assert.ok(action!.contexts.includes(context), 'context=' + context + ' 取到的行动没声明它');
  }
  assert.equal(pathwayActionFor('seer', 9, 'daily', F)?.id, 'f.daily');
  assert.equal(pathwayActionFor('seer', 9, 'pvp', F)?.id, 'f.pvp');
  assert.equal(pathwayActionFor('seer', 9, 'battle', F)?.id, 'f.battle');
  assert.equal(pathwayActionFor('seer', 9, 'command', F)?.id, 'f.command');
});

test('M2.29 resolver：一条行动可声明多个场景（多场景是声明出来的，不是硬编码）', () => {
  assert.equal(pathwayActionFor('warrior', 9, 'explore', F)?.id, 'f.multi');
  assert.equal(pathwayActionFor('warrior', 9, 'pvp', F)?.id, 'f.multi');
  // 它没声明 daily ⇒ 那个场景取不到（这正是「不硬编码所有场景都能用」的意思）
  assert.equal(pathwayActionFor('warrior', 9, 'daily', F), null);
});

test('M2.29 resolver：序列递进 —— 高序列取到更强的那一条，低序列取不到它', () => {
  // 序列 9（最弱）：只能用 seq 9 的行动
  assert.equal(pathwayActionFor('seer', 9, 'explore', F)?.id, 'f.explore');
  // 序列 6（更强）：seq 6 与 seq 9 都已解锁 ⇒ 取 seq 最小的那条（更强）
  assert.equal(pathwayActionFor('seer', 6, 'explore', F)?.id, 'f.seq6');
  // 序列 5：仍然取 f.seq6（它是已解锁里最强的）
  assert.equal(pathwayActionFor('seer', 5, 'explore', F)?.id, 'f.seq6');
  /*
   * 解锁语义（与 `min_seq` 同口径）：`action.seq >= player.sequence` ⇒ **序列号越小解锁得越多**。
   * ⚠️ 这里我第一版写反了（以为是「seq ≤ 玩家序列」），被断言直接抓出来 —— 记在这里免得下一个人再想一遍。
   */
  // 序列 9（最弱）：只解锁 seq 9 的五条
  assert.deepEqual(
    unlockedActionsFor('seer', 9, F).map((a) => a.id),
    ['f.explore', 'f.daily', 'f.pvp', 'f.battle', 'f.command'],
    '序列 9 只解锁 seq 9 的行动',
  );
  // 序列 5（更强）：seq 6 与 9 都解锁 ⇒ 六条全解锁，且更强的那条（seq 6）排在前面
  assert.deepEqual(
    unlockedActionsFor('seer', 5, F).map((a) => a.id),
    ['f.seq6', 'f.explore', 'f.daily', 'f.pvp', 'f.battle', 'f.command'],
    '序列 5 解锁全部，且按 seq 升序 = 从强到弱',
  );
});

test('M2.29 resolver：取不到时返回 null（途径/场景不匹配，不做兜底）', () => {
  assert.equal(pathwayActionFor('seer', 9, 'pvp', PATHWAY_ACTIONS), null, '现有 7 条都没声明 pvp');
  assert.equal(pathwayActionFor('reader', 9, 'battle', PATHWAY_ACTIONS), null);
  // actionById 同理
  assert.equal(actionById('nope'), null);
  assert.equal(actionById('seer.divine')?.pathway, 'seer');
});

test('M2.29：现有 7 条在 explore 场景都取得到（迁移后的接入点没断）', () => {
  for (const pathway of OPEN_PATHWAYS) {
    const action = pathwayActionFor(pathway, 9, 'explore');
    assert.ok(action, pathway + ' 的探索菜单项在迁移后取不到了 —— 这会让菜单少一项');
  }
});
