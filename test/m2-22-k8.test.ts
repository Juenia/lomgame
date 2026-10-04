/**
 * M2.22 任务 5（K8）端到端：**DIG 的写入口必须全量落库**。
 *
 * K8 的原始描述是「DIG 会被不落 `dig_delta` 的路径改动」。
 * 本轮把「不落」的那一处找出来了：`pvp-hooks.ts` 的 **PVP 等待分支**
 * （先出招的一方只记动作、不结算的那一支）—— 它 `update` 了状态却**没有 `appendEvents`**。
 *
 * ⚠️ 症状的形状值得记住：**末值对得上，链断了。**
 * 末值之所以对得上，是因为下一次 PVP 结算会把 `before` 读成当前真实值 ——
 * 状态表永远是对的，错的是**事件流中间少了一跳**。
 * 所以「只比末值」的对账（M2.18 的做法）查不出这一类，判据要换成**链完整性**：
 *
 *     后一条.payload.before === 前一条.payload.after
 *
 * 这两条用例各守一半：第一条守「这一笔落了没有」，第二条守「整条链接不接得上」。
 * 全仓口径的对账脚本是 `scripts/audit-dig.ts`。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BATTLE } from '../src/config/numeric.ts';
import type { DomainEvent } from '../src/domain/character/types.ts';
import { createHarness, type Harness } from './helpers/app.ts';

/** 命运赌注的消化度代价（判定层只记账，角色卡由命令层扣 —— 正是 K8 漏掉的那一笔） */
const DIG_COST = BATTLE.skillEffects.fate_wager.digCost;

async function setUp() {
  const h = createHarness({ deterministicIds: true });
  const a = await h.createCharacter('41001', '甲挑战者', 'seer');
  const b = await h.createCharacter('41002', '乙应战者', 'warrior');
  // 发起者：序列 7（「技能是解禁」的判据是 sequence <= skill.seq）+ 灵力足 + DIG 留余量
  const state = h.repos.characters.findById(a.id)!;
  h.repos.characters.update({ ...state, sequence: 7, mp: 100, dig: 50, status: 'active' });
  return { h, a, b };
}

/** 发一条指令并推进时钟（绕开频控，不绕过指令本身 —— 与 m2-10-pvp.test.ts 同一手法） */
async function send(h: Harness, userId: string, rawText: string) {
  h.advance(11000);
  return h.send({ rawText, userId });
}

const digEvents = (h: Harness, id: string): DomainEvent[] =>
  h.repos.characters.eventsOf(id).filter((event) => event.type === 'dig_delta');

/** 链完整性：逐条验证 before 接得上上一条的 after */
function assertChain(events: DomainEvent[], hint: string): void {
  let previous: number | null = null;
  for (const event of events) {
    const before = Number(event.payload.before);
    const after = Number(event.payload.after);
    if (previous !== null) {
      assert.equal(before, previous, hint + '：第 ' + event.createdAt + ' 条的 before 必须接上一条的 after');
    }
    previous = after;
  }
}

test('M2.22（K8）：PVP 出招等待期间扣的 DIG 要落 dig_delta', async () => {
  const { h, a } = await setUp();
  try {
    const digBefore = h.repos.characters.findById(a.id)!.dig;
    await send(h, a.userId, '.挑战 乙应战者 发起');

    const text = (await send(h, a.userId, '.战斗 技能 命运赌注')).map((m) => m.text).join('\n');
    assert.match(text, /等他/, '这一招应当停在「等他回应」那一支（waiting 分支）');

    // 「此刻」：DIG 真的被扣了
    const digAfter = h.repos.characters.findById(a.id)!.dig;
    assert.equal(digBefore - digAfter, DIG_COST, '命运赌注的代价是 DIG ' + DIG_COST);

    // 「曾经」：这一笔必须落库 —— 补 pvp-hooks 那一行之前，这里是 **0 条**
    const events = digEvents(h, a.id);
    assert.equal(events.length, 1, '等待分支也要落 dig_delta（K8 漏的就是这一条）');
    assert.equal(Number(events[0]!.payload.before), digBefore, 'before 要记的是扣之前的真值');
    assert.equal(Number(events[0]!.payload.after), digAfter, 'after 要等于状态表扣完之后的值');
    assert.equal(Number(events[0]!.payload.delta), -DIG_COST, 'delta 是负数（扣）');
    assert.ok(events[0]!.seed && events[0]!.seed!.length > 0, '判定 seed 进库（铁律 3）');
  } finally {
    h.app.close();
  }
});

test('M2.22（K8）：一整场 PVP 打完，DIG 的事件链逐条相接（不断链）', async () => {
  const { h, a, b } = await setUp();
  try {
    await send(h, a.userId, '.挑战 乙应战者 发起');

    // 发起者用命运赌注（扣 DIG）→ 等待；应战者出招 → 这一回合结算
    await send(h, a.userId, '.战斗 技能 命运赌注');
    await send(h, b.userId, '.战斗 攻击');

    // 再打一个回合，让链上出现不止一跳
    await send(h, a.userId, '.战斗 技能 命运赌注');
    await send(h, b.userId, '.战斗 攻击');

    const events = digEvents(h, a.id);
    assert.ok(events.length >= 2, '两个回合至少两条（等待分支那两笔 + 可能的其它），实际 ' + events.length);
    assertChain(events, '发起者');

    /*
     * 最强的一条：**事件流的末值 = 状态表的值**。
     * 光有它不够（末值对了也可能中间断链），所以要连着 assertChain 一起看。
     */
    const last = events[events.length - 1]!;
    assert.equal(
      Number(last.payload.after),
      h.repos.characters.findById(a.id)!.dig,
      '事件流末值必须等于状态表（K4 的两侧对账）',
    );
  } finally {
    h.app.close();
  }
});
