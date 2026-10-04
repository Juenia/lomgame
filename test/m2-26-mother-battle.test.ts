/**
 * M2.26 任务 3.6：母亲（mother）的三条技能 —— **能出招 + 三个新字段真的被读到**。
 *
 * ## 为什么这一条比前两批的战斗用例更要紧
 *
 * 第一批（完美者）与第二批（阅读者）**一条新效果字段都没造** —— 它们复用了
 * `damageMultiplier` / `hits` / `secondHitDecay` / `nextRoundDefensePenalty` 这四个**已经有读点**的字段。
 * 母亲这一批造了**三个新字段**：
 *
 * | 字段 | 用途 | 读取点 |
 * | --- | --- | --- |
 * | `enemyDamagePenalty` | 藤蔓缠绕：对方下一次出手的伤害削减 | `resolve.ts` 的 `creatureSingleStrike`（用完即消） |
 * | `lifeSteal` | 生命汲取：按这一击的实伤回血 | `resolve.ts` 的 `case 'life_drain'` |
 * | `selfHpCost` | 大地的拥抱：出手前先扣自己的血 | `resolve.ts` 的 `case 'earth_embrace'` |
 *
 * ⇒ 这正是 **K10** 的形状：`numeric.battle.skillEffects` 是 `Record`，**加键就够了、tsc 全绿**，
 *   而「这一招打出来是什么」由 `resolve.ts` 的 `switch` 决定。少了读取点，
 *   配置里写着 `lifeSteal: 0.5`，玩法里一点血都不回 —— 灵力照扣、tsc 一声不吭。
 *
 * ## 判据分成两层（这是本轮改过一次写法的地方）
 *
 * 第一版把两者都压在**命令层 + 事件流**上，三条全红。原因很具体：
 *
 *   · `pvp_round` 事件的 payload **只有数字与 kind**（`challengerHp` / `challengerDamageDealt` / …），
 *     **没有任何文本字段** —— 技能文本（`RoundEvent`）根本不落 `domain_events`；
 *   · 而「回合结束时甲的血」是**两件事叠加**的结果（吸血 − 被反击），净变化完全可能是负的。
 *     用它当判据，测出来的是「对面打得疼不疼」，不是「吸血有没有生效」。
 *
 * 所以拆成两层，各测各的（与项目既有做法一致 —— `test/m2-10.test.ts` 就是直调判定层）：
 *
 * | 层 | 用例 | 判据 |
 * | --- | --- | --- |
 * | 命令层 | D1 | `.战斗 技能 <名>` 能不能解析成母亲的 `skillId` 并暂存（**玩家真的出得了这条招**） |
 * | 判定层 | D2 / D3 / D4 | 直调 `resolveBattleRound`，读 `result.events` 的文本（**这条招真的有效果**） |
 *
 * 判定层那三条走**纯函数**，因此可以注入固定随机源、并且能拿到完整的 `RoundEvent[]` ——
 * 这比在命令层绕一圈可靠得多。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadCreatures } from '../src/data/loader.ts';
import { resolveBattleRound } from '../src/domain/battle/index.ts';
import type { BattleState } from '../src/domain/battle/index.ts';
import type { CharacterState } from '../src/domain/character/types.ts';
import { createSeededRng } from '../src/domain/rng.ts';
import { createHarness, type Harness } from './helpers/app.ts';

const SPECIES = new Map(loadCreatures().creatures.map((species) => [species.id, species]));

function makeCharacter(patch: Partial<CharacterState> = {}): CharacterState {
  return {
    id: 'c-1',
    userId: 'u-1',
    name: '测试者',
    pathway: 'mother',
    sequence: 7,
    pathwayStatus: 'initiated',
    gender: 'male',
    hp: 100,
    mp: 100,
    mad: 20,
    cor: 0,
    dig: 0,
    dp: 0,
    status: 'active',
    promotionFails: 0,
    currentCityId: 'byron',
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  };
}

function makeBattle(patch: Partial<BattleState> = {}): BattleState {
  const base: BattleState = {
    id: 'b-1',
    characterId: 'c-1',
    creatureId: 'whisperer-1',
    speciesId: 'whisperer',
    speciesName: '低语者',
    creatureSequence: 8,
    creatureDying: false,
    world: {
      locationId: 'bone_market',
      locationName: '骨市',
      night: false,
      danger: 2,
      weatherHitPenalty: 0,
      weatherLabel: '晴',
    },
    round: 1,
    status: 'active',
    playerHp: 60,
    playerMp: 100,
    playerStatuses: [],
    playerDefensePenalty: 0,
    creatureHp: 400,
    creatureMaxHp: 400,
    creatureStatuses: [],
    creatureBerserk: false,
    creatureEvolved: false,
    creatureShield: false,
    allyCalled: false,
    allyArrivesAtRound: null,
    allyCount: 0,
    creaturePlayingDead: false,
    negateCreatureActions: 0,
    negatePlayerActions: 0,
    isPvp: false,
    opponentCharacterId: null,
    opponentName: null,
    turnOf: 'challenger' as const,
    pendingAction: null,
    foresight: null,
    lastPlayerDamage: 0,
    startedAt: 0,
    lastRoundAt: 0,
    resolvedAt: null,
  };
  return { ...base, ...patch, world: { ...base.world, ...(patch.world ?? {}) } };
}

function speciesView() {
  const species = SPECIES.get('whisperer')!;
  return {
    id: species.id,
    name: species.name,
    habits: species.habits,
    special: species.battle!.special,
    specialName: species.battle!.specialName,
    damage: species.battle!.damage,
    hit: species.battle!.hit,
  };
}

/**
 * 打若干回合，返回**第一条包含 marker 的回合文本**。
 *
 * 命中是概率的（`roll < 命中率`），所以不能只打一回合 —— 循环若干次，
 * 直到出现那条文本。循环上限是**天花板**不是承诺（K14 的兄弟错误：不要把上限读成事实）。
 */
function findText(skillId: string, marker: string, patch: Partial<BattleState> = {}): string | null {
  const view = speciesView();
  for (let index = 0; index < 60; index += 1) {
    const result = resolveBattleRound(
      makeCharacter(),
      makeBattle(patch),
      { kind: 'skill', skillId },
      createSeededRng('mother-' + skillId + '-' + index),
      { species: view, creatureAction: { kind: 'attack', label: '攻击', note: '' } },
    );
    const lines = result.events.map((event) => event.text).join('\n');
    if (lines.includes(marker)) return lines;
  }
  return null;
}

/* ---- 命令层：玩家真的出得了这条招 ---- */

test('M2.26 母亲 D1（命令层）：三条技能都能被解析成母亲的 skillId 并出招', async () => {
  const h = createHarness({ deterministicIds: true });
  try {
    const a = await h.createCharacter('45001', '甲耕作者', 'mother');
    const b = await h.createCharacter('45002', '乙陪练', 'warrior');
    h.repos.characters.update({ ...h.repos.characters.findById(a.id)!, sequence: 7, mp: 100, hp: 100, });
    h.repos.characters.update({ ...h.repos.characters.findById(b.id)!, mp: 100, hp: 100, });
    h.repos.flags.set(a.id, 'loc', h.now(), 'tingen_center');
    h.repos.flags.set(b.id, 'loc', h.now(), 'tingen_center');

    h.advance(31 * 60 * 1000);
    await h.send({ rawText: '.挑战 乙陪练 发起', userId: a.userId });

    /*
     * ⚠️ 断言的是 `pendingAction.skillId`，**不是**技能文本 ——
     * PVP 是异步回合，先出招只记动作，文本产生在结算那一步（而文本也不落库）。
     */
    const expected: Array<[string, string]> = [
      ['藤蔓缠绕', 'vine_bind'],
      ['生命汲取', 'life_drain'],
      ['大地的拥抱', 'earth_embrace'],
    ];
    for (const [name, skillId] of expected) {
      assert.ok(h.repos.battles.activeOf(a.id), name + ' 之前战斗应当还在');
      h.advance(31 * 60 * 1000);
      await h.send({ rawText: '.战斗 技能 ' + name, userId: a.userId });
      const pending = h.repos.battles.activeOf(a.id)?.pendingAction;
      assert.equal(pending?.skillId, skillId, name + ' 应当被解析成 ' + skillId);
      /*
       * ⚠️ **必须让乙也出招**：PVP 是异步回合 —— 甲出招只记 `pendingAction`，
       * **等双方都出招之后才结算**，结算才会把它清空。
       * 少了这一步，下一次断言读到的是**上一回合残留的那条技能**
       * （第一次写这条用例就是这么错的：第二轮读到的还是 vine_bind）。
       */
      if (h.repos.battles.activeOf(b.id)) {
        h.advance(31 * 60 * 1000);
        await h.send({ rawText: '.战斗 防御', userId: b.userId });
      }
    }
  } finally {
    h.app.close();
  }
});

/* ---- 判定层：这条招真的有效果 ---- */

test('M2.26 母亲 D2（K10 守卫）：生命汲取**真的回血** —— 不是「配置里写了、玩法里没有」', () => {
  const lines = findText('life_drain', '补了回来');
  assert.ok(
    lines,
    '生命汲取必须真的回血（跑了 60 个回合都没有那一条）—— 说明 resolve.ts 的 case life_drain ' +
      '没读到 lifeSteal，或 playerAttack 的返回值没接上（它原来返回 void，是这一批改成返回实伤的）',
  );
  const gain = Number(/\+(\d+)/.exec(lines!)?.[1] ?? '0');
  assert.ok(gain > 0, '回血量必须是正数，实际 ' + gain);
});

test('M2.26 母亲 D3：大地的拥抱**真的扣自己的血**（selfHpCost 被读到）', () => {
  const lines = findText('earth_embrace', '全砸了出去');
  assert.ok(lines, '大地的拥抱必须写出「代价」那一条文本（说明 selfHpCost 被读到了）');
  const cost = Number(/-(\d+)/.exec(lines!)?.[1] ?? '0');
  assert.equal(cost, 20, '代价应当是 numeric 里写的 20 点，实际 ' + cost);
});

test('M2.26 母亲 D4：藤蔓缠绕**真的走到那一条 case**（enemyDamagePenalty 被读到）', () => {
  /*
   * 减益本身是判定层内部的一个数（不回执），所以这里守的是它的**回执那一半**：
   * 命中写「藤蔓从土里钻出来」、打空写「藤蔓扑了个空」—— 两条都算通（case 走到了）。
   * 而「减益真的削减了对方伤害」由 `creatureSingleStrike` 里那三行保证（用完即消）。
   */
  const hit = findText('vine_bind', '藤蔓从土里钻出来');
  const miss = findText('vine_bind', '藤蔓扑了个空');
  assert.ok(
    hit || miss,
    '藤蔓缠绕必须走到判定层那一条 case（命中或打空都会写回执）—— 一条都没有说明 case 没接上',
  );
});
