import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEngine } from '../src/domain/event/engine.ts';
import { evalCond, evalConds, isValidCond, parseCond } from '../src/domain/event/trigger.ts';
import { parseCard, type EventCard } from '../src/cards/schema.ts';
import { createSeededRng } from '../src/domain/rng.ts';
import type { CharacterState } from '../src/domain/character/types.ts';

function asCard(raw: unknown): EventCard {
  /*
   * M2.40：卡片 schema 收紧后 `name` 必填（它是群里的显示名）。
   * 这个文件里手写的卡只关心各自要测的那条判据，不关心名字 ——
   * 所以在**唯一的入口**补默认值，而不是逐张手写（默认值只有一处，K22）。
   * 已经有 name 的会被 ...raw 覆盖掉。
   */
  const withName = typeof raw === 'object' && raw !== null && !('name' in raw) ? { name: '测试卡', ...raw } : raw;
  const parsed = parseCard(withName);
  assert.equal(parsed.ok, true, parsed.ok ? '' : parsed.issues.join('; '));
  if (!parsed.ok) throw new Error('unreachable');
  return parsed.card;
}

function makeState(overrides: Partial<CharacterState> = {}): CharacterState {
  return {
    id: 'char-1',
    userId: 'u1',
    name: '克莱恩',
    pathway: 'seer', pathwayStatus: 'initiated', gender: 'male',
    sequence: 9,
    hp: 100,
    mp: 100,
    mad: 0,
    cor: 0,
    dig: 0,
    dp: 0,
    status: 'active', promotionFails: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function ctx(overrides: Partial<Parameters<typeof evalCond>[1]> = {}) {
  return {
    character: makeState(),
    flags: new Set<string>(),
    date: '2026-09-21',
    ...overrides,
  };
}

const CARD_A = asCard({
  id: 'daily_901',
  trigger: { type: 'daily', weight: 10, cond: [] },
  effects: [{ dig: 2 }, { item: '便士', n: 1 }],
  texts: { priv: '普通的一天，无事发生。', group: '无事发生。' },
});

const CARD_GATED = asCard({
  id: 'daily_902',
  trigger: { type: 'daily', weight: 10, cond: ['flag:joined_church', 'mad<50'] },
  effects: [{ dig: 3 }],
  texts: { priv: '教会的人来找你了。', group: '有人来过。' },
});

const CARD_LOC = asCard({
  id: 'daily_903',
  trigger: { type: 'daily', weight: 10, cond: [], location: ['老码头'] },
  effects: [{ flag: 'owes_favor' }],
  texts: { priv: '码头上有人叫住了你。', group: '码头有人喊了一声。' },
});

const CARD_SEQ = asCard({
  id: 'daily_904',
  trigger: { type: 'random', weight: 5, cond: [], min_seq: 8, max_seq: 9 },
  effects: [{ mad: 2 }],
  texts: { priv: '夜里有点不对劲。', group: '夜里有动静。' },
});

const CARD_ZERO_WEIGHT = asCard({
  id: 'daily_905',
  trigger: { type: 'daily', weight: 0, cond: [] },
  effects: [{ dig: 1 }],
  texts: { priv: '这张卡不该被抽到。', group: '不该出现。' },
});

test('条件解析：白名单四类写法，其余一律拒绝（不用 eval）', () => {
  assert.deepEqual(parseCond('flag:joined_church'), { kind: 'flag', flag: 'joined_church' });
  assert.deepEqual(parseCond('location:老码头'), { kind: 'location', location: '老码头' });
  assert.deepEqual(parseCond('mad>50'), { kind: 'compare', field: 'mad', operator: '>', value: 50 });
  assert.deepEqual(parseCond('seq<=8'), { kind: 'compare', field: 'seq', operator: '<=', value: 8 });
  assert.deepEqual(parseCond(' dig >= 60 '), { kind: 'compare', field: 'dig', operator: '>=', value: 60 });

  assert.equal(parseCond('process.exit(1)'), null);
  assert.equal(parseCond('1===1'), null);
  assert.equal(parseCond('level>3'), null, '字段不在白名单');
  assert.equal(parseCond('flag:'), null);
  assert.equal(isValidCond('cor!=0'), true);
  assert.equal(isValidCond('cor!==0'), false, '不认 JS 的 !==');
});

test('条件求值：seq 读的是 character.sequence', () => {
  assert.equal(evalCond('flag:joined_church', ctx({ flags: new Set(['joined_church']) })), true);
  assert.equal(evalCond('flag:joined_church', ctx()), false);
  assert.equal(evalCond('location:老码头', ctx({ location: '老码头' })), true);
  assert.equal(evalCond('location:老码头', ctx()), false);
  // 序列号数字越小越高：seq<=8 表示「序列 8 及以上」
  assert.equal(evalCond('seq<=8', ctx({ character: makeState({ sequence: 8 }) })), true);
  assert.equal(evalCond('seq<=8', ctx({ character: makeState({ sequence: 7 }) })), true);
  assert.equal(evalCond('seq<=8', ctx({ character: makeState({ sequence: 9 }) })), false);
  assert.equal(evalCond('mad>50', ctx({ character: makeState({ mad: 51 }) })), true);
  assert.equal(evalCond('mad>50', ctx({ character: makeState({ mad: 50 }) })), false);
  assert.equal(evalCond('cor!=0', ctx({ character: makeState({ cor: 1 }) })), true);
  assert.equal(evalCond('乱写的条件', ctx()), false, '解析失败视为不满足，而不是崩溃');
  assert.equal(evalConds(['flag:joined_church', 'dig>=0'], ctx({ flags: new Set(['joined_church']) })), true);
});

test('引擎过滤：flag / 序列区间 / 地点 / 每日去重 / 冷却', () => {
  const engine = new EventEngine([CARD_A, CARD_GATED, CARD_LOC, CARD_SEQ, CARD_ZERO_WEIGHT]);
  const date = '2026-09-21';

  // 不限定 type 时，random 卡同样在池子里
  assert.deepEqual(
    engine.eligible(ctx(), { date }).map((c) => c.id),
    ['daily_901', 'daily_904', 'daily_905'],
  );

  assert.deepEqual(
    engine.eligible(ctx({ flags: new Set(['joined_church']) }), { date }).map((c) => c.id),
    ['daily_901', 'daily_902', 'daily_904', 'daily_905'],
  );

  assert.deepEqual(
    engine.eligible(ctx({ location: '老码头' }), { date }).map((c) => c.id),
    ['daily_901', 'daily_903', 'daily_904', 'daily_905'],
  );

  assert.deepEqual(
    engine.eligible(ctx(), { date, types: ['random'] }).map((c) => c.id),
    ['daily_904'],
  );
  assert.deepEqual(
    engine.eligible(ctx({ character: makeState({ sequence: 7 }) }), { date, types: ['random'] }),
    [],
    '序列 7 不该看到 min_seq=8 的卡',
  );

  assert.deepEqual(
    // M2.69：triggeredToday 是**次数**（卡片的 daily_limit 是上限，默认 1）
    engine.eligible(ctx(), { date, triggeredToday: new Map([['daily_901', 1]]) }).map((c) => c.id),
    ['daily_904', 'daily_905'],
  );
  assert.deepEqual(
    engine.eligible(ctx(), { date, inCooldown: (card) => card.id === 'daily_905' }).map((c) => c.id),
    ['daily_901', 'daily_904'],
  );
});

test('引擎抽取：权重为 0 的卡永远抽不到，同 seed 结果一致', () => {
  const engine = new EventEngine([CARD_A, CARD_ZERO_WEIGHT]);
  for (let i = 0; i < 50; i += 1) {
    const picked = engine.pick(ctx(), createSeededRng(`seed-${i}`), { date: '2026-09-21' });
    assert.equal(picked?.id, 'daily_901');
  }
  const again = engine.pick(ctx(), createSeededRng('seed-1'), { date: '2026-09-21' });
  assert.equal(again?.id, 'daily_901');
});

test('引擎抽取：空池返回 null，不抛异常', () => {
  const engine = new EventEngine([CARD_LOC]);
  assert.equal(engine.pick(ctx(), createSeededRng('s'), { date: '2026-09-21' }), null);
});

test('卡效果 → apply：数值走唯一入口，flag 单独返回', () => {
  const card = asCard({
    id: 'daily_906',
    trigger: { type: 'daily', weight: 1, cond: [] },
    effects: [{ dig: 2 }, { mad: 3 }, { item: '便士', n: 2 }, { flag: 'met_mentor' }],
    texts: { priv: '一张测试卡。', group: '测试。' },
  });
  const { deltas, flagsToSet } = EventEngine.toDeltas(card);
  assert.deepEqual(deltas, [
    { type: 'dig', value: 2 },
    { type: 'mad', value: 3 },
    { type: 'item', itemId: '便士', quantity: 2 },
  ]);
  assert.deepEqual(flagsToSet, ['met_mentor']);

  const application = EventEngine.applyCard(makeState(), card, { now: 1000, seed: 's1' });
  assert.equal(application.result.newState.dig, 2);
  assert.equal(application.result.newState.mad, 3);
  assert.deepEqual(application.flagsToSet, ['met_mentor']);
  assert.equal(application.result.events.length, 3, 'dig / mad / item 各一条事件');
  assert.ok(application.result.events.every((e) => e.seed === 's1'));
  assert.equal(application.result.events[0]?.reason, '事件卡:daily_906');
});
