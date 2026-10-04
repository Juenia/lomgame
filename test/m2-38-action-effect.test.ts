/**
 * M2.38 任务 1（**P0**）：**行动 effect 的读取点**。
 *
 * ## 这份文件守什么
 *
 * M2.29 交付的每个节点是四件套（能力 / 战斗技能 / 途径行动 / 配方），
 * **只有行动没有读取点** —— pathwayActionFor 只被用于取文案，effect 一个字节都没读过。
 * 这份文件把「行动真的会施放」钉死在三层上：
 *
 * | 层 | 用例 |
 * | --- | --- |
 * | **归属**（每一行都有落点） | ① 0 orphan + pending 必须写明原因 |
 * | **解析**（payload 真的被读） | ② 改一个数字 ⇒ 输出跟着变；③ delta 类真的映射到数值入口 |
 * | **执行**（端到端） | ④ 标记的作用域；⑤ 「.行动」写标记 + 落事件 |
 * | **检查器**（K23 反向用例） | ⑥ 判据抓得住「没有落点」的那一条 |
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { checkActionEffects } from '../src/data/link-check.ts';
import {
  ACTION_FIELD_EFFECTS,
  auditActionEffects,
  exploreDangerMarkMultiplier,
  resolvePathwayAction,
} from '../src/domain/menu/pathway-action-resolve.ts';
import { PATHWAY_ACTIONS } from '../src/domain/menu/pathway-actions.ts';
import { FLAG_LOCATION } from '../src/infra/db/flags.ts';
import { createHarness } from './helpers/app.ts';

const character = {
  id: 'c1', name: '试的人', dig: 50, mad: 0, cor: 0, hp: 100, mp: 100, dp: 0,
  sequence: 6, pathway: 'seer', pathwayStatus: 'initiated',
} as never;

test('M2.38 任务 1：21 条行动 0 条没有落点，「已登记未实现」必须看得见', () => {
  const rows = auditActionEffects(PATHWAY_ACTIONS);
  assert.equal(rows.length, PATHWAY_ACTIONS.length);
  assert.deepEqual(
    rows.filter((row) => row.status === 'orphan').map((row) => row.actionId),
    [],
    '还有行动没有任何效果落点 —— 加它就等于只加一句提示',
  );
  /*
   * ⚠️ pending 与 handled **必须分得开**：一个「已登记未实现」的 field
   * 如果和「已实现」长得一样，读的人会以为它能用（K19 的形状）。
   */
  const pending = rows.filter((row) => row.status === 'pending');
  /*
   * ⚠️ 这条断言在 M2.38 时是 `pending.length > 0`（当时有 3 条登记未实现，
   * 而「已登记未实现」必须看得见）。M2.65 把 10 条 pending 全部接上了下家 ——
   * 于是这里反过来：**一条都不许剩**。
   *
   * 判据口径没变，只是阈值跟着事实走；K19 要的是「pending 与 handled 分得开」，
   * 而不是「永远留着几条 pending」。真要有新的 pending，它会在下面那条循环里被要求写清原因。
   */
  assert.deepEqual(
    pending.map((row) => row.actionId),
    [],
    'M2.65 起 42 条行动的效果全部有下家；新加的 pending 必须先在这里说明白为什么',
  );
  for (const row of pending) {
    assert.ok(row.note.length > 0, row.actionId + ' 是 pending，必须写清「为什么还没实现」');
  }
});

test('M2.38 任务 1：改 payload，行为跟着变 —— 这就是「有读取点」的定义', () => {
  const base = PATHWAY_ACTIONS.find((action) => action.id === 'seer.disguise')!;
  const input = { action: base, character, locationId: 'tingen', day: '2026-01-01' };

  const before = resolvePathwayAction(input);
  assert.equal(before.marks.length, 1, '化身是 buff 类 ⇒ 应当产出一个标记');
  assert.equal(before.marks[0]!.value, '0.9');

  // **只改 payload 里的一个数字**（别的一字不动）
  const tweaked = {
    ...base,
    effect: { kind: 'buff' as const, payload: { field: 'exploreDangerMultiplier', multiplier: 0.5, uses: 1 } },
  };
  const after = resolvePathwayAction({ ...input, action: tweaked });
  assert.equal(after.marks[0]!.value, '0.5', 'payload 改了，resolver 的输出必须跟着变');
  assert.notEqual(before.marks[0]!.value, after.marks[0]!.value);
});

test('M2.38 任务 1：delta 类真的映射到数值入口（maxHpBonus → hp）', () => {
  const action = PATHWAY_ACTIONS.find((entry) => entry.id === 'mother.tend')!;
  const outcome = resolvePathwayAction({ action, character, locationId: 'tingen', day: '2026-01-01' });
  assert.deepEqual(outcome.deltas, [{ type: 'hp', value: 10 }], '抚育：maxHpBonus 10 ⇒ 一次 hp +10（走 apply）');
});

test('M2.38 任务 1：标记的作用域是「地点 + 日期」，读不到就是 1', () => {
  const store = new Map<string, string>();
  const read = (flag: string): string | null => store.get(flag) ?? null;

  assert.equal(exploreDangerMarkMultiplier(read, 'tingen', '2026-01-01'), 1, '没有标记时恒为 1 ⇒ 既有行为逐位不变');
  store.set('action:exploreDanger:tingen:2026-01-01', '0.9');
  assert.equal(exploreDangerMarkMultiplier(read, 'tingen', '2026-01-01'), 0.9);
  assert.equal(exploreDangerMarkMultiplier(read, 'backlund', '2026-01-01'), 1, '换地点就失效');
  assert.equal(exploreDangerMarkMultiplier(read, 'tingen', '2026-01-02'), 1, '换天就失效 —— 不需要显式清理');
});

test('M2.38 任务 1（端到端）：.行动 真的施放 —— 写标记 + 落事件', async () => {
  const h = createHarness({ deterministicIds: true });
  try {
    const who = await h.createCharacter('900001', '试行动的人', 'seer');
    // 起点钉在**序列 9**：先测「未解锁的不给用」，之后再升到 6（建号夹具已经是 initiated）
    h.repos.characters.update({
      ...h.repos.characters.findById(who.id)!,
      sequence: 9,
      dig: 50,
      pathwayStatus: 'initiated',
    });
    // 行动要先站在某个地点上（handler 会拒绝「不在任何地点」）
    h.repos.flags.set(who.id, FLAG_LOCATION, h.now(), 'tingen');
    h.advance(61_000);

    /*
     * ---- 先测「序列 9 只看到序列 9 的行动」 ----
     *
     * ⚠️ 这一段原本是**独立的一条用例**，但**同一进程里连续两次建号会失败**
     *（`createMortal` 走真实两步流程：.创建 → 回数字；第二次被挡，错误是「建号失败」）。
     * 于是改成「同一个角色改序列」—— 顺带把「解锁口径」测在同一份夹具上，还省一次建号。
     */
    const list = (await h.send({ rawText: '.行动', userId: '900001' })).map((m) => m.text).join(String.fromCharCode(10));
    assert.match(list, /占卜/, '序列 9 应当能用序列 9 的占卜');
    assert.doesNotMatch(list, /化身/, '序列 9 **不该**能用序列 6 的化身（解锁口径与 min_seq 同）');
    h.advance(61_000);
    const denied = (await h.send({ rawText: '.行动 化身', userId: '900001' })).map((m) => m.text).join(String.fromCharCode(10));
    assert.match(denied, /没有这个行动/, '未解锁的行动要被拒。实际：' + denied.slice(0, 120));

    // 把它升到序列 6 —— 化身在这一档解锁
    h.repos.characters.update({ ...h.repos.characters.findById(who.id)!, sequence: 6, dig: 50, pathwayStatus: 'initiated' });
    h.advance(61_000);

    const text = (await h.send({ rawText: '.行动 化身', userId: '900001' })).map((m) => m.text).join(String.fromCharCode(10));
    assert.match(text, /化身/, '回执要认这次行动。实际：' + text.slice(0, 160));

    const flags = h.repos.flags.list(who.id);
    assert.ok(
      flags.some((flag) => flag.startsWith('action:exploreDanger:tingen:')),
      '标记要落库（探索 handler 就是靠它拿倍率）。实际标记：' + flags.join('、'),
    );

    const events = h.app.db
      .prepare("SELECT type, payload FROM domain_events WHERE type = 'action_used'")
      .all() as Array<{ type: string; payload: string }>;
    assert.equal(events.length, 1, '每次使用都要留痕（否则「行动被用过」在库里查不到）');
    assert.match(events[0]!.payload, /seer[.]disguise/, '事件要带 actionId');

    // 探索侧真的读到了这个标记（同一个键、同一个函数）
    const markFlag = flags.find((flag) => flag.startsWith('action:exploreDanger:'))!;
    assert.equal(h.repos.flags.value(who.id, markFlag), '0.9');
  } finally {
    h.app.close();
  }
});

test('M2.38 任务 1（K23 反向用例）：行动表检查抓得住「没有落点」的那一条', () => {
  /*
   * K23：写下一条判据时，先用「**已知会失败**」的输入试一次。
   * 这里构造一条 field 不在 ACTION_FIELD_EFFECTS 里的行动 —— 它必须报 error。
   */
  const broken = [
    {
      id: 'probe.bad',
      pathway: 'seer',
      seq: 9,
      name: '坏行动',
      contexts: ['explore'],
      label: () => '',
      command: () => '',
      preview: '',
      effect: { kind: 'buff', payload: { field: '这个字段没有落点', value: 1 } },
    },
  ];
  const report = checkActionEffects(broken as never);
  assert.equal(report.issues.length, 1, '没有落点的行动必须被报出来');
  assert.equal(report.issues[0]!.level, 'error');
  assert.equal(report.issues[0]!.check, 'action-effect');
  assert.match(report.issues[0]!.message, /probe[.]bad/);

  // 对照侧（K9）：真实的表必须 0 error —— 否则这条判据只会恒亮
  assert.deepEqual(checkActionEffects().issues, [], '真实的 21 条行动应当全部有落点');
  assert.ok(Object.keys(ACTION_FIELD_EFFECTS).length > 0);
});
