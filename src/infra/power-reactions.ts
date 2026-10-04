/**
 * 势力反应的接线（M2.59）：把「某地出了某件事」变成「谁动了、动了什么」。
 *
 * ## 这一层补的是哪个空壳
 *
 * `world/events.ts` 的 `factionEvents()` 从 M2.4 起就恒返回空数组，注释写着
 * 「等 M2.6 的势力表落地」—— 而 M2.6 落地的是**领地**（谁管哪块地），不是势力。
 * 于是「哪个势力反应」这个问题在过去 50 多个里程碑里没有答案：
 * 世界出了事，只有播报，没有任何人动。
 *
 * ## 它做什么
 *
 *   事件（目击 / 灾厄 / 环境异象）
 *     ├─> 属地势力按「目标 × 事件类型 × 警觉 × 资源」算反应强度
 *     ├─> 强度过门槛的动手（封锁 / 净化 / 巡逻 / 趁乱动手…）
 *     └─> 落一条 world_events（type: 'power'）让玩家看见，并累积它的警觉
 *
 * **警觉累积是闭环**：动过一次的势力下一次更容易再动（事态升级），
 * 而没人出事的时候它会慢慢落回去。与 M2.58 的生态恐慌同一个形状。
 */
import type { Db } from './db/sqlite.ts';
import type { WorldEvent } from '../domain/world/events.ts';
import type { WorldEventRepo } from './db/world-events.ts';
import { PowerStateRepo } from './db/power-state.ts';
import { INFLUENCE_NEUTRAL } from '../domain/world/power.ts';
import { CausalRepo } from './causal-log.ts';
import {
  ACTION_LABELS,
  alertDeltaOf,
  decayAlert,
  decayInfluence,
  enduranceOf,
  influenceDeltaOf,
  resolvePowerReactions,
  type PowerEvent,
  type PowerEventKind,
  type PowerIndex,
  type PowerReaction,
} from '../domain/world/power.ts';

/**
 * 势力动向事件的**基准**存活时间：势力动一次，玩家该有一段时间能看见。
 *
 * M2.67：真正落库时乘 `enduranceOf(power)`（0.5 + 财力）——
 * 富的势力那条「封锁了现场」挂 9 小时，穷的那条挂 3 小时。
 * 「钱决定能烧多久」在玩家侧就表现为**它在你消息流里留多久**。
 */
const POWER_EVENT_TTL_BASE_MS = 6 * 60 * 60 * 1000;

export interface PowerReactionInput {
  db: Db;
  powerIndex: PowerIndex;
  worldEvents: WorldEventRepo;
  /** 事件发生的地点；null = 全境（灾厄这类） */
  locationId: string | null;
  locationName: string | null;
  kind: PowerEventKind;
  /** 事件强度 0—1 */
  severity: number;
  /** 幂等键的来源：同一次事件重放得到同一批反应 id */
  sourceId: string;
  /**
   * M2.60：触发它的那个**因果节点** id（`sighting:xxx` / `worldevent:xxx`）。
   *
   * 不传 = 只记反应，不连因果边（旧口径，行为不变）。
   * 传了就把这次反应挂到它响应的事上 —— 那是「谁导致了谁」这条链的关键一步。
   */
  sourceNodeId?: string;
  now: number;
}

/**
 * 算势力反应、落库、播报。返回这次真的动了的那些。
 *
 * 幂等：反应 id 是 `power:<sourceId>:<powerId>`，落库是 INSERT OR IGNORE ——
 * 同一次事件重放不会重复播报（与 world_events 的既有做法一致）。
 */
export function notePowerReactions(input: PowerReactionInput): PowerReaction[] {
  if (input.powerIndex.size === 0) return [];
  const event: PowerEvent = {
    kind: input.kind,
    locationId: input.locationId,
    severity: Math.min(1, Math.max(0, input.severity)),
    at: input.now,
    sourceId: input.sourceId,
  };
  const states = new PowerStateRepo(input.db);
  const reactions = resolvePowerReactions({
    powers: input.powerIndex.powers,
    event,
    states: states.all(),
    isHomeOf: (powerId, locationId) => input.powerIndex.isHomeOf(powerId, locationId),
  });
  if (reactions.length === 0) return [];

  const events: WorldEvent[] = [];
  for (const reaction of reactions) {
    // 先累积警觉：动过一次的势力下一次更容易再动
    states.recordReaction(reaction.powerId, input.now, alertDeltaOf(reaction));
    /*
     * M2.67：**影响力也要动** —— 属地内涨、属地外落（见 influenceDeltaOf）。
     *
     * 放在这里而不是判定层：判定层不认识 power_state，它只回报「谁动了、动了多大」
     *（与 M2.65 的行动标记同一条纪律：判定层算，命令层/接线层写）。
     */
    const isHome = input.powerIndex.isHomeOf(reaction.powerId, input.locationId);
    states.addInfluence(reaction.powerId, influenceDeltaOf(reaction, isHome), input.now);
    const power = input.powerIndex.byId(reaction.powerId);
    events.push({
      id: reaction.id,
      type: 'power',
      text: powerEventText(reaction, input.locationName),
      visibility: 'public',
      factionId: reaction.powerId,
      createdAt: input.now,
      // M2.67：财力决定这条公告挂多久（它有钱一直守在那儿）
      expiresAt: input.now + Math.round(POWER_EVENT_TTL_BASE_MS * (power ? enduranceOf(power) : 1)),
      /*
       * ⚠️ **刻意不带数字选项**。
       *
       * 带选项的代价是一处真实踩到的坑：数字回复落到「最新一条还有效的事件」上
       * （Router 的 latestLive），而势力动向是在原事件之后几毫秒落的 ——
       * 于是玩家打「1」命中的是「教会加派了巡逻」，而不是那条他真正该回应的消息。
       * test/m2-4.test.ts 抓住了它（回数字不再执行成探索）。
       *
       * 语义上也该如此：势力动向是**对某件事的响应**，不是一件独立的事。
       * 玩家要行动，回应的应该是触发它的那条消息；这条只负责让他看见「有人动了」。
       */
    });
  }
  input.worldEvents.insertMany(events);
  /*
   * M2.60：把这几条反应记进因果图，各自连一条 responded 边回它响应的事。
   *
   * 没有这一步的话，一次势力反应只是一条孤立的播报 ——
   * 「教会为什么封锁了老码头」这个问题在任何地方都查不到答案。
   */
  if (input.sourceNodeId !== undefined) {
    const causal = new CausalRepo(input.db);
    for (const reaction of reactions) {
      causal.recordReaction({
        powerId: reaction.powerId,
        powerName: reaction.powerName,
        action: ACTION_LABELS[reaction.action],
        sourceId: input.sourceId,
        sourceNodeId: input.sourceNodeId,
        locationId: input.locationId,
        at: input.now,
      });
    }
  }
  return reactions;
}

/**
 * 势力动向的播报正文。第一行是抬头（与其它世界事件同一约定）。
 *
 * 措辞按**动作**分，因为玩家真正需要读出来的是「他们正在做什么」，
 * 而不是「谁相关度多少」—— 后者进 reason 字段给报告看。
 */
export function powerEventText(reaction: PowerReaction, locationName: string | null): string {
  const where = locationName ?? '全境';
  const what = ACTION_LABELS[reaction.action];
  const scale =
    reaction.strength >= 0.7 ? '大张旗鼓地' : reaction.strength >= 0.5 ? '认真地' : '试探性地';
  return '【势力 · ' + reaction.powerName + '】\n' + reaction.powerName + '在' + where + scale + what + '。';
}

/**
 * 警觉的小时衰减 —— 由世界 tick 一起跑（它本来就是每小时一次）。
 *
 * 与生态恐慌同一个挂点、同一个理由（M2.58 的 decayZoneFear）：
 * 分成两个定时器就会出现「衰减跑过了但 tick 没跑」这种只在并发窗口里发作的中间态。
 */
export function decayPowerAlert(db: Db, powerIndex: PowerIndex, now: number, hours: number): number {
  if (hours <= 0) return 0;
  const repo = new PowerStateRepo(db);
  const states = repo.all();
  let changed = 0;
  for (const power of powerIndex.powers) {
    const state = states.get(power.id);
    if (state === undefined) continue;
    let touched = false;
    if (state.alert > 0) {
      repo.setAlert(power.id, decayAlert(state.alert, hours), now);
      touched = true;
    }
    /*
     * M2.67：**影响力向中性值回归**（涨上去的会落回来，掉下去的会慢慢长回来）。
     *
     * 与警觉挂在同一个 tick、同一个理由（M2.58 的 decayZoneFear）：分成两个定时器
     * 就会出现「衰减跑过了但 tick 没跑」这种只在并发窗口里发作的中间态。
     */
    if (Math.abs(state.influence - INFLUENCE_NEUTRAL) > 1e-6) {
      repo.setInfluence(power.id, decayInfluence(state.influence, hours), now);
      touched = true;
    }
    if (touched) changed += 1;
  }
  return changed;
}