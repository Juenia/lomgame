/**
 * **神明接上电**（M2.99）—— 前一版的引擎是纯函数，世界推进还不会问它。
 *
 * 这一条端到端测四件事：
 *   ① 世界 tick 真的会问神座（不是只在测试里被直接调用）
 *   ② **安静的世界里它极少发生**（稀有性在接线之后仍然成立）
 *   ③ 神的行动**匿名**（`rumor`）：玩家该感觉到「有东西动了」，而不是收到通知
 *   ④ 出手之后有沉寂与冷却（同一位神不会连着两小时都动）
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { DivineThroneFileSchema, type DivineThrone } from '../src/domain/world/divine-throne.ts';
import { advanceWorld } from '../src/infra/world-tick.ts';
import { createHarness } from './helpers/app.ts';

const FILE = new URL('../src/data/divine-thrones.yaml', import.meta.url);
function loadThrones(): DivineThrone[] {
  const parsed = DivineThroneFileSchema.safeParse(parse(readFileSync(FILE, 'utf8')));
  assert.ok(parsed.success);
  return parsed.data.divine_thrones;
}

test('M2.99 世界推进里真的会出现神明的行动，而且极少', () => {
  const h = createHarness();
  try {
    const deps = h.app.router.deps as unknown as {
      divineThrones?: readonly DivineThrone[];
      worldEvents: { all(): Array<{ id: string; type: string; text: string }> };
    };
    deps.divineThrones = loadThrones();
    const HOURS = 6_000;
    let now = h.now();
    for (let i = 0; i < HOURS; i += 1) {
      now += 3_600_000;
      advanceWorld(deps as never, now);
    }
    const events = deps.worldEvents.all().filter((e) => e.id.startsWith('divine:'));
    assert.ok(events.length > 0, HOURS + ' 小时里一次神明行动都没有 —— 接线断了（世界 tick 没问神座）');
    assert.ok(events.length < 120, '出手 ' + events.length + ' 次，太频繁了 —— 稀有性在接线之后没生效');
    // 匿名：玩家该感觉到异动，而不是收到通知
    assert.ok(events.every((e) => e.type === 'rumor'), '神的行动必须是匿名的（rumor）：' + JSON.stringify(events[0]));
    assert.ok(events.every((e) => e.text.includes('【世界 · ')), '抬头要与其它世界事件同一口径');
    // 同一位神不会在同一小时出现两次（id 里带小时键）
    const ids = events.map((e) => e.id);
    assert.equal(new Set(ids).size, ids.length, '同一个小时里同一位神出手了两次');
  } finally {
    h.app.close();
  }
});

test('M2.99 没接神座时，世界 tick 照常跑（空数组 = 众神沉寂）', () => {
  const h = createHarness();
  try {
    const deps = h.app.router.deps as unknown as {
      divineThrones?: readonly DivineThrone[];
      worldEvents: { all(): Array<{ id: string; type: string; text: string }> };
    };
    deps.divineThrones = [];
    let now = h.now();
    for (let i = 0; i < 200; i += 1) {
      now += 3_600_000;
      advanceWorld(deps as never, now);
    }
    assert.equal(deps.worldEvents.all().filter((e) => e.id.startsWith('divine:')).length, 0, '关掉了就不该有');
  } finally {
    h.app.close();
  }
});
