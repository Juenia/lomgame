/**
 * 路途事件表（M2.7 主任务三 §5.3）。
 *
 * 「移动本身是一段内容，不是传送」—— 这张表就是那句话的全部内容。
 * 事件本身是**纯数据**：谁会遇到什么、能选什么动作；怎么结算在 travel.ts。
 *
 * 两条设计约定：
 *   1. **每个事件给玩家一个选择**（任务书 §5.4：战斗 / 逃跑 / 观察 / 互动）。
 *      风浪没有「战斗」这个选项 —— 对着浪挥拳说不通，所以每个事件自己列可选动作，
 *      菜单层照抄这份清单生成按钮。
 *   2. **群播报只报「有人」，不报是谁**（与 M2.6 通缉播报同一口径）：
 *      路上发生了什么对整个群是气氛，对当事人是隐私。
 */

export type TravelChoiceId = 'fight' | 'flee' | 'observe' | 'interact';

export const TRAVEL_CHOICE_LABELS: Record<TravelChoiceId, string> = {
  fight: '战斗',
  flee: '逃跑',
  observe: '观察',
  interact: '互动',
};

export const TRAVEL_EVENT_IDS = [
  'storm',
  'sea_monster',
  'fog',
  'ghost_ship',
  'bandit',
  'beast',
  'traveler',
  'spirit_tide',
] as const;

export type TravelEventId = (typeof TRAVEL_EVENT_IDS)[number];

export interface TravelEventDef {
  id: TravelEventId;
  /** 中文名（回执与报告都用它，避免两处写死） */
  label: string;
  /** 只可能出现在哪类路线上；both = 陆海通用（任务书 §5.3 的「任意」两行） */
  kind: 'sea' | 'land' | 'both';
  /** 遭遇类：有敌意对象，所以「战斗 / 逃跑」才有意义 */
  encounter: boolean;
  /** 这个事件允许玩家选哪些动作 */
  choices: TravelChoiceId[];
  /** 私聊正文（当事人看到的） */
  text: string;
  /** 群播报（匿名）。null = 这件事不值得惊动整个群 */
  groupText: string | null;
}

export const TRAVEL_EVENTS: Record<TravelEventId, TravelEventDef> = {
  storm: {
    id: 'storm',
    label: '风浪',
    kind: 'sea',
    encounter: false,
    choices: ['observe', 'interact'],
    text: '甲板在脚底下翻了一个身。你抓住缆绳，咸水灌进领口，指甲缝里全是盐。',
    groupText: '海上起了风浪，有人正在浪里往回划。',
  },
  sea_monster: {
    id: 'sea_monster',
    label: '海怪',
    kind: 'sea',
    encounter: true,
    choices: ['fight', 'flee', 'observe'],
    text: '海面裂开一道口子，有什么东西正从下面往上看你 —— 它比船还长。',
    groupText: '有人在海上遇到了不属于已知物种的东西。',
  },
  fog: {
    id: 'fog',
    label: '迷雾',
    kind: 'both',
    encounter: false,
    choices: ['observe', 'interact'],
    text: '雾从四面八方合拢，罗盘开始自己转。你确定刚才走过这棵树。',
    groupText: null,
  },
  ghost_ship: {
    id: 'ghost_ship',
    label: '幽灵船',
    kind: 'sea',
    encounter: true,
    choices: ['fight', 'flee', 'observe', 'interact'],
    text: '一艘没有灯的三桅船从雾里驶出来。甲板上站满了人，一个都没有脸。',
    groupText: '雾里驶过一艘不该存在的船，看见的人都说不清它有多大。',
  },
  bandit: {
    id: 'bandit',
    label: '盗匪',
    kind: 'land',
    encounter: true,
    choices: ['fight', 'flee', 'observe', 'interact'],
    text: '路障后面走出四个人，为首的那个把刀在袖口上蹭了蹭，问你赶不赶时间。',
    groupText: '官道上又有人被拦了。',
  },
  beast: {
    id: 'beast',
    label: '野兽',
    kind: 'land',
    encounter: true,
    choices: ['fight', 'flee', 'observe'],
    text: '灌木丛里传来一声呼吸 —— 不属于任何你叫得出名字的动物。',
    groupText: null,
  },
  traveler: {
    id: 'traveler',
    label: '同行旅人',
    kind: 'both',
    encounter: false,
    choices: ['interact', 'observe'],
    text: '路边有人朝你招手。他的行李比你想象的重，而且他一直在看你的手。',
    groupText: null,
  },
  spirit_tide: {
    id: 'spirit_tide',
    label: '灵界渗透',
    kind: 'both',
    encounter: true,
    choices: ['observe', 'flee', 'interact'],
    text: '你忽然闻到自己童年的味道，而这里离家已经几百里。',
    groupText: '有旅人说，他在路上听见了不该听见的声音。',
  },
};

export function isTravelEventId(value: string): value is TravelEventId {
  return (TRAVEL_EVENT_IDS as readonly string[]).includes(value);
}

export function travelEventLabel(id: string): string {
  return isTravelEventId(id) ? TRAVEL_EVENTS[id].label : id;
}

export function travelEventDef(id: TravelEventId): TravelEventDef {
  return TRAVEL_EVENTS[id];
}

/** 事件 id → 中文名的查表（报告里按事件分布统计时用） */
export function travelEventLabels(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const id of TRAVEL_EVENT_IDS) out[id] = TRAVEL_EVENTS[id].label;
  return out;
}
