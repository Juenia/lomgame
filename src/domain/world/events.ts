/**
 * 世界公共事件流（M2.4）—— 判定层纯函数，**没有任何 IO**。
 *
 * 硬约束（任务书第二节）：
 *   1. `generateWorldEvents(world, now, seed)` 只读**世界状态**：
 *      时段 / 天气 / 月相 / 雾日 / 季节 / 星期…… 以及各地点此刻的天气状态（含 since）。
 *      **一个玩家字段都不读** —— 这是 4 个分片能看见同一串事件的前提，
 *      也是 `test/m2-4.test.ts` 里「改玩家字段不改输出」那条测试守的东西。
 *   2. 同 seed 同输出：整条链路只用 `createSeededRng(seedFrom([...]))`，
 *      连事件的 id 都是「原因」拼出来的，不是一个自增序号或随机串。
 *   3. 不进 IO：落库 / 播报 / 限频的**执行**都在 infra 层（infra/world-tick.ts + db/world-events.ts），
 *      这里只回答「这一刻世界上该发生什么」。
 *
 * 五类事件（任务书 §1 的类型 + §2 的生成规则）：
 *   environment 环境   —— 血月 / 灵界渗透 / 灰雾潮**开始时**（天气驱动）
 *   discovery   发现   —— 某个地点出了事（低频，每日至多一次；雾日加权）
 *   rumor       传闻   —— 每天 1—3 条，匿名，真假难辨
 *   faction     势力   —— **占位**：M2.6 接入「势力控制地点变化」
 *   calamity    灾厄   —— **M2.14 已接入**：纯 seed 派生的世界状态
 *                        （见 domain/world/calamity.ts），灾厄开始的整点播一条
 *
 * 关于「某地点被探索 N 次后」这条生成规则的落地方式（任务书 §2 表格）：
 *   「被探索 N 次」是**玩家侧**的计数；而硬约束要求生成器不读玩家状态。
 *   两者不可兼得，本轮按硬约束办：发现事件用**世界侧**的低频规则触发
 *   （每天至多一次，雾日 ×1.6），口径写在 docs/M2.4-世界事件覆盖.md。
 *   这么做的额外好处是分片安全：按玩家计数的话，每片只有 1/4 的玩家，
 *   4 片必然算出 4 串不同的事件，「4 片看到相同世界事件」直接不成立。
 */
import { NUMERIC } from '../../config/numeric.ts';
import { createSeededRng, seedFrom } from '../rng.ts';
import type { WorldSnapshot } from '../menu/types.ts';
import { dayIndexOf, hourStartOf, hourOf } from './clock.ts';
import { calamityAt, calamityDayAnchor, type Calamity } from './calamity.ts';
import { normalizeWeather, weatherFlavor, type WeatherState } from './weather.ts';

export type WorldEventType =
  | 'environment'
  | 'discovery'
  /**
   * 势力（M2.6 留的空壳，M2.59 终于用上了）。
   *
   * ⚠️ 与 M2.4 起就在的 `faction` **不是**同一个东西：
   *   faction —— M2.4 规划里的「势力控制地点变化」，从来没人填过这个函数体；
   *   power   —— M2.59 的「势力对某件事做出了反应」（封锁 / 净化 / 趁乱动手）。
   * 前者是地盘的**变化**，后者是对事件的**响应**。
   * 保留 faction 不动（它是 M2.4 账上的一项，删掉会让那笔账无从对起），
   * 新事件一律用 power。
   */
  | 'power'
  | 'faction'
  | 'calamity'
  | 'rumor';

export type WorldEventVisibility = 'public' | 'anonymous' | 'faction';

export interface WorldEventOption {
  /** '1' | '2' | … （与 M2.3 菜单的键同一套约定） */
  key: string;
  label: string;
  /** 对应完整指令（M2.3 硬约束：菜单只是入口，真正干活的永远是原来那条指令） */
  command: string;
}

export interface WorldEvent {
  id: string;
  type: WorldEventType;
  /**
   * 播报正文。**第一行是抬头**（如 `【世界 · 老码头】`），其余行是正文 ——
   * 表里只有一个 text 列（任务书 §6 的 DDL），所以抬头与正文同列存放，
   * 渲染层按第一个换行拆开（domain/menu/world-event.ts 的 worldEventMenu）。
   */
  text: string;
  visibility: WorldEventVisibility;
  factionId?: string;
  createdAt: number;
  expiresAt?: number;
  options?: WorldEventOption[];
}

export const WORLD_EVENT_TYPE_LABELS: Record<WorldEventType, string> = {
  environment: '环境',
  discovery: '发现',
  faction: '势力',
  power: '势力动向',
  calamity: '灾厄预警',
  rumor: '传闻',
};

/** 默认可见性（任务书 §3：public 全群 / anonymous 全群但隐藏来源 / faction 只给该势力） */
const VISIBILITY_OF: Record<WorldEventType, WorldEventVisibility> = {
  environment: 'public',
  discovery: 'public',
  rumor: 'anonymous',
  faction: 'faction',
  // 势力的动向是**看得见的**：街上多了巡逻、路口封了，谁都知道
  power: 'public',
  calamity: 'public',
};

/**
 * 事件优先级（同小时内超过上限时按它截断）。
 * 环境事件是「世界真的变了」，绝不能被传闻挤掉；传闻最软，先丢传闻。
 */
const PRIORITY_OF: Record<WorldEventType, number> = {
  environment: 5,
  faction: 4,
  calamity: 4,
  // 与灾厄同级：势力真的动手了，是玩家该看见的事（但不能挤掉环境事件）
  power: 4,
  discovery: 3,
  rumor: 1,
};

/* ---------------- 候选（生成器内部的中间形态） ---------------- */

export interface Candidate {
  /** 事件 id：由**原因**拼出来（同 seed 同原因 → 同 id → 落库天然幂等） */
  id: string;
  type: WorldEventType;
  /** 抬头里的地点（传闻传 null = 不指名） */
  locationName: string | null;
  /** 抬头之后的正文 */
  body: string;
  createdAt: number;
  options: WorldEventOption[];
}

/** 抬头：`【世界 · 老码头】` / `【世界 · 传闻】`（任务书 §4 的播报样例） */
function headline(candidate: Candidate): string {
  return `【世界 · ${candidate.locationName ?? WORLD_EVENT_TYPE_LABELS[candidate.type]}】`;
}

function toEvent(candidate: Candidate, now: number): WorldEvent {
  const visibility = VISIBILITY_OF[candidate.type];
  const event: WorldEvent = {
    id: candidate.id,
    type: candidate.type,
    text: `${headline(candidate)}\n${candidate.body}`,
    visibility,
    createdAt: candidate.createdAt,
    expiresAt: now + NUMERIC.world.events.ttlMs,
    options: candidate.options.slice(0, NUMERIC.world.events.maxOptions),
  };
  return event;
}

/* ---------------- 选项（玩家响应，任务书 §4） ---------------- */

/**
 * 三条固定选项：去看看 / 打听（占卜）/ 无视。
 * 「无视」映射到既有指令 `.今日`（今天的入口菜单）—— 本轮**不新增指令**，
 * 也绝不消耗行动点：无视就该是无视。
 */
function optionsFor(type: WorldEventType, locationName: string | null): WorldEventOption[] {
  const where = locationName ?? '';
  if (type === 'rumor') {
    return [
      { key: '1', label: where ? `去${where}打听（占卜）` : '打听一下（占卜）', command: where ? `占卜 ${where}` : '占卜 今天的传闻' },
      { key: '2', label: where ? `去${where}看看` : '去看看', command: where ? `探索 ${where}` : '今日' },
      { key: '3', label: '不理它', command: '今日' },
    ];
  }
  if (type === 'calamity') {
    return [
      { key: '1', label: where ? `回${where}看看` : '看看情况', command: where ? `探索 ${where}` : '今日' },
      { key: '2', label: '看看今天能做什么', command: '今日' },
    ];
  }
  // environment / discovery / faction：世界真的动了，第一条是「去现场」
  return [
    { key: '1', label: where ? `去${where}看看` : '去看看', command: where ? `探索 ${where}` : '今日' },
    { key: '2', label: '打听消息（占卜）', command: where ? `占卜 ${where}` : '占卜 今天发生了什么' },
    { key: '3', label: '无视，该干嘛干嘛', command: '今日' },
  ];
}

/* ---------------- 每天一份的确定性排期（传闻 / 发现） ---------------- */

/** 允许播报的小时（安静时段之外，任务书没规定时段，这是 M2.4 补的运营口径） */
export function activeHours(): number[] {
  const cfg = NUMERIC.world.events;
  const hours: number[] = [];
  for (let hour = 0; hour < 24; hour += 1) {
    if (hour >= cfg.quietFromHour && hour < cfg.quietToHour) continue;
    hours.push(hour);
  }
  return hours;
}

/**
 * 当天的事件排期。
 * **纯函数**：只依赖 (seed, dayIndex, 世界状态)，与「什么时候被调用」无关 ——
 * 补跑重放同一个小时时，算出来的还是同一批事件（id 相同 → 落库幂等）。
 */
interface DayPlan {
  /** 第 hour 小时该播的传闻下标（0 起） */
  rumorHours: Map<number, number[]>;
  rumorCount: number;
  discoveryHour: number | null;
  discoveryIndex: number;
  /**
   * M2.14：当天有没有灾厄（有就是这一份）。
   *
   * 与传闻 / 发现是**同一份「当天排期」**，所以放在这里 ——
   * 缓存 key 只吃 (seed, dayIndex, locationCount, foggy)，而灾厄只吃前两个，
   * 所以加它**不用改 key**。
   */
  calamity: Calamity | null;
}

const dayPlanCache = new Map<string, DayPlan>();

export function dayPlanFor(
  seed: string,
  dayIndex: number,
  input: { locationCount: number; foggy: boolean },
): DayPlan {
  const cfg = NUMERIC.world.events;
  const key = `${seed}|${dayIndex}|${input.locationCount}|${input.foggy ? 1 : 0}`;
  const cached = dayPlanCache.get(key);
  if (cached) return cached;

  const hours = activeHours();
  const rumorCount = Math.min(
    cfg.rumorMaxPerDay,
    cfg.rumorMinPerDay + Math.floor(createSeededRng(seedFrom(['world-events', 'rumor-count', seed, dayIndex])).next() * (cfg.rumorMaxPerDay - cfg.rumorMinPerDay + 1)),
  );

  // 抽 count 个**互不相同**的小时：把候选小时洗一遍再取前 count 个（不重不漏，且同 seed 同结果）
  const rng = createSeededRng(seedFrom(['world-events', 'rumor-hours', seed, dayIndex]));
  const shuffled = [...hours];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng.next() * (i + 1));
    const a = shuffled[i]!;
    shuffled[i] = shuffled[j]!;
    shuffled[j] = a;
  }
  const rumorHours = new Map<number, number[]>();
  for (let index = 0; index < rumorCount; index += 1) {
    const hour = shuffled[index] ?? hours[index % hours.length]!;
    const list = rumorHours.get(hour) ?? [];
    list.push(index);
    rumorHours.set(hour, list);
  }

  // 发现：每天至多一次，雾日更容易被人挖到东西（世界状态加权，不是玩家状态）
  const dRng = createSeededRng(seedFrom(['world-events', 'discovery', seed, dayIndex]));
  const chance = cfg.discoveryChance * (input.foggy ? cfg.discoveryFoggyMultiplier : 1);
  let discoveryHour: number | null = null;
  let discoveryIndex = 0;
  if (dRng.next() < Math.min(1, chance)) {
    discoveryHour = hours[Math.floor(dRng.next() * hours.length)] ?? null;
    discoveryIndex = Math.floor(dRng.next() * Math.max(1, input.locationCount));
  }

  const plan: DayPlan = {
    rumorHours,
    rumorCount,
    discoveryHour,
    discoveryIndex,
    // 灾厄的「日起点」对齐到白天开始（9 点）—— 用 calamityDayAnchor 而不是 dayStartOf，
    // 与 calamityAt 内部同一个锚点（理由见 calamity.ts 的注释：0 点会被安静时段吃掉）
    calamity: calamityAt(seed, calamityDayAnchor(dayIndex)),
  };
  dayPlanCache.set(key, plan);
  // 缓存只是性能护栏（同一小时会被反复问）；上限防止长跑把内存堆起来
  if (dayPlanCache.size > 4096) dayPlanCache.clear();
  return plan;
}

/** 传闻文案池：匿名、真假难辨（任务书 §1 rumor 的定义） */
const RUMOR_TEXTS = [
  '有人在{loc}附近看见了不该看见的东西，说这话的人不肯留名字。',
  '雾散之后，{loc}的墙上多了一行字，没人承认是自己写的。',
  '听说{loc}最近少了一个人，家里没有报官。',
  '有人在{loc}捡到一枚旧徽章，第二天就病了。',
  '{loc}的守夜人说，昨晚有人敲门，敲了七下。',
  '有人在{loc}的井里打上来一只鞋，尺码不对。',
];

/** 发现文案池（任务书 §4 的样例就是这一条的第一句） */
const DISCOVERY_TEXTS = [
  '有人在{loc}挖到了什么，消息传得很快。',
  '{loc}的旧地基被人翻开，露出来的东西没人认得。',
  '{loc}昨夜塌了一角，底下是一间空屋子。',
  '有人把{loc}的一段旧墙拆了，砖缝里是空的。',
];

function fill(template: string, locationName: string): string {
  return template.replace(/\{loc\}/g, locationName);
}

/* ---------------- 生成器（对外唯一入口） ---------------- */

/**
 * 这一刻世界上该发生什么。
 *
 * `now` 是**轻 tick 的小时起点**（infra/world-tick.ts 传进来的就是小时键对应的时刻）；
 * 传别的时间也不会炸：内部一律先归到小时。
 */
export function generateWorldEvents(world: WorldSnapshot, now: number, seed: string): WorldEvent[] {
  const cfg = NUMERIC.world.events;
  const hourStart = hourStartOf(now);
  const hour = hourOf(hourStart);
  // 安静时段（0—5 点）：世界不播报（见 numeric.world.events 的说明）
  if (hour >= cfg.quietFromHour && hour < cfg.quietToHour) return [];

  const dayIndex = dayIndexOf(hourStart);
  const locations = world.locations ?? [];
  const candidates: Candidate[] = [];
  const nameOf = (id: string): string => locations.find((l) => l.id === id)?.name ?? id;

  // ---- 1) 环境：血月 / 灵界渗透 / 灰雾潮**开始时** ----
  //     判据是「这个地点当前天气的 since 落在本小时」——同一次天气只会播报一次，
  //     补跑重放时算出来的 id 相同，落库幂等。
  const states: readonly WeatherState[] = world.weatherStates ?? [];
  /*
   * 判据：**本小时这个地点确实换了天气**。
   *
   * 首选 weatherChangedThisHour（tick 直接给的名单）；没给才退回「since 落在本小时」。
   * 为什么不能只用后者：天气时长的抖动一旦不为零，since 就不再是整点，
   * 而 tick 只在整点跑 —— 14:37 过期的天气在 15:00 才被处理，此时
   * hourStartOf(14:37)=14:00 ≠ 15:00，环境事件会整批丢掉（实测三条 M2.4 用例当场红）。
   */
  const changedThisHour = world.weatherChangedThisHour;
  for (const state of states) {
    const weather = normalizeWeather(state.weather);
    if (!(cfg.environmentWeathers as readonly string[]).includes(weather)) continue;
    if (changedThisHour === undefined) {
      if (hourStartOf(state.since) !== hourStart) continue;
    } else if (!changedThisHour.includes(state.locationId)) {
      continue;
    }
    const locationName = nameOf(state.locationId);
    candidates.push({
      id: `env:${state.locationId}:${weather}:${state.since}`,
      type: 'environment',
      locationName,
      body: weatherFlavor(weather),
      createdAt: hourStart,
      options: optionsFor('environment', locationName),
    });
  }

  // ---- 2) 势力（仍占位，留 M2.15）与 3) 灾厄（M2.14 已接入） ----
  candidates.push(...factionEvents(world, hourStart, seed, hour));
  candidates.push(...calamityEvents(world, hourStart, seed, hour));

  // ---- 4) 发现：低频（每日至多一次，雾日加权） ----
  const plan = dayPlanFor(seed, dayIndex, {
    locationCount: locations.length,
    foggy: world.clock.foggy,
  });
  if (plan.discoveryHour === hour && locations.length > 0) {
    const target = locations[plan.discoveryIndex % locations.length]!;
    const rng = createSeededRng(seedFrom(['world-events', 'discovery-text', seed, dayIndex]));
    const template = DISCOVERY_TEXTS[Math.floor(rng.next() * DISCOVERY_TEXTS.length)] ?? DISCOVERY_TEXTS[0]!;
    candidates.push({
      id: `disc:${target.id}:${dayIndex}`,
      type: 'discovery',
      locationName: target.name,
      body: fill(template, target.name),
      createdAt: hourStart,
      options: optionsFor('discovery', target.name),
    });
  }

  // ---- 5) 传闻：每天 1—3 条 ----
  for (const index of plan.rumorHours.get(hour) ?? []) {
    const rng = createSeededRng(seedFrom(['world-events', 'rumor-text', seed, dayIndex, index]));
    const template = RUMOR_TEXTS[Math.floor(rng.next() * RUMOR_TEXTS.length)] ?? RUMOR_TEXTS[0]!;
    // 传闻要有点头绪才好「去打听」：指一个地点，但**不保证是真的**
    const target = locations.length > 0
      ? locations[Math.floor(rng.next() * locations.length)]!
      : null;
    const locationName = target?.name ?? null;
    candidates.push({
      id: `rumor:${dayIndex}:${index}`,
      type: 'rumor',
      locationName,
      body: locationName ? fill(template, locationName) : fill(template, '城外'),
      createdAt: hourStart,
      options: optionsFor('rumor', locationName),
    });
  }

  // ---- 截断：每小时最多 maxPerHour 条（任务书 §3 的防刷屏闸门） ----
  const byPriority = (a: Candidate, b: Candidate): number => {
    const weight = PRIORITY_OF[b.type] - PRIORITY_OF[a.type];
    if (weight !== 0) return weight;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  };
  candidates.sort(byPriority);

  let chosen = candidates.slice(0, cfg.maxPerHour);
  /**
   * 传闻保底。
   *
   * 任务书同时要求「rumor 每天 1—3 条」和「每小时最多 3 条」——
   * 环境事件密集时（天气驱动，实测占九成）后一条会把前一条挤掉：
   * 初版实现下 14 天里有 4 天传闻是 0 条，直接违反「每天 1—3 条」。
   * 所以这里给传闻留一个位置：本小时既有传闻候选、又一条都没进来时，
   * 用传闻换掉优先级最低的那一条。每小时上限仍然是 maxPerHour，闸门没有被突破。
   */
  if (chosen.length === cfg.maxPerHour && !chosen.some((candidate) => candidate.type === 'rumor')) {
    const rumor = candidates.slice(cfg.maxPerHour).find((candidate) => candidate.type === 'rumor');
    if (rumor) {
      chosen = [...candidates.slice(0, cfg.maxPerHour - 1), rumor].sort(byPriority);
    }
  }

  return chosen.map((candidate) => toEvent(candidate, hourStart));
}

/**
 * 势力事件（M2.6 接入点）。
 * **本轮恒为空**：势力控制地点的变化要等 M2.6 的势力表落地，
 * 这里先把位置留出来（类型、可见性、优先级都已经定好），接的时候只填这个函数体。
 */
export function factionEvents(
  _world: WorldSnapshot,
  _at: number,
  _seed: string,
  _hour: number,
): Candidate[] {
  return [];
}

/**
 * 灾厄文案（M2.14）。
 *
 * ⚠️ 两句必须在一起：**「外面更危险」与「动手有回报」**。
 * 只写前者，玩家会以为灾厄是个纯惩罚；只写后者，就变成发福利。
 * 灾厄期战斗确实该更危险（生物更强）、也确实该有额外回报（掉落更多）——
 * 这**不是矛盾**，是这个机制的全部张力所在。
 */
function calamityBody(calamity: Calamity): string {
  const strength =
    calamity.level >= 3
      ? '那些东西比任何时候都更靠近人住的地方'
      : calamity.level === 2
        ? '雾里的东西比平时更强，也更愿意往有人的地方走'
        : '外面的动静比平时大一些';
  return [
    `${calamity.name}压下来了。接下来 ${calamity.days} 天，${strength}。`,
    '这段日子出去会更危险 —— 但愿意动手的人，会拿到平时拿不到的东西：',
    '灾厄里的生物身上，带着平时不会带的东西。',
  ].join('\n');
}

/**
 * 灾厄预警（M2.14 填的函数体；M2.4 留的接入点，类型 / 可见性 / 优先级 / 选项早就位）。
 *
 * 只做一件事：**在灾厄开始的那个小时播一条**。
 *
 * 灾厄本身不在这里算 —— 它是纯 seed 派生的世界状态（domain/world/calamity.ts），
 * 这里只是它的**播报出口**。生态侧读的是同一个 calamityAt，所以
 * 「群里说的灾厄」与「生态里动的灾厄」永远是同一次计算（单一来源）。
 *
 * 幂等靠 id：`calamity:{since}` —— 补跑重放同一个小时算出来的 id 相同，
 * 落库是 INSERT OR IGNORE，不会重复播。
 */
export function calamityEvents(
  world: WorldSnapshot,
  at: number,
  seed: string,
  _hour: number,
): Candidate[] {
  const hourStart = hourStartOf(at);
  const plan = dayPlanFor(seed, dayIndexOf(hourStart), {
    locationCount: (world.locations ?? []).length,
    foggy: world.clock.foggy,
  });
  const calamity = plan.calamity;
  if (!calamity) return [];
  // 灾厄持续几天，但**只播一条**：播在它开始的那一刻
  if (hourStartOf(calamity.since) !== hourStart) return [];

  return [
    {
      id: `calamity:${calamity.since}`,
      type: 'calamity',
      // 全服灾厄不指地点 —— 抬头回落到 WORLD_EVENT_TYPE_LABELS.calamity =「灾厄预警」
      locationName: null,
      body: calamityBody(calamity),
      createdAt: hourStart,
      options: optionsFor('calamity', null),
    },
  ];
}

/* ---------------- 只读小工具（播报/报表用） ---------------- */

/** 事件抬头（第一行） */
export function worldEventHeadline(event: WorldEvent): string {
  return event.text.split('\n')[0] ?? '';
}

/** 事件正文（抬头之后的所有行） */
export function worldEventBody(event: WorldEvent): string {
  return event.text.split('\n').slice(1).join('\n');
}

/** 该事件此刻能不能被数字回复命中（过期即不可） */
export function isEventLive(event: WorldEvent, now: number): boolean {
  return event.expiresAt === undefined || event.expiresAt > now;
}
