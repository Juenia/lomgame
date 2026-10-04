/**
 * M2.168：**神的记忆落库** —— 跨小时计划与出手状态不再随进程消失。
 *
 * 在这之前它们是进程内的（`DivinePlans` 的 Map 与 `deps.divineState`）。
 * 丢的代价**不是报错**，而是两件看起来像设计的怪事：
 *   · 祂正要走完的计划链从第三步回到第一步（像神在反复做同一件事）
 *   · 沉寂期与手段冷却一起清空（重启那一刻众神可能连着出手）
 *
 * 这一条守三件事：
 *   ① 落库版与内存版**行为逐字一致**（两处实现分叉只在重启那一刻暴露）
 *   ② 走完最后一步就清掉（不是留在那儿等下一次 get）
 *   ③ 真实世界 tick 出手之后，库里真的留下了记录
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHarness } from './helpers/app.ts';
import { advanceWorld } from '../src/infra/world-tick.ts';
import { DivinePlans, type DivinePlanStore } from '../src/domain/world/divine-mind.ts';
import { DivinePlansRepo, DivineStateRepo } from '../src/infra/db/divine.ts';

process.env.TEMP = process.env.TEMP ?? 'data/tmp';

test('M2.168 计划落库：新建一个仓储（＝重启）之后计划还在', () => {
  const h = createHarness();
  try {
    const repo = new DivinePlansRepo(h.app.db as never);
    repo.begin('黑夜女神', 'keep_secrets', ['erase_record', 'send_dream'], 1000);
    // 模拟重启：换一个仓储实例读同一张表
    const after = new DivinePlansRepo(h.app.db as never).get('黑夜女神');
    assert.ok(after !== null, '重启之后计划没了');
    assert.equal(after!.goalId, 'keep_secrets');
    assert.deepEqual(after!.steps, ['erase_record', 'send_dream']);
    assert.equal(after!.step, 0);
    assert.equal(after!.startedAt, 1000);
    // 推进一步之后再重启：进度也在
    repo.advance('黑夜女神');
    assert.equal(new DivinePlansRepo(h.app.db as never).get('黑夜女神')!.step, 1, '推进没有落库');
  } finally {
    h.app.close();
  }
});

test('M2.168 走完就清掉，而且**两处实现逐字一致**', () => {
  const h = createHarness();
  try {
    const db = h.app.db as never;
    const memory: DivinePlanStore = new DivinePlans();
    const stored: DivinePlanStore = new DivinePlansRepo(db);
    const trace = (store: DivinePlanStore, seat: string): unknown[] => {
      const log: unknown[] = [];
      store.begin(seat, 'goal', ['a', 'b'], 1);
      log.push(store.get(seat));
      log.push(store.advance(seat));
      log.push(store.get(seat));
      log.push(store.advance(seat));
      log.push(store.get(seat));
      return log;
    };
    assert.deepEqual(trace(stored, '甲'), trace(memory, '乙'), '落库版与内存版的行为不一致');
    // 最后一步走完 ⇒ 两边都清掉
    assert.equal(memory.get('乙'), null);
    assert.equal(stored.get('甲'), null);
    // 没有计划时 advance 返回 null（不是抛）
    assert.equal(stored.advance('丙'), null);
  } finally {
    h.app.close();
  }
});

test('M2.168 出手状态落库：沉寂期与手段冷却跨重启还在', () => {
  const h = createHarness();
  try {
    const db = h.app.db as never;
    const repo = new DivineStateRepo(db);
    assert.equal(repo.get('sleepless'), undefined, '一开始不该有记录');
    repo.set('sleepless', { lastActAt: 5000, methodUsedAt: { erase_record: 4200 } });
    const after = new DivineStateRepo(db).get('sleepless');
    assert.equal(after?.lastActAt, 5000, '重启之后沉寂期没了');
    assert.equal(after?.methodUsedAt['erase_record'], 4200, '手段冷却没了');
  } finally {
    h.app.close();
  }
});

test('M2.168 端到端：世界 tick 出手之后，库里真的留下了记录', () => {
  const h = createHarness();
  try {
    const deps = h.app.router.deps;
    let now = h.now();
    for (let i = 0; i < 3000; i += 1) {
      now += 3_600_000;
      advanceWorld(deps, now);
    }
    const state = new DivineStateRepo(h.app.db as never);
    const acted = deps.divineThrones.filter((t) => state.get(t.pathway) !== undefined);
    assert.ok(acted.length > 0, '3000 小时里没有任何一位神的出手被记下来 —— 接线断了');
    // 记下来的时刻必须是世界时间里的（不是 0、也不是墙上时间）
    const one = state.get(acted[0]!.pathway)!;
    assert.ok(one.lastActAt > h.now(), '记下的出手时刻不对：' + one.lastActAt);
    assert.ok(one.lastActAt <= now, '出手时刻不该超过推进到的时间');
  } finally {
    h.app.close();
  }
});
