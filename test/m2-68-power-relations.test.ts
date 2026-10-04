/**
 * M2.68：**势力之间的关系进判定**。
 *
 * ## 这一份守什么
 *
 * `powers.yaml` 从 M2.59 起就写着「relations 是默认值，会被运行时状态覆盖（power_relations 表）」，
 * 而实际上那两件事**都没有发生**：
 *
 * | 声称 | 实际 |
 * | --- | --- |
 * | 关系影响玩法 | 反应引擎一个字节都没读过 `relations` |
 * | 运行时表能覆盖默认 | `PowerRelationRepo.upsert` **一个调用者都没有**，表只被后台的只读页读 |
 *
 * 这一轮把两边都接上：引擎加**第二轮**（盟友壮胆 / 敌对牵制 / 欠人情的跟着走），
 * 合并链变成三层（内容 → 历史 → 运行时），并给 GM 一支能写第三层的笔。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadPowers } from '../src/data/loader.ts';
import {
  buildRelationIndex,
  relationAdjustmentOf,
  resolvePowerReactions,
  type Power,
  type PowerEvent,
  type PowerState,
} from '../src/domain/world/power.ts';
import { gmSetPowerRelation } from '../src/admin/gm.ts';
import { createHarness } from './helpers/app.ts';

const POWERS = loadPowers().powers;

function fakePower(patch: Partial<Power> = {}): Power {
  return {
    id: 'p1',
    name: '试验势力',
    type: 'police',
    description: '',
    home_region: '',
    stance: 'neutral',
    goals: [],
    resources: { manpower: 0.5, wealth: 0.5, mystic: 0.3 },
    relations: [],
    ...patch,
  };
}

function ev(patch: Partial<PowerEvent> = {}): PowerEvent {
  return { kind: 'sighting', locationId: 'loc_a', severity: 1, at: 1000, sourceId: 'src1', ...patch };
}

/* ================================================================== *
 * 一、关系索引：对称化与单向人情
 * ================================================================== */

test('M2.68 关系表：盟友与敌对**对称化**，一方写就够了', () => {
  const police = fakePower({ id: 'police', relations: [{ to: 'church', kind: 'ally' }] });
  const church = fakePower({ id: 'church', relations: [] });
  const index = buildRelationIndex([police, church]);
  assert.deepEqual(index.get('police')!.allies, ['church']);
  assert.deepEqual(index.get('church')!.allies, ['police'], '另一方没写，也算数 —— 否则「谁先写」决定谁能用');
});

test('M2.68 关系表：同一对既写盟友又写敌对时，**敌对胜**（且与顺序无关）', () => {
  const a = fakePower({ id: 'a', relations: [{ to: 'b', kind: 'ally' }] });
  const b = fakePower({ id: 'b', relations: [{ to: 'a', kind: 'hostile' }] });
  const forward = buildRelationIndex([a, b]);
  const backward = buildRelationIndex([b, a]);
  assert.deepEqual(forward.get('a')!.hostiles, ['b'], '翻脸比盟约更该算数');
  assert.deepEqual(forward.get('a')!.allies, []);
  assert.deepEqual(
    backward.get('a')!.hostiles,
    forward.get('a')!.hostiles,
    '换个数组顺序必须得到同一张表（否则结果是遍历顺序的函数）',
  );
});

test('M2.68 关系表：人情是**单向**的 —— 只有欠的那一方写', () => {
  const debtor = fakePower({ id: 'debtor', relations: [{ to: 'creditor', kind: 'debt' }] });
  const creditor = fakePower({ id: 'creditor', relations: [] });
  const index = buildRelationIndex([debtor, creditor]);
  assert.deepEqual(index.get('debtor')!.owes, ['creditor']);
  assert.deepEqual(index.get('creditor')!.owes, [], '债主不欠谁 —— 人情不能对称化');
});

test('M2.68 关系表：真实内容里的三方关系与声明一致', () => {
  const index = buildRelationIndex(POWERS);
  const police = index.get('police')!;
  const gang = index.get('gang')!;
  assert.ok(police.allies.includes('church'), '警察与教会是盟友（内容表两个方向都写了）');
  assert.ok(police.hostiles.includes('gang'), '警察与黑帮敌对');
  assert.ok(gang.hostiles.includes('police') && gang.hostiles.includes('church'), '黑帮与这两家都敌对');
  const war = index.get('god_of_war')!;
  assert.ok(war.owes.includes('storm_lord'), '战神欠风暴之主一个人情（单向）');
});

/* ================================================================== *
 * 二、第二轮：盟友壮胆 / 敌对牵制 / 跟着还人情
 * ================================================================== */

test('M2.68 调整量：三种关系各自的方向与大小', () => {
  const index = buildRelationIndex([
    fakePower({ id: 'me', relations: [{ to: 'friend', kind: 'ally' }, { to: 'foe', kind: 'hostile' }, { to: 'boss', kind: 'debt' }] }),
    fakePower({ id: 'friend' }),
    fakePower({ id: 'foe' }),
    fakePower({ id: 'boss' }),
  ]);

  const alone = relationAdjustmentOf('me', new Set(['me']), index);
  assert.equal(alone.delta, 0, '旁边没人就什么都不改');
  assert.deepEqual([alone.allies, alone.hostiles, alone.owes], [[], [], []]);

  const withFriend = relationAdjustmentOf('me', new Set(['me', 'friend']), index);
  assert.ok(withFriend.delta > 0, '盟友在场 → 壮胆');
  assert.deepEqual(withFriend.allies, ['friend']);

  const withFoe = relationAdjustmentOf('me', new Set(['me', 'foe']), index);
  assert.ok(withFoe.delta < 0, '敌对在场 → 牵制');
  assert.ok(Math.abs(withFoe.delta) === Math.abs(withFriend.delta), '两边是同一个量级（对称的）');

  const withBoss = relationAdjustmentOf('me', new Set(['me', 'boss']), index);
  assert.ok(withBoss.delta > 0 && withBoss.delta < withFriend.delta, '人情比盟约轻');

  // 三家一起在场：加起来
  const all = relationAdjustmentOf('me', new Set(['me', 'friend', 'foe', 'boss']), index);
  assert.ok(Math.abs(all.delta - (withFriend.delta + withFoe.delta + withBoss.delta)) < 1e-9);
});

test('M2.68 调整量：盟友加成封顶（三四个盟友不该叠成必然反应）', () => {
  const many = ['a', 'b', 'c', 'd'].map((id) => fakePower({ id }));
  const me = fakePower({ id: 'me', relations: many.map((p) => ({ to: p.id, kind: 'ally' as const })) });
  const index = buildRelationIndex([me, ...many]);
  const reacting = new Set(['me', 'a', 'b', 'c', 'd']);
  const capped = relationAdjustmentOf('me', reacting, index, 2);
  const uncapped = relationAdjustmentOf('me', reacting, index, 4);
  assert.ok(capped.delta < uncapped.delta, '封顶真的起了作用');
  assert.equal(capped.allies.length, 4, '但**在场名单**仍然是完整的（报告要看得见全部盟友）');
});

test('M2.68 关系表：只改一侧改不动结果 —— 这就是合并层必须归一化方向的原因', () => {
  /*
   * 现场：内容表里 police→gang 与 gang→police 各写了一次 hostile，
   * 而运行时那一层只写一个方向。按方向合并的话 police→gang 那一条还在，
   * 于是「同一对冲突时敌对优先」会把它判成敌对 —— GM 改完什么也没发生。
   * 这一条把那个事实钉住；上面那条用例与最后的端到端用例各守着一半的修法。
   */
  const police = fakePower({ id: 'police', relations: [{ to: 'gang', kind: 'hostile' }] });
  const gang = fakePower({ id: 'gang', relations: [{ to: 'police', kind: 'ally' }] });
  const index = buildRelationIndex([police, gang]);
  assert.deepEqual(index.get('gang')!.hostiles, ['police'], '两边写反时敌对优先');
  assert.deepEqual(index.get('gang')!.allies, []);
});

/* ================================================================== *
 * 三、引擎：第二轮真的改了「谁动」
 * ================================================================== */

test('M2.68 引擎：警察与教会都动了，黑帮就收敛（被牵制到门槛以下 = 干脆不动）', () => {
  const police = fakePower({ id: 'police', name: '警察', relations: [{ to: 'gang', kind: 'hostile' }] });
  const church = fakePower({ id: 'church', name: '教会', relations: [{ to: 'gang', kind: 'hostile' }] });
  const gang = fakePower({
    id: 'gang', name: '黑帮', type: 'gang',
    // 目标给了「封锁」→ 对目击的相关度 +0.2（够得着第一轮，才谈得上第二轮）
    goals: ['封锁'],
    relations: [{ to: 'police', kind: 'hostile' }, { to: 'church', kind: 'hostile' }],
  });
  const states = new Map<string, PowerState>();
  const input = {
    powers: [police, church, gang],
    event: ev(),
    states,
    isHomeOf: () => true,
  };
  const withEnemies = resolvePowerReactions(input);
  assert.deepEqual(
    withEnemies.map((r) => r.powerId).sort(),
    ['church', 'police'],
    '两家敌对都在场时，黑帮被压到门槛以下 —— 这就是「收敛」',
  );

  /*
   * 把「黑帮 vs 警察」改成盟友：**两侧都要改**（警察那一侧不再声明敌对）。
   *
   * ⚠️ 只改一侧是不够的 —— 同一条关系在两边写反时按「敌对优先」判（下一条用例守着这个事实）。
   * 生产里走的是 GM 写运行时表，那条路会在合并层**归一化方向**，
   * 所以「GM 写一次就覆盖」是成立的（见本文件最后一条端到端用例）。
   */
  const policeAlly = { ...police, relations: [] };
  const allied = { ...gang, relations: [{ to: 'police', kind: 'ally' as const }, { to: 'church', kind: 'hostile' as const }] };
  const withAlly = resolvePowerReactions({ ...input, powers: [policeAlly, church, allied] });
  assert.ok(
    withAlly.some((r) => r.powerId === 'gang'),
    '与警察结盟之后它会跟着一起动（实际：' + withAlly.map((r) => r.powerId).join('、') + '）',
  );
});

test('M2.68 引擎：关系写进 reason（报告要能回答「它为什么动」）', () => {
  const me = fakePower({ id: 'me', name: '我方', relations: [{ to: 'friend', kind: 'ally' }] });
  const friend = fakePower({ id: 'friend', name: '盟友家' });
  const out = resolvePowerReactions({
    powers: [me, friend],
    event: ev(),
    states: new Map(),
    isHomeOf: () => true,
  });
  const mine = out.find((r) => r.powerId === 'me');
  assert.ok(mine !== undefined, '对照前提：它动了');
  assert.match(mine.reason, /与盟友家同进/, 'reason 里要写清盟友也在场：' + mine.reason);
});

test('M2.68 引擎：没有关系时与加这一轮之前逐位相同（缺省 = 中性）', () => {
  const lonely = fakePower({ id: 'lonely' });
  const out = resolvePowerReactions({
    powers: [lonely],
    event: ev(),
    states: new Map(),
    isHomeOf: () => true,
  });
  assert.equal(out.length, 1);
  assert.ok(
    !/同进|相争|还人情/.test(out[0]!.reason),
    '一条关系都没有的势力，reason 里不该出现关系的话：' + out[0]!.reason,
  );
});

/* ================================================================== *
 * 四、运行时那一层：GM 能写，而且真的进判定
 * ================================================================== */

test('M2.68 GM：写势力关系的四条拒绝判据（K23 反向用例）', () => {
  const h = createHarness({ deterministicIds: true });
  try {
    const bad = [
      [{ from: '', to: 'police', kind: 'ally' }, /两端/],
      [{ from: 'police', to: 'police', kind: 'ally' }, /自己/],
      [{ from: 'police', to: '没这家', kind: 'ally' }, /没有这家势力/],
      [{ from: 'police', to: 'church', kind: '合伙' }, /ally . hostile . debt|ally \/ hostile \/ debt/],
    ] as const;
    for (const [body, pattern] of bad) {
      const out = gmSetPowerRelation(h.app.db, body);
      assert.equal(out.ok, false, JSON.stringify(body) + ' 应当被拒');
      assert.match((out as { error: string }).error, pattern);
    }
    // 对照侧：合法的一条写得进去
    const ok = gmSetPowerRelation(h.app.db, { from: 'gang', to: 'police', kind: 'ally' });
    assert.equal(ok.ok, true, JSON.stringify(ok));
  } finally {
    h.app.close();
  }
});

test('M2.68 三层合并（端到端）：GM 写的那一条覆盖 powers.yaml 的默认值，并且进了判定索引', () => {
  const h = createHarness({ deterministicIds: true });
  try {
    const deps = h.app.router.deps;
    const before = deps.powerIndex.byId('gang')!.relations.find((r) => r.to === 'police');
    assert.equal(before?.kind, 'hostile', '对照前提：内容表里黑帮与警察是敌对的');

    gmSetPowerRelation(h.app.db, { from: 'gang', to: 'police', kind: 'ally' });
    const reload = h.app.reloadContent();
    assert.equal(reload.ok, true, '热重载要成功：' + JSON.stringify(reload.errors));

    const after = h.app.router.deps.powerIndex.byId('gang')!.relations.find((r) => r.to === 'police');
    assert.equal(
      after?.kind,
      'ally',
      '运行时那一层必须覆盖内容默认值 —— 否则 powers.yaml 里那句「会被运行时状态覆盖」是假的',
    );
    // 而没被运行时改过的那几条原样保留
    const church = h.app.router.deps.powerIndex.byId('gang')!.relations.find((r) => r.to === 'church');
    assert.equal(church?.kind, 'hostile', '没被改过的默认关系不该被动');
  } finally {
    h.app.close();
  }
});
