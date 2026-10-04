/**
 * M2.26 任务 1.5：**技能「生效」而不只是「被选」** —— 断言到伤害字段。
 *
 * ## 为什么要有这一条（与 §任务 1 那条的分工）
 *
 * `test/m2-26-steam-battle.test.ts` 断言的是 `battles.pendingAction.skillId` ——
 * 那证明「**指令被解析成了这条技能**」，但**不证明它打出了伤害**：
 * 判定层的 `switch (skill.id)` 里没有这个 case 时，动作照样被暂存、灵力照样扣，
 * 只是结算时落到 `default`（M2.19 给 sailor 补技能时踩的正是这个形状）。
 *
 * 这一条把链路走完：**双方都出招 → 回合结算 → 读伤害字段**。
 *
 * ## 字段名与随机源（K2 的两条教训，都踩过）
 *
 * · 字段是 **`challengerDamageDealt` / `opponentDamageDealt`**（在 `pvp_round` 事件的 payload 里），
 *   **不是** `hit` / `damage` —— 猜字段名会得到一串 `undefined`，
 *   而 `undefined > 0` 恒为 false，断言会以「方向不对」的样子失败、指向完全错误的方向。
 * · **命中是概率的**（`roll < 命中率`）。harness 的 rng 由 messageId + seed 派生、**不可注入**，
 *   所以这一条**不能只打一个回合**：它循环若干个回合，
 *   断言「**至少有一个回合真的打出了伤害**」（几个回合全不中的概率极低）。
 *
 * 照抄给后两批：知识、母神各一条，把 `skillName` 换掉即可。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DomainEvent } from '../src/domain/character/types.ts';
import { createHarness, type Harness } from './helpers/app.ts';

/** 每次发指令推进 31 分钟（`.挑战` 有 30 分钟冷却） */
async function send(h: Harness, userId: string, rawText: string) {
  h.advance(31 * 60 * 1000);
  return h.send({ rawText, userId });
}

/** 从 `pvp_round` 事件里读双方伤害（字段名见文件头 —— **不是** hit / damage） */
function damages(h: Harness, characterId: string): Array<{ mine: number; theirs: number }> {
  const events: DomainEvent[] = h.repos.characters.eventsOf(characterId);
  return events
    .filter((event) => event.type === 'pvp_round')
    .map((event) => ({
      mine: Number(event.payload.challengerDamageDealt ?? 0),
      theirs: Number(event.payload.opponentDamageDealt ?? 0),
    }));
}

test('M2.26 任务 1.5：完美者的技能**真的打得出伤害**（结算后的伤害字段 > 0）', async () => {
  const h = createHarness({ deterministicIds: true });
  try {
    const a = await h.createCharacter('43001', '甲工匠', 'perfect');
    const b = await h.createCharacter('43002', '乙陪练', 'warrior');
    const state = h.repos.characters.findById(a.id)!;
    h.repos.characters.update({ ...state, sequence: 7, mp: 100, hp: 100, status: 'active' });
    const foe = h.repos.characters.findById(b.id)!;
    // 陪练：血厚、不还手（把「对手先倒下」这个干扰项压到最低）
    h.repos.characters.update({ ...foe, mp: 100, hp: 100, status: 'active' });
    h.repos.flags.set(a.id, 'loc', h.now(), 'tingen_center');
    h.repos.flags.set(b.id, 'loc', h.now(), 'tingen_center');

    await send(h, a.userId, '.挑战 乙陪练 发起');

    /*
     * 打若干个回合：**每个回合都要双方各出一个动作才会结算**。
     * 发起者用技能（序列 9 的精准打击），陪练用防御（不还手、也不打断）。
     */
    let rounds = 0;
    for (let i = 0; i < 8; i += 1) {
      const attacker = h.repos.characters.findById(a.id)!;
      h.repos.characters.update({ ...attacker, mp: 100, hp: 100, status: 'active' });
      const defender = h.repos.characters.findById(b.id)!;
      h.repos.characters.update({ ...defender, mp: 100, hp: 100, status: 'active' });

      const mine = h.repos.battles.activeOf(a.id);
      if (!mine) break; // 打完了（对方倒下 / 脱战）
      await send(h, a.userId, '.战斗 技能 精准打击');
      const his = h.repos.battles.activeOf(b.id);
      if (!his) break;
      await send(h, b.userId, '.战斗 防御');
      rounds += 1;
    }

    const rows = damages(h, a.id);
    assert.ok(rounds > 0, '至少要打完一个回合（双方各出一个动作才结算）');
    assert.ok(rows.length > 0, '结算过就应当有 pvp_round 事件');

    const total = rows.reduce((sum, row) => sum + row.mine, 0);
    /*
     * 断言：**至少有一个回合真的造成了伤害**。
     * 只打一个回合会 flaky（命中是概率的），所以这里循环若干回合、断言总量 > 0 ——
     * 几个回合全部落空的概率极低。
     */
    assert.ok(
      rows.some((row) => row.mine > 0),
      '完美者的技能必须真的打得出伤害（读了 ' + rows.length + ' 个回合，伤害合计 ' + total + '）' +
        ' —— 为 0 说明判定层那条 case 没走到，而不是「运气不好」',
    );
  } finally {
    h.app.close();
  }
});
