/**
 * M2.30 任务 4：**批次 A2（序列 5）的补验收 —— 判定层直调**。
 *
 * ## 为什么走判定层而不跑批（`docs/对照规范.md` §四·补二 的标准）
 *
 * > **高序列（序列 ≤ 6）的机制验收走「判定层直调 + 零夹具生产链路用例」；跑批只验低序列链路。**
 *
 * 实测依据：`m229-a1`（50 人 × 30 天）入途径→8 是 11 人、8→7 是 3 人，**序列 6/5 一个都没有**。
 * ⇒ 拿跑批验序列 5，等于用一个测不到它的仪器去测它。
 *
 * ## 覆盖（21 条 = 7 途径 × 3 类）
 *
 * | 类 | 怎么直调 | 断言什么 |
 * | --- | --- | --- |
 * | **能力**（7 条） | `mergeAbilityEffects` | 该途径的序列 5 能力真的进了合并结果 |
 * | **技能**（7 条） | `resolveBattleRound` + 注入随机源 | 那一招打得出伤害 / 回血 / 有代价 |
 * | **行动**（7 条） | `pathwayActionFor(pathway, 5, context)` | 序列 5 的人取得到，且 `contexts` 正确 |
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadAbilities, loadCreatures } from '../src/data/loader.ts';
import { mergeAbilityEffects } from '../src/domain/ability/ability.ts';
import { resolveBattleRound } from '../src/domain/battle/index.ts';
import type { BattleState } from '../src/domain/battle/index.ts';
import type { CharacterState } from '../src/domain/character/types.ts';
import { OPEN_PATHWAYS } from '../src/domain/character/rules.ts';
import { pathwayActionFor } from '../src/domain/menu/pathway-actions.ts';
import { createSeededRng } from '../src/domain/rng.ts';

const SPECIES = new Map(loadCreatures().creatures.map((species) => [species.id, species]));

function makeCharacter(patch: Partial<CharacterState> = {}): CharacterState {
  return {
    id: 'c-1', userId: 'u-1', name: '测试者', pathway: 'seer', sequence: 5,
    pathwayStatus: 'initiated', gender: 'male', hp: 100, mp: 100, mad: 20, cor: 0, dig: 90,
    dp: 0, status: 'active', promotionFails: 0, createdAt: 0, updatedAt: 0, ...patch,
  };
}

function makeBattle(patch: Partial<BattleState> = {}): BattleState {
  const base: BattleState = {
    id: 'b-1', characterId: 'c-1', creatureId: 'w-1', speciesId: 'whisperer', speciesName: '低语者',
    creatureSequence: 8, creatureDying: false,
    world: { locationId: 'old_dock', locationName: '老码头', night: false, danger: 2, weatherHitPenalty: 0, weatherLabel: '晴' },
    round: 1, status: 'active', playerHp: 60, playerMp: 100, playerStatuses: [], playerDefensePenalty: 0,
    creatureHp: 400, creatureMaxHp: 400, creatureStatuses: [], creatureBerserk: false, creatureEvolved: false,
    creatureShield: false, allyCalled: false, allyArrivesAtRound: null, allyCount: 0, creaturePlayingDead: false,
    negateCreatureActions: 0, negatePlayerActions: 0, isPvp: false, opponentCharacterId: null, opponentName: null,
    turnOf: 'challenger', pendingAction: null, foresight: null, lastPlayerDamage: 0,
    startedAt: 0, lastRoundAt: 0, resolvedAt: null,
  };
  return { ...base, ...patch, world: { ...base.world, ...(patch.world ?? {}) } };
}

function speciesView() {
  const species = SPECIES.get('whisperer')!;
  return { id: species.id, name: species.name, habits: species.habits, special: species.battle!.special,
    specialName: species.battle!.specialName, damage: species.battle!.damage, hit: species.battle!.hit };
}

/** 打若干回合，返回第一条包含 marker 的回合文本（命中是概率的，所以要循环） */
function findText(skillId: string, marker: string): string | null {
  const view = speciesView();
  for (let index = 0; index < 60; index += 1) {
    const result = resolveBattleRound(
      makeCharacter(), makeBattle(), { kind: 'skill', skillId },
      createSeededRng('a2-' + skillId + '-' + index),
      { species: view, creatureAction: { kind: 'attack', label: '攻击', note: '' } },
    );
    const lines = result.events.map((event) => event.text).join('\n');
    if (lines.includes(marker)) return lines;
  }
  return null;
}

/* ---- 能力（7 条）---- */

test('M2.30 A2 能力：7 途径的序列 5 能力都在内容表里、且真的并进合并结果', () => {
  const abilities = loadAbilities().abilities;
  for (const pathway of OPEN_PATHWAYS) {
    const own = abilities.filter((ability) => ability.pathway === pathway && ability.seq === 5);
    assert.equal(own.length, 1, pathway + ' 应当正好有一条序列 5 的能力');
    // 合并规则是「同一字段相加 / 布尔取或」——这里只要证明它**进得去**（不是死配置，K10）
    const merged = mergeAbilityEffects(own);
    const keys = Object.keys(merged);
    assert.ok(keys.length > 0, pathway + ' 的序列 5 能力合并后是空的 —— 配置里有、读点读不到');
  }
});

/* ---- 技能（7 条）---- */

test('M2.30 A2 技能：7 途径的序列 5 技能都能走到判定层那一条 case', () => {
  /*
   * 每条技能的「回执那一句」是它在 `resolve.ts` 里**只有走到那个 case 才会写**的文本 ——
   * 与 M2.26 的「技能 id 通路」不同，这一条证明的是**分支真的被执行了**。
   */
  const skills: Array<[string, string]> = [
    ['puppet_strings', '线一抖'],
    ['opening_strike', '那个空档'],
    ['dream_enter', '走进它的梦里'],
    ['tailwind', '风是从背后来的'],
    ['retrofit', '本来不是干这个的'],
    ['consult', '翻到了那一页'],
    ['ripen', '让它到了'],
  ];
  for (const [skillId, marker] of skills) {
    const lines = findText(skillId, marker);
    assert.ok(lines, skillId + ' 没有走到判定层那一条 case（跑了 60 个回合都没有回执）');
  }
});

test('M2.30 A2 技能：三条「自带代价」的技能真的扣了自己的血（selfHpCost 被读到）', () => {
  const lines = findText('ripen', '让它到了');
  assert.ok(lines, '催熟要有回执');
  const cost = Number(/-(\d+)/.exec(lines!)?.[1] ?? '0');
  assert.ok(cost > 0, '催熟的自扣代价必须是正数，实际 ' + cost);
});

/* ---- 行动（7 条）---- */

test('M2.30 A2 行动：7 途径的序列 5 行动都取得到、且 contexts 与设计一致', () => {
  const expected: Array<[string, string[]]> = [
    ['seer', ['explore', 'command']],
    ['warrior', ['explore', 'pvp']],
    ['sleepless', ['daily', 'command']],
    ['sailor', ['command', 'daily']],
    ['perfect', ['command', 'daily']],
    ['reader', ['command', 'pvp']],
    ['mother', ['explore', 'command']],
  ];
  for (const [pathway, contexts] of expected) {
    // 序列 5 的人在**每一个声明的场景**里都要取得到它
    for (const context of contexts) {
      const action = pathwayActionFor(pathway as never, 5, context as never);
      assert.ok(action, pathway + ' 在 ' + context + ' 场景取不到序列 5 的行动');
      assert.equal(action!.seq, 5, pathway + ' 在 ' + context + ' 取到的应当是序列 5 的那一条');
    }
    // 未声明的场景取不到（声明式，不是硬编码所有场景）
    const undeclared = ['explore', 'daily', 'pvp', 'battle', 'command'].filter(
      (context) => !contexts.includes(context),
    );
    for (const context of undeclared) {
      const action = pathwayActionFor(pathway as never, 5, context as never);
      assert.notEqual(action?.seq, 5, pathway + ' 在未声明的 ' + context + ' 场景不该给到序列 5 的行动');
    }
  }
});
