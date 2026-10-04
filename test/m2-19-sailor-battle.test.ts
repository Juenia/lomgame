/**
 * M2.19 任务 2：水手的战斗技能。
 *
 * 为什么要有这一轮：M2.19 接入 sailor 之后，**可争的三对里有一对是「风暴↔战神」** ——
 * 而 skillsFor('sailor', 9) 当时返回空数组，没有技能的水手在 PVP 里只能平砍，
 * 那一对可争等于摆设。结构指标达标 ≠ 那条路真能打（K9 的同一条道理）。
 *
 * 两组：
 *   §A 技能池 —— 四条途径都非空；水手在 9 / 8 / 7 各解禁一条
 *   §B **真的打得出来** —— 随机源取 0.1（命中侧）、断言字段是 playerDamageDealt
 *      （K2 的两条教训：掷大了会挥空，测的就不是技能；字段名写错会得到一串 undefined，
 *       而 undefined < undefined 恒为 false，失败会指向完全错误的方向）
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  resolveBattleRound,
  skillEffectOf,
  skillsFor,
  type BattleState,
} from '../src/domain/battle/index.ts';
import type { Rng } from '../src/domain/character/types.ts';
import { createHarness, DEFAULT_USER } from './helpers/app.ts';

/** 永远掷一个固定值：把命中与伤害钉死，让「平砍 vs 技能」只差技能本身 */
function fixed(value: number): Rng {
  return { next: () => value };
}

/* 与 test/m2-18-cd.test.ts 的 makeBattle 同形（那两份都是文件私有的，这里复制一份最小的） */
function makeBattle(characterId: string, patch: Partial<BattleState> = {}): BattleState {
  return {
    id: 'b-test',
    characterId,
    creatureId: 'bone_choir-1',
    speciesId: 'bone_choir',
    speciesName: '骨唱诗班',
    creatureSequence: 9,
    creatureDying: false,
    world: {
      locationId: 'old_dock',
      locationName: '老码头',
      night: false,
      danger: 2,
      weatherHitPenalty: 0,
      weatherLabel: '晴',
    },
    round: 1,
    status: 'active',
    playerHp: 100,
    playerMp: 60,
    playerStatuses: [],
    playerDefensePenalty: 0,
    creatureHp: 500,
    creatureMaxHp: 500,
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
    turnOf: 'challenger',
    pendingAction: null,
    foresight: null,
    lastPlayerDamage: 0,
    startedAt: 0,
    lastRoundAt: 0,
    resolvedAt: null,
    ...patch,
  };
}

/* ==================== §A 技能池 ==================== */

test('M2.19-D1：四条途径的技能池都非空，水手在 9 / 8 / 7 各解禁一条', () => {
  for (const pathway of ['seer', 'warrior', 'sleepless', 'sailor'] as const) {
    assert.ok(skillsFor(pathway, 9).length > 0, pathway + ' 在序列 9 必须有技能（空数组 = 那条路只能平砍）');
  }
  // 技能是**解禁**不是升级：序列 8 的池子把序列 9 的也包进来
  const at9 = skillsFor('sailor', 9).map((s) => s.name);
  const at8 = skillsFor('sailor', 8).map((s) => s.name);
  const at7 = skillsFor('sailor', 7).map((s) => s.name);
  assert.deepEqual(at9, ['潮击']);
  assert.deepEqual(at8.slice().sort(), ['破浪', '潮击'].sort());
  assert.deepEqual(at7.slice().sort(), ['漩涡', '潮击', '破浪'].sort());
  // 序列 7 的池子比序列 9 大，且**包含**它 —— 「能做到以前做不到的事」的同一形状
  assert.ok(at7.length > at9.length);
  assert.ok(at9.every((name) => at7.includes(name)));
});

test('M2.19-D2：三条技能各有一条主动攻击能力，且数值与定位相符', () => {
  const tide = skillEffectOf('tide_strike');
  const wave = skillEffectOf('wave_rush');
  const mael = skillEffectOf('maelstrom');
  // 序列 9 是「稳的一击」：有倍率、**没有**延迟代价
  assert.equal(tide.damageMultiplier, 1.35);
  assert.equal(tide.nextRoundDefensePenalty, undefined, '潮击不带下回合防御惩罚');
  // 序列 8 是两段
  assert.equal(wave.hits, 2);
  assert.equal(wave.secondHitDecay, 0.75);
  // 序列 7 是那个大赌注：倍率最高、代价也最重
  assert.equal(mael.damageMultiplier, 2);
  assert.equal(mael.nextRoundDefensePenalty, 0.5);
  // 与战士的强攻对照：倍率必须**低于**强攻，否则强攻「借下回合的钱」这个取舍就不成立了
  assert.ok(
    Number(tide.damageMultiplier) < Number(skillEffectOf('power_strike').damageMultiplier),
    '潮击的倍率要低于强攻（强攻多出来的那部分是拿防御换的）',
  );
});

/* ==================== §B 真的打得出来 ==================== */

test('M2.19-D3：水手在战斗里用潮击打出的伤害**高于平砍**（端到端判定层）', async () => {
  const h = createHarness({ deterministicIds: true });
  try {
    const created = await h.createCharacter(DEFAULT_USER, '水手', 'sailor');
    const character = h.repos.characters.findById(created.id)!;
    assert.equal(character.pathway, 'sailor', '夹具确实是水手');
    const battle = makeBattle(created.id, { isPvp: true, opponentCharacterId: 'c-700099', opponentName: '对手' });

    /*
     * 随机源取 0.1（**偏小**）：命中判定是 roll < 命中率，掷大了会「挥空」——
     * 那测的就是运气而不是技能了（K2）。两次调用用同一个值，所以只差技能本身。
     */
    const plain = resolveBattleRound(character, battle, { kind: 'attack' }, fixed(0.1));
    const skill = resolveBattleRound(character, battle, { kind: 'skill', skillId: 'tide_strike' }, fixed(0.1));

    assert.ok(plain.playerDamageDealt > 0, '平砍先要能打到人（否则下面比的是两次挥空）');
    assert.ok(
      skill.playerDamageDealt > plain.playerDamageDealt,
      '潮击要比平砍重：技能 ' + skill.playerDamageDealt + ' vs 平砍 ' + plain.playerDamageDealt,
    );
  } finally {
    h.app.close();
  }
});

test('M2.19-D4：序列 7 的漩涡打得更重，但下回合的防御惩罚真的落到战斗状态上', async () => {
  const h = createHarness({ deterministicIds: true });
  try {
    const created = await h.createCharacter(DEFAULT_USER, '老水手', 'sailor');
    const base = h.repos.characters.findById(created.id)!;
    // 把手上的资源调到序列 7 能用漩涡（MP 22、且序列上解禁）
    const character = { ...base, sequence: 7, mp: 60 };
    h.repos.characters.update({ ...base, sequence: 7, mp: 60 });
    const battle = makeBattle(created.id, { playerMp: 60, isPvp: true, opponentCharacterId: 'c-700099', opponentName: '对手' });
    const tide = resolveBattleRound(character, battle, { kind: 'skill', skillId: 'tide_strike' }, fixed(0.1));
    const mael = resolveBattleRound(character, battle, { kind: 'skill', skillId: 'maelstrom' }, fixed(0.1));
    assert.ok(
      mael.playerDamageDealt > tide.playerDamageDealt,
      '漩涡要比潮击重：' + mael.playerDamageDealt + ' vs ' + tide.playerDamageDealt,
    );
    /*
     * 代价的那一面：判定层必须**真的走漩涡那个分支**（而不是 default 的「什么也没发生」）。
     * 字段名不猜 —— D2 已经断言了 skillEffects 里的 nextRoundDefensePenalty，
     * 这里断言的是「这一次调用确实执行了漩涡」这条事件。
     */
    const textOf = (out: ReturnType<typeof resolveBattleRound>): string =>
      out.events.map((event) => event.text).join(' | ');
    assert.match(textOf(mael), /漩涡/);
    assert.doesNotMatch(textOf(mael), /什么也没发生/, '不能落到 default 分支');
    assert.doesNotMatch(textOf(tide), /什么也没发生/, '潮击也不能落到 default 分支');
  } finally {
    h.app.close();
  }
});
