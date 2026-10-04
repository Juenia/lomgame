/**
 * **神明的思考**（M2.98）—— 用户要求：「神明需要拥有非常强的思考 AI」。
 *
 * 「强」在这份测试里被拆成四件可断言的事：
 *   ① **观感**：把局势关键词翻成人话（谁挡了我的哪个目标）
 *   ② **记忆**：同一个人做的同一件事，第二次在祂眼里更严重
 *   ③ **计划**：不是每轮重新掷骰子，而是**接着上一步往下走**
 *   ④ **可解释**：每个决定都要说得出为什么（`reason` 不是装饰）
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { DivineThroneFileSchema, type DivineThrone } from '../src/domain/world/divine-throne.ts';
import { DivineMemory, DivinePlans, divineInsight, divineThink, coolingMethods } from '../src/domain/world/divine-mind.ts';
import { divineStance } from '../src/domain/world/divine-decide.ts';

const FILE = new URL('../src/data/divine-thrones.yaml', import.meta.url);
function throneOf(pathway: string): DivineThrone {
  const parsed = DivineThroneFileSchema.safeParse(parse(readFileSync(FILE, 'utf8')));
  assert.ok(parsed.success);
  return parsed.data.divine_thrones.find((t) => t.pathway === pathway)!;
}
function seededRng(seed: number): { next(): number } {
  let s = seed >>> 0;
  return { next(): number { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; } };
}

test('M2.98 观感：局势关键词被翻成「谁挡了我的哪个目标」', () => {
  const god = throneOf('sleepless');
  const insight = divineInsight({
    throne: god,
    keys: ['player_digs_sealed', 'rival_gains_followers'],
    affection: 0,
  });
  assert.ok(insight.actors.length > 0, '要说得出是谁在动：' + JSON.stringify(insight.actors));
  assert.ok(insight.threats.length > 0, '挖封印物对黑夜女神是威胁（她要让该埋的继续埋着）');
  assert.ok(insight.threats.every((t) => god.goals.some((g) => g.id === t.goalId)), '威胁必须落在祂自己的目标上');
  // 无关的局势不该被算成威胁（不能见风就是雨）
  const quiet = divineInsight({ throne: god, keys: ['bodies_uncollected'], affection: 0 });
  assert.equal(quiet.threats.length, 0, '无关的局势不该被算成威胁：' + JSON.stringify(quiet.threats));
});

test('M2.98 记忆：同一个人第二次做同一件事，在祂眼里更严重', () => {
  const god = throneOf('sleepless');
  const keys = ['player_digs_sealed'];
  const first = divineInsight({ throne: god, keys, affection: 0 });
  const again = divineInsight({ throne: god, keys, affection: -2 });
  assert.ok(
    again.threats[0]!.weight > first.threats[0]!.weight,
    '第二次应当更严重：' + first.threats[0]!.weight + ' → ' + again.threats[0]!.weight,
  );
  // 记忆本身：记满之后丢最旧的
  const memory = new DivineMemory(3);
  for (let i = 0; i < 5; i += 1) memory.remember('黑夜女神', 'player-1', -1, i);
  assert.equal(memory.deedsOf('黑夜女神').length, 3, '上限是 3');
  assert.equal(memory.affectionOf('黑夜女神', 'player-1'), -3, '好恶按记得的那几件累加');
  assert.equal(memory.affectionOf('黑夜女神', 'player-2'), 0, '没见过的人没有好恶');
});

test('M2.98 计划：不是每轮重新掷骰子，而是接着上一步往下走', () => {
  const god = throneOf('sleepless');
  const plans = new DivinePlans();
  const insight = divineInsight({ throne: god, keys: ['player_digs_sealed'], affection: 0 });
  const now = 1_000_000;
  const first = divineThink({ throne: god, insight, plan: plans.get('黑夜女神'), cooling: new Set(), now });
  assert.ok(first.goalId !== null, '要挑出一个目标');
  assert.ok(first.newPlanSteps.length >= 2, '这个目标要有多步可走：' + JSON.stringify(first.newPlanSteps));
  assert.ok(first.reason.includes('挡了') || first.reason.includes('开着'), '理由要说人话：' + first.reason);
  // 把计划记下来
  const plan = plans.begin('黑夜女神', first.goalId!, first.newPlanSteps, now);
  const stepOne = first.options[0]!.method.id;
  assert.equal(plan.steps[0], stepOne, '计划的第一步就是祂这一轮会做的');
  // 走完一步之后：下一轮应当接着走，而不是重新挑
  plans.advance('黑夜女神');
  const second = divineThink({
    throne: god,
    insight,
    plan: plans.get('黑夜女神'),
    cooling: new Set([stepOne]),
    now: now + 3_600_000,
  });
  assert.equal(second.goalId, first.goalId, '还在同一个目标上');
  assert.ok(second.reason.includes('接着走计划'), '第二轮要接着走：' + second.reason);
  assert.notEqual(second.options[0]!.method.id, stepOne, '不该重复上一步');
});

test('M2.98 评估：威胁命中与资源都进排序，且每条候选都解释自己', () => {
  const god = throneOf('sleepless');
  const insight = divineInsight({ throne: god, keys: ['player_digs_sealed'], affection: 0 });
  const thinking = divineThink({ throne: god, insight, plan: null, cooling: new Set(), now: 0 });
  assert.ok(thinking.options.length > 0, '要有候选：' + JSON.stringify(thinking.options.map((o) => o.method.id)));
  for (const option of thinking.options) {
    assert.ok(option.why.length >= 3, option.method.id + ' 的理由太薄：' + JSON.stringify(option.why));
    assert.ok(Number.isFinite(option.score), option.method.id + ' 的分数不是数');
  }
  // 降序
  for (let i = 1; i < thinking.options.length; i += 1) {
    assert.ok(thinking.options[i - 1]!.score >= thinking.options[i]!.score, '候选必须按分数降序');
  }
  // 冷却中的不出现
  const top = thinking.options[0]!.method.id;
  const cooled = divineThink({ throne: god, insight, plan: null, cooling: new Set([top]), now: 0 });
  assert.ok(!cooled.options.some((o) => o.method.id === top), '冷却中的手段不该出现在候选里');
});

test('M2.98 冷却判定与决策共用一套口径（两处漂移会让神做出做不到的事）', () => {
  const god = throneOf('sleepless');
  const now = 10_000_000;
  const method = god.methods[0]!;
  const cooling = coolingMethods(god, { [method.id]: now - 1000 }, now);
  assert.ok(cooling.has(method.id), '刚用过的手段要在冷却里');
  const old = coolingMethods(god, { [method.id]: now - method.cooldown_hours * 3_600_000 - 1 }, now);
  assert.ok(!old.has(method.id), '过了冷却就不该在');
  assert.equal(coolingMethods(god, undefined, now).size, 0, '没传记录就是没有冷却');
});

test('M2.98 接进决策：给了「想过的结果」就用它的首选', () => {
  const god = throneOf('sleepless');
  const insight = divineInsight({ throne: god, keys: ['player_digs_sealed'], affection: 0 });
  const thinking = divineThink({ throne: god, insight, plan: null, cooling: new Set(), now: 0 });
  const rng = seededRng(7);
  let used = 0;
  for (let i = 0; i < 400; i += 1) {
    const st = divineStance({
      throne: god,
      situation: { keys: ['player_digs_sealed'], playerKeys: [], playerCity: 'tingen', playerSequence: 9 },
      hoursSinceLastAct: 1e9,
      mind: thinking,
      now: 0,
      rng,
    });
    if (st.method !== null) {
      assert.equal(st.method.id, thinking.options[0]!.method.id, '想过之后就该做那一条');
      used += 1;
    }
  }
  assert.ok(used > 0, '400 次里一次都没出手 —— 稀有性把这条路堵死了');
  /*
   * 想过但无可用手段 ⇒ 什么都不做（而不是退回随机）。
   *
   * ⚠️ 稀有性判定在 mind **之前** —— 大多数轮次连「出手」这一步都过不了，
   * 所以这里要跑到真的出手那一次，才谈得上「想过之后没得做」的理由。
   */
  let emptyReason: string | null = null;
  const rng2 = seededRng(11);
  for (let i = 0; i < 2000 && emptyReason === null; i += 1) {
    const empty = divineStance({
      throne: god,
      situation: { keys: ['player_digs_sealed'], playerKeys: [], playerCity: 'tingen', playerSequence: 9 },
      hoursSinceLastAct: 1e9,
      mind: { options: [], reason: '步骤都在冷却' },
      now: 0,
      rng: rng2,
    });
    assert.equal(empty.method, null, '想过之后没得做，就该什么都不做');
    if (empty.reasons.some((r) => r.includes('步骤都在冷却'))) emptyReason = empty.reasons.join(' / ');
  }
  assert.ok(emptyReason !== null, '2000 次里一次都没走到「出手但无手段」那一步');
});
