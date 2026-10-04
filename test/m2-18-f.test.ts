/**
 * M2.18 任务 F：战斗类教义判据。
 *
 * 本文件只覆盖**枚举层与纯函数层**（F1 / F2）。
 * F3（真指令的端到端）**本轮没做成** —— 见文件末尾的登记与 docs/M2.18-F交付说明.md。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NUMERIC } from '../src/config/numeric.ts';
import { loadContent } from '../src/data/loader.ts';
import { TabooActionSchema, TabooTargetSchema } from '../src/domain/church/index.ts';
import { matchTaboos } from '../src/domain/church/taboo.ts';

const content = loadContent();
const war = content.churches.find((church) => church.id === 'god_of_war')!;

test('M2.18-F1：action 枚举加了 challenge / battle，checkAfter 同步', () => {
  assert.ok(TabooActionSchema.safeParse('challenge').success);
  assert.ok(TabooActionSchema.safeParse('battle').success);
  assert.ok(TabooTargetSchema.safeParse('mortal').success);
  assert.deepEqual([...NUMERIC.church.taboo.checkAfter], ['explore', 'use', 'ritual', 'challenge', 'battle']);
});

test('M2.18-F2：纯函数层 —— 只有带 target: mortal 的 challenge 命中', () => {
  const base = { locationId: 'backlund', cityId: 'backlund', rank: 0, church: war };
  assert.equal(matchTaboos({ ...base, action: 'challenge', target: 'mortal' }).length, 1, '打普通人 → 违反');
  assert.equal(matchTaboos({ ...base, action: 'challenge' }).length, 0, '不传 target → 不命中');
  assert.equal(matchTaboos({ ...base, action: 'battle', target: 'mortal' }).length, 0, 'battle 不是这条判据的动作');
  // M2.17 的三条探索类判据不动（它们是另一层投射）
  assert.equal(matchTaboos({ ...base, action: 'explore', locationId: 'backlund_theatre' }).length, 1, 'M2.17 的剧院判据仍在');
});

/*
 * F3（真指令的端到端）**本轮没做成**：`.挑战 乙 发起` 在这个夹具里没有走到
 * challenge.ts 的发起分支（回执只说「系统繁忙」，而那其实是一处 import 缺失；
 * 补上 import 后异常消失，但检查点仍未被触发）。
 *
 * 检查点代码本身已就位（`deps.battles.create(battle)` 之后、`appendEvents` 之前），
 * **端到端证据留给 m220 跑批**：看 `church_taboo_violation` 的 payload 里有没有
 * `god_of_war_no_striking_mortal`。详见 docs/M2.18-F交付说明.md 的偏差登记。
 */
