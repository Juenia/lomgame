import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NUMERIC } from '../src/config/numeric.ts';
import {
  bountyMultiplierFor,
  damageMultiplierOf,
  gapLabelOf,
  hitChanceOf,
  resistChanceOf,
  resolveAssault,
} from '../src/domain/wanted/assault.ts';
import { bountyOf, resolveReport } from '../src/domain/wanted/wanted.ts';
import { createSeededRng, seedFrom } from '../src/domain/rng.ts';
import { createHarness } from './helpers/app.ts';

const CFG = NUMERIC.assault;
const G = CFG.sequenceGating;

/** 按顺序吐固定值的 rng：判定是"掷几次、每次多少"，用这个才测得准 */
function rngOf(...values: number[]): { next(): number } {
  let index = 0;
  return {
    next: () => {
      const value = values[index] ?? values[values.length - 1] ?? 0;
      index += 1;
      return value;
    },
  };
}

/** 数 rng 被调了几次（"不该掷骰时不掷"那条纪律靠它验） */
function countingRng(value = 0.99): { next(): number; calls: () => number } {
  let calls = 0;
  return {
    next: () => {
      calls += 1;
      return value;
    },
    calls: () => calls,
  };
}

function input(attackerSeq: number, targetSeq: number, over: Record<string, number> = {}) {
  return {
    attackerSeq,
    targetSeq,
    baseHit: CFG.baseHit,
    baseDamage: 40,
    baseDamageMax: CFG.baseDamageMax,
    ...over,
  };
}

/* ================================================================== *
 * 一、序列差矩阵（任务书 §3.2 的表，逐格验）
 * ================================================================== */

test('M2.6.1 矩阵：命中率与伤害倍率逐格对上任务书 §3.2', () => {
  // | 攻击者 → 目标 | 命中率 | 伤害倍率 |（全部来自任务书 §3.2 的表）
  const usable: Array<[number, number, number, number]> = [
    [9, 9, 0.5, 1.0],
    [9, 8, 0.2, 0.5],
    [9, 7, 0.08, 0.25],
    [8, 9, 0.6, 1.1],
    [7, 9, 0.72, 1.21],
  ];
  for (const [attackerSeq, targetSeq, hit, damage] of usable) {
    const diff = attackerSeq - targetSeq;
    assert.ok(
      Math.abs(hitChanceOf(diff) - hit) < 1e-9,
      attackerSeq + '→' + targetSeq + ' 命中率应为 ' + hit + '，实际 ' + hitChanceOf(diff),
    );
    assert.ok(
      Math.abs(damageMultiplierOf(diff) - damage) < 1e-9,
      attackerSeq + '→' + targetSeq + ' 伤害倍率应为 ' + damage + '，实际 ' + damageMultiplierOf(diff),
    );
  }

  // 任务书那一行「9 → 6 | diff 3 | 不可行」
  const blockedRow = 9 - 6;
  assert.equal(hitChanceOf(blockedRow), 0, '9→6 应当不可行');
  assert.equal(damageMultiplierOf(blockedRow), 0);
});

test('M2.6.1 矩阵：序列 9 打序列 5（diff = 4）与任何 diff ≥ 3 一律被拦', () => {
  for (const targetSeq of [6, 5, 4, 3, 0]) {
    const result = resolveAssault(input(9, targetSeq), rngOf(0));
    assert.equal(result.blocked, true, '9→' + targetSeq + ' 应当被拦');
    assert.equal(result.blockedBy, 'sequence_gap');
    assert.equal(result.reason, '你根本近不了他的身。');
    assert.equal(result.hitChance, 0);
    assert.equal(result.damageMax, 0);
  }
  // 边界：diff 正好等于阈值时拦，差一级则不拦
  assert.equal(resolveAssault(input(9, 9 - G.blockThreshold), rngOf(0)).blocked, true);
  assert.equal(
    resolveAssault(input(9, 9 - G.blockThreshold + 1), rngOf(0)).blocked,
    false,
    'diff = 阈值 − 1 时不该被拦',
  );
});

test('M2.6.1 判定：序列差 ≥ 3 被拦时**一次骰都不掷**', () => {
  const rng = countingRng();
  const result = resolveAssault(input(9, 6), rng);
  assert.equal(result.blocked, true);
  assert.equal(rng.calls(), 0, '被拦时消耗随机数会让同 seed 下别的判定跟着漂');

  // 对照：同序列时要掷一次
  const hitRng = countingRng(0.1);
  resolveAssault(input(9, 9), hitRng);
  assert.equal(hitRng.calls(), 1);

  // 对照：没命中时只掷一次（抗性不该被触发）
  const missRng = countingRng(0.9);
  resolveAssault(input(9, 9), missRng);
  assert.equal(missRng.calls(), 1, '没命中就不该掷抗性骰');
});

test('M2.6.1 判定：命中率 clamp 到 1.0（公式在 diff ≤ −4 时会超过 100%）', () => {
  assert.ok(hitChanceOf(0) <= 1);
  for (const diff of [-3, -4, -6, -8]) {
    assert.ok(hitChanceOf(diff) <= 1, 'diff ' + diff + ' 的命中率必须被 clamp 到 1.0');
  }
  assert.equal(hitChanceOf(-8), 1, '序列 0 打序列 8 应当是必中');
  // 伤害倍率不 clamp —— 高序列本来就该打得重
  assert.ok(damageMultiplierOf(-8) > 1);
});

/* ================================================================== *
 * 二、命中 / 未命中 / 抗性
 * ================================================================== */

test('M2.6.1 判定：命中与未命中按 roll 判定，伤害按序列差缩放', () => {
  // 9→9：roll 0.49 < 0.5 命中，伤害 = 基准 × 1.0
  const evenHit = resolveAssault(input(9, 9), rngOf(0.49));
  assert.equal(evenHit.hit, true);
  assert.equal(evenHit.damage, 40);

  // 9→9：roll 0.5 不命中（边界是 <）
  assert.equal(resolveAssault(input(9, 9), rngOf(0.5)).hit, false);

  // 9→8：命中率 20%，命中时伤害减半
  const weakHit = resolveAssault(input(9, 8, { baseDamage: 50 }), rngOf(0.19));
  assert.equal(weakHit.hit, true);
  assert.equal(weakHit.damage, 25);
  assert.equal(weakHit.damageMax, Math.round(CFG.baseDamageMax * 0.5));
  assert.equal(resolveAssault(input(9, 8), rngOf(0.2)).hit, false, 'roll = 命中率时算未命中');

  // 8→9：命中率 60%，伤害 ×1.1
  const strongHit = resolveAssault(input(8, 9, { baseDamage: 50 }), rngOf(0.59));
  assert.equal(strongHit.hit, true);
  assert.equal(strongHit.damage, 55);
});

test('M2.6.1 抗性：公式以「threshold + 1」表达那个 7，序列 6/5/4 分别是 60% / 70% / 80%', () => {
  // ⚠️ 任务书 §3.3 的注释写「序列6: 50%」，但同一行的公式 0.5 + (7 − 6) × 0.1 = 0.6。
  // 序列 5 / 4 的两个数据点都支持公式，所以以公式为准（见 numeric.assault 顶部的说明）。
  assert.ok(Math.abs(resistChanceOf(6) - 0.6) < 1e-9);
  assert.ok(Math.abs(resistChanceOf(5) - 0.7) < 1e-9);
  assert.ok(Math.abs(resistChanceOf(4) - 0.8) < 1e-9);
  // 序列 0 必然抵抗（clamp 到 1.0）
  assert.equal(resistChanceOf(0), 1);
  // 序列 7 及以上不触发抗性
  for (const seq of [7, 8, 9]) assert.equal(resistChanceOf(seq), 0);
});

test('M2.6.1 抗性：目标序列 ≤ 6 时，命中之后还要过一道判定', () => {
  // 攻击者序列 7 打序列 6（diff = 1，命中率 20%）：
  // roll 0.1 命中 → 抗性骰 0.59 < 0.6 → 被挡下
  const resisted = resolveAssault(input(7, 6), rngOf(0.1, 0.59));
  assert.equal(resisted.blocked, true);
  assert.equal(resisted.blockedBy, 'resist');
  assert.equal(resisted.reason, '伤害被什么东西挡下了。');
  assert.equal(resisted.hit, true, '被挡下的前提是"打中了"');
  assert.equal(resisted.resistChecked, true);
  assert.equal(resisted.resisted, true);
  assert.equal(resisted.damage, undefined, '被挡下就不该有伤害');

  // 同样的命中，抗性骰 0.61 ≥ 0.6 → 没挡住，照常结算
  const through = resolveAssault(input(7, 6), rngOf(0.1, 0.61));
  assert.equal(through.blocked, false);
  assert.equal(through.hit, true);
  assert.ok((through.damage ?? 0) > 0);
  assert.equal(through.resistChecked, true);
  assert.equal(through.resisted, false);
});

test('M2.6.1 抗性：高序列目标的抗性只在命中后掷骰，未命中时不掷', () => {
  const rng = countingRng(0.99); // 必然未命中
  const result = resolveAssault(input(7, 6), rng);
  assert.equal(result.hit, false);
  assert.equal(result.resistChecked, false);
  assert.equal(rng.calls(), 1, '未命中时只掷一次（命中骰），不该掷抗性骰');
});

/* ================================================================== *
 * 三、反向限制：高打低
 * ================================================================== */

test('M2.6.1 高打低：强 ≥ 1 级时通缉直接跳到 3 级，赏金按目标序列缩放', () => {
  const high = resolveAssault(input(8, 9), rngOf(0.1));
  assert.equal(high.hit, true);
  assert.equal(high.wantedLevelOverride, CFG.reverseWanted.highAttacksLow.wantedLevelOverride);
  assert.equal(high.wantedLevelOverride, 3);
  // 目标序列 9 → 1 + (9 − 9) × 0.5 = 1.0
  assert.equal(high.bountyMultiplier, 1);

  // 打更强的目标，赏金放大
  const stronger = resolveAssault(input(5, 8), rngOf(0.1));
  assert.equal(stronger.wantedLevelOverride, 3);
  assert.ok(Math.abs(stronger.bountyMultiplier - 1.5) < 1e-9, '序列 8 的目标 → ×1.5');
  assert.ok(Math.abs(bountyMultiplierFor(7) - 2) < 1e-9);
  assert.ok(Math.abs(bountyMultiplierFor(6) - 2.5) < 1e-9);
});

test('M2.6.1 高打低：同序列或弱打强时**不**触发反向限制', () => {
  const even = resolveAssault(input(9, 9), rngOf(0.1));
  assert.equal(even.wantedLevelOverride, null);
  assert.equal(even.bountyMultiplier, 1);

  const weaker = resolveAssault(input(9, 8), rngOf(0.1));
  assert.equal(weaker.wantedLevelOverride, null);
  assert.equal(weaker.bountyMultiplier, 1);

  // 被拦时也不该有反向限制（压根没打成）
  const blocked = resolveAssault(input(9, 6), rngOf(0.1));
  assert.equal(blocked.wantedLevelOverride, null);
});

/* ================================================================== *
 * 四、可复现与文案
 * ================================================================== */

test('M2.6.1 可复现：同一个 seed 必然得到同一个结果', () => {
  const seed = seedFrom(['m2-6-1', 'reproduce']);
  const run = () =>
    resolveAssault(
      input(9, 8, { baseDamage: 37 }),
      createSeededRng(seedFrom([seed, 'judge'])),
    );
  const a = run();
  const b = run();
  assert.deepEqual(a, b);
});

test('M2.6.1 文案：gapLabel 说清谁强谁弱（命令层不做任何比较）', () => {
  assert.equal(gapLabelOf(0), '你们序列相同');
  assert.equal(gapLabelOf(1), '你比他弱 1 个序列');
  assert.equal(gapLabelOf(3), '你比他弱 3 个序列');
  assert.equal(gapLabelOf(-2), '你比他强 2 个序列');
});

/* ================================================================== *
 * 五、集成（真实路由）
 * ================================================================== */

test('M2.6.1 集成：序列差 ≥ 3 的袭击被拦，回执明确、不扣 AP、不产生通缉', async () => {
  const h = createHarness();
  try {
    const attacker = await h.createCharacter('31001', '凡人');
    const target = await h.createCharacter('31002', '半神');
    // 把目标抬到序列 6：diff = 9 − 6 = 3 → 必拦
    const demi = h.repos.characters.findById(target.id)!;
    h.repos.characters.update({ ...demi, sequence: 6, updatedAt: h.now() });

    const messages = await h.send({ rawText: '.袭击 @31002', userId: '31001' });
    const text = messages.map((message) => message.text).join('\n');

    assert.ok(text.includes('你根本近不了他的身。'), '回执要直接说清为什么：' + text.slice(0, 200));
    assert.ok(text.includes('你比他弱 3 个序列'), '回执要给出序列差：' + text.slice(0, 200));

    const blocked = h.app.db
      .prepare(
        "SELECT payload, seed FROM domain_events WHERE character_id = ? AND type = 'assault_blocked'",
      )
      .all(attacker.id) as Array<{ payload: string; seed: string | null }>;
    assert.equal(blocked.length, 1, '被拦也要留痕（统计"被拦次数"靠它）');
    assert.ok(blocked[0]!.seed, '判定 seed 必须写进 domain_events');
    const payload = JSON.parse(blocked[0]!.payload) as { blockedBy: string; diff: number };
    assert.equal(payload.blockedBy, 'sequence_gap');
    assert.equal(payload.diff, 3);
  } finally {
    h.app.close();
  }
});

test('M2.6.1 集成：高打低命中后签 3 级通缉，赏金按目标序列缩放', async () => {
  const h = createHarness();
  try {
    const attacker = await h.createCharacter('31011', '老手');
    const target = await h.createCharacter('31012', '新人');
    // 攻击者序列 7、目标序列 9（新号）→ 高打低，3 级通缉
    const veteran = h.repos.characters.findById(attacker.id)!;
    h.repos.characters.update({ ...veteran, sequence: 7, updatedAt: h.now() });

    let wanted = h.repos.wanted.listActiveOf(attacker.id, h.now());
    for (let attempt = 0; attempt < 12 && wanted.length === 0; attempt += 1) {
      const me = h.repos.characters.findByUserId('31011')!;
      const victim = h.repos.characters.findByUserId('31012')!;
      h.repos.characters.update({ ...me, updatedAt: h.now() });
      h.repos.characters.update({ ...victim, hp: 100, status: 'active', updatedAt: h.now() });
      await h.send({ rawText: '.袭击 @31012', userId: '31011' });
      h.advance(31 * 60 * 1000);
      wanted = h.repos.wanted.listActiveOf(attacker.id, h.now());
    }
    assert.equal(wanted.length, 1, '12 次都没命中就说明判定层坏了');
    assert.equal(wanted[0]!.level, 3, '高打低必须直接跳到 3 级围剿，而不是 1 级盘查');

    // 赏金缩放：目标序列 9 → ×1.0；换成序列 8 的目标就是 ×1.5
    const report = resolveReport({ targetStates: wanted, targetFactionId: 'police', now: h.now() });
    assert.equal(report.ok, true);
    assert.equal(report.rewardPenny, bountyOf(3), '3 级基础赏金 × 1.0');
  } finally {
    h.app.close();
  }
});

test('M2.6.1 集成：赏金缩放真的体现在举报金额上（序列 8 目标 → ×1.5）', async () => {
  const h = createHarness();
  try {
    const attacker = await h.createCharacter('31021', '猎手');
    const target = await h.createCharacter('31022', '猎物');
    const veteran = h.repos.characters.findById(attacker.id)!;
    h.repos.characters.update({ ...veteran, sequence: 7, updatedAt: h.now() });
    // 目标序列 8：高打低且 (9 − 8) × 0.5 = 0.5 → 赏金 ×1.5
    const prey = h.repos.characters.findById(target.id)!;
    h.repos.characters.update({ ...prey, sequence: 8, updatedAt: h.now() });

    let wanted = h.repos.wanted.listActiveOf(attacker.id, h.now());
    for (let attempt = 0; attempt < 12 && wanted.length === 0; attempt += 1) {
      const me = h.repos.characters.findByUserId('31021')!;
      const victim = h.repos.characters.findByUserId('31022')!;
      h.repos.characters.update({ ...me, updatedAt: h.now() });
      h.repos.characters.update({ ...victim, hp: 100, status: 'active', updatedAt: h.now() });
      await h.send({ rawText: '.袭击 @31022', userId: '31021' });
      h.advance(31 * 60 * 1000);
      wanted = h.repos.wanted.listActiveOf(attacker.id, h.now());
    }
    assert.equal(wanted.length, 1);
    assert.equal(wanted[0]!.level, 3);
    assert.ok(Math.abs((wanted[0]!.bountyMultiplier ?? 1) - 1.5) < 1e-9, '倍率必须落库');

    const reward = Math.round(bountyOf(3) * 1.5);
    assert.equal(reward, 750);
    const report = resolveReport({ targetStates: wanted, targetFactionId: 'police', now: h.now() });
    assert.equal(report.rewardPenny, reward, '举报金额要带上缩放');
  } finally {
    h.app.close();
  }
});

test('M2.6.1 集成：M2.6 的普通袭击（同序列）仍然是 1 级通缉、赏金不缩放', async () => {
  const h = createHarness();
  try {
    const attacker = await h.createCharacter('31031', '同辈');
    await h.createCharacter('31032', '另一个同辈');
    let wanted = h.repos.wanted.listActiveOf(attacker.id, h.now());
    for (let attempt = 0; attempt < 12 && wanted.length === 0; attempt += 1) {
      const me = h.repos.characters.findByUserId('31031')!;
      const victim = h.repos.characters.findByUserId('31032')!;
      h.repos.characters.update({ ...me, updatedAt: h.now() });
      h.repos.characters.update({ ...victim, hp: 100, status: 'active', updatedAt: h.now() });
      await h.send({ rawText: '.袭击 @31032', userId: '31031' });
      h.advance(31 * 60 * 1000);
      wanted = h.repos.wanted.listActiveOf(attacker.id, h.now());
    }
    assert.equal(wanted.length, 1);
    assert.equal(wanted[0]!.level, 1, '同序列不该触发高打低覆盖');
    assert.equal(wanted[0]!.bountyMultiplier ?? 1, 1);
    const report = resolveReport({ targetStates: wanted, targetFactionId: 'police', now: h.now() });
    assert.equal(report.rewardPenny, bountyOf(1));
  } finally {
    h.app.close();
  }
});
