import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NUMERIC, applyNumericOverrides, resetNumeric } from '../src/config/numeric.ts';
import { escalationMadOf, samplePlaysPerDay } from '../src/sim/empirical.ts';
import { playEscalationMad } from '../src/domain/play/play.ts';
import { createHarness } from './helpers/app.ts';

test('扮演加压：本版关闭（200×14 实测证明世界时钟单独就够，不需要补偿）', () => {
  assert.equal(
    NUMERIC.play.escalation.madPerExtraPlay,
    0,
    'M2.2 复算结论是「自然拉开」，所以补偿旋钮必须处于关闭状态（依据见 docs/M2.2-失控复算报告.md）',
  );
  for (const played of [0, 5, 20, 40]) {
    assert.equal(playEscalationMad(played), 0, '关闭状态下任何次数都不加压');
  }
  assert.equal(escalationMadOf(20, { threshold: 10, madPerExtraPlay: 0 }), 0);
  assert.equal(NUMERIC.play.exposureChance, 0.38, 'W5 定值不动');
});

test('扮演加压（机制）：当天第 N 次之后逐次加压，阈值以内的玩家日一次都不加', () => {
  // 把旋钮临时打开，验证机制本身可用（后续分布变化时可能真的要启用）
  const snapshot = { ...NUMERIC.play.escalation };
  applyNumericOverrides({ play: { escalation: { threshold: 10, madPerExtraPlay: 0.3 } } });
  try {
    for (let played = 0; played < 10; played += 1) {
      assert.equal(playEscalationMad(played), 0, `当天第 ${played + 1} 次不该加压`);
    }
    assert.ok(Math.abs(playEscalationMad(10) - 0.3) < 1e-9);
    assert.ok(Math.abs(playEscalationMad(12) - 0.9) < 1e-9);
    for (const plays of [0, 1, 9, 10, 15, 25]) {
      assert.equal(
        escalationMadOf(plays, NUMERIC.play.escalation),
        Math.max(0, plays - 10) * 0.3,
        `投影必须与规则同形（plays=${plays}）`,
      );
    }
    assert.equal(escalationMadOf(25, undefined), 0, '不给配置就不加压');
  } finally {
    applyNumericOverrides({ play: { escalation: snapshot } });
    resetNumeric();
    assert.equal(NUMERIC.play.escalation.madPerExtraPlay, 0, '测完必须复原成关闭状态');
  }
});

test('扮演加压：直方图抽样反映「当天扮演了几次」的分布', () => {
  // 稳健型那种分布：绝大多数玩家日 0—8 次
  const steady = [17, 3, 4, 4, 8, 1, 6, 5, 5, 3, 1, 0, 0, 2];
  const picks = Array.from({ length: 50 }, (_, index) => samplePlaysPerDay(steady, index / 50));
  assert.ok(picks.every((value) => value >= 0 && value <= steady.length - 1));
  const steadyHit = picks.filter((value) => value > 10).length;
  assert.ok(steadyHit <= 8, `稳健型被加压的玩家日应当很少，实际 ${steadyHit}/50`);

  // 激进型那种分布：尾部很长
  const aggressive = [1, 1, 0, 2, 1, 0, 1, 2, 3, 3, 4, 2, 0, 0, 3, 2, 4, 3, 6, 2];
  const hard = Array.from({ length: 50 }, (_, index) => samplePlaysPerDay(aggressive, index / 50));
  const hardHit = hard.filter((value) => value > 10).length;
  assert.ok(hardHit > 15, `激进型被加压的玩家日应当很多，实际 ${hardHit}/50`);

  assert.equal(samplePlaysPerDay([], 0.5), 0);
  assert.equal(samplePlaysPerDay([0, 0], 0.5), 0);
});

test('扮演加压：打开旋钮后真的会把 MAD 顶上去（端到端），关闭时一个点都不加', async () => {
  const h = createHarness();
  try {
    await h.createCharacter('50001', '狂人');
    const threshold = 3;
    const perPlay = 0.4;
    applyNumericOverrides({ play: { escalation: { threshold, madPerExtraPlay: perPlay } } });

    let last = h.repos.characters.findByUserId('50001')!.mad;
    const gains: number[] = [];
    for (let index = 1; index <= threshold + 2; index += 1) {
      h.advance(11_000); // 跨过 .扮演 的 10 秒令牌桶冷却
      await h.send({ rawText: '.扮演 我试着稳定自己的梦', userId: '50001' });
      const now = h.repos.characters.findByUserId('50001')!.mad;
      gains.push(now - last);
      last = now;
    }
    const first = gains[0]!;
    const late = gains[threshold]!;
    assert.ok(
      late >= first + perPlay - 1e-9,
      `第 ${threshold + 1} 次的 MAD 增量应当比第一次多出加压量：${first} → ${late}`,
    );
    const played = h.repos.dailyCounters.countOf(
      h.repos.characters.findByUserId('50001')!.id,
      new Date(h.now() + 8 * 3600 * 1000).toISOString().slice(0, 10),
      'play',
    );
    assert.equal(played, threshold + 2, '当天扮演次数应当被记录（每日计数器 play）');
  } finally {
    resetNumeric();
    h.app.close();
  }
});
