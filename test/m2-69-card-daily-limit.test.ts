/**
 * M2.69：**事件卡的每日上限**（`daily_limit`）接判定。
 *
 * ## 这一份守什么
 *
 * `daily_limit` 从 W2 起就写在每一张卡的顶层（65 张全写），**运行期零读取**：
 * 每日去重走的是「(角色, 卡, 日期) 一行在不在」，也就是恒为 **1 次**。于是：
 *
 *   · 写 `daily_limit: 2` 的两张卡（daily_012 / daily_016）实际只能出一次；
 *   · 「今天别出这张卡」这件事没有任何表达方式（只能把卡从内容里删掉，
 *     而那会打断 locations.yaml 里对它的引用）。
 *
 * 这一轮把一行记录从「触发过没有」变成「触发过几次」（迁移 0030 加 `count` 列），
 * 并让 `EventEngine.eligible` 比 `daily_limit` —— 那是这个字段**全仓唯一的读取点**。
 *
 * ## 为什么这件事值得单独一轮
 *
 * 它是 `docs/框架现状解读.md` 的**未决项 B2-1**（原文：「它本来打算约束什么？
 * 与 event_triggers 的每日去重是同一件事还是两件事？无文档」）。
 * 这一轮给出的答案是：**同一件事的两半** —— 去重是机制，daily_limit 是那条机制的上限。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadCards } from '../src/cards/loader.ts';
import { EventEngine } from '../src/domain/event/engine.ts';
import { parseCard, type EventCard } from '../src/cards/schema.ts';
import { dateKey } from '../src/infra/date.ts';
import type { CharacterState } from '../src/domain/character/types.ts';
import { createHarness } from './helpers/app.ts';

/** 真实卡片池（与运行时同一个加载器：src/cards/loader.ts） */
const CARD_SET = loadCards().cards;

function asCard(raw: Record<string, unknown>): EventCard {
  const parsed = parseCard({ name: '测试卡', ...raw });
  assert.equal(parsed.ok, true, parsed.ok ? '' : parsed.issues.join('; '));
  if (!parsed.ok) throw new Error('unreachable');
  return parsed.card;
}

function makeState(): CharacterState {
  return {
    id: 'c-m269', userId: 'u-m269', name: '试的人', pathway: 'seer', pathwayStatus: 'initiated',
    gender: 'male', sequence: 9, hp: 100, mp: 100, mad: 0, cor: 0, dig: 0, dp: 0,
    status: 'active', promotionFails: 0, createdAt: 0, updatedAt: 0,
  };
}

const CTX = { character: makeState(), flags: new Set<string>(), date: '2026-09-21' };

/* ================================================================== *
 * 一、引擎：上限表达的是「几次」
 * ================================================================== */

test('M2.69 引擎：daily_limit 是**次数上限**（1 次的卡出过就不再进池）', () => {
  const once = asCard({ id: 'daily_901', trigger: { type: 'daily', weight: 10 }, texts: { priv: 'x' } });
  const engine = new EventEngine([once]);
  assert.deepEqual(
    engine.eligible(CTX, { date: CTX.date, triggeredToday: new Map() }).map((c) => c.id),
    ['daily_901'],
    '今天没出过 → 在池里',
  );
  assert.deepEqual(
    engine.eligible(CTX, { date: CTX.date, triggeredToday: new Map([['daily_901', 1]]) }),
    [],
    '出过一次（上限也是 1）→ 不在池里（与加这一轮之前的行为逐位相同）',
  );
});

test('M2.69 引擎：daily_limit: 2 的卡出过一次**仍然在池里**（这一轮修的就是它）', () => {
  const twice = asCard({
    id: 'daily_902', daily_limit: 2,
    trigger: { type: 'daily', weight: 10 }, texts: { priv: 'x' },
  });
  const engine = new EventEngine([twice]);
  assert.deepEqual(
    engine.eligible(CTX, { date: CTX.date, triggeredToday: new Map([['daily_902', 1]]) }).map((c) => c.id),
    ['daily_902'],
  );
  assert.deepEqual(
    engine.eligible(CTX, { date: CTX.date, triggeredToday: new Map([['daily_902', 2]]) }),
    [],
    '第二次之后才出局',
  );
});

test('M2.69 引擎：daily_limit: 0 = 今天不许出（而不是「不限次」）', () => {
  const off = asCard({
    id: 'daily_903', daily_limit: 0,
    trigger: { type: 'daily', weight: 10 }, texts: { priv: 'x' },
  });
  const engine = new EventEngine([off]);
  assert.deepEqual(engine.eligible(CTX, { date: CTX.date, triggeredToday: new Map() }), []);
  assert.deepEqual(engine.eligible(CTX, { date: CTX.date }), [], '不传 counts 也一样（缺省是 0 次）');
});

/* ================================================================== *
 * 二、内容侧：现在真的有卡用得上「两次」
 * ================================================================== */

test('M2.69 内容：65 张卡里的 daily_limit 分布与「>1 的卡真的进得了池」', () => {
  const limits = new Map<number, number>();
  for (const card of CARD_SET) limits.set(card.daily_limit, (limits.get(card.daily_limit) ?? 0) + 1);
  assert.equal(limits.get(1), CARD_SET.length - 2, '除两张之外全部是 1 —— 改了内容要同步这一条');
  assert.equal(limits.get(2), 2, '恰好两张写 2（daily_012 / daily_016）');

  const twice = CARD_SET.filter((card) => card.daily_limit > 1);
  const engine = new EventEngine(twice);
  const used = new Map(twice.map((card) => [card.id, 1]));
  assert.deepEqual(
    engine.eligible(CTX, { date: CTX.date, types: ['daily'], triggeredToday: used }).map((c) => c.id).sort(),
    twice.filter((card) => card.trigger.type === 'daily').map((card) => card.id).sort(),
    '出过一次之后它们**仍然**在池里 —— 这正是这一轮修的东西',
  );
});

/* ================================================================== *
 * 三、仓储：一行记录说的是次数
 * ================================================================== */

test('M2.69 仓储：mark 两次 → 记两次（不是「插一行然后忽略重复」）', async () => {
  const h = createHarness({ deterministicIds: true });
  try {
    // event_triggers.character_id 有外键 —— 用真建一个角色（顺便验一遍外键还在生效）
    const who = await h.createCharacter('940001', '记次数的人', 'seer');
    const repo = h.repos.eventTriggers;
    const date = dateKey(h.now());
    assert.equal(repo.countOf(who.id, 'daily_012', date), 0, '没出过就是 0');
    repo.mark(who.id, 'daily_012', date);
    assert.equal(repo.countOf(who.id, 'daily_012', date), 1);
    repo.mark(who.id, 'daily_012', date);
    assert.equal(repo.countOf(who.id, 'daily_012', date), 2, '第二次是 +1，不是被忽略');
    assert.deepEqual([...repo.countsOn(who.id, date).entries()], [['daily_012', 2]]);
    // ⚠️ countOn 数的是**不同的卡**（报告口径），不是次数和
    assert.equal(repo.countOn(who.id, date), 1);
  } finally {
    h.app.close();
  }
});

test('M2.69 迁移：event_triggers 真的有 count 列（0030 跑过了）', () => {
  const h = createHarness({ deterministicIds: true });
  try {
    const cols = h.app.db.prepare('PRAGMA table_info(event_triggers)').all() as Array<{ name: string }>;
    const names = cols.map((col) => col.name);
    assert.ok(names.includes('count'), 'count 列必须在（实际列：' + names.join(',') + '）');
    const applied = h.app.db
      .prepare("SELECT name FROM schema_migrations WHERE name LIKE '0030%'")
      .all() as Array<{ name: string }>;
    assert.equal(applied.length, 1, '0030 这条迁移要登记在 schema_migrations 里');
  } finally {
    h.app.close();
  }
});

test('M2.69 冷却与上限是两件事（互不干扰）', async () => {
  const h = createHarness({ deterministicIds: true });
  try {
    const who = await h.createCharacter('940002', '冷却的人', 'seer');
    const repo = h.repos.eventTriggers;
    repo.mark(who.id, 'daily_001', '2026-09-21');
    assert.equal(repo.inCooldown(who.id, 'daily_001', '2026-09-21', 7), true, '今天刚出过 → 在冷却里');
    assert.equal(repo.inCooldown(who.id, 'daily_001', '2026-09-28', 7), false, '七天之后 → 冷却结束');
    assert.equal(repo.inCooldown(who.id, 'daily_001', '2026-09-22', 0), false, 'cooldown 0 = 不冷却');
  } finally {
    h.app.close();
  }
});
