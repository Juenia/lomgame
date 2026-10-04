/**
 * 选项驱动（M2.3）：菜单的数据形状。
 *
 * 三条硬约束写在这里，越界就是 bug：
 *   1. `Menu` 是**纯数据**：选项生成器是纯函数 `(character, world, location) → Menu`，
 *      不读库、不掷骰、不看 `Date.now()`；
 *   2. `MenuOption.command` 必须是**完整指令原文**（不含前导点号）——
 *      菜单只是入口，真正干活的永远是原来那条指令；
 *   3. `MenuOption.key` 里 `'0'` 固定是「自己写一个行为」（任务书 §5.3），
 *      其余是 `'1'` 起的连续数字。数字回复路由器按这个约定查表。
 */
import type { CharacterState, PathwayId } from '../character/types.ts';
import type { PathwayTags } from '../play/tags.ts';
import type { WorldClock } from '../world/clock.ts';
import type { WeatherId, WeatherState, WorldModifiers } from '../world/weather.ts';

/** 菜单归属（落 pending_menus.menu_type，用于排查与上下文推进） */
export type MenuType =
  | 'today'
  | 'play'
  | 'explore'
  | 'world'
  | 'brew'
  | 'drink'
  | 'promote'
  | 'rest'
  | 'purify'
  | 'trade'
  /** 任意指令执行完的「下一步」（任务书 §4） */
  | 'result'
  /** 玩家回了 0，等待自由输入（任务书 §5.3） */
  | 'freeform'
  /**
   * M2.4：世界公共事件的播报菜单（不是某个人的菜单，是「房间里的那张」）。
   * 玩家没有个人菜单时，数字回复会落到它上面（见 router/menu.ts 的 pick）。
   */
  | 'world_event'
  /** M2.5：晋升仪式的准备菜单（.仪式 准备） */
  | 'ritual'
  /**
   * M2.7：移动相关（目的地菜单 + 路途事件的选择菜单）。
   * 它必须是一个**独立的菜单类型**，因为虚拟玩家的菜单决策要认得它 ——
   * 路途事件不处理完，玩家在路上什么都做不了（服务端只放行查看类指令）。
   */
  | 'travel'
  /**
   * M2.7.6：创建角色时的性别选择。
   *
   * 它必须是一个独立类型，因为它是**唯一一个「玩家还没有角色」时存在的菜单** ——
   * 数字回复的分发要专门为它放行（见 router/index.ts 的 #handleMenuReply），
   * 而它的归属键不是 characterId，是 'create:<userId>'（见 create-menu.ts）。
   */
  | 'create'
  /**
   * M2.8：非凡生物遭遇（观察 / 对峙 / 撤退 / 互动）。
   *
   * 与 'travel' 同一个理由需要独立类型：遭遇是个**未决状态** ——
   * 玩家没选动作之前，那只生物还站在那里。虚拟玩家的菜单决策要认得它，
   * 否则它会像没看见一样走开，而「感知分层生效了没有」就无从验证。
   */
  | 'encounter'
  /**
   * M2.9：PVE 战斗的回合菜单（攻击 / 防御 / 技能 / 物品 / 撤退）。
   *
   * 与 'encounter' 同一个理由需要独立类型，而且更强：战斗是**跨指令的多回合状态**，
   * 玩家可能关掉 QQ 五分钟再回来 —— 虚拟玩家的决策必须认得它，
   * 否则它会在战斗里回一个不相干的数字，而「回合制到底有没有跑起来」就无从验证。
   */
  | 'battle'
  /**
   * M2.11：**挑战邀约**（应战者看到发起者状态之后的三个选择）。
   *
   * 与 'encounter' / 'battle' 同一个理由需要独立类型：它也是一个**未决状态** ——
   * 应战者没表态之前，那一场挑战悬在那里。虚拟玩家的菜单决策必须认得它，
   * 否则它会像没看见一样走开（实测过：不认这张菜单时，PVP 会一场都打不起来）。
   */
  | 'challenge';

/** 自由输入选项的固定 key（任务书 §5.3：菜单带 `0. 自己写一个行为`） */
export const FREEFORM_KEY = '0';

export interface MenuOption {
  /** '1' | '2' | … | '0'（'0' = 自己写一个行为，恒由渲染层补） */
  key: string;
  /** 显示文本 */
  label: string;
  /** 对应完整指令，如 '扮演 在码头观察雾中的影子' */
  command: string;
  /** 可选预览：匹配度、危险度、掉落倾向（只显示高/中/低，不给精确数值） */
  preview?: string;
  /** 不可选原因，有值则显示为灰色 */
  disabled?: string;
}

export interface Menu {
  title: string;
  /** 世界状态摘要，如 ['雾天', '夜晚', '危险 +20%'] */
  context: string[];
  options: MenuOption[];
  /** 是否显示 '0. 自己写一个行为' */
  allowFreeform: boolean;
}

/**
 * 玩家此刻看到的世界（M2.2 的 worldViewFor 已经算好的那一份）。
 * 菜单是纯函数，所以世界的所有输入都必须由调用方传进来 —— 这里不做任何 IO。
 */
export interface WorldSnapshot {
  clock: WorldClock;
  weather: WeatherId;
  modifiers: WorldModifiers;
  /** 今日在该地点已探索的次数（探索菜单的「今日 x/3 次」）；不给按 0 算 */
  exploreUsedToday?: number;
  /**
   * 可达地点的只读视图（探索菜单的「换个地方」选项要用）。
   * 由命令层从 locations 表 + explore_daily 表拼出来；纯函数不读库，所以必须传进来。
   */
  locations?: readonly LocationView[];
  /**
   * M2.4：各地点此刻的天气状态（含 since/until 与扩散 pending）。
   * 世界事件生成器靠它判断「这一刻某地刚要起血月 / 灰雾潮」——
   * 只读它，不读下面任何玩家字段（硬约束：事件生成器不读玩家状态）。
   */
  weatherStates?: readonly WeatherState[];
  /**
   * M2.53：**本小时真的换了天气**的地点 id。
   *
   * 原来生成器靠「weatherStates 里某个地点的 since 落在本小时」间接推断这件事 ——
   * 那在天气时长整齐时成立（恒 6 小时、起点整点 ⇒ since 永远是整点），
   * 一旦时长带上抖动就大范围失配：天气 14:37 过期，而 tick 只在整点跑，
   * 15:00 处理时 since 是 14:37，hourStartOf(14:37)=14:00 ≠ 15:00 ⇒ 环境事件整批丢。
   *
   * 可选：不给就退回旧判据（分析与复现脚本里手工构造的快照不用跟着改）。
   */
  weatherChangedThisHour?: readonly string[];
}

/** 探索菜单看到的一个地点（内容表 + 当日计数 + 该地点此刻的天气） */
export interface LocationView {
  id: string;
  name: string;
  /**
   * M2.7：这个地点属于哪座城市。
   * 缺省/空字符串 = 不归属任何城市（内容表没登记），此时**不参与城市过滤** ——
   * 与「老角色没有 currentCityId」同一个保守口径：宁可多给几个选项，
   * 也不要因为内容表漏登记而让玩家在菜单里看不到任何地方。
   * 做成可选字段，是为了让模拟器与报告脚本里那些手工构造 LocationView 的地方
   * （m23-menu-coverage / m24-event-coverage / world-tick）不用跟着改 —— 它们不关心城市。
   */
  city?: string;
  /** 危险度 0—5 */
  danger: number;
  /** 序列门槛（数字越小要求越高） */
  minSeq: number;
  maxSeq: number;
  /** 掉落表条目数（「掉落 N 种」，诚实反映产出面而不是拿危险度瞎编） */
  lootCount: number;
  /** 今日已探索次数 */
  usedToday?: number;
  /** 该地点此刻的天气（与当前地点可能不同 —— 这正是「换个地方」的意义） */
  weather?: WeatherId;
}

/**
 * 途径套件：菜单只认这三样。
 * 选项**从标签生成**而不是写死：标签改了（内容层），菜单跟着变。
 */
/**
 * M2.7：这个地点在不在玩家此刻的城市里。
 *
 * 两个方向都保守：
 *   - 玩家没有 currentCityId（M2.7 之前建的老角色、模拟器直接构造的角色）→ 不限制；
 *   - 地点没有归属城市（内容表漏登记）→ 不限制。
 * 两种情况都退回 M2.6 的「地点是平的」行为，绝不会让玩家面对一张空菜单。
 */
export function inCurrentCity(
  state: { currentCityId?: string | null },
  view: { city?: string },
): boolean {
  const cityId = state.currentCityId ?? null;
  if (!cityId) return true;
  if (!view.city) return true;
  return view.city === cityId;
}

export interface PathwayKit {
  id: PathwayId;
  /** 中文途径名（愚者 / 战士 / 不眠者） */
  label: string;
  tags: PathwayTags;
}

/** 背包里的一格（只读视图；命令层的 inventory.list() 直接可用） */
export interface InventoryItem {
  itemId: string;
  quantity: number;
  bindType?: string;
  /**
   * **中文名**（M2.100）。
   *
   * ⚠️ 它为什么必须有：背包的快捷按钮要写「使用 魔药·愚者·序列9」，
   * 而 `itemId` 是 `potion_seer_9` —— 按钮插进输入框的就是那串英文。
   * 命令层本来就认名字（`deps.items.findByNameOrName`），所以这里给得出名字，
   * 按钮就能写成玩家看得懂的那一条。
   * 查不到物品时退回 itemId（宁可难看，也不要空）。
   */
  name?: string;
  /** 物品大类（potion / material / consumable / sealed …）—— 快捷按钮的副标题用它 */
  kind?: string;
}

/** 任务书接口签名里写的 `Item[]`：就是背包格子 */
export type Item = InventoryItem;

/** 手上的魔药（命令层查 items 表得到；纯函数不读库） */
export interface PotionInBag {
  itemId: string;
  name: string;
  pathway?: PathwayId | undefined;
  seq?: number | undefined;
}

/**
 * 菜单生成器看到的角色 = 数据库里的那张卡 + 几张只读视图。
 * 用「交叉类型」而不是新接口：`buildPlayMenu(state: CharacterState, …)` 的签名
 * 仍然原样成立（多出来的字段是可选的），仓库里任何 CharacterState 都能直接传。
 */
export type MenuCharacter = CharacterState & {
  inventory?: readonly InventoryItem[];
  /** 队伍人数（有队友多「协作」选项）；1 = 独行 */
  partySize?: number;
  /** 当日已用次数（rest / purify / divination / play …） */
  dailyCounters?: Readonly<Record<string, number>>;
  /** 当日标签用量（匹配度分档要考虑复读惩罚） */
  tagUsage?: ReadonlyMap<string, number>;
  /** 手上的魔药（有魔药多「服用」） */
  potions?: readonly PotionInBag[];
  /** 序列 8 已解锁的能力名（如「小丑」）：菜单据此给出「用新能力做这件事」 */
  abilityName?: string;
  /** 是否队伍队长（决定「队伍任务」能不能发起） */
  isPartyLeader?: boolean;
  /** 当日已探索该地点的次数（键 = 地点 id）；与 WorldSnapshot.exploreUsedToday 二选一即可 */
  exploreCounts?: Readonly<Record<string, number>>;
  /** M2.7.6 / M2.85：手上还没用掉的配方线索条数（菜单的「看线索」项用它写 preview） */
  clueCount?: number;
};

/**
 * **这一种菜单是不是「正在进行的事」**（M2.109）。
 *
 * ## 为什么要有这张表
 *
 * 用户的原话：「玩家数据状态的处理**绑定太弱**了，包括遭遇了非凡事件的触发 ——
 * 倘若不小心点了别的按钮，也**直接无视接下去了**。状态绑定极差」。
 *
 * 事实确实如此：路由只对**裸数字**检查待答菜单（`#hasPendingMenu`），
 * 而**显式指令一律直接执行** —— 遭遇了一只生物、打到一半的战斗、仪式进行中，
 * 玩家随手发一条别的指令就绕过去了，那件事从此不再被提起。
 *
 * ## 判据
 *
 * 写在 `Record<MenuType, boolean>` 里：**加一个新的菜单类型而没在这里表态，tsc 直接红**
 * （AGENTS §3.1：清单只能有一份，且不许手抄 —— 抄漏了不会报错，只会安静地少挡一半）。
 *
 * `true` = 它是**正在进行的事**：没处理完之前，别的指令不能绕过（只放行查看类指令）。
 */
export const MENU_BLOCKS_OTHER_COMMANDS: Readonly<Record<MenuType, boolean>> = {
  battle: true,
  challenge: true,
  encounter: true,
  travel: true,
  ritual: true,
  create: true,
  // ⚠️ 它是「等你写一句话」—— 写什么都是回答，所以**不拦**（拦了玩家就写不出来了）
  freeform: false,
  today: false,
  play: false,
  explore: false,
  world: false,
  brew: false,
  drink: false,
  promote: false,
  rest: false,
  purify: false,
  trade: false,
  result: false,
  world_event: false,
};

/**
 * **任何未决状态下都放行的查看类指令**（M2.109）。
 *
 * 它们**不改变世界、也不推进任何事** —— 玩家在遭遇里想知道自己还有多少血，
 * 那不该被拦住。这份清单**有意保持最小**：每多一条，就多一个「在战斗里偷偷做别的事」的口子。
 */
export const VIEW_ONLY_COMMANDS: readonly string[] = ['状态', '帮助', '菜单', '图鉴', '今日', '世界'];

/**
 * **未决状态下仍然放行的「自己的指令」**（M2.109）。
 *
 * 光有 `MENU_BLOCKS_OTHER_COMMANDS` 是不够的 —— 第一版只放行查看类，结果把
 * 「撤退」「观察」「战斗 技能」这些**处理当前事物的指令**也拦了：20 条既有用例当场红。
 *
 * 判据是「**它属不属于眼前这件事**」：遭遇里可以发 `.遭遇`、战斗里可以发 `.战斗`、
 * 路上可以发 `.移动`。写在 `Record<MenuType, readonly string[]>` 里 —— 加一种菜单类型
 * 而不表态，**tsc 直接红**（AGENTS §3.1）。
 *
 * 空数组 = 这件事只能靠回数字处理（建号就是这样）。
 */
export const MENU_ALLOWED_COMMANDS: Readonly<Record<MenuType, readonly string[]>> = {
  battle: ['战斗', '遭遇'],
  challenge: ['挑战', '战斗', '袭击'],
  encounter: ['遭遇', '战斗'],
  travel: ['移动', '走'],
  ritual: ['仪式', '干扰'],
  create: [],
  freeform: [],
  today: [],
  play: [],
  explore: [],
  world: [],
  brew: [],
  drink: [],
  promote: [],
  rest: [],
  purify: [],
  trade: [],
  result: [],
  world_event: [],
};
