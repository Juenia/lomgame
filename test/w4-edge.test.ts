import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NUMERIC } from '../src/config/numeric.ts';
import { mergeAbilityEffects } from '../src/domain/ability/ability.ts';
import { apply, CLAMP } from '../src/domain/effect/apply.ts';
import { loadCards } from '../src/cards/loader.ts';
import { EventEngine } from '../src/domain/event/engine.ts';
import { dateKey } from '../src/infra/date.ts';
import { runDailyTick } from '../src/infra/tick.ts';
import { StaticFingerprintProvider } from '../src/infra/fingerprint.ts';
import type { CharacterState } from '../src/domain/character/types.ts';
import { createHarness } from './helpers/app.ts';

const A = '20001';

function makeState(overrides: Partial<CharacterState> = {}): CharacterState {
  return {
    id: 'char-1', userId: 'u1', name: '克莱恩', pathway: 'seer', pathwayStatus: 'initiated', gender: 'male', sequence: 9,
    hp: 100, mp: 100, mad: 0, cor: 0, dig: 0, dp: 0,
    status: 'active', promotionFails: 0, createdAt: 0, updatedAt: 0,
    ...overrides,
  };
}

test('apply：sequence 也走唯一入口，并被 0—9 夹住', () => {
  assert.deepEqual(CLAMP.sequence, [0, 9]);
  const down = apply(makeState({ sequence: 9 }), [{ type: 'sequence', value: -1 }], '晋升', 0, 's');
  assert.equal(down.newState.sequence, 8);
  assert.equal(down.events[0]?.type, 'sequence_delta');

  const floored = apply(makeState({ sequence: 0 }), [{ type: 'sequence', value: -1 }], '晋升', 0, 's');
  assert.equal(floored.newState.sequence, 0);
  assert.equal(floored.events.length, 0, '无变化不产事件');
});

test('能力合并：先攻加成等当前未接入战斗系统的字段照样能查出来', () => {
  const merged = mergeAbilityEffects([
    { id: 'a', pathway: 'warrior', seq: 8, name: '格斗家', effect: { initiativeBonus: 2 } },
    { id: 'b', pathway: 'warrior', seq: 7, name: '武器大师', effect: { initiativeBonus: 1 } },
  ]);
  assert.equal(merged.initiativeBonus, 3);
});

test('队伍指令：加入不存在的队伍 / 不在队伍时查看', async () => {
  const h = createHarness();
  await h.createCharacter(A, '克莱恩');
  h.advance(11_000);
  assert.match((await h.send({ rawText: '.队伍 加入 不存在', userId: A }))[0]?.text ?? '', /找不到这个队伍/);
  h.advance(11_000);
  assert.match((await h.send({ rawText: '.队伍', userId: A }))[0]?.text ?? '', /你不在任何队伍里/);
  h.advance(11_000);
  assert.match((await h.send({ rawText: '.队伍 离开', userId: A }))[0]?.text ?? '', /不在任何队伍/);
  h.app.close();
});

test('.晋升：失控状态下被拒（先恢复再晋升）', async () => {
  const h = createHarness();
  const character = await h.createCharacter(A, '克莱恩');
  h.repos.flags.set(character.id, 'ability_seer_9', h.now());
  h.repos.characters.update({
    ...h.repos.characters.findById(character.id)!,
    dig: 90,
    status: 'lost_control',
    updatedAt: h.now(),
  });
  h.advance(11_000);
  assert.match((await h.send({ rawText: '.晋升', userId: A }))[0]?.text ?? '', /失控状态/);
  h.app.close();
});

test('.休息：正常执行并消耗每日次数（M2.85：不再有行动点门槛）', async () => {
  const h = createHarness();
  const character = await h.createCharacter(A, '克莱恩');
  h.repos.characters.update({ ...h.repos.characters.findById(character.id)!, mad: 40, updatedAt: h.now() });
  h.advance(11_000);
  const text = (await h.send({ rawText: '.休息', userId: A }))[0]?.text ?? '';
  assert.doesNotMatch(text, /行动点/, '休息不该再提行动点');
  assert.equal(h.repos.dailyCounters.countOf(character.id, dateKey(h.now()), 'rest'), 1, '要记一次每日次数');
  assert.equal(h.repos.characters.findById(character.id)!.mad, 35, 'MAD 40 → 35');
  h.app.close();
});

test('.占卜：灵性不足时被拒，不写每日次数', async () => {
  const h = createHarness();
  const character = await h.createCharacter(A, '克莱恩');
  h.repos.characters.update({ ...h.repos.characters.findById(character.id)!, mp: 1, updatedAt: h.now() });
  h.advance(11_000);
  assert.match((await h.send({ rawText: '.占卜 会有事吗', userId: A }))[0]?.text ?? '', /灵性不足/);
  assert.equal(h.repos.dailyCounters.countOf(character.id, dateKey(h.now()), 'divination'), 0);
  h.app.close();
});

test('每日结算：失控角色在结算中被解除，且次日才可能再次失控', async () => {
  const h = createHarness();
  const character = await h.createCharacter(A, '克莱恩');
  h.repos.characters.update({
    ...h.repos.characters.findById(character.id)!,
    mad: 100,
    cor: 100,
    status: 'lost_control',
    updatedAt: h.now(),
  });

  const summary = runDailyTick(h.app.router.deps, h.now());
  assert.equal(summary.recovered, 1, '失控在结算里自然解除');
  assert.equal(summary.lostControl, 0, '同一天不重复判定');
  assert.equal(h.repos.characters.findById(character.id)!.status, 'active');
  h.app.close();
});

test('每日结算：清理保留期外的事件触发记录', async () => {
  const h = createHarness();
  const character = await h.createCharacter(A, '克莱恩');
  h.repos.eventTriggers.mark(character.id, 'daily_001', '2020-01-01');
  h.repos.eventTriggers.mark(character.id, 'daily_002', '2020-01-02');
  const pruned = runDailyTick(h.app.router.deps, h.now());
  assert.ok(pruned.eventsPruned >= 2);
  const rows = h.app.db.prepare('SELECT COUNT(*) AS n FROM event_triggers').get() as { n: number };
  assert.equal(rows.n, 0);
  h.app.close();
});

test('指纹：固定为 null 时退回账号维度风控', async () => {
  const h = createHarness({ fingerprint: new StaticFingerprintProvider(null) });
  const a = await h.createCharacter(A, '克莱恩');
  const b = await h.createCharacter('20002', '正义', 'warrior');
  h.repos.inventory.add(a.id, '辅助材料·银粉', 1, 'unbound', h.now());
  h.repos.inventory.add(b.id, '便士', 200, 'unbound', h.now());
  h.advance(11_000);
  const sent = await h.send({ rawText: '.交易 @20002 辅助材料·银粉 1 50', userId: A });
  const id = /单号：([A-F0-9]{6})/.exec(sent[0]?.text ?? '')![1];
  assert.equal(h.repos.trades.getById(id)?.deviceKey, null);
  h.app.close();
});

test('组队卡：人数不足时不会出现在 .扮演 的暴露池里', async () => {
  const { cards } = loadCards();
  const engine = new EventEngine(cards);
  const date = '2026-09-21';
  const solo = engine.eligible(
    { character: makeState(), flags: new Set(), date, partySize: 1, location: '老码头' },
    { date, types: ['random'], location: '老码头' },
  );
  assert.ok(!solo.some((card) => card.id === 'random_007'));
  // 老码头 的 random 卡只有 random_002（需要 owes_favor）与 random_007（需要两人）
  assert.equal(solo.length, 0, '两个条件都不满足时，老码头没有可触发的暴露卡');

  const withFlag = engine.eligible(
    {
      character: makeState(),
      flags: new Set(['owes_favor']),
      date,
      partySize: 1,
      location: '老码头',
    },
    { date, types: ['random'], location: '老码头' },
  );
  assert.deepEqual(withFlag.map((card) => card.id), ['random_002'], '社交 flag 仍然能单独触发别的卡');
});

test('配置单点：W4 旋钮都在 numeric 里', () => {
  assert.equal(typeof NUMERIC.promotion.digThreshold, 'number');
  assert.equal(typeof NUMERIC.promotion.failStreakBonus, 'number');
  assert.equal(typeof NUMERIC.tick.lostControlDays, 'number');
  assert.equal(typeof NUMERIC.recovery.purify.cor, 'number');
  assert.ok(NUMERIC.recovery.purify.materials.length > 0, '净化材料是配置，不是硬编码');
  assert.equal(typeof NUMERIC.party.maxMembers, 'number');
  assert.equal(typeof NUMERIC.divination.cooldownMs, 'number');
});

test('失控文本池：至少 10 条，且没有未定义片段', async () => {
  const h = createHarness();
  assert.ok(h.app.router.deps.lostControlPool.all.length >= 30);
  for (const pathway of ['seer', 'warrior', 'sleepless'] as const) {
    assert.ok(
      h.app.router.deps.lostControlPool.byPathway[pathway].length >= 10,
      `${pathway} 至少 10 条失控文本`,
    );
  }
  h.app.close();

  const { issues } = loadCards();
  const fragmentErrors = issues.filter(
    (issue) => issue.level === 'error' && issue.message.includes('未定义的片段'),
  );
  assert.deepEqual(fragmentErrors, []);
});
