import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NUMERIC } from '../src/config/numeric.ts';
import { EventEngine } from '../src/domain/event/engine.ts';
import { canCreateParty, canJoinParty, canLeaveParty } from '../src/domain/party/party.ts';
import { loadCards } from '../src/cards/loader.ts';
import type { CharacterState } from '../src/domain/character/types.ts';
import { createHarness } from './helpers/app.ts';

const A = '20001';
const B = '20002';
const C = '20003';
const D = '20004';
const E = '20005';

function makeState(overrides: Partial<CharacterState> = {}): CharacterState {
  return {
    id: 'char-1', userId: 'u1', name: '克莱恩', pathway: 'seer', pathwayStatus: 'initiated', gender: 'male', sequence: 9,
    hp: 100, mp: 100, mad: 0, cor: 0, dig: 0, dp: 0,
    status: 'active', promotionFails: 0, createdAt: 0, updatedAt: 0,
    ...overrides,
  };
}

test('队伍规则纯函数：重复入队 / 已解散 / 满员 / 不在队伍', () => {
  assert.equal(canCreateParty(null).ok, true);
  assert.match(String((canCreateParty('P1') as { reason?: string }).reason), /已经在一个队伍里/);
  assert.equal(canJoinParty({ currentPartyId: null, targetStatus: 'active', size: 1 }).ok, true);
  assert.match(
    String((canJoinParty({ currentPartyId: null, targetStatus: 'disbanded', size: 1 }) as { reason?: string }).reason),
    /已经解散/,
  );
  assert.match(
    String(
      (canJoinParty({ currentPartyId: null, targetStatus: 'active', size: NUMERIC.party.maxMembers }) as { reason?: string })
        .reason,
    ),
    /队伍已满/,
  );
  assert.match(String((canLeaveParty(null) as { reason?: string }).reason), /不在任何队伍/);
});

test('.队伍 创建 / 加入 / 离开：上限 4 人，队长离开即解散', async () => {
  const h = createHarness();
  await h.createCharacter(A, '克莱恩');
  await h.createCharacter(B, '正义', 'warrior');
  const c = await h.createCharacter(C, '阿尔杰', 'sleepless');
  const d = await h.createCharacter(D, '戴里克', 'seer');
  await h.createCharacter(E, '佛尔思', 'seer');

  h.advance(11_000);
  const created = await h.send({ rawText: '.队伍 创建', userId: A });
  const partyId = /队伍 ([A-F0-9]{6})/.exec(created[0]?.text ?? '')?.[1];
  assert.ok(partyId, `创建回执应带队伍号：${created[0]?.text}`);
  assert.equal(h.repos.parties.count(), 1);

  // 已在队伍里的队长不能再建一个
  h.advance(11_000);
  assert.match((await h.send({ rawText: '.队伍 创建', userId: A }))[0]?.text ?? '', /已经在一个队伍里/);

  // 用队长 QQ 加入
  h.advance(11_000);
  const joined = await h.send({ rawText: `.队伍 加入 @${A}`, userId: B });
  assert.match(joined[0]?.text ?? '', /你加入了队伍/);
  assert.equal(joined[1]?.targetId, A, '队长会收到私聊通知');

  // 用队伍号加入
  h.advance(11_000);
  await h.send({ rawText: `.队伍 加入 ${partyId}`, userId: C });
  h.advance(11_000);
  await h.send({ rawText: `.队伍 加入 ${partyId}`, userId: D });
  assert.equal(h.repos.parties.sizeOf(partyId!), NUMERIC.party.maxMembers);

  // 第 5 个人被拒
  h.advance(11_000);
  assert.match((await h.send({ rawText: `.队伍 加入 ${partyId}`, userId: E }))[0]?.text ?? '', /队伍已满/);

  // 成员离开
  h.advance(11_000);
  const left = await h.send({ rawText: '.队伍 离开', userId: B });
  assert.match(left[0]?.text ?? '', /你离开了队伍/);
  assert.equal(h.repos.parties.sizeOf(partyId!), 3);

  // 队长离开 → 解散 + 通知其余成员
  h.advance(11_000);
  const dissolved = await h.send({ rawText: '.队伍 离开', userId: A });
  assert.match(dissolved[0]?.text ?? '', /队伍随之解散/);
  assert.equal(h.repos.parties.get(partyId!)?.status, 'disbanded');
  assert.equal(h.repos.parties.partyOf(c.id), null, '解散后成员不再属于任何队伍');
  assert.equal(dissolved.length, 3, '队长自己 + 通知仍在队的 2 名成员（B 已离开）');
  assert.deepEqual(
    dissolved.slice(1).map((reply) => reply.targetId).sort(),
    [C, D].sort(),
  );
  h.app.close();
});

test('组队卡：party:size>=2 条件通过后才进入抽取池', () => {
  const { cards } = loadCards();
  const engine = new EventEngine(cards);
  const date = '2026-09-21';
  const base = { date, types: ['random' as const] };

  // 两张组队卡同时带地点限制：老码头 / 墓园小径
  const atDock = { ...base, location: '老码头' };
  const atGraveyard = { ...base, location: '墓园小径' };

  const solo = engine.eligible({ character: makeState(), flags: new Set(), date, partySize: 1 }, atDock);
  const paired = engine.eligible({ character: makeState(), flags: new Set(), date, partySize: 2 }, atDock);
  const pairedGraveyard = engine.eligible(
    { character: makeState(), flags: new Set(), date, partySize: 2 },
    atGraveyard,
  );

  assert.ok(!solo.some((card) => card.id === 'random_007'), '单人时组队卡不可触发');
  assert.ok(paired.some((card) => card.id === 'random_007'), '两人时组队卡进入池子');
  assert.ok(pairedGraveyard.some((card) => card.id === 'random_008'));
  assert.ok(
    !engine
      .eligible({ character: makeState(), flags: new Set(), date, partySize: 1 }, atGraveyard)
      .some((card) => card.id === 'random_008'),
    '单人时另一张组队卡同样不可触发',
  );
});

test('组队卡的 cond 已从社交 flag 换成 party:size>=2', () => {
  const { cards } = loadCards();
  for (const id of ['random_007', 'random_008']) {
    const card = cards.find((candidate) => candidate.id === id)!;
    assert.deepEqual(card.trigger.cond, ['party:size>=2']);
  }
});

test('partySizeOf：不在队伍里按 1 计', async () => {
  const h = createHarness();
  const a = await h.createCharacter(A, '克莱恩');
  assert.equal(h.repos.parties.partySizeOf(a.id), 1);
  h.repos.parties.create(a.id, h.now());
  assert.equal(h.repos.parties.partySizeOf(a.id), 1, '只有队长一人时规模为 1');
  const b = await h.createCharacter(B, '正义', 'warrior');
  const party = h.repos.parties.partyOf(a.id)!;
  h.repos.parties.addMember(party.id, b.id, h.now());
  assert.equal(h.repos.parties.partySizeOf(a.id), 2);
  assert.equal(h.repos.parties.partySizeOf(b.id), 2);
  h.app.close();
});
