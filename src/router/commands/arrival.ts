/**
 * 到达结算与路途事件的待决判断（M2.7）。
 *
 * 为什么单独一个文件（而不是塞进 move.ts 或 common.ts）：
 *   它是**所有指令的公共前置**——玩家在路上时，任何一条指令都可能触发「你已经到了」。
 *   放在 move.ts 里会让 common.ts 反过来 import 命令层，
 *   放在 common.ts 里又会让它长成第二个大杂烩。
 *
 * 两条时间线要分清：
 *   - **到达**（arrivesAt）：到点就完成，玩家不用做任何事 —— 这是「移动消耗游戏时间」的兑现；
 *   - **事件**（events[].at）：到点后变成「待决」，玩家要做一次选择（战斗/逃跑/观察/互动）。
 *     如果玩家一直没有回应、而行程已经结束，则**自动按观察结算** ——
 *     否则那条 travels 行会永远挂在那里，玩家每次上线都被同一件事拦住。
 */
import { NUMERIC } from '../../config/numeric.ts';
import { capsFromAbilityEffects, NO_ABILITY_EFFECTS } from '../../domain/ability/ability.ts';
import { mortalCapsFor } from '../../domain/initiation/index.ts';
import { applyWithCaps } from '../../domain/effect/apply.ts';
import {
  REGION_DANGER_NEUTRAL,
  choicesOf,
  isTravelEventId,
  regionUneaseLine,
  resolveTravelChoice,
  travelEventDef,
} from '../../domain/geo/index.ts';
import type { TravelChoiceId, TravelEventId } from '../../domain/geo/index.ts';
import { createSeededRng, seedFrom } from '../../domain/rng.ts';
import type { CharacterState, DomainEvent } from '../../domain/character/types.ts';
import { FLAG_LOCATION } from '../../infra/db/flags.ts';
import type { TravelEventRecord, TravelRecord } from '../../infra/db/geo.ts';
import type { RouterDeps } from '../index.ts';

export interface PendingTravelEvent {
  travel: TravelRecord;
  record: TravelEventRecord;
  eventId: TravelEventId;
  label: string;
  text: string;
  choices: TravelChoiceId[];
}

/** 玩家此刻有没有「到点了、还没决定」的路途事件 */
export function pendingTravelEvent(
  deps: RouterDeps,
  characterId: string,
  now: number,
): PendingTravelEvent | null {
  const travel = deps.travels.activeOf(characterId);
  if (!travel) return null;
  const due = travel.events.find((entry) => !entry.resolved && entry.at <= now);
  if (!due) return null;
  // 行程里的事件 id 是 TEXT 列读出来的（string）；内容表改过 id 时可能对不上，
  // 那种情况下按「没有这件事」处理 —— 宁可少一件，也不要让 .移动 崩掉
  if (!isTravelEventId(due.id)) return null;
  const def = travelEventDef(due.id);
  return {
    travel,
    record: due,
    eventId: due.id,
    label: def.label,
    text: def.text,
    choices: choicesOf(due.id),
  };
}

/** 应用一批 delta（与 common.ts 的 applyFor 同一套上限口径，但这里不依赖命令层公共模块） */
function applyTravel(
  deps: RouterDeps,
  state: CharacterState,
  deltas: Parameters<typeof applyWithCaps>[1],
  reason: string,
  now: number,
  seed: string,
) {
  // M2.7.6：普通人没有途径（也就没有能力），但要叠上普通人的属性上限
  const effects = state.pathway
    ? deps.abilities.effectsOf(state.id, state.pathway)
    : NO_ABILITY_EFFECTS;
  return applyWithCaps(state, deltas, reason, now, seed, {
    ...capsFromAbilityEffects(effects),
    ...mortalCapsFor(state),
  });
}

export interface ArrivalResult {
  character: CharacterState;
  /** 已经到了（这次调用完成的） */
  arrived: boolean;
  lines: string[];
  /** 到达的城市 id（没到达时 null） */
  cityId: string | null;
}

/**
 * 把「已经到点」的行程结算掉。任何指令前都可以安全调用（没在旅行就什么都不做）。
 *
 * 三件事的顺序不能变：
 *   1. 先把未决事件按「观察」补结算（玩家不在场也得有个结果）；
 *   2. 再切城市 + 落地点（通缉系统读的是 flags.loc，必须与城市同时更新）；
 *   3. 最后写 domain_events（复现与报告的证据链）。
 */
export function settleArrival(
  deps: RouterDeps,
  character: CharacterState,
  now: number,
): ArrivalResult {
  const travel = deps.travels.activeOf(character.id);
  if (!travel) return { character, arrived: false, lines: [], cityId: null };
  if (now < travel.arrivesAt) return { character, arrived: false, lines: [], cityId: null };

  const route = deps.routes.get(travel.routeId);
  if (!route) {
    // 路线被内容表删了：不把玩家永远扣在路上，直接把行程标成中止
    travel.status = 'aborted';
    deps.travels.update(travel);
    return { character, arrived: false, lines: ['这条路线上已经什么都没有了，你折返了。'], cityId: null };
  }

  const events: DomainEvent[] = [];
  const lines: string[] = [];
  let state = character;

  // 1) 没来得及决定的事件：按「观察」补结算（最保守的选择，不会替玩家冒险）
  for (const entry of travel.events) {
    if (entry.resolved) continue;
    if (!isTravelEventId(entry.id)) {
      entry.resolved = true;
      continue;
    }
    const result = resolveTravelChoice({
      eventId: entry.id,
      choice: 'observe',
      routeDanger: route.danger,
      rng: createSeededRng(seedFrom([travel.id, entry.id, 'auto-observe'])),
    });
    const applied = applyTravel(deps, state, result.deltas, `旅途事件:${entry.id}:auto`, now, travel.id);
    state = applied.newState;
    events.push(...applied.events);
    entry.resolved = true;
    entry.choice = 'observe';
    entry.outcome = `（未及决定）${result.outcome}`;
    lines.push(`路上还发生了【${travelEventDef(entry.id).label}】，你没来得及应对 —— ${result.outcome}。`);
  }

  // 2) 切城市 + 落地点
  // 为什么直接写 flag 而不用 wanted-hooks 的 setCurrentLocation：
  // 那会形成 common.ts → arrival.ts → wanted-hooks.ts → common.ts 的循环依赖。
  // 落下来的东西是同一个（flags.loc 存地点 id），这里只是少绕一层。
  const city = deps.geo.city(route.to);
  state = { ...state, currentCityId: route.to, updatedAt: now };
  deps.characters.update(state);
  if (city) deps.flags.set(state.id, FLAG_LOCATION, now, city.center);

  // 3) 行程收尾
  travel.status = 'arrived';
  travel.events = travel.events.map((entry) => ({ ...entry, resolved: true }));
  deps.travels.update(travel);

  events.push({
    type: 'travel_arrive',
    characterId: state.id,
    payload: {
      travelId: travel.id,
      routeId: route.id,
      from: route.from,
      to: route.to,
      hours: route.duration_hours,
      costPenny: route.cost_penny,
      events: travel.events.map((entry) => entry.id),
    },
    reason: `移动:${route.from}->${route.to}`,
    seed: travel.id,
    createdAt: now,
  });
  deps.characters.appendEvents(events);

  const regionName = deps.geo.regionName(route.to);
  lines.unshift(
    `你抵达了${city?.name ?? route.to}（${regionName}）。` +
      `这趟${route.type === 'sea' ? '海路' : '陆路'}走了 ${route.duration_hours} 小时。`,
  );
  /*
   * M2.71：**陌生感**（Region.danger 的第二个读取点）。
   * 只在太凶（≥0.7）或太顺（≤0.3）的区域说一句 —— 中间那一段返回 null，
   * 每趟都感慨等于没感慨。
   */
  const unease = regionUneaseLine(deps.geo.regionOfCity(route.to)?.danger ?? REGION_DANGER_NEUTRAL);
  if (unease !== null) lines.push(unease);
  return { character: state, arrived: true, lines, cityId: route.to };
}

/** 路途进度文案（.移动 无参且在路上时） */
export function travelProgressText(
  deps: RouterDeps,
  travel: TravelRecord,
  now: number,
): string {
  const route = deps.routes.get(travel.routeId);
  const remainingHours = Math.max(0, (travel.arrivesAt - now) / (60 * 60 * 1000));
  const target = route ? (deps.geo.city(route.to)?.name ?? route.to) : '某个地方';
  const pending = travel.events.filter((entry) => !entry.resolved).length;
  const lines = [
    `你正在去${target}的路上，还剩 ${remainingHours.toFixed(1)} 小时。`,
    `路上已经安排好的事：${travel.events.length} 件，其中 ${pending} 件还没处理。`,
  ];
  if (pending === 0) lines.push('（没事就等着吧 —— 到了会自动告诉你，或者你随手发一条指令也会结算。）');
  return lines.join('\n');
}

/** 路线花费的展示口径（.移动 校验与回执共用一份，避免两处各写一遍） */
export function travelCostLabel(deps: RouterDeps, routeId: string): string {
  const route = deps.routes.get(routeId);
  if (!route) return '—';
  return `${route.cost_penny} 便士 · ${route.duration_hours} 小时`;
}
