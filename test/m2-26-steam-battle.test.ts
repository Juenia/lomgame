/**
 * M2.26 第一批端到端：**完美者（perfect）的技能真的能被解析并出招**。
 *
 * ## 这一条测什么、不测什么（读之前先看这段）
 *
 * **测**：指令面 → 判定层的**技能 id 通路**。`.战斗 技能 <名>` 能不能被解析成
 * 完美者的那三条 `skillId`，并被暂存进 `battles.pendingAction`。
 *
 * **不测**：伤害数值 —— 那是随机命中决定的，测出来的是运气（K2 的教训：
 * 「测战斗时随机源选错侧 → 测的不是加成，是运气」）。
 *
 * ## 为什么 PVP 里「出招」不等于「生效」
 *
 * PVP 是**异步回合**：先出招的一方只记下动作（`outcome.kind === 'waiting'`），
 * **等对方也出招之后才一起结算** —— 技能文本（「你把它校到零位」）产生在**结算**那一步。
 * 所以一条「出招后立刻断言技能文本」的用例是**测错了位置**（本轮第一次写就是这么错的）。
 *
 * ## 为什么必须有这一条（K10 的处置）
 *
 * `numeric.battle.skills` 与 `skillEffects` 都是 `Record` —— **加键就够了、tsc 全绿**，
 * 而决定「这一招打出来是什么」的是 `resolve.ts` 的 `switch (skill.id)`。
 * M2.19 补 `sailor` 时正是这么踩的：**灵力照扣、回执说「什么也没发生」、伤害 0、tsc 一声不吭**。
 * 下面这条守的正是「**id 通路接上了**」这一半；另一半（分支里的效果）由
 * `docs/M2.26-蒸汽实现.md` §验收 登记为遗留 —— 它需要**回合结算**才能观测到。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHarness, type Harness } from './helpers/app.ts';

/*
 * 每次发指令推进 **31 分钟**：`.挑战` 有 30 分钟冷却（NUMERIC.battle.pvp.challengeCooldownMs），
 * 而这条用例要在同一条用例里对**同一个人**发起多次挑战 —— 推 11 秒会在第二轮撞上
 * 「你刚找过他 —— 再过 30 分钟」（这是本轮写测试时实际踩到的）。
 */
async function send(h: Harness, userId: string, rawText: string) {
  h.advance(31 * 60 * 1000);
  return h.send({ rawText, userId });
}

async function setUp() {
  const h = createHarness({ deterministicIds: true });
  const a = await h.createCharacter('42001', '甲工匠', 'perfect');
  const b = await h.createCharacter('42002', '乙战士', 'warrior');
  const state = h.repos.characters.findById(a.id)!;
  h.repos.characters.update({ ...state, sequence: 7, mp: 100, hp: 100, status: 'active' });
  const foe = h.repos.characters.findById(b.id)!;
  h.repos.characters.update({ ...foe, mp: 100, hp: 100, status: 'active' });
  /*
   * ⚠️ 两人必须**同地点** —— 那是 `.挑战` 的入口条件（跨地点直接拒）。
   * 出生城市由 userId 派生，两个人的 userId 不同、城市就可能不同，
   * 所以这里显式把两个人放到同一个地点（与 m2-10-pvp.test.ts 的
   * 「跨地点明确拒绝」用例同一手法，只是方向相反）。
   */
  h.repos.flags.set(a.id, 'loc', h.now(), 'tingen_center');
  h.repos.flags.set(b.id, 'loc', h.now(), 'tingen_center');
  return { h, a, b };
}

test('M2.26 蒸汽：三条技能都能被解析成完美者的 skillId 并出招', async () => {
  const { h, a } = await setUp();
  try {
    for (const [name, id] of [
      ['精准打击', 'precise_strike'],
      ['连环校准', 'chain_calibration'],
      ['过载', 'overload'],
    ] as const) {
      // 先确认建号拿到的途径确实是 perfect（出生城市不支持时会被校正成别的）
      assert.equal(h.repos.characters.findById(a.id)!.pathway, 'perfect', '甲工匠必须是完美者途径');

      const text = (await send(h, a.userId, '.挑战 乙战士 发起')).map((m) => m.text).join('\n');
      assert.match(text, /你先动了手/, '挑战要能发起（失败的话回执会说原因）');

      const out = (await send(h, a.userId, '.战斗 技能 ' + name)).map((m) => m.text).join('\n');
      assert.doesNotMatch(out, /没有这个技能|不是你那条途径|用不了/, '「' + name + '」必须是一条可用技能');
      assert.doesNotMatch(out, /什么也没发生/, '「' + name + '」不该落到 default 分支');

      // 出招之后：动作被暂存，且暂存的**就是这条技能**（这就是 id 通路接上的证据）
      const battle = h.repos.battles.activeOf(a.id)!;
      assert.ok(battle.pendingAction, '出招后动作要被暂存（PVP 是异步回合）');
      assert.equal(battle.pendingAction!.kind, 'skill', '暂存的应当是一个技能动作');
      assert.equal(battle.pendingAction!.skillId, id, '暂存的 skillId 必须是「' + name + '」');

      await send(h, a.userId, '.战斗 认输'); // 收尾，让下一轮能重新发起
    }
  } finally {
    h.app.close();
  }
});

test('M2.26 蒸汽：序列 9 的玩家也有可用的起手技（这一条不能省）', async () => {
  const h = createHarness({ deterministicIds: true });
  try {
    const a = await h.createCharacter('42101', '新手工匠', 'perfect');
    const b = await h.createCharacter('42102', '陪练', 'warrior');
    const state = h.repos.characters.findById(a.id)!;
    h.repos.characters.update({ ...state, sequence: 9, mp: 100, hp: 100, status: 'active' });
    const foe = h.repos.characters.findById(b.id)!;
    h.repos.characters.update({ ...foe, mp: 100, hp: 100, status: 'active' });
    h.repos.flags.set(a.id, 'loc', h.now(), 'tingen_center');
    h.repos.flags.set(b.id, 'loc', h.now(), 'tingen_center');

    await send(h, a.userId, '.挑战 陪练 发起');
    await send(h, a.userId, '.战斗 技能 精准打击');
    const battle = h.repos.battles.activeOf(a.id)!;
    assert.equal(battle.pendingAction?.skillId, 'precise_strike', '序列 9 的完美者必须有一条能出招的技能');

    // 反例：序列 9 用不了序列 7 的那条（「技能是解禁，不是升级」）
    const refused = (await send(h, a.userId, '.战斗 技能 过载')).map((m) => m.text).join('\n');
    assert.match(refused, /还没轮到你|用不了|序列 7/, '序列 9 不该能用序列 7 的技能');
  } finally {
    h.app.close();
  }
});
