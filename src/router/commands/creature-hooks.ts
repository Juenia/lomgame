/**
 * 生物的接线层（M2.8）：把判定层（纯函数）与数据库接起来。
 *
 * 与 initiation-hooks.ts 同一手法，三件事、顺序固定：
 *   1. 从库里查出判定需要的输入（这个地点此刻有哪些生物）；
 *   2. 调纯函数（rollEncounter / resolveSighting）；
 *   3. 把结果落库，并且**无论有没有命中都写一条带 seed 的 domain_events**。
 *
 * 第 3 条是硬约束（任务书 §4.2「每次判定 seed 写入 domain_events」）。
 * 只记命中的那次是不够的：「他三十天一只生物都没遇到」这个问题，
 * 只能靠**每一次**掷骰的抽样值来回答（是概率低？是地点不对？还是那里根本没生物？）。
 */
import type { CharacterState, DomainEvent } from '../../domain/character/types.ts';
import { encounterRateAt } from '../../domain/world/authority-effects.ts';
import { isInitiated, sequenceOrInitiate } from '../../domain/character/types.ts';
import {
  resolveSighting,
  rollEncounter,
  type Creature,
  type CreatureSpecies,
  type EncounterCandidate,
  type SightingResult,
} from '../../domain/creature/index.ts';
import {
  buildEncounterMenu,
  encounterFlavorOf,
  encounterTitleOf,
  type EncounterMenuView,
} from '../../domain/menu/encounter-menu.ts';
import type { Menu } from '../../domain/menu/types.ts';
import { createSeededRng, seedFrom } from '../../domain/rng.ts';
import { isFoggy, timeOfDay } from '../../domain/world/clock.ts';
import { weatherLabel } from '../../domain/world/weather.ts';
import { advanceCreatures } from '../../infra/creature-tick.ts';
import { decayZoneFear, noteSightingForEcology } from '../../infra/info-ecology.ts';
import { notePowerReactions } from '../../infra/power-reactions.ts';
import { CausalRepo } from '../../infra/causal-log.ts';
import { ZoneStateRepo } from '../../infra/db/zone-state.ts';
import { newSightingId } from '../../infra/ids.ts';
import { worldViewFor } from './common.ts';
import type { RouterDeps } from '../index.ts';

/**
 * 惰性推进生态 tick —— 与 M2.2 的世界时钟**同一挂点、同一理由**：
 * 世界 tick 是每 5 分钟一次、而且 startOps=false（实例测试 / 压测）时根本不跑；
 * 生物的节拍必须跟着玩家动作走，否则「压测里生物一动不动」这种假象就会出现。
 *
 * 任何异常都不该影响玩家这条指令 —— 与 #advanceWorld 同样的兜底。
 */
export function advanceCreatureEcology(deps: RouterDeps, now: number): void {
  /*
   * M2.58 阶段三：恐慌随小时衰减。
   *
   * 挂在这里而不是单独一个定时器，理由见 info-ecology.ts 的 decayZoneFear ——
   * 分成两个定时器就会出现「衰减跑过了但生态 tick 没跑」这种中间态，
   * 而那种中间态只在压测并发的窗口里出现，最难查。
   *
   * 一次 tick 固定按 1 小时衰减（调度器本来就是每小时调一次）。
   */
  try {
    decayZoneFear(deps.db, deps.zoneIndex, now, 1);
  } catch {
    // 与 #advanceWorld 同样的兜底：衰减出问题不该影响玩家这条指令
  }
  /*
   * 恐慌读一次全表，交给 zoneOf —— 生态 tick 一次要问几百次「这个地点的参数」，
   * 每次都查库会把这一层变成 IO 热点。
   */
  const fearByZone = new ZoneStateRepo(deps.db).fearByZone();
  advanceCreatures({
    repo: deps.creatures,
    speciesList: deps.creatureIndex.all(),
    locationIds: deps.locations.all().map((location) => location.id),
    /*
     * M2.58 阶段二：地点 → 生态参数。
     *
     * 这一行是「不同地方的世界不一样」真正生效的地方 ——
     * 没有它，生态 tick 的所有概率仍然读全局常量，
     * 而普利兹港的老鼠会和拜朗的老鼠行为完全一样。
     * 域表里没登记的地点由 ZoneIndex 返回全局基线（不是报错）。
     */
    zoneOf: (locationId: string) =>
      deps.zoneIndex.paramsOf(locationId, (zoneId) => fearByZone.get(zoneId) ?? 0),
    /*
     * ⚠️ neighborsOf **故意没传** —— 也就是说捕食仍然是「只吃同一个地点的猎物」。
     *
     * 我加过它，也实测过，然后撤了。数据（同一份快照、同样 30 天、只差这一个变量）：
     *
     *   只同地点 gap=3   捕食 16/h   死亡  589/72h   种群 113→146→…→124
     *   +相邻    gap=3   捕食 132/h  死亡 2737/72h   种群 104→ 97→…→ 98
     *   +相邻    gap=4   捕食  83/h  死亡 2161/72h   种群 108→110→…→106
     *
     * 三种都不会灭绝，但放宽之后只是**死得更多**：捕食涨 5—8 倍，种群反而低两成，
     * 而补充次数几乎等于死亡次数 —— 那个生态不是自己维持的，是靠世界不停投喂撑着的。
     * 换来的「更活跃」是假的。
     *
     * 真正的毛病是**慢热**（生物刚播种时散在 58 个地点，要靠迁移撞到一起才有机会），
     * 而放大捕食范围治不了慢热，只会把成年期的种群压低。要治得从播种那一步入手。
     * 口子留着：将来做「捕食者循着气味追踪猎物」时，这个参数就是它的入口。
     */
    now,
    worldSeed: deps.worldSeed ?? 'world',
  });
}

/**
 * 感知层次 → 事件严重度（M2.59）。
 *
 * 为什么是层次而不是生物序列：势力**不知道**那只东西序列几 ——
 * 它知道的是「有人报上来说看见了什么」。看见得越清楚，报上来的越具体，
 * 事就越大。这与玩家视角完全一致（他就是那个报信的人）。
 *
 * blur / silhouette 两层给得很低：连报信人都说不清的事，势力不会为此出动，
 * 而那正是「看不清就只能撤退」这条设计在势力侧的镜像。
 */
const SEVERITY_BY_LAYER: Record<SightingResult['layer'], number> = {
  blur: 0.15,
  silhouette: 0.3,
  full: 0.5,
  advantage: 0.7,
  essence: 0.9,
};

/** 一次遭遇在「要展示给玩家」这个意义上的全部内容 */
export interface SightingDisplay {
  sightingId: string;
  layer: SightingResult['layer'];
  /** 【遭遇 · 老码头 · 雾天】 */
  headline: string;
  /** 玩家在**这一层**看到的文本 */
  text: string;
  /** 行为旁白（可能没有） */
  behaviorText: string | null;
  /** 菜单（观察 / 对峙 / 撤退 / 互动 的子集） */
  menu: Menu;
  /** 审计用：判定层次与它允许的动作 */
  allowedActions: readonly string[];
}

/** 地点此刻的候选生物（实例 + 物种模板），两者缺一不可 */
function candidatesAt(deps: RouterDeps, locationId: string): EncounterCandidate[] {
  const out: EncounterCandidate[] = [];
  for (const creature of deps.creatures.atLocation(locationId)) {
    const species = deps.creatureIndex.byId(creature.speciesId);
    if (!species) continue;
    out.push({ creature, species });
  }
  return out;
}

/**
 * 探索（或移动到达）时掷一次遭遇。
 *
 * 没命中返回 null，但**仍然写了一条带 seed 的 domain_events**（见文件头）。
 * 命中则写一条 sightings（action 尚未选定 —— 遭遇是个未决状态）。
 */
export function runSighting(input: {
  deps: RouterDeps;
  character: CharacterState;
  locationId: string;
  now: number;
  seed: string;
}): SightingDisplay | null {
  const { deps, character, locationId, now, seed } = input;
  const candidates = candidatesAt(deps, locationId);
  if (candidates.length === 0) return null;

  const clock = timeOfDay(now);
  const night = clock === 'night';
  const foggy = isFoggy(now, deps.worldSeed ?? 'world');
  const world = worldViewFor(deps, now, locationId, character.pathway ?? undefined);
  const weatherText = weatherLabel(world.weather);

  const encounterRng = createSeededRng(seedFrom([seed, 'creature-encounter']));
  /*
   * M2.88：**当地权柄的遭遇倍率** —— 「战争」让这一带到处是东西，
   * 玩家走两趟就能感觉到，不用读播报。
   */
  const encounterRate = encounterRateAt(deps.world, locationId, now);
  const roll = rollEncounter({
    state: character,
    candidates,
    world: { night, foggy, rateMultiplier: encounterRate },
    rng: encounterRng,
  });

  // 无论命中与否都留档：这是「他为什么没遇到」的唯一答案来源
  deps.characters.appendEvents([
    {
      type: 'creature_encounter_roll',
      characterId: character.id,
      payload: {
        locationId,
        candidates: candidates.length,
        chance: Number(roll.chance.toFixed(4)),
        roll: Number(roll.roll.toFixed(4)),
        hit: roll.hit,
        night,
        foggy,
        speciesId: roll.picked?.species.id ?? null,
      },
      reason: roll.hit ? '遭遇命中' : '遭遇未命中',
      seed,
      createdAt: now,
    },
  ]);

  if (!roll.hit || !roll.picked) return null;

  const { creature, species } = roll.picked;
  const mortal = !isInitiated(character);
  const sighting = resolveSighting({
    state: character,
    creature,
    species,
    world: {
      locationId,
      locationName: deps.locations.get(locationId)?.name ?? locationId,
      foggy,
      night,
      weatherLabel: weatherText,
    },
    rng: createSeededRng(seedFrom([seed, 'creature-sighting'])),
    seed,
  });

  const sightingId = newSightingId(character.id, now);
  deps.creatures.recordSighting({
    id: sightingId,
    characterId: character.id,
    creatureId: creature.id,
    speciesId: species.id,
    layer: sighting.layer,
    seed,
    at: now,
  });

  const locationName = deps.locations.get(locationId)?.name ?? locationId;
  const playerSeq = sequenceOrInitiate(character);
  /*
   * M2.58 阶段三：**把这次目击接进信息生态**。
   *
   * 在此之前，你撞见了什么只留在你自己的档案里 —— 世界不会因此知道，
   * 不会传出去，也不会有人来管（src/domain/world/ 一处都没读过 sightings）。
   *
   * 这里做两件事，然后它们各自回到世界：
   *   1. 按域的**隐秘度**掷一次，传出去了就往 world_events 落一条匿名传闻；
   *   2. 无论传没传出去，那个域的**恐慌**都涨一点（发生过就该更紧张）。
   * 恐慌随后抑制该域的繁衍 —— 那是这一层真正的闭环。
   *
   * 整段包在 try 里：信息生态出问题不该让玩家这次探索失败。
   */
  let rumorEventId: string | null = null;
  /** M2.72：这条传闻失真了没有（因果图上决定 caused / mutated） */
  let rumorDistorted = false;
  try {
    const ecology = noteSightingForEcology({
      db: deps.db,
      zoneIndex: deps.zoneIndex,
      worldEvents: deps.worldEvents,
      locationId,
      locationName,
      sightingId,
      worldSeed: deps.worldSeed ?? 'world',
      now,
    });
    rumorEventId = ecology.rumorEventId;
    rumorDistorted = ecology.distorted;
  } catch {
    // 记不下来也要让玩家看到这次遭遇
  }
  /*
   * M2.60：为这次目击建因果节点。
   *
   * 它是这条链的**起点**：目击 → (传出去了) 传闻 → (有人在意) 势力反应。
   * 节点 id 由 sightingId 拼出，所以重放同一次目击得到同一个节点。
   */
  const severityForCausal = SEVERITY_BY_LAYER[sighting.layer] ?? 0.3;
  let sightingNodeId: string | null = null;
  try {
    sightingNodeId = new CausalRepo(deps.db).recordSighting({
      sightingId,
      characterId: character.id,
      locationId,
      speciesId: species.id,
      speciesName: species.name,
      layer: sighting.layer,
      intensity: severityForCausal,
      summary:
        character.name + '在' + locationName + '看见了' + species.name + '（' + sighting.layer + '）',
      ...(rumorEventId === null ? {} : { rumorEventId }),
      // M2.72：失真 → mutated 边（不传时是 caused，与 M2.60 逐位相同）
      ...(rumorDistorted ? { distorted: true } : {}),
      at: now,
    });
  } catch {
    // 因果图出问题不该让玩家这次探索失败
  }
  /*
   * M2.59：**势力对这次目击的反应**。
   *
   * 这是「哪个势力反应」这个问题第一次有答案 —— 在此之前，
   * world/events.ts 的 factionEvents() 从 M2.4 起就恒返回空数组，
   * 世界出了事只有播报，没有任何人动。
   *
   * 感知层次换算成严重度：看得越清楚 = 事越大。
   * 一个普通人只看到一团雾（blur），教会不会为它出动；
   * 一个序列 7 的人看见了本质（essence），那就是他们必须处理的事。
   */
  try {
    notePowerReactions({
      db: deps.db,
      powerIndex: deps.powerIndex,
      worldEvents: deps.worldEvents,
      locationId,
      locationName,
      kind: 'sighting',
      severity: severityForCausal,
      sourceId: sightingId,
      // M2.60：把反应挂回这次目击 —— 因果图上就是一条 responded 边
      ...(sightingNodeId === null ? {} : { sourceNodeId: sightingNodeId }),
      now,
    });
  } catch {
    // 势力反应出问题不该让玩家这次探索失败
  }
  /*
   * M2.13 前置 3：**把这一层的判定当场留档。**
   *
   * 为什么必须在这里写，而不是让报告脚本去 JOIN：
   * 感知层次是 `delta = 生物序列 − 玩家序列` 的函数，而**两边的序列都会变** ——
   * 玩家会晋升（9→8→7），生物会进化（序列 −1）。
   * 从 `sightings` JOIN `characters` / `creatures` 读出来的是「**现在**的序列」，
   * 不是判定当时的那个数。30 天窗口下这两者能差 1—2 级，
   * 而 `advantage` 那一层的宽度**只有 2**（delta ∈ [1, 2]）—— 差 1 就整层挪位。
   *
   * 所以判定的三个输入（玩家序列 / 生物序列 / 物种）与结果（层次）必须**同时**落库。
   *
   * ## 为什么不复用既有的 `creature_sighting`
   *
   * `creature_sighting` **已经有了**，写在 `encounter.ts` 的「遭遇处置」那一步
   * （payload 是 creatureId / speciesId / layer / action / harvest）。
   * 那一条记的是**玩家选了哪个动作**，发生时点比这里晚（玩家可能隔了几小时才回话），
   * 而它里面**没有序列** —— 序列正是这一轮要补的那一位。
   *
   * 往同名的类型里塞两种形状的 payload，会让「读 `creature_sighting` 的人」
   * 一半拿到带序列的、一半拿到不带的（而且分不清哪条是哪条）。
   * 所以这里用**另一个类型名**，与 `creature_encounter_roll` 对称：
   *   `creature_encounter_roll` —— 遇没遇到（含概率与抽样值）
   *   `creature_sighting_roll`  —— 看清到哪一层（含判定当时的双方序列）
   * 一条遭遇会同时留下这两条 + 处置那一条，各答一个问题。
   *
   * 这是一处**只增不改**的留档：它不参与任何判定，也不进 `signatureOf`（状态签名），
   * 而且**不进 `CREATURE_EVENT_TYPES`**（那是「遭遇次数」的口径，加进去会翻倍）。
   */
  deps.characters.appendEvents([
    {
      type: 'creature_sighting_roll',
      characterId: character.id,
      payload: {
        sightingId,
        locationId,
        layer: sighting.layer,
        playerSeq,
        creatureSeq: creature.sequence,
        /** delta 一并写下来：它是层次判据里唯一的那个数，报告不该再算一遍 */
        delta: creature.sequence - playerSeq,
        speciesId: species.id,
        speciesName: species.name,
        mortal,
        allowedActions: [...sighting.allowedActions],
      },
      reason: '感知分层判定',
      seed,
      createdAt: now,
    },
  ]);

  /*
   * M2.70：**标题里那一句氛围**（`creature.flavor` 的落点）。
   * 退回规则在 `encounterFlavorOf` 里（一处定义，与 .遭遇 处置回执共用）。
   */
  const titleFlavor = encounterFlavorOf({ flavor: species.flavor, visibleName: sighting.visible.name });

  const view: EncounterMenuView = {
    locationName,
    weatherLabel: weatherText,
    flavor: titleFlavor,
    text: sighting.text,
    layer: sighting.layer,
    allowedActions: sighting.allowedActions,
    behaviorText: sighting.behavior?.text ?? null,
    mortal,
    // M2.10 前置 2：动手那一项要写清「你比它弱几个序列」（只影响显示，不影响判定）。
    // 符号：玩家序列 − 生物序列，正数 = 玩家更弱（与 M2.6.1 的 diff 同号）
    sequenceGap: playerSeq - creature.sequence,
  };

  return {
    sightingId,
    layer: sighting.layer,
    // M2.70：与菜单标题**同一个生成函数**（格式只写一遍）
    headline: encounterTitleOf({ locationName, weatherLabel: weatherText, flavor: titleFlavor }),
    text: sighting.text,
    behaviorText: sighting.behavior?.text ?? null,
    menu: buildEncounterMenu(view),
    allowedActions: sighting.allowedActions,
  };
}

/**
 * 遭遇的候选池查询（虚拟玩家与报告用）：这个地点此刻有哪些生物、玩家能看清哪一层。
 * 纯查询，不落库、不掷骰。
 */
export function sightingPreview(
  deps: RouterDeps,
  character: CharacterState,
  locationId: string,
): Array<{ creature: Creature; species: CreatureSpecies; sequenceDelta: number; canSeeName: boolean }> {
  const playerSequence = sequenceOrInitiate(character);
  const mortal = !isInitiated(character);
  return candidatesAt(deps, locationId).map(({ creature, species }) => ({
    creature,
    species,
    sequenceDelta: creature.sequence - playerSequence,
    // 普通人不看 delta：他永远只看到最模糊的一层（M2.7.6 pathway_status 的兑现）
    canSeeName: !mortal && creature.sequence - playerSequence <= 0,
  }));
}

/** 遭遇判定的 domain event 类型（报告脚本据此统计遭遇次数） */
export const CREATURE_EVENT_TYPES = ['creature_encounter_roll', 'creature_sighting'] as const;

export type { DomainEvent };
