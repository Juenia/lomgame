/**
 * 世界地理域层出口（M2.7）。
 *
 * 目录结构：
 *   types.ts    区域 / 城市 / 航线 / 行程的数据形状（含 zod schema）
 *   geo.ts      GeoIndex —— 三张表的只读索引（城市查询、途径查询、路线查询）
 *   birth.ts    出生城市：由 userId 确定性派生（不可重选的结构性实现）
 *   events.ts   路途事件表（风浪 / 海怪 / 迷雾 / 幽灵船 / 盗匪 / 野兽 / 同行旅人 / 灵界渗透）
 *   travel.ts   移动判定：计划事件点、结算玩家的选择
 */
export * from './types.ts';
export { GeoIndex } from './geo.ts';
export { BIRTH_CITY_TAG, birthCityOf, birthCityIdOf, birthDistribution } from './birth.ts';
export {
  TRAVEL_CHOICE_LABELS,
  TRAVEL_EVENTS,
  TRAVEL_EVENT_IDS,
  isTravelEventId,
  travelEventDef,
  travelEventLabel,
  travelEventLabels,
  type TravelChoiceId,
  type TravelEventDef,
  type TravelEventId,
} from './events.ts';
export {
  MS_PER_HOUR,
  REGION_DANGER_NEUTRAL,
  choicesOf,
  effectiveRouteDanger,
  eventPointsFor,
  parseRouteEvents,
  planTravel,
  regionUneaseLine,
  resolveTravelChoice,
  travelWeightsOf,
  type PlannedTravelEvent,
  type TravelChoiceResult,
  type TravelPlan,
} from './travel.ts';
