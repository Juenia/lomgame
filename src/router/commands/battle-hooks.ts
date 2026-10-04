/**
 * 战斗的接线层（M2.9）：把判定层（纯函数）与数据库接起来。
 *
 * 与 creature-hooks.ts / initiation-hooks.ts 同一手法，三件事、顺序固定：
 *   1. 从库里查出判定需要的输入（生物实例、物种模板、背包里能用的物品）；
 *   2. 调纯函数（decideCreatureAction / resolveBattleRound）；
 *   3. 把结果落库，并且**每个回合都写一条带 seed 的 domain_events**。
 *
 * 第 3 条是硬约束（任务书 §4.2「每次判定 seed 写入 domain_events」）。
 * 只记结果不记 seed 是不够的：玩家投诉「我明明比它强却一直打不中」时，
 * 唯一能回答的是一整个回合的抽样值，而不是终局的那个「你输了」。
 *
 * ⚠️ 三个「命令层必须做对」的地方，都写在这里而不是散在命令里：
 *   - **HP 只有一份**：战斗里的 playerHp 与角色卡的 hp 是同一管血（syncBattleToCharacter）；
 *   - **超时是自动防御，不是判负**：settleBattleTimeout 逐格补齐，一格 5 分钟；
 *   - **战斗改世界只有一条路**：writeBackCreature（判定层与命令层都不直接碰 creatures 表）。
 */
import { DEITY_PREFIX, canChallengeGod, challengeCooldownMs, deityAsOpponent, deityIdOf, isDeityOpponent } from '../../domain/world/god-challenge.ts';
import type { Deity } from '../../domain/world/pantheon.ts';
import { PATHWAY_LABELS } from '../../domain/character/rules.ts';
import { BATTLE } from '../../config/numeric.ts';
import type { CharacterState, DomainEvent } from '../../domain/character/types.ts';
import { isInitiated, sequenceOrInitiate } from '../../domain/character/types.ts';
import {
  battleSpeciesViewOf,
  createBattleState,
  decideCreatureAction,
  isBattleOver,
  resolveBattleRound,
} from '../../domain/battle/index.ts';
import type {
  BattleExtraordinaryEffect,
  BattleItemEffect,
  BattleState,
  CreatureAction,
  PlayerAction,
  RoundResult,
} from '../../domain/battle/types.ts';
import { rollHarvest } from '../../domain/creature/perception.ts';
import type { CreatureSpecies } from '../../domain/creature/types.ts';
import { createSeededRng, seedFrom } from '../../domain/rng.ts';
import { rollCalamityDrop } from '../../domain/extraordinary/index.ts';
import { pickExtraordinaryItem } from './explore.ts';
import { calamityAt } from '../../domain/world/calamity.ts';
import { isFoggy, timeOfDay } from '../../domain/world/clock.ts';
import { weatherLabel } from '../../domain/world/weather.ts';
import { applyFor } from './common.ts';
import type { EffectDelta } from '../../domain/effect/apply.ts';
import { newBattleId } from '../../infra/ids.ts';
import type { RouterDeps } from '../index.ts';

/**
 * 世界此刻的样子（战斗开始时算一次，整场冻住）。
 *
 * 「雾天 -10%」必须冻住：如果每回合现算，玩家投诉「我明明打中了」时，
 * 回放会因为天气变了而对不上 —— 那正是「同一 seed 必须复现同一次判定」这条纪律的反面。
 */
function battleWorldOf(
  deps: RouterDeps,
  locationId: string,
  now: number,
  character?: CharacterState,
): BattleState['world'] {
  const foggy = isFoggy(now, deps.worldSeed ?? 'world');
  const weather = deps.world.weatherOf(locationId);
  /*
   * M2.85 RPG 化 B：**装备的命中加成**在开局时折进来。
   * 只在给了角色时算（挑战神那条路也会传，但神战里装备影响很小，不影响可玩性）。
   */
  let equipmentHit = 0;
  if (character !== undefined) {
    const byId = new Map(deps.equipmentTable.map((e) => [e.id, e]));
    const worn = deps.equipment.of(character.id).map((s) => byId.get(s.equipmentId)).filter((e): e is NonNullable<typeof e> => e !== undefined);
    for (const item of worn) {
      // 途径不符的装备不给加成（与 .装备栏 的口径一致）
      if (item.pathway !== undefined && item.pathway !== character.pathway) continue;
      equipmentHit += item.stats.hit ?? 0;
    }
  }
  return {
    locationId,
    locationName: deps.locations.get(locationId)?.name ?? locationId,
    night: timeOfDay(now) === 'night',
    danger: deps.locations.get(locationId)?.danger ?? 0,
    weatherHitPenalty: foggy ? BATTLE.weather.fogHitPenalty : 0,
    weatherLabel: weatherLabel(weather),
    equipmentHitBonus: equipmentHit,
    // M2.85 C：把内容表的技能效果折进快照（判定层只读它，不必知道内容表）
    skillEffects: Object.fromEntries(deps.battleSkillTable.map((s) => [s.id, { ...s.effect }])),
    // M2.85 B（重做）：非凡物品的代价也要进快照 —— 有增幅就一定有副作用
    equipmentDebuffs: (() => {
      if (character === undefined) return {};
      const byId = new Map(deps.equipmentTable.map((e) => [e.id, e]));
      const worn = deps.equipment.of(character.id).map((s) => byId.get(s.equipmentId)).filter((e): e is NonNullable<typeof e> => e !== undefined);
      const out: Record<string, number> = {};
      for (const item of worn) {
        if (item.pathway !== undefined && item.pathway !== character.pathway) continue;
        for (const [k, v] of Object.entries(item.debuffs)) if (typeof v === 'number') out[k] = (out[k] ?? 0) + v;
      }
      return out;
    })(),
  };
}

/**
 * 「动手」这一层允不允许（与遭遇菜单共用一份口径）。
 *
 * ⚠️ 服务端这一层是**兜底**：菜单不给的选项，直接敲指令也不放行。
 * 所以它必须与 `canStartBattle` 保持同一份判据 —— 两处漂移的后果是
 * 「菜单里有但点了被拒」或者「菜单里没有但敲指令能打」，两种都很难查。
 * 门槛为什么是 silhouette（而不是任务书写的 full）见 encounter-menu.ts 的那一段。
 */
export function battleEntryAllowed(layer: string, mortal: boolean): boolean {
  if (mortal) return false;
  return layer === 'silhouette' || layer === 'full' || layer === 'advantage' || layer === 'essence';
}

export interface StartBattleResult {
  ok: boolean;
  reason?: string;
  battle?: BattleState;
}

/**
 * 从一次**未决遭遇**开战。
 *
 * 为什么入口是「未决遭遇」而不是一条独立指令：M2.8 把「你遇到了它」做成了世界状态
 *（sightings 里 action 为 NULL 的那一行）。战斗的对手就该是那一只 ——
 * 让玩家能对着一只「不在那里的生物」开打，等于把 M2.8 的世界实体层绕过去了。
 */
export function startBattle(input: {
  deps: RouterDeps;
  character: CharacterState;
  creatureId: string;
  layer: string;
  sightingId: string;
  now: number;
  seed: string;
}): StartBattleResult {
  const { deps, character, now } = input;
  if (deps.battles.activeOf(character.id)) {
    return { ok: false, reason: '你已经在打了。' };
  }
  if (!battleEntryAllowed(input.layer, !isInitiated(character))) {
    return {
      ok: false,
      reason: '你还没看清那是什么 —— 现在动手只是把自己送上去。',
    };
  }
  const creature = deps.creatures.byId(input.creatureId);
  const species = creature ? deps.creatureIndex.byId(creature.speciesId) : null;
  if (!creature || !species) {
    return { ok: false, reason: '你再看过去的时候，那里已经没有东西了。' };
  }

  const battle = createBattleState({
    id: newBattleId(character.id, now),
    character,
    creature,
    species,
    world: battleWorldOf(deps, creature.locationId, now, character),
    now,
  });
  deps.battles.create(battle);
  // 遭遇被「动手」了结：它不再是一个悬在那里的未决状态
  deps.creatures.resolveSighting(input.sightingId, 'confront', []);
  deps.characters.appendEvents([
    {
      type: 'battle_start',
      characterId: character.id,
      payload: {
        battleId: battle.id,
        creatureId: creature.id,
        speciesId: species.id,
        layer: input.layer,
        creatureHp: battle.creatureHp,
        creatureSequence: battle.creatureSequence,
        /*
         * M2.13：**玩家当时的序列**。
         *
         * 为什么要在这里写下来：这一轮的核心验收是「**序列 9 的玩家用封印物打赢序列 8 的生物 ≥ 3 次**」，
         * 而报告只能从库里数。`characters.sequence` 是**现在**的值 ——
         * 打完那一场之后他又升了一级的话，「序列 9 打赢序列 8」这件事就查不出来了
         * （30 天窗口里 9→8→7 是常态）。与前置 3 补 `creature_sighting_roll` 是同一个理由。
         *
         * 只增不改：既有读 `battle_start` 的地方一个字段都不用改。
         */
        playerSequence: sequenceOrInitiate(character),
        sequenceGap: battle.creatureSequence - sequenceOrInitiate(character),
        locationId: creature.locationId,
      },
      reason: '进入战斗',
      seed: input.seed,
      createdAt: now,
    },
  ]);
  return { ok: true, battle };
}

/** 背包里能带进战斗的东西（消耗品 / 符咒 / 魔药） */
/**
 * M2.85 RPG 化：**挑战神** —— 与 startBattle 并排，但对手不是生物。
 *
 * 用户拍板：「神明并非是不可战胜的，倘若玩家可以击败序列 0，则能晋升成为新的序列 0。」
 *
 * 做法：把神**装扮成一只生物**（见 domain/world/god-challenge.ts 的 deityAsOpponent），
 * 于是回合、状态、逃跑、超时这些逻辑一行都不用改；`deity:` 前缀是唯一的标记，
 * 胜利结算时靠它分辨「这是掉落还是登神」。
 */
export function startDeityBattle(input: {
  deps: RouterDeps;
  character: CharacterState;
  deity: Deity;
  now: number;
}): StartBattleResult {
  const { deps, character, deity, now } = input;
  if (deps.battles.activeOf(character.id)) return { ok: false, reason: '你已经在打了。' };
  const allowed = canChallengeGod(character.sequence ?? 9);
  if (!allowed.ok) return { ok: false, reason: allowed.reason };
  const opponentId = DEITY_PREFIX + deity.id;
  const last = deps.battles.lastChallengeAt(character.id, opponentId);
  if (last !== null && now - last < challengeCooldownMs()) {
    const days = Math.ceil((challengeCooldownMs() - (now - last)) / 86_400_000);
    return { ok: false, reason: `你刚从他面前退下来 —— ${days} 天之后再来。` };
  }
  // 战场固定「灰雾之上」：那是原著里神所在的层
  const arena = 'above_grey_fog';
  const { creature, species } = deityAsOpponent(deity, arena, now);
  const battle = createBattleState({
    id: newBattleId(character.id, now),
    character,
    creature,
    species,
    world: battleWorldOf(deps, arena, now, character),
    now,
    maxRounds: BATTLE.godMaxRounds,   // 神战是生死局，没有「8 回合僵持」
  });
  deps.battles.create(battle);
  deps.characters.appendEvents([
    {
      type: 'battle_start',
      characterId: character.id,
      reason: '挑战神',
      createdAt: now,
      payload: { battleId: battle.id, creatureId: creature.id, speciesId: species.id, layer: 'full', creatureHp: battle.creatureHp },
    },
  ]);
  return { ok: true, battle };
}
export function battleItemsOf(
  deps: RouterDeps,
  characterId: string,
): Array<{ itemId: string; name: string; quantity: number }> {
  const out: Array<{ itemId: string; name: string; quantity: number }> = [];
  for (const slot of deps.inventory.list(characterId)) {
    const item = deps.items.get(slot.itemId);
    if (!item) continue;
    /*
     * M2.13：**封印物也进这一份清单**（它们要在战斗里被选中）。
     * `type === 'sealed'` 是判据，而不是 `kind` —— 封印物的 kind 是 trinket
     * （用完之后还在），与「消耗品」不是同一类（见 domain/item/item.ts 的注释）。
     */
    const usable =
      (item.kind === 'consumable' && (item.effect !== undefined || item.battle !== undefined)) ||
      item.kind === 'potion' ||
      item.type === 'sealed';
    if (!usable) continue;
    out.push({ itemId: item.id, name: item.name, quantity: slot.quantity });
  }
  return out;
}

/**
 * M2.13：**封印物 → 判定层要的那份效果**（命令层才认识 items 表）。
 *
 * 与 `battleItemEffectOf` 是两个函数而不是一个带分支的：两者问的问题不同
 * （对面会怎么样 / 我这一下会怎么样），合并之后「谁改了什么」就查不清了。
 * 只有 `type === 'sealed'` 才会走到这里 —— 神奇物品是被动的，符咒走 `battleItemEffectOf`。
 */
export function battleExtraordinaryEffectOf(
  deps: RouterDeps,
  itemId: string,
): BattleExtraordinaryEffect | null {
  const item = deps.items.get(itemId);
  if (!item || item.type !== 'sealed') return null;
  const effect = item.effect ?? {};
  const side = item.sideEffect ?? {};
  const cost: { mad?: number; cor?: number } = {};
  if (typeof side.mad === 'number' && side.mad !== 0) cost.mad = side.mad;
  if (typeof side.cor === 'number' && side.cor !== 0) cost.cor = side.cor;
  return {
    itemId: item.id,
    name: item.name,
    ...(effect.ignoreSequenceGap === true ? { ignoreSequenceGap: true } : {}),
    ...(typeof effect.hitModifier === 'number' ? { hitModifier: effect.hitModifier } : {}),
    ...(typeof effect.damageMultiplier === 'number' ? { damageMultiplier: effect.damageMultiplier } : {}),
    ...(effect.reroll === true ? { reroll: true } : {}),
    ...(Object.keys(cost).length > 0 ? { cost } : {}),
  };
}

/** 物品 → 判定层要的那份效果（命令层才认识 items 表） */
export function battleItemEffectOf(
  deps: RouterDeps,
  itemId: string,
): BattleItemEffect | null {
  const item = deps.items.get(itemId);
  if (!item) return null;
  if (item.kind === 'potion') {
    const cfg = BATTLE.itemEffects.potion;
    return { itemId: item.id, name: item.name, self: { mp: cfg.mp, mad: cfg.mad } };
  }
  const battle = item.battle;
  return {
    itemId: item.id,
    name: item.name,
    ...(item.effect ? { self: item.effect } : {}),
    ...(battle
      ? {
          battle: {
            ...(battle.damage !== undefined ? { damage: battle.damage } : {}),
            ...(battle.cleanse !== undefined ? { cleanse: battle.cleanse } : {}),
            ...(battle.hitBonus !== undefined ? { hitBonus: battle.hitBonus } : {}),
            ...(battle.applyToCreature ? { applyToCreature: battle.applyToCreature } : {}),
          },
        }
      : {}),
  };
}

/**
 * 战斗里的血就是角色卡上的血。
 *
 * 为什么必须有这一步：玩家在战斗中途完全可以发一条 .休息（战斗不占用一条指令通道），
 * 于是角色卡的 HP 会动，而战斗状态里的 playerHp 不动 ——
 * 下一回合按「净变化」提交时，那笔账就会把玩家刚回的血抹掉。
 * 与其禁止（「战斗期间不能休息」是一条会漏的规则），不如**以角色卡为准**同步一次：
 * 血只有一管，谁改的算谁的。
 */
function syncBattleToCharacter(deps: RouterDeps, battle: BattleState, character: CharacterState): BattleState {
  if (battle.playerHp === character.hp && battle.playerMp === character.mp) return battle;
  const synced: BattleState = {
    ...battle,
    playerHp: character.hp,
    playerMp: character.mp,
  };
  // ⚠️ 用 syncState 而不是 saveRound：这不是一个回合，不该往 battle_rounds 里写一行
  //    （写了会让报告里的回合数分布与玩家动作分布被假回合污染，而读数时看不出异常）
  deps.battles.syncState(synced);
  return synced;
}

export interface RoundOutcome {
  result: RoundResult;
  /** 结算之后的角色卡（已通过唯一数值入口落库） */
  character: CharacterState;
  /** 胜利掉落（物品 id 列表） */
  drops: string[];
  /** 生物动作（回执与报告都用它） */
  creatureAction: CreatureAction;
}

/**
 * 跑一个回合。
 *
 * 随机源有两路，**必须是两路**：
 *   playerRng —— 玩家动作的一切判定（命中 / 暴击 / 逃跑）
 *   aiRng     —— 生物这一回合的决策
 * 分成两路之后，「占卜预判」只要拿同一个 aiRng 就能看到**真的会发生的那件事**；
 * 共用一路上午的随机数会被玩家的动作消费掉，预知就变成了猜。
 */
export function runBattleRound(input: {
  deps: RouterDeps;
  character: CharacterState;
  battle: BattleState;
  action: PlayerAction;
  now: number;
  seed: string;
  roundAt: number;
}): RoundOutcome {
  const { deps, character, battle, action, seed } = input;
  const species = deps.creatureIndex.byId(battle.speciesId);
  const speciesView = species
    ? battleSpeciesViewOf(species)
    : {
        id: battle.speciesId,
        name: battle.speciesName,
        habits: [] as string[],
        special: null,
        specialName: null,
        damage: [10, 18] as const,
        hit: BATTLE.actions.attack.baseHit,
      };

  const current = syncBattleToCharacter(deps, battle, character);
  const aiRng = createSeededRng(seedFrom([current.id, current.round, 'ai']));
  const creatureAction = decideCreatureAction(speciesView, current, aiRng);
  const playerRng = createSeededRng(seedFrom([seed, 'player']));
  // 预知用的是**下一回合**那一路随机源 —— 与下一回合真正的决策同源
  const foresightRng = createSeededRng(seedFrom([current.id, current.round + 1, 'ai']));
  const itemEffect = action.itemId ? battleItemEffectOf(deps, action.itemId) : undefined;
  // M2.13：封印物（这一回合的攻击换一种打法）。只有 kind = 'extraordinary' 时才查，
  // 免得普通攻击也去 items 表里绕一圈（那会让「这一次判定读了什么」变得含糊）
  const extraordinaryEffect =
    action.kind === 'extraordinary' && action.extraordinaryId
      ? battleExtraordinaryEffectOf(deps, action.extraordinaryId)
      : undefined;

  const result = resolveBattleRound(character, current, action, playerRng, {
    creatureAction,
    species: speciesView,
    aiRng: foresightRng,
    ...(itemEffect ? { item: itemEffect } : {}),
    ...(extraordinaryEffect ? { extraordinary: extraordinaryEffect } : {}),
  });
  /*
   * 判定层不写时钟（它的 lastRoundAt 原样带回来），所以**这一格的时间由接线层盖上**。
   *
   * 为什么非盖不可：超时补跑是拿 lastRoundAt 做水位线的，
   * 而水位线不往前走，settleBattleTimeout 的循环条件永远成立 ——
   * 一次超时会把整场战斗一口气推到底（实测抓到过：走开 5 分钟补了 8 个回合）。
   * 落库时写的是 roundAt，内存里也必须是 roundAt，两边不能各说各话。
   */
  result.battle.lastRoundAt = input.roundAt;

  /* ---- 1. 状态机 + 回合记录（一个事务） ---- */
  deps.battles.saveRound({
    battle: result.battle,
    result,
    playerAction: action,
    creatureAction,
    seed,
    now: input.roundAt,
  });

  /* ---- 2. 玩家数值：净变化一起走唯一数值入口 ---- */
  const deltas: EffectDelta[] = [];
  const hpDelta = result.playerHp - character.hp;
  const mpDelta = result.playerMp - character.mp;
  if (hpDelta !== 0) deltas.push({ type: 'hp', value: hpDelta });
  if (mpDelta !== 0) deltas.push({ type: 'mp', value: mpDelta });
  if (result.itemMadDelta !== 0) deltas.push({ type: 'mad', value: result.itemMadDelta });
  /*
   * M2.85 B（重做）：**非凡物品的代价**。
   * 用户拍板「装备上去有增幅，但也有 debuff」—— 这一笔就是那个 debuff 真正落到身上的地方。
   * 无论是用技能还是用封印物，只要动用了它们，理智与腐蚀都要付。
   */
  if ((result.equipmentCost?.mad ?? 0) !== 0) deltas.push({ type: 'mad', value: result.equipmentCost!.mad });
  if ((result.equipmentCost?.cor ?? 0) !== 0) deltas.push({ type: 'cor', value: result.equipmentCost!.cor });
  // M2.13：使用封印物的 COR 代价（与 itemMadDelta 同一手法：判定层记账，这里提交）
  if (result.itemCorDelta !== 0) deltas.push({ type: 'cor', value: result.itemCorDelta });
  /*
   * M2.12：**命运赌注的代价是消化度**（不是灵力，也不是物品）。
   *
   * 判定层不认识角色卡的消化度（它只读一个不可变的快照），所以这笔账由这里记 ——
   * 与 itemMadDelta 完全同一个手法。为什么值得单开一条：
   * 消化度是**晋升的资源**，所以这一下是玩家真金白银在赌 ——
   * 序列 8→7 的门槛是 DIG 85，在战斗里花掉的每一分都要重新刷回来。
   */
  if (action.kind === 'skill' && action.skillId === 'fate_wager') {
    deltas.push({ type: 'dig', value: -BATTLE.skillEffects.fate_wager.digCost });
  }
  const over = isBattleOver(result.status);
  const drops: string[] = [];
  if (over && result.status === 'player_win') {
    deltas.push({ type: 'dig', value: BATTLE.rewards.digOnWin });
    drops.push(...rollVictoryDrops(deps, species, seed, isDeityOpponent(result.battle.creatureId)));
  }
  if (over && result.status === 'player_lose') {
    deltas.push({ type: 'mad', value: BATTLE.rewards.madOnLose });
  }

  let next = character;
  const events: DomainEvent[] = [];
  if (deltas.length > 0) {
    const applied = applyFor(deps, character, deltas, '战斗第 ' + result.round + ' 回合', input.roundAt, seed);
    if (!applied.rejected) {
      next = applied.newState;
      events.push(...applied.events);
    }
  }
  if (over && result.status === 'player_lose' && next.hp <= 0) {
    next = { ...next, status: 'injured', updatedAt: input.roundAt };
  }
  /*
   * M2.13：**战斗里用封印物也要留档**（与 .使用 那条路同一个事件类型）。
   *
   * 为什么非写不可：`.战斗 物品 封印之刃` 走的是战斗状态机，不经过 `use.ts` ——
   * 不写这一条的话，报告里「封印物使用次数（按物品）」永远是 0，
   * 而「序列 9 用封印物打赢序列 8」这件事就只剩 battle_rounds 里的一段 JSON。
   * 实测踩过一次：第二轮的封印物使用数报的是 0，而行为日志里明明有两次
   * `.战斗 物品 sealed_blade`。
   */
  if (action.kind === 'extraordinary' && action.extraordinaryId) {
    events.push({
      type: 'extraordinary_used',
      characterId: character.id,
      payload: {
        itemId: action.extraordinaryId,
        type: 'sealed',
        actionKind: 'battle',
        inBattle: true,
        battleId: current.id,
        round: result.round,
        playerSequence: sequenceOrInitiate(character),
        creatureSequence: current.creatureSequence,
        /** 这一回合**真的**用上了「无视序列差」没有（封印之刃的核心指标） */
        ignoredSequenceGap: result.ignoredSequenceGap,
      },
      reason: '战斗中使用封印物:' + action.extraordinaryId,
      seed,
      createdAt: input.roundAt,
    });
  }
  if (drops.length > 0) {
    for (const itemId of drops) {
      deps.inventory.addMany(character.id, [{ itemId, quantity: 1, bindType: 'bound' }], input.roundAt);
      events.push({
        type: 'item_gain',
        characterId: character.id,
        payload: { itemId, quantity: 1, bindType: 'bound', battleId: current.id },
        reason: '战斗掉落',
        seed,
        createdAt: input.roundAt,
      });
    }
  }

  /*
   * ==================================================================
   * M2.14：**灾厄产出的封印物**（封印物的第二条来源）
   * ==================================================================
   *
   * ⚠️ **M2.14 方案 A 起，战斗不再是主路径**：200×30 实测灾厄期只有 3 场战斗胜利，
   * 而灾厄期探索有 1398 次。主路径挪到了 explore.ts（每次探索），
   * 这一条**保留**为次路径 —— 它不参与「灾厄产出 ≥ 20%」的主验收（观察项）。
   * 保留的理由是语义而不是统计：**「打赢灾厄生物拿东西」是核心叙事**，
   * 而且它是全序列可达的那一条（另一条候选 encounter.ts 的「观察本质」采集
   * 要看到本质层，序列 9 拿不到）。
   *
   * ⚠️ 用**独立随机源** seedFrom([seed, 'calamity-drop'])：
   * 绝不插进 rollVictoryDrops 的随机序列 —— 那会让既有战斗掉落整体漂移
   * （与 explore.ts 的封印物掉落同一手法，纪律写在 domain/wanted/assault.ts 文件头）。
   *
   * 非灾厄期这一整段不执行：掉落率表里没有 0 级，rollCalamityDrop 也返回 null。
   */
  if (over && result.status === 'player_win') {
    const calamity = calamityAt(deps.worldSeed ?? 'world', input.roundAt);
    if (calamity) {
      const dropSeed = seedFrom([seed, 'calamity-drop']);
      // M2.14 方案 A：战斗那条降为**次路径**（样本太少，不参与主验收），段名 'battle'
      const drop = rollCalamityDrop({ segment: 'battle', rng: createSeededRng(dropSeed) });
      const itemId = drop
        ? pickExtraordinaryItem(deps, drop.kind, createSeededRng(seedFrom([dropSeed, 'pick'])))
        : null;
      if (drop && itemId) {
        deps.inventory.addMany(character.id, [{ itemId, quantity: 1, bindType: 'unbound' }], input.roundAt);
        events.push({
          type: 'item_gain',
          characterId: character.id,
          payload: {
            itemId,
            quantity: 1,
            bindType: 'unbound',
            battleId: current.id,
            extraordinaryKind: drop.kind,
            calamityLevel: calamity.level,
            roll: Number(drop.roll.toFixed(6)),
            chance: drop.chance,
          },
          reason: '战斗·灾厄掉落',
          seed: dropSeed,
          createdAt: input.roundAt,
        });
      }
    }
  }

  /*
   * ---- 2.4 M2.85 B（重做）：**非凡物品的掉落** ----
   *
   * 用户要「装备的来源」。原著的规则是：非凡物品来自**非凡者失控后遗留的非凡特性**，
   * 所以掉落要挂在「打赢了一只够强的生物」上，而不是随便哪场仗都掉。
   *
   * 概率与挑法都用种子跑（可复现）：序列越低（越强）越可能掉，掉出来的也越强。
   */
  if (over && result.status === 'player_win' && species !== null && !isDeityOpponent(result.battle.creatureId)) {
    const lootRng = createSeededRng(seedFrom([seed, character.id, 'equipment-drop']));
    const foeSeq = species.baseSequence;
    /*
     * ⚠️ **数值修正**（用户：「非凡物品不是大白菜」）。
     *
     * 第一版给了 18% / 8% / 3% —— 打十场掉一两件，那是街边货。
     * 原著里非凡物品是「非凡者失控后遗留的非凡特性」做成的，属于**极稀有**的东西。
     * 现在压到：强敌（序列 ≤4）3% / 中等（≤6）1% / 其余 0.2%。
     * 一次掉落因此是**值得写进世界事件**的事，而不是刷资源。
     */
    const chance = foeSeq <= 4 ? 0.03 : foeSeq <= 6 ? 0.01 : 0.002;
    if (lootRng.next() < chance) {
      const pool = deps.equipmentTable.filter((e) => e.sequence >= foeSeq - 1 && e.sequence <= foeSeq + 2 && e.level !== '0');
      if (pool.length > 0) {
        const got = pool[Math.floor(lootRng.next() * pool.length)]!;
        if (deps.equipment.acquire(character.id, got.id, 'battle', input.roundAt)) {
          deps.characters.appendEvents([{
            type: 'equipment_drop', characterId: character.id,
            payload: { equipmentId: got.id, from: species.id }, reason: '战斗掉落非凡物品', seed: null, createdAt: input.roundAt,
          }]);
          deps.worldEvents.insert({
            id: 'equip-drop-' + character.id + '-' + input.roundAt,
            type: 'power',
            text: '【世界 · 遗物】' + character.name + '在' + species.name + '身上找到了一样东西 —— ' + got.name + '\n（它有增幅，也有代价：' + got.negativeEffects[0]?.slice(0, 40) + '）',
            visibility: 'public',
            createdAt: input.roundAt,
          });
        }
      }
    }
  }

  /* ---- 2.5 M2.85：对手是**神** → 登神（而不是掉落、也不是写回生物表） ---- */
  const beatGod = over && result.status === 'player_win' && isDeityOpponent(result.battle.creatureId);
  if (beatGod) {
    const deityId = deityIdOf(result.battle.creatureId);
    const deity = deps.pantheon.find((d) => d.id === deityId);
    deps.godhood.claim({ deityId, characterId: character.id, at: input.roundAt });
    deps.worldEvents.insert({
      id: 'god-claim-' + deityId + '-' + input.roundAt,
      type: 'power',
      text:
        `【世界 · 神位】${character.name} 击败了${deity?.name ?? deityId}\n` +
        `神位易主 —— 从这一刻起，${deity !== undefined && deity.pathways.length > 0 ? deity.pathways.map((p) => PATHWAY_LABELS[p] ?? p).join('、') : '这条途径'}的神是他。`,
      visibility: 'public',
      createdAt: input.roundAt,
    });
  }

  /*
   * M2.85 RPG 化：**你的行为会落到别人对你的看法上**。
   *
   * 用户拍板：「玩家的行为可能交恶或者交好 NPC」—— 这是最频繁也最自然的触发点：
   * 你杀的生物走哪条途径，就决定了**谁记你的好、谁记你的仇**。
   *
   *   与某位 NPC **同途径**的生物   → 他记仇（你在动他的人）
   *   与某位 NPC **敌对途径**的生物 → 他记好（你替他办了事）
   *
   * ⚠️ 只在**打赢**时结算，每次 ±1 —— 好感是**攒**出来的，不是一次定生死。
   */
  if (over && result.status === 'player_win' && species !== null) {
    const slain = species.pathwayAffinity as readonly string[];
    if (slain.length > 0) {
      for (const disp of deps.npcDispositions) {
        const sameRoad = disp.pathways.some((p) => slain.includes(p));
        const hitsRival = disp.hostilePathways.some((p) => slain.includes(p));
        if (sameRoad) deps.npcRelations.bump(disp.npcId, character.id, -1, input.roundAt);
        else if (hitsRival) deps.npcRelations.bump(disp.npcId, character.id, 1, input.roundAt);
      }
    }
  }
  /* ---- 3. 战斗改世界：**唯一一条路** ---- */
  // ⚠️ 神不在生物表里（creatureId 是 deity: 前缀）—— 写回去会去找一个不存在的生物
  if (over && !beatGod) {
    deps.battles.writeBackCreature({
      creatureId: result.battle.creatureId,
      hp: result.status === 'player_win' ? null : result.battle.creatureHp,
      maxHp: result.battle.creatureMaxHp,
      sequence: result.battle.creatureSequence,
    });
  } else {
    deps.battles.writeBackCreature({
      creatureId: result.battle.creatureId,
      hp: result.battle.creatureHp,
      maxHp: result.battle.creatureMaxHp,
      sequence: result.battle.creatureSequence,
    });
  }

  /* ---- 4. 审计：每个回合一条带 seed 的 domain_events ---- */
  events.push({
    type: 'battle_round',
    characterId: character.id,
    payload: {
      battleId: current.id,
      round: result.round,
      playerAction: action.kind,
      skillId: action.skillId ?? null,
      itemId: action.itemId ?? null,
      creatureAction: creatureAction.kind,
      special: creatureAction.special ?? null,
      creatureActed: result.creatureActed,
      playerDamageDealt: result.playerDamageDealt,
      creatureDamageDealt: result.creatureDamageDealt,
      flags: result.flags,
      rolls: result.rolls,
      status: result.status,
      auto: Boolean(action.auto),
    },
    reason: '战斗回合：' + action.kind + ' vs ' + creatureAction.kind,
    seed,
    createdAt: input.roundAt,
  });
  if (over) {
    events.push({
      type: 'battle_end',
      characterId: character.id,
      payload: {
        battleId: current.id,
        status: result.status,
        rounds: result.round,
        drops,
        auto: Boolean(action.auto),
      },
      reason: '战斗结束：' + result.status,
      seed,
      createdAt: input.roundAt,
    });
  }

  deps.characters.update(next);
  deps.characters.appendEvents(events);

  return { result, character: next, drops, creatureAction };
}

/**
 * 胜利掉落：物种 drops 表（任务书 §4.3.6）+ 符咒池。
 *
 * 两处口径分开是有理由的：
 *   drops        —— 「从它身上能取到什么」（与观察本质采的是同一张表，内容侧只维护一处）
 *   victoryDrops —— 「打完之后战场上留下什么」（符咒不是它身上的器官）
 */
function rollVictoryDrops(
  deps: RouterDeps,
  species: CreatureSpecies | null,
  seed: string,
  /**
   * M2.85：**这是不是一场神战**。是的话不发通用战利品（符咒那些）。
   *
   * 理由：打赢一尊神得到的是一整个**神位**，再掉一张「符咒·灼烧」既没意义也出戏
   * （实测第一次打出登神时，战报末尾就跟着一行「掉落：符咒·灼烧」）。
   */
  isGodBattle = false,
): string[] {
  const out: string[] = [];
  if (isGodBattle) return out;
  if (species) {
    const rng = createSeededRng(seedFrom([seed, 'battle-drop']));
    for (const drop of species.drops) {
      if (rng.next() < drop.chance) out.push(drop.itemId);
    }
  }
  const bonusRng = createSeededRng(seedFrom([seed, 'battle-victory-drop']));
  for (const entry of BATTLE.rewards.victoryDrops) {
    if (bonusRng.next() < entry.chance) out.push(entry.itemId);
  }
  return out.filter((itemId) => deps.items.get(itemId) !== null);
}

export interface TimeoutOutcome {
  rounds: number;
  battle: BattleState | null;
  /** 最后一场超时战斗的结局（有就带上） */
  last: RoundOutcome | null;
}

/**
 * 超时自动防御（任务书 §4.3.1）。
 *
 * 三条语义：
 *   1. **超时判自动「防御」，不是判负** —— 判负是惩罚挂机，对 QQ 的异步场景不合适；
 *      自动防御的代价已经够清楚：白送对面一个回合（只减半伤害、回 5 灵力）。
 *   2. **一格 5 分钟**：离开 40 分钟的玩家回来时会看到战斗已经按 5 分钟一格推到结束，
 *      而不是「一次超时补 8 个回合」——后者会让「5 分钟」变成一个没有意义的数。
 *   3. **每格都写盘**：回来了、进程重启了、库还在，战斗就在原地等着。
 */
export function settleBattleTimeout(
  deps: RouterDeps,
  character: CharacterState,
  now: number,
): TimeoutOutcome {
  let battle = deps.battles.activeOf(character.id);
  if (!battle) return { rounds: 0, battle: null, last: null };
  /*
   * ⚠️ M2.10：**PVP 的超时不归这里管**。
   *
   * 这一条不是防御性判断，是必须的：`activeOf` 从 M2.10 起会同时找到 PVP 的战斗，
   * 而下面这个循环跑的是**PVE 的回合结算**（`runBattleRound` + 生物的 AI）——
   * 拿它去推进一场 PVP，会让应战者的对手变成一只「看不懂动作的生物」。
   * PVP 有它自己的超时入口（pvp-hooks.ts 的 settlePvpTimeout：谁轮到就替谁防御）。
   */
  if (battle.isPvp) return { rounds: 0, battle, last: null };

  let rounds = 0;
  let current = character;
  let last: RoundOutcome | null = null;
  while (
    battle &&
    battle.status === 'active' &&
    now - battle.lastRoundAt >= BATTLE.playerTimeoutMs &&
    rounds < BATTLE.maxRounds
  ) {
    const roundAt = battle.lastRoundAt + BATTLE.playerTimeoutMs;
    const seed = seedFrom([battle.id, battle.round, 'timeout', roundAt]);
    last = runBattleRound({
      deps,
      character: current,
      battle,
      action: { kind: 'defend', auto: true },
      now,
      seed,
      roundAt,
    });
    current = last.character;
    rounds += 1;
    battle = last.result.battle;
  }
  return { rounds, battle, last };
}
