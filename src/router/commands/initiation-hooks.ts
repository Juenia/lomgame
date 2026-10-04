/**
 * 入途径的接线层（M2.7.6；M2.85 修订）：把判定层（纯函数）与数据库接起来。
 *
 * 这一层只做三件事，且顺序固定：
 *   1. 从库里查出判定需要的输入（哪座城市、手上有没有线索）；
 *   2. 调 resolveInitiation（纯函数，带 seed）；
 *   3. 把结果落库，并且**无论结果是什么都写一条带 seed 的 domain_events**。
 *
 * 第 3 条是硬约束（任务书 §一）：每一次判定都要能被复现。
 * M2.85：势力引导的邀约/任务结算从这一层删除 —— 「走上途径」只剩探索翻线索，
 * 保底由 cluePityDays 在判定层承接。
 */
import type { CharacterState, DomainEvent, PathwayId } from '../../domain/character/types.ts';
import type { InitiationWorld } from '../../domain/initiation/types.ts';
import {
  resolveInitiation,
  type InitiationAction,
  type InitiationResult,
} from '../../domain/initiation/index.ts';
import { newClueId } from '../../infra/ids.ts';
import type { RouterDeps } from '../index.ts';

/** 判定层的世界输入：调用方查库后喂进来 */
export function initiationWorldFor(deps: RouterDeps, character: CharacterState): InitiationWorld {
  return {
    // 线索只落在**此刻所在的城市**：走到别处，翻到的就是别人地盘上流传的东西
    factions: deps.initiation.factionsOfCity(character.currentCityId),
    openClues: deps.clues.unusedOf(character.id),
    bornAt: character.createdAt,
  };
}

/**
 * 跑一次入途径判定并落库。
 *
 * seed 由调用方传（通常是 seedFrom([messageId, characterId, now, 'initiate']))，
 * 于是同一条指令重放必然得到同一结果 —— 与 W2 起的全部判定一个口径。
 */
export function runInitiation(input: {
  deps: RouterDeps;
  character: CharacterState;
  action: InitiationAction;
  rng: { next(): number };
  seed: string;
  now: number;
}): InitiationResult {
  const { deps, character, action, rng, seed, now } = input;
  const result = resolveInitiation({
    state: character,
    action,
    world: initiationWorldFor(deps, character),
    rng,
    seed,
  });

  const events: DomainEvent[] = [
    {
      type: `initiation_${result.kind}`,
      characterId: character.id,
      payload: {
        action: action.kind,
        rolls: result.rolls,
        clue: result.clue ? { pathway: result.clue.pathway } : null,
      },
      reason: '入途径判定',
      seed,
      createdAt: now,
    },
  ];

  if (result.clue) {
    const id = newClueId(character.id, result.clue.foundAt);
    deps.clues.insert({
      id,
      characterId: character.id,
      pathway: result.clue.pathway,
      clueText: result.clue.clueText,
      foundAt: result.clue.foundAt,
      usedAt: null,
    });
    events.push({
      type: 'recipe_clue_found',
      characterId: character.id,
      payload: { clueId: id, pathway: result.clue.pathway },
      reason: '翻到配方线索',
      seed,
      createdAt: now,
    });
  }

  deps.characters.appendEvents(events);
  return result;
}

/**
 * 这个人现在**有配方**的途径（决定 .魔药 能调哪一瓶）。
 *
 * M2.85：来源只剩自己翻到的线索（recipe_clues 里还没用掉的那些）——
 * 原来的另一路「势力给到手的配方」（pathway_offers）随引导玩法一并删除。
 */
export function recipePathwaysOf(deps: RouterDeps, character: CharacterState): PathwayId[] {
  return [...new Set(deps.clues.unusedOf(character.id).map((clue) => clue.pathway))];
}

/**
 * 入途径那一刻的落库（.服用 调用）。
 *
 * 三联一起写：pathway / sequence / pathway_status。分三次写的话，
 * 中间任何一次失败都会留下一个「有途径但没有序列」的角色 ——
 * 那种状态在任何判定里都没有定义。
 */
export function markInitiated(input: {
  deps: RouterDeps;
  character: CharacterState;
  pathway: CharacterState['pathway'];
  sequence: number;
  seed: string;
  now: number;
}): void {
  const { deps, character, pathway, sequence, seed, now } = input;
  const clues = deps.clues.unusedOf(character.id);
  for (const clue of clues) deps.clues.markUsed(clue.id, now);
  deps.characters.appendEvents([
    {
      type: 'pathway_initiated',
      characterId: character.id,
      payload: { pathway, sequence, usedClues: clues.length },
      reason: '入途径',
      seed,
      createdAt: now,
    },
  ]);
}
