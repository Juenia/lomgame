/**
 * 命令层的通缉钩子（M2.6）。
 *
 * 为什么单独一个文件，而不是塞进 commands/common.ts：
 *   common.ts 是「所有命令都要用」的基础工具；通缉钩子只有**行动类指令**才用，
 *   而且它比一般工具重（会改状态、写事件、发播报）。分开之后，
 *   「哪些命令接了通缉判定」这件事在 import 图上就看得见。
 *
 * 两条设计约定：
 *   1. **一行接入**：命令层结算完自己的状态之后调用 tollOnAction，它追加罚款 / 掉血与播报。
 *   2. **每次判定都把 seed 写进 domain_events**（任务书 §二硬约束）：
 *      事件里带 chance / roll，复现时用同一个 seed 能重建同一个 roll。
 *
 * ⚠️ M2.85：原第 1 条「基础 AP 照旧由各命令自己扣」与「追加扣 AP」随行动值机制移除。
 */
import { NUMERIC } from '../../config/numeric.ts';
import { createSeededRng, seedFrom } from '../../domain/rng.ts';
import { CURRENCY_ITEM_ID } from '../../domain/item/item.ts';
import { clamp } from '../../domain/character/rules.ts';
import { factionOfLocation, factionLabel, isWildLocation } from '../../domain/faction/faction.ts';
import {
  defaultWantedWorld,
  pickActiveWanted,
  resolveWanted,
  type WantedAction,
  type WantedResult,
  type WantedState,
} from '../../domain/wanted/wanted.ts';
import type { CharacterState, DomainEvent } from '../../domain/character/types.ts';
import type { RouterDeps } from '../index.ts';
import { FLAG_LOCATION, FLAG_REPUTATION } from '../../infra/db/flags.ts';
import { applyFor } from './common.ts';

const CFG = NUMERIC.wanted;

/* ---------------- 当前地点 ---------------- */

/** 玩家此刻在哪（没有记录 = null，判定层按安全处理） */
export function currentLocationOf(deps: RouterDeps, characterId: string): string | null {
  return deps.flags.value(characterId, FLAG_LOCATION);
}

/**
 * 记下「玩家现在在哪」。
 *
 * 为什么要这个：通缉的整个玩法都建立在「势力范围」上，而角色表里没有位置字段
 * （任务书 §三 不许新增角色相关表）。落库路径见 FLAG_LOCATION 的注释。
 * 什么时候写：一切**明确指向某个地点**的行动 —— 探索、事件卡、袭击目标所在处。
 */
export function setCurrentLocation(
  deps: RouterDeps,
  characterId: string,
  locationId: string,
  now: number,
): void {
  deps.flags.set(characterId, FLAG_LOCATION, now, locationId);
}

/**
 * 带兜底的所在地点：从没记录过的角色算在新手城（廷根市，警察厅地盘）。
 * 判定层自己不认识"兜底"这件事 —— 它只认注入进来的 locationId，
 * 所以「新号算在哪」是一条命令层的策略，不是判定规则。
 */
export function locationOrDefault(deps: RouterDeps, characterId: string): string {
  return currentLocationOf(deps, characterId) ?? CFG.defaultLocationId;
}

/* ---------------- 信誉 ---------------- */

export function reputationOf(deps: RouterDeps, characterId: string): number {
  const raw = deps.flags.value(characterId, FLAG_REPUTATION);
  const parsed = raw === null ? NaN : Number(raw);
  return Number.isFinite(parsed) ? parsed : CFG.reputation.initial;
}

/** 加减信誉（夹在 numeric 给的区间里）。返回新值，方便回执直接引用 */
export function addReputation(
  deps: RouterDeps,
  characterId: string,
  delta: number,
  now: number,
): number {
  const next = clamp(
    reputationOf(deps, characterId) + delta,
    CFG.reputation.min,
    CFG.reputation.max,
  );
  deps.flags.set(characterId, FLAG_REPUTATION, now, String(next));
  return next;
}

/* ---------------- 通缉状态查询 ---------------- */

export function activeWantedOf(deps: RouterDeps, characterId: string, now: number): WantedState[] {
  return deps.wanted.listActiveOf(characterId, now);
}

/** 状态面板里的那一行；没被通缉时返回 null（不占版面） */
export function wantedStatusLine(
  deps: RouterDeps,
  characterId: string,
  now: number,
): string | null {
  const states = activeWantedOf(deps, characterId, now);
  if (states.length === 0) return null;
  // ⚠️ 必须用 locationOrDefault（带新手城兜底），不能用 currentLocationOf：
  // 判定层走的是兜底后的地点，这里如果读裸值，新号会显示"你在无主的地方，暂时安全"，
  // 而判定层同时在廷根市盘查他 —— 同一个语义两种结果是最难查的那类 bug。
  const here = locationOrDefault(deps, characterId);
  const parts = states.map((state) => {
    const days = Math.ceil(Math.max(0, state.expiresAt - now) / (24 * 3600 * 1000));
    return state.level + ' 级（' + factionLabel(state.factionId) + '，剩 ' + days + ' 天）';
  });
  const hereName = deps.locations.get(here)?.name ?? here;
  const safe = isWildLocation(here);
  return (
    '通缉：' + parts.join('、') +
    (safe
      ? '　—— 你现在在' + hereName + '（无主的地方），暂时安全'
      : '　—— 你现在在' + hereName + '（' + factionLabel(factionOfLocation(here)) + '的地盘），会被找上门')
  );
}

/* ---------------- 遭遇结算 ---------------- */

export interface WantedToll {
  /** 判定结果（纯函数产物，原样带出来给报告与测试看） */
  result: WantedResult;
  /** 实际罚掉的款（便士；可能因为钱不够而少于判定值） */
  finePenny: number;
  /** 实际掉的血 */
  hpDrain: number;
  /** 需要追加到回执里的行 */
  lines: string[];
  /** 需要播报的「有可疑人物出现」文本；不需要则为 null */
  suspiciousBroadcast: string | null;
}

export interface WantedTollInput {
  deps: RouterDeps;
  /** 已经扣过基础 AP 之后的角色状态 */
  state: CharacterState;
  /** 玩家此刻在哪（通常 = currentLocationOf） */
  locationId: string | null;
  action?: WantedAction['type'];
  now: number;
  /** 判定 seed：由调用方按「消息 id + 角色 + 时间」派生，保证可复现 */
  seed: string;
}

/**
 * 结算一次「在势力范围内行动」的遭遇。
 *
 * 顺序：
 *   1. 挑出此刻在管他的那条通缉令（pickActiveWanted）；
 *   2. 纯函数判定（resolveWanted）；
 *   3. 追加 AP → 罚款 → 掉血；
 *   4. 写 domain_events（带 seed / chance / roll）。
 */
export function applyWantedToll(input: WantedTollInput): { state: CharacterState; toll: WantedToll } {
  const { deps, now, seed } = input;
  const factionIdHere = factionOfLocation(input.locationId);
  const states = activeWantedOf(deps, input.state.id, now);
  const active = pickActiveWanted(states, factionIdHere, now);

  const rng = createSeededRng(seedFrom([seed, 'wanted']));
  const result = resolveWanted(
    active,
    { type: input.action ?? 'act', locationId: input.locationId },
    defaultWantedWorld(),
    rng,
  );

  const toll: WantedToll = {
    result,
    finePenny: 0,
    hpDrain: 0,
    lines: [],
    suspiciousBroadcast: null,
  };
  if (result.encounter === 'none') return { state: input.state, toll };

  let state = input.state;
  const events: DomainEvent[] = [];

  // 命中才有的惩罚：罚款 + 掉血
  if (result.hit && result.finePenny > 0) {
    const wallet = deps.inventory.count(state.id, CURRENCY_ITEM_ID);
    const charged = Math.min(result.finePenny, wallet);
    if (charged > 0 && deps.inventory.tryRemove(state.id, CURRENCY_ITEM_ID, charged, now)) {
      toll.finePenny = charged;
      events.push({
        type: 'wanted_fine',
        characterId: state.id,
        payload: {
          level: result.level,
          factionId: result.factionId,
          charged,
          wanted: result.finePenny,
        },
        reason: '通缉罚款',
        seed,
        createdAt: now,
      });
    }
  }
  if (result.hit && result.hpDrain > 0) {
    const applied = applyFor(deps, state, [{ type: 'hp', value: -result.hpDrain }], '通缉围剿', now, seed);
    if (!applied.rejected) {
      state = applied.newState;
      events.push(...applied.events);
      toll.hpDrain = result.hpDrain;
    }
  }

  events.push({
    type: 'wanted_encounter',
    characterId: state.id,
    payload: {
      level: result.level,
      encounter: result.encounter,
      factionId: result.factionId,
      locationId: input.locationId,
      chance: result.chance,
      roll: result.roll,
      hit: result.hit,
      finePenny: toll.finePenny,
      hpDrain: toll.hpDrain,
    },
    reason: '通缉遭遇:' + result.action,
    seed,
    createdAt: now,
  });
  deps.characters.appendEvents(events);

  toll.lines = renderWantedTollLines(result, toll);
  toll.suspiciousBroadcast = suspiciousText(deps, state, input.locationId, result, now);
  return { state, toll };
}

function renderWantedTollLines(result: WantedResult, toll: WantedToll): string[] {
  const lines: string[] = [];
  lines.push('');
  lines.push(
    '【通缉 · ' + result.level + ' 级 · ' + factionLabel(result.factionId ?? 'none') + ' · ' +
      result.action + '】',
  );
  lines.push(...result.narrative);
  const costs: string[] = [];
  if (toll.finePenny > 0) costs.push('罚款 ' + toll.finePenny + ' 便士');
  if (toll.hpDrain > 0) costs.push('生命 -' + toll.hpDrain);
  lines.push(costs.length > 0 ? costs.join('，') : '这次没被按住。');
  return lines;
}

/**
 * **一行接入**：命令层结算完自己的基础 AP 之后调用它。
 *
 *   const outcome = tollOnAction({ deps, state, baseApCost: 1, now, seed });
 *   state = outcome.state;
 *   lines.push(...outcome.lines);
 *
 * 它替调用方做完三件事：判定 + 发播报 + 把要追加的回执行返回。
 * 角色状态仍然由调用方 `deps.characters.update(state)` 统一落库 ——
 * 这条边界不能破，否则同一条指令里会出现两次 update。
 */
export interface WantedTollOutcome {
  state: CharacterState;
  /** 要追加到回执里的行；没有遭遇时是空数组 */
  lines: string[];
}

export function tollOnAction(input: {
  deps: RouterDeps;
  /** 当前角色状态 */
  state: CharacterState;
  now: number;
  seed: string;
  action?: WantedAction['type'];
  /** 明确的地点；不传则用"这个角色此刻在哪"（带新手城兜底） */
  locationId?: string | null;
}): WantedTollOutcome {
  const { deps } = input;
  const locationId =
    input.locationId === undefined ? locationOrDefault(deps, input.state.id) : input.locationId;
  const { state, toll } = applyWantedToll({
    deps,
    state: input.state,
    locationId,
    ...(input.action ? { action: input.action } : {}),
    now: input.now,
    seed: input.seed,
  });
  if (toll.suspiciousBroadcast) deps.broadcast?.(toll.suspiciousBroadcast);
  return { state, lines: toll.lines };
}

/* ------------------------------------------------------------------ *
 * 「有可疑人物出现」播报（按 角色 × 地点 节流）
 * ------------------------------------------------------------------ */

function alertFlagOf(locationId: string): string {
  return 'wanted_alert:' + locationId;
}

/**
 * 通缉犯在势力范围内露面的群播报。
 *
 * 节流是必须的：没有它，一个被通缉的玩家在廷根市连按 10 条指令就刷 10 条群消息。
 * 节流键是 **角色 × 地点**（不是全局）：他去完廷根、又跑到贝克兰德，两边都该播一次。
 */
export function suspiciousText(
  deps: RouterDeps,
  state: CharacterState,
  locationId: string | null,
  result: WantedResult,
  now: number,
): string | null {
  if (!result.suspicious || !locationId) return null;
  const flag = alertFlagOf(locationId);
  const last = Number(deps.flags.value(state.id, flag) ?? 0);
  if (Number.isFinite(last) && last > 0 && now - last < CFG.suspiciousBroadcastCooldownMs) return null;
  deps.flags.set(state.id, flag, now, String(now));
  return (
    '【' + factionLabel(result.factionId ?? 'none') + '】的地界上有人报官：**有可疑人物出现**。'
  );
}
