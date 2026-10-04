import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PARTY_TASKS, checkPartyTask, eligiblePartyTasks, pickPartyTask, partyTaskKey } from '../src/domain/party/task.ts';
import { createSeededRng } from '../src/domain/rng.ts';
import { createHarness } from './helpers/app.ts';

const A = '20001';
const B = '20002';

test('队伍任务：可用任务随人数放开，抽样可复现', () => {
  assert.equal(eligiblePartyTasks(1).length, 0);
  assert.equal(eligiblePartyTasks(2).length, 2, '两人可做前两个任务');
  assert.equal(eligiblePartyTasks(3).length, 3, '三人解锁仪式护法');
  assert.equal(eligiblePartyTasks(4).length, PARTY_TASKS.length);

  const first = pickPartyTask(3, createSeededRng('party-task'));
  const again = pickPartyTask(3, createSeededRng('party-task'));
  assert.deepEqual(first, again);
  assert.equal(pickPartyTask(1, createSeededRng('x')), null);
});

test('队伍任务：只有队长能发起、需要人数、每日 1 次', () => {
  assert.match(
    String((checkPartyTask({ isLeader: false, partyId: 'P', memberCount: 3, usedToday: 0, }) as { reason?: string }).reason),
    /只有队长/,
  );
  assert.match(
    String((checkPartyTask({ isLeader: true, partyId: null, memberCount: 1, usedToday: 0, }) as { reason?: string }).reason),
    /不在任何队伍/,
  );
  assert.match(
    String((checkPartyTask({ isLeader: true, partyId: 'P', memberCount: 1, usedToday: 0, }) as { reason?: string }).reason),
    /至少需要 2 人/,
  );
  assert.match(
    String((checkPartyTask({ isLeader: true, partyId: 'P', memberCount: 2, usedToday: 1, }) as { reason?: string }).reason),
    /今天已经做过/,
  );
  /* M2.85：原来这里还有一段「行动点不足」的拒绝判据 —— 队伍任务不再有行动点门槛 */
  assert.equal(checkPartyTask({ isLeader: true, partyId: 'P', memberCount: 2, usedToday: 0, }).ok, true);
});

test('.队伍 任务：全员分赃、落 party_tasks、每日限一次（M2.85：不再扣行动点）', async () => {
  const h = createHarness();
  const a = await h.createCharacter(A, '克莱恩');
  const b = await h.createCharacter(B, '正义', 'warrior');
  h.advance(11_000);
  await h.send({ rawText: '.队伍 创建', userId: A });
  const party = h.repos.parties.partyOf(a.id)!;
  h.repos.parties.addMember(party.id, b.id, h.now());

  const digBefore = {
    a: h.repos.characters.findById(a.id)!.dig,
    b: h.repos.characters.findById(b.id)!.dig,
  };

  h.advance(11_000);
  const sent = await h.send({ rawText: '.队伍 任务', userId: A, scene: 'group' });
  /*
   * 2 条 = 群回执 + 队员私聊通知（extra 通道，party.ts 里给每个队员发的）。
   * 群聊与私聊合并后，队长那份明细直接落在群里，所以不再是原来的 3 条。
   */
  assert.equal(sent.length, 2, '群回执 + 队员私聊通知');
  assert.equal(sent[0]?.scene, 'group');
  assert.match(sent[0]?.text ?? '', /队伍任务【/);
  assert.match(sent[0]?.text ?? '', /参与成员（2 人）/);

  const stateA = h.repos.characters.findById(a.id)!;
  const stateB = h.repos.characters.findById(b.id)!;
  assert.ok(stateA.dig > digBefore.a && stateB.dig > digBefore.b, '两名成员都要拿到消化度');
  assert.equal(h.repos.inventory.count(a.id, '便士'), h.repos.inventory.count(b.id, '便士'));
  assert.ok(h.repos.inventory.count(a.id, '便士') > 0, '全员分货币');

  const rows = h.app.db.prepare('SELECT task_id, members FROM party_tasks').all() as Array<{
    task_id: string;
    members: number;
  }>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.members, 2);

  assert.equal(h.repos.dailyCounters.countOf(party.leaderId, new Date(h.now() + 8 * 3600 * 1000).toISOString().slice(0, 10), partyTaskKey(party.id)) >= 1, true);

  h.advance(11_000);
  const again = await h.send({ rawText: '.队伍 任务', userId: A });
  assert.match(again[0]?.text ?? '', /今天已经做过队伍任务/);
  h.app.close();
});

test('.队伍 任务：非队长发起被拒，独狼被拒', async () => {
  const h = createHarness();
  const a = await h.createCharacter(A, '克莱恩');
  const b = await h.createCharacter(B, '正义', 'warrior');
  h.advance(11_000);
  await h.send({ rawText: '.队伍 创建', userId: A });
  const party = h.repos.parties.partyOf(a.id)!;
  h.repos.parties.addMember(party.id, b.id, h.now());

  h.advance(11_000);
  assert.match((await h.send({ rawText: '.队伍 任务', userId: B }))[0]?.text ?? '', /只有队长/);

  const c = await h.createCharacter('20003', '阿尔杰', 'sleepless');
  h.advance(11_000);
  await h.send({ rawText: '.队伍 创建', userId: '20003' });
  h.advance(11_000);
  assert.match((await h.send({ rawText: '.队伍 任务', userId: '20003' }))[0]?.text ?? '', /至少需要 2 人/);
  h.app.close();
});
