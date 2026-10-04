/**
 * 世界 tick（M2.2）
 *
 *   轻 tick：每小时一次 —— 推进时段、刷新天气（过期换天气 / 扩散落地）、预留地点资源位（M2.3）
 *   重 tick：每天 0 点一次 —— 推进月相、雾日、天气扩散、日序号
 *
 * 幂等：每个 tick 先到 `world_ticks` 里抢占 (tick_type, tick_key)，抢不到就直接跳过；
 *       天气推进本身也是状态机（同 now 再跑一次不会有变化），所以补跑与重复调用都安全。
 *
 * 补跑：进程重启后从 `world_state` 的水位线（last_light_at / last_heavy_at）往后逐格补齐，
 *       单次调用有上限（numeric.world.weather.maxCatchUpLight / maxCatchUpHeavy），不会跑爆。
 *
 * 调用点：应用启动（recovery）、main 的定时器（每 5 分钟）、以及每条指令前的惰性推进
 *       （惰性推进让「真实 HTTP 实例测试」也能看到世界在动，不必依赖墙上时间）。
 */
import { NUMERIC } from '../config/numeric.ts';
import { applyAuthority, pickAuthority } from './authority.ts';
// M2.99：神明的行动 —— 决策（动不动）与思考（动什么）分在两个文件里
import { divineStance } from '../domain/world/divine-decide.ts';
import { DivinePlans, InMemoryDivineState, coolingMethods, divineInsight, divineThink } from '../domain/world/divine-mind.ts';
// M2.164：神明让死者回来（死亡不可逆，但神能开门）
import {
  CORRUPTION_ON_DARK_REVIVE,
  CORRUPTION_PER_WHISPER,
  RESURRECTION_URGE_PER_HOUR,
  RETURN_FORM_LABELS,
  REVIVE_AFTER_HOURS,
  REVIVE_ODDS,
  WHISPER_URGE_PER_HOUR,
  affinityAfterReturn,
  boundToSeat,
  canRevive,
  corruptionTierOf,
  deathChanceOf,
  deathLineOf,
  deathTierOf,
  humanOf,
  isDarkSeat,
  returnFormOf,
  reviveLineOf,
  whisperChance,
} from '../domain/world/npc-life.ts';
import { decayPowerAlert, notePowerReactions } from './power-reactions.ts';
// M2.169：神座的运行时状态（内容为底、状态覆盖）
import { mergeThroneState } from '../domain/world/divine-throne-state.ts';
// M2.170：对撞时到期不作数（还有人在争 ⇒ 往后拖；拖满 ⇒ 两败俱伤）
import { settleOrExtend } from '../domain/world/throne-contest.ts';
// M2.169：神倒下之后，祂的教会会怎么样
import { churchFateLineOf, fateAfterFall } from '../domain/world/church-fate.ts';
// M2.169：神明的阴谋（世界级 —— 结盟 / 渗透 / 削弱 / 神战 / 陨落）
import {
  DIVINE_SCHEME_URGE_PER_HOUR,
  SCHEME_STAGE_LABELS,
  canSchemeAgainst,
  detected,
  exposureGain,
  nextStageAt,
  resolveScheme,
  schemeEndLine,
  stageAfter,
} from '../domain/world/divine-scheme.ts';
// M2.167：撑不住的人会变成怪物（形态 / 判定 / 播报都在 domain/world/fallen-beast.ts）
import {
  BEAST_ATTACK_PER_HOUR,
  beastSequenceOf,
  hybridTraits,
  mutationLineOf,
  npcMutationChance,
  pickFallenBeast,
} from '../domain/world/fallen-beast.ts';
import { CausalRepo } from './causal-log.ts';
import { tickBoundaries } from './boundary-state.ts';
import { seedFrom, createSeededRng } from '../domain/rng.ts';
import {
  clockLabel,
  dayIndexOf,
  dayStartOf,
  hourStartOf,
  moonPhase,
  seasonOf,
  timeOfDay,
  TIME_OF_DAY_LABELS,
  worldClock,
  isFoggy,
  type WorldClock,
} from '../domain/world/clock.ts';
import {
  initialWeatherState,
  isEpicWeather,
  weatherLabel,
  weatherWeightContext,
  tickWeather,
  type WeatherChange,
  type WeatherId,
  type WeatherState,
  type WeatherTickOutput,
} from '../domain/world/weather.ts';
import { generateWorldEvents, worldEventHeadline, type WorldEvent } from '../domain/world/events.ts';
import type { BroadcastButton } from './broadcast.ts';
import { worldModifiers } from '../domain/world/weather.ts';
import type { LocationView, WorldSnapshot } from '../domain/menu/types.ts';
import { dateKey } from './date.ts';
import { mergeBroadcastParts } from './broadcast.ts';
import type { RouterDeps } from '../router/index.ts';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function tzOffset(): number {
  return NUMERIC.world.clock.tzOffsetMinutes;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * 该时刻所在小时的起点（按东八区切）。
 * 实现 M2.4 起搬到了 domain/world/clock.ts（世界事件生成器要用同一个口径），这里原样转出，
 * 老调用方（tests / 水位线计算）的 import 路径不用动。
 */
export { hourStartOf };

/** 小时键：`2026-01-01T13`（东八区），世界 tick 的去重键 */
export function hourKeyOf(at: number, tzOffsetMinutes: number = tzOffset()): string {
  const date = new Date(at + tzOffsetMinutes * 60_000);
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T${pad(date.getUTCHours())}`;
}

export interface WorldTickResult {
  clock: WorldClock;
  light: { executed: number; keys: string[] };
  heavy: { executed: number; keys: string[] };
  changes: WeatherChange[];
  /**
   * 需要全群播报的文本（显著天气 + 极罕见天气预告 + M2.4 世界事件）。
   *
   * M2.39：**长度恒为 0 或 1** —— 本 tick 的全部变化已经合成一条。
   * ## M2.86：不再合并，且**每条都带自己的按钮**
 *
 * 用户：「没必要整合在一起了，主动推送如果短时间内多次推送，增加下推送延迟队列，
 *        事件底部附带对应的原始按钮」
 *
 * 原来是合并成一条。合并的代价在实机上暴露过：两条事件拼在一起、各自带一组编号，
 * 玩家回数字只能对上最后一条（见 renderTickBroadcasts 里的详细说明）。
 * 现在每条事件**各自成一条播报**，底部附它自己的回调按钮 ——
 * 按钮的 data 是完整指令，平台回传后走普通路由，不依赖待答菜单，所以多条互不干扰。
 *
 * 错开发送由调用方的令牌桶负责（20/qpm，见 infra/broadcast.ts）。
   */
  broadcasts: BroadcastItem[];
  states: WeatherState[];
  /** M2.4：本轮新落库的世界事件（补跑重放时为 0 条，幂等由事件 id 保证） */
  events: WorldEvent[];
  /** true = 本次什么都没做（同小时已推进过） */
  skipped: boolean;
}

export interface AdvanceWorldOptions {
  /** 忽略进程内水位线缓存，强制查一次库（启动补跑 / 定时器用） */
  force?: boolean;
}

/**
 * M2.39：一格 tick 的天气播报素材（尚未渲染成文本）。
 * 之所以先收结构、最后才渲染：单 tick 要的是「逐格原文合并」，
 * 批量补跑要的是「跨格汇总」，两者渲染方式不同但读的是同一份数据。
 */
export interface WeatherFeed {
  at: number;
  broadcasts: WeatherChange[];
  forecasts: Array<{ locationId: string; weather: WeatherId; at: number }>;
}

/**
 * 进程内水位线（每个 WorldRepo 一份）：
 *   已经结算到（不含）lightUntil 之前的每一个整点、heavyUntil 之前的每一天。
 * 「时钟回跳」在实例测试里天天发生（每个虚拟玩家都把时钟拨回自己当天的 01:00），
 * 没有这道缓存的话每次回跳都要查一遍库 —— 实测会把 200×14 拖慢数倍。
 */
interface Watermark {
  seed: string;
  lightUntil: number;
  heavyUntil: number;
}

const watermarks = new WeakMap<object, Watermark>();

/** 查一次库，算出「已经结算到哪儿」 */
function readWatermark(deps: RouterDeps, now: number): Watermark {
  const repo = deps.world;
  const seed = repo.seed();
  const lastLight = repo.lastTick('light');
  const lastHeavy = repo.lastTick('heavy');
  const today = dayIndexOf(now);
  return {
    seed,
    lightUntil: lastLight ? hourStartOf(lastLight.tickAt) + HOUR_MS : hourStartOf(now),
    heavyUntil: lastHeavy ? dayStartOf(dayIndexOf(lastHeavy.tickAt) + 1) : dayStartOf(today),
  };
}

/**
 * 推进世界到 `now`（幂等）。
 * 所有时间都来自参数；函数内部不读墙上时间。
 */
export function advanceWorld(
  deps: RouterDeps,
  now: number,
  options: AdvanceWorldOptions = {},
): WorldTickResult {
  const repo = deps.world;
  const seed = deps.worldSeed ?? 'world';
  const targetHour = hourStartOf(now);

  // 先看水位线：不需要推进就 O(1) 返回（不建行、不查库）
  let mark = watermarks.get(repo);
  if (mark && !options.force && now < mark.lightUntil && now < mark.heavyUntil) {
    return {
      clock: worldClock(now, mark.seed),
      light: { executed: 0, keys: [] },
      heavy: { executed: 0, keys: [] },
      changes: [],
      broadcasts: [],
      states: [],
      events: [],
      skipped: true,
    };
  }

  repo.ensure(now, seed);
  if (!mark || options.force) {
    mark = readWatermark(deps, now);
    watermarks.set(repo, mark);
  }
  if (!options.force && now < mark.lightUntil && now < mark.heavyUntil) {
    return {
      clock: worldClock(now, mark.seed),
      light: { executed: 0, keys: [] },
      heavy: { executed: 0, keys: [] },
      changes: [],
      broadcasts: [],
      states: [],
      events: [],
      skipped: true,
    };
  }

  const clock = worldClock(now, mark.seed);

  const locations = deps.locations.all();
  // M2.4 修复：冷启动的天气起点必须**对齐到整点**。
  // 原来传的是 now（某条指令的真实时刻，带毫秒），于是 state.until = 各进程各自的 now + 6h，
  // 而换天气的抽签键就是 state.until —— 4 个分片的首条指令时刻不同 → 首次换天气的 rollAt 不同
  // → 天气序列从第一次换天气起就分叉 → 世界事件跟着分叉。
  // 对齐到小时起点后，「同 seed + 同一小时」在任意进程里都是同一串天气（M2.2 的系数一个没动）。
  let states = ensureWeatherRows(repo, locations, hourStartOf(now), mark.seed);

  const changes: WeatherChange[] = [];
  /**
   * M2.39：本 tick 逐格的天气输出 —— 播报素材**先收集、最后统一渲染**。
   * 原来是每格直接 push 进 broadcasts（一格一推、一推一乘群数），加速补跑时就是几千条消息。
   */
  const weatherFeeds: WeatherFeed[] = [];
  /** M2.4：本轮真正落库的世界事件（补跑重放时同 id 不重复落，这里就是真实的增量） */
  const events: WorldEvent[] = [];
  const lightKeys: string[] = [];
  const heavyKeys: string[] = [];

  // ---- 轻 tick：从水位线开始逐小时补齐 ----
  let cursor = mark.lightUntil;
  let guard = 0;
  while (cursor <= targetHour && lightKeys.length < NUMERIC.world.weather.maxCatchUpLight) {
    guard += 1;
    if (guard > NUMERIC.world.weather.maxCatchUpLight * 2 + 8) break;
    const key = hourKeyOf(cursor);
    const claimed = repo.claimTick({
      tickType: 'light',
      tickKey: key,
      tickAt: cursor,
      executedAt: now,
      summary: { hour: key },
    });
    if (claimed) {
      const output = runWeatherTick(deps, states, cursor, mark.seed);
      states = output.states;
      changes.push(...output.changes);
      weatherFeeds.push({ at: cursor, broadcasts: output.broadcasts, forecasts: output.forecasts });
      // M2.4：世界主动说话。每小时轻 tick 检查一次该生成什么事件（任务书 §3）。
      // 只挂在轻 tick 上：重 tick 落在 0 点（安静时段），本来就不该生成事件。
      // 把「这一小时真的换了天气的地点」直接交给事件生成器（见 runWorldEvents 的注释）
      runWorldEvents(deps, states, cursor, mark.seed, events, output.changes);
      /*
       * M2.62：**边界输入**。世界从这里与外面接触。
       *
       * 逐格判定（每小时一次），`cursor` 就是这一格的小时起点 ——
       * 与 runWorldEvents 同一个口径。
       *
       * 为什么不带库状态：边界事件由**时刻表**（seed 派生的间隔序列）决定，
       * 因为凡是进 world_events 的东西都必须是 (世界 seed, 小时) 的函数 ——
       * 依赖各分片自己的库状态会让「4 片看到同一串世界事件」当场破掉
       * （test/m2-4.test.ts 的分片一致性用例就是这么拦下第一版的）。
       *
       * 幂等由事件 id（boundary:<边界>:<小时>）与 INSERT OR IGNORE 保证 ——
       * 补跑重放同一格时 isNew 为 false，恐慌与警觉不会被重复加。
       */
      try {
        runBoundaries(deps, cursor, mark.seed);
      } catch {
        // 边界输入出问题不该影响世界推进（与 runWorldEvents 同一条兜底）
      }
      lightKeys.push(key);
    }
    cursor += HOUR_MS;
  }
  const lightUntil = Math.max(mark.lightUntil, cursor);

  // ---- 重 tick：逐日补齐（推进月相 / 雾日 / 日序号） ----
  const today = dayIndexOf(now);
  let dayCursor = dayIndexOf(mark.heavyUntil);
  let heavyGuard = 0;
  while (dayCursor <= today && heavyKeys.length < NUMERIC.world.weather.maxCatchUpHeavy) {
    heavyGuard += 1;
    if (heavyGuard > NUMERIC.world.weather.maxCatchUpHeavy * 2 + 8) break;
    const at = dayStartOf(dayCursor);
    const key = dateKey(at);
    const claimed = repo.claimTick({
      tickType: 'heavy',
      tickKey: key,
      tickAt: at,
      executedAt: now,
      summary: { day: dayCursor },
    });
    if (claimed) {
      repo.update(
        { dayIndex: dayCursor, moonPhase: moonPhase(at), foggy: isFoggy(at, mark.seed) },
        now,
      );
      // 重 tick 也做一次天气推进：每天 0 点把「扩散 / 过期」对齐到日边界
      const output = runWeatherTick(deps, states, at, mark.seed);
      states = output.states;
      changes.push(...output.changes);
      weatherFeeds.push({ at, broadcasts: output.broadcasts, forecasts: output.forecasts });
      heavyKeys.push(key);
    }
    dayCursor += 1;
  }
  const heavyUntil = Math.max(mark.heavyUntil, dayStartOf(dayCursor));

  if (lightKeys.length > 0 || heavyKeys.length > 0) {
    repo.upsertWeather(states, now);

  /*
   * M2.76：**权柄事件** —— 世界级能力改写世界状态。
   *
   * 挂在天气推进**之后**：覆盖层的作用对象就是天气，所以「先算自然天气、
   * 再让权柄压一层」是唯一不会打乱顺序的位置（反过来的话，本 tick 刚写的覆盖
   * 会被同一 tick 的自然天气盖掉）。
   *
   * ⚠️ **独立的 rng**：与天气派生分开。共用一个流的话，权柄的频率会随天气分布变化 ——
   * 那不是设计，是耦合。种子带 targetHour，所以同一小时补跑两次不会触发两条。
   */
  const authorityPool = deps.authorities ?? [];
  if (authorityPool.length > 0) {
    const authorityRng = createSeededRng(seedFrom([seed, 'authority', String(targetHour)]));
    if (authorityRng.next() < NUMERIC.world.authority.chancePerHour) {
      const authority = pickAuthority(authorityPool, authorityRng);
      if (authority !== null) {
        const until = applyAuthority(repo, authority, now);
        deps.worldEvents.insertMany([
          {
            id: 'authority:' + authority.id + ':' + targetHour,
            /*
             * 用 environment 而不是 rumor：权柄的播报是**全服可见**的，
             * 而 rumor 的默认可见性是 anonymous（隐藏来源）—— 权柄不需要隐藏。
             */
            type: 'environment',
            // 抬头格式与其它世界事件一致（渲染层按第一个换行拆开）
            text: '【世界 · ' + authority.name + '】' + '\n' + authority.broadcast,
            visibility: 'public',
            createdAt: now,
            expiresAt: until,
          },
        ]);
        deps.logger?.info('权柄事件', { authority: authority.id, weather: authority.weather, until });
      }
    }
  }

  /*
   * ═══════════ M2.99：**神明的行动** ═══════════
   *
   * 与上面的权柄事件**同一个位置**（天气推进之后）：世界刚算完自然天气，
   * 诸神此刻的决定作用在它之上。
   *
   * 三条纪律：
   *   ① **独立的 rng**（seed 带 `divine` 与 targetHour）—— 与天气、权柄分开，
   *      否则神明出手的频率会随天气分布变化（那不是设计，是耦合）。
   *   ② **绝大多数小时什么都不发生**。稀有性不在这一段里，在 `divineStance` 的四道门里
   *      （基础率 0.1%/小时 + 沉寂期 + 状态因子 + 显现折扣）。
   *   ③ 神的行动**匿名播报**（`rumor`）：玩家该感觉到「有东西动了」，而不是收到一份通知。
   *      「谁动的」要他自己去查 —— 那正是这个世界该有的样子。
   */
  /*
   * M2.169：**内容是底、状态覆盖** —— 陨落 / 夺位之后，这里读到的是现在那一位。
   * 少了这一层合并，阴谋改了库里的状态而世界 tick 还念着旧名字（不报错）。
   */
  const thrones = mergeThroneState(deps.divineThrones ?? [], deps.divineThroneState?.all() ?? []);
  if (thrones.length > 0) {
    const divineRng = createSeededRng(seedFrom([seed, 'divine', String(targetHour)]));
    /*
     * M2.168：这两样现在都有**落库版**（infra/db/divine.ts），线上由 app 注入；
     * 测试与跑批不传时落到进程内实现 —— 接口相同，判定层一个字没改。
     */
    const state = deps.divineState ?? new InMemoryDivineState();
    const plans = deps.divinePlans ?? new DivinePlans();
    /*
     * 局势：这一小时世界上的关键词。第一版从**已经发生的事**派生：
     * 生效中的权柄（`repo.activeOverrides`）与天气。玩家个人的局势不在这里 ——
     * 那要走注视那条路（`divineGaze`），它需要「谁在看着谁」，那是命令层的事。
     */
    const situationKeys: string[] = [];
    for (const override of repo.activeOverrides(now)) {
      if (override.kind === 'weather') situationKeys.push('weather_forced');
      else situationKeys.push('world_altered');
    }
    const situation = {
      keys: situationKeys,
      playerKeys: [] as string[],
      playerCity: '',
      playerSequence: 9,
    };
    for (const throne of thrones) {
      // 空位的神只剩「后手」，但祂们仍然会动（`divineStance` 里由状态因子压到 15%）
      const seat = throne.seat;
      const used = state.get(throne.pathway);
      const hoursSinceLastAct = used === undefined ? 1e9 : (now - used.lastActAt) / HOUR_MS;
      const cooling = coolingMethods(throne, used?.methodUsedAt, now);
      const insight = divineInsight({ throne, keys: situationKeys, affection: 0 });
      const mind = divineThink({ throne, insight, plan: plans.get(seat), cooling, now });
      const stance = divineStance({
        throne,
        situation,
        hoursSinceLastAct,
        methodUsedAt: used?.methodUsedAt,
        mind,
        now,
        rng: divineRng,
      });
      // 「想过」之后如果要起一个新计划，就记下来（下一次接着走）
      if (mind.newPlanSteps.length > 0 && mind.goalId !== null && plans.get(seat) === null) {
        plans.begin(seat, mind.goalId, mind.newPlanSteps, now);
      }
      if (stance.method === null) continue;
      const method = stance.method;
      const broadcast = method.broadcast === '' ? method.text : method.broadcast;
      deps.worldEvents.insertMany([
        {
          id: 'divine:' + throne.pathway + ':' + targetHour,
          // 匿名：玩家该感觉到「有东西动了」，而不是收到一份通知
          type: 'rumor',
          text: (stance.manifest ? '【世界 · 神降】' : '【世界 · 异动】') + '\n' + broadcast,
          visibility: 'public',
          createdAt: now,
          expiresAt: now + method.cooldown_hours * HOUR_MS,
        },
      ]);
      // 记下这一次：沉寂期与冷却都靠它（进程内，重启会丢 —— 见 RouterDeps 的注释）
      const methodUsedAt = { ...(used?.methodUsedAt ?? {}) };
      methodUsedAt[method.id] = now;
      state.set(throne.pathway, { lastActAt: now, methodUsedAt });
      plans.advance(seat);
      deps.logger?.info('神明行动', {
        pathway: throne.pathway,
        seat,
        method: method.id,
        manifest: stance.manifest,
        reason: stance.reasons.join(' / '),
      });
    }
    deps.divineState = state;
    deps.divinePlans = plans;
  }

  /*
   * ═══════ M2.164：**神明让死者回来** ═══════
   *
   * 用户拍板的两条是一对：「NPC 死亡是真的死亡（永久，不刷新）」+「神明可以复活（邪神也可以）」。
   * 也就是说：**死亡不可逆，但神能开门**。这一段就是那道门。
   *
   * 四道门（与 divineStance 的稀有性同一个手法 —— 神不是有求必应的）：
   *   ① 世界级大门：每小时 0.2%（约二十天一次），见 npc-life.ts 的 RESURRECTION_URGE_PER_HOUR
   *   ② 死人要死满 24 小时（刚死就回来太廉价）
   *   ③ 关系：那位神得**跟他有关系**（同教会 / 同势力 / 同途径）——
   *      没有这一条，神就成了随机刷新器
   *   ④ 门槛：情报与财力够不够（**只判够不够，不扣减** —— 与 divine-decide 同口径：
   *      神的 resources 是静态内容，要真扣减就得先把神座状态落库，那是另一件事）
   *
   * ⚠️ 播报**匿名**（rumor）：谁动的手进日志与图鉴，不进公开播报 ——
   *    与神明行动那一条完全一致。
   *
   * ⚠️ 邪神那一档（hidden / outsider）找回来的人**不再是原来那个人**：
   *    堕落度跟着回来（CORRUPTION_ON_DARK_REVIVE）。这是「邪神蛊惑 NPC 堕落」的入口之一。
   */
  const allThrones = mergeThroneState(deps.divineThrones ?? [], deps.divineThroneState?.all() ?? []);
  if (allThrones.length > 0) {
    const reviveRng = createSeededRng(seedFrom([seed, 'resurrect', String(targetHour)]));
    if (reviveRng.next() < RESURRECTION_URGE_PER_HOUR) {
      /*
       * 一次世界 tick **最多复活一个人**（`waitingLoop` 标签）：
       * 「两位神在同一小时各找回一个人」不是不可能，但那会让这条机制显得廉价。
       * 候选人也取前 20 位（死得越久越靠前）—— 与「先死的人先被想起来」一致。
       */
      const waiting = deps.npcLife
        .dead()
        .filter((l) => l.diedAt !== null && now - l.diedAt >= REVIVE_AFTER_HOURS * HOUR_MS)
        .slice(0, 20);
      waitingLoop: for (const life of waiting) {
        const entry = deps.npcRoster.byId(life.npcId);
        if (entry === null) continue;
        const seq = entry.sequence ?? 9;
        const tier = deathTierOf(seq);
        const hoursSinceDeath = (now - (life.diedAt ?? now)) / HOUR_MS;
        for (const throne of allThrones) {
          // 空位没有手可伸（那一位已经不在了）；占而不得的那一档仍然能伸手
          if (throne.state === 'vacant') continue;
          const related = boundToSeat({
            npcChurch: entry.church,
            npcPathway: entry.pathway,
            npcTempter: life.tempter,
            throneChurches: throne.resources.churches,
            thronePathway: throne.pathway,
          });
          if (!related) continue;
          const gate = canRevive({ sequence: seq, resources: throne.resources, hoursSinceDeath });
          if (!gate.ok) continue;
          if (reviveRng.next() >= REVIVE_ODDS[tier]) continue;
          const dark = isDarkSeat(throne.seatKind);
          /*
           * **回来的是谁**（用户追问：「神明复活的他还是他吗？邪神复活的他还是人吗？」）。
           *
           * 复活不是读档 —— 形态决定三件事：他对你的关系、他的性情算不算黑暗、
           * 以及他还算不算人。三条都要落到状态上，否则那只是一句文案。
           */
          const form = returnFormOf({ dark, revivals: life.revivals, sequence: seq, roll: reviveRng.next() });
          const human = humanOf(form);
          deps.npcLife.revive(life.npcId, now, form, human);
          if (dark) deps.npcLife.corrupt(life.npcId, CORRUPTION_ON_DARK_REVIVE, throne.pathway);
          /* 关系下场：缺了一块的人不记得那件事，换了壳的人从没认识过你，祂的东西只认祂 */
          for (const rel of deps.npcRelations.all()) {
            if (rel.npcId !== life.npcId) continue;
            const target = affinityAfterReturn(rel.affinity, form);
            if (target !== rel.affinity) deps.npcRelations.bump(life.npcId, rel.characterId, target - rel.affinity, now);
          }
          deps.npcDeeds.record({
            npcId: life.npcId,
            kind: 'revived',
            detail: entry.name + ' 被找了回来（' + throne.pathway + ' · ' + RETURN_FORM_LABELS[form] + ' · ' + gate.reason + '）',
            merit: 0,
            at: now,
          });
          deps.worldEvents.insert({
            id: 'npc-revive-' + life.npcId + '-' + now,
            type: 'rumor',
            text: '【世界 · 归来】' + reviveLineOf(entry.name, form, ''),
            visibility: 'public',
            createdAt: now,
          });
          deps.logger?.info('神明复活', {
            npc: life.npcId,
            seat: throne.seat,
            pathway: throne.pathway,
            form,
            human,
            tier,
            reason: gate.reason,
          });
          break waitingLoop;
        }
      }
    }
  }

  /*
   * ═══════ M2.164：**邪神在低语**（「邪神蛊惑 NPC 堕落」）═══════
   *
   * 与复活那一段是两条不同的路：
   *   复活成 thrall  死了之后被收走 —— 一次性、彻底
   *   低语           活着的时候被一点点说动 —— 慢，而且**世界看得见**
   *
   * 三道门：
   *   ① 世界级大门：每小时 0.4%（祂的日常，比复活频繁得多）
   *   ② 只有邪神那一档会低语（hidden / outsider，且不是空位）
   *   ③ 祂得**够得到那个人**（resources.reach 里有他所在的城市）——
   *      邪神没有教会，伸手靠的是「哪里能碰到」
   *
   * 说动之后会发生什么（这是机制，不是文案）：堕落度过了 30 就按**黑暗向**算 ——
   * 于是 `willScheme` 放行，他会替祂去布局（算计玩家或同行）。
   *
   * ⚠️ 玩家**拿不到**一份「谁被蛊惑了」的名单：那正是这个世界不该给的东西。
   *    他能看见的是一条世界动静，以及那个人后来做的事。
   */
  const corruptRng = createSeededRng(seedFrom([seed, 'whisper', String(targetHour)]));
  const whisperers = allThrones.filter((t) => isDarkSeat(t.seatKind) && t.state !== 'vacant');
  if (whisperers.length > 0 && corruptRng.next() < WHISPER_URGE_PER_HOUR) {
    const throne = whisperers[Math.floor(corruptRng.next() * whisperers.length)]!;
    const reach = throne.resources.reach;
    const alive = deps.npcRoster.all.filter((e) =>
      e.source === 'cast' && reach.includes(e.city) && deps.npcLife.isAlive(e.id),
    );
    if (alive.length > 0) {
      const target = alive[Math.floor(corruptRng.next() * alive.length)]!;
      const life = deps.npcLife.of(target.id);
      const chance = whisperChance({
        temperament: target.temperament,
        sequence: target.sequence ?? 9,
        corrupted: life?.corrupted ?? 0,
      });
      if (corruptRng.next() < chance) {
        const after = deps.npcLife.corrupt(target.id, CORRUPTION_PER_WHISPER, throne.pathway);
        const tier = corruptionTierOf(after.corrupted);
        deps.worldEvents.insert({
          id: 'npc-whisper-' + target.id + '-' + now,
          type: 'rumor',
          text: tier === 'fallen'
            ? '【世界 · 异样】' + target.name + '\n他最近说话的方式变了 —— 像是有人在替他答话。'
            : '【世界 · 异样】' + target.name + '\n有人最近见过他，说他不太一样了。',
          visibility: 'public',
          createdAt: now,
        });
        deps.logger?.info('邪神低语', { npc: target.id, pathway: throne.pathway, tier, corrupted: after.corrupted });
      }
    }
  }

  /*
   * ═══════ M2.170：**神位争夺**（空出来的位置怎么落地）═══════
   *
   * 用户口径：「神位得竞争本来就是残酷的」。
   *
   * 三种结局，每一种都真的改变世界状态：
   *   ① 他撑到了最后   ⇒ **那个位置是他的**（神座 seat = 他的名字 —— 玩家真的成神了）
   *   ② 他死在仪式里   ⇒ 位置继续空着（被打断的人不算数，而别人记得是谁动的手）
   *   ③ 他自己下来     ⇒ 同上（`.王座 放弃` 写的那一条）
   *
   * ⚠️ 这是全项目里**唯一**一处「玩家能坐上序列 0」的落点 ——
   * 所以它必须比别处都难：7 天公开、每天掉理智、而且别人能直接上来杀你。
   */
  const contestRepo = deps.throneContests;
  if (contestRepo !== undefined && deps.divineThroneState !== undefined) {
    for (const contest of contestRepo.open()) {
      const claimant = deps.characters.findById(contest.claimantId);
      const throne = thrones.find((t) => t.pathway === contest.pathway);
      // `title` 是那个座位的称号（如「黑暗」= 黑夜女神的位置）—— 不是途径 id
      const pathwayName = throne?.title ?? contest.pathway;
      /* ① 他不在了（死了 / 号没了）⇒ 仪式断了。位置继续空着 —— 而这件事有人做了。 */
      if (claimant === null || claimant.hp <= 0) {
        contestRepo.lapse({
          pathway: contest.pathway,
          brokenBy: claimant === null ? 'gone' : 'death',
          note: '他在仪式里没能撑住 —— 位置继续空着。',
        });
        deps.worldEvents.insert({
          id: 'throne-lapse-' + contest.pathway + '-' + now,
          type: 'power',
          text: '【世界 · 王座】' + pathwayName + '的位置上没人了 —— 有人没能撑到最后。',
          visibility: 'public',
          createdAt: now,
        });
        continue;
      }
      /* ② 到期了 —— 但**对撞时到期不作数**（只要还有别人在争） */
      if (now >= contest.endsAt) {
        const verdict = settleOrExtend({ contest, now });
        if (verdict.kind === 'extend') {
          contestRepo.extend({
            pathway: contest.pathway,
            endsAt: verdict.endsAt,
            extensions: contest.extensions + 1,
          });
          deps.worldEvents.insert({
            id: 'throne-extend-' + contest.pathway + '-' + now,
            type: 'power',
            text: '【世界 · 王座】' + pathwayName + '的位置上还有两个人在争 —— 这一局不算数。',
            visibility: 'public',
            createdAt: now,
          });
          continue;
        }
        if (verdict.kind === 'stalemate') {
          contestRepo.lapse({ pathway: contest.pathway, brokenBy: 'stalemate', note: verdict.note });
          deps.worldEvents.insert({
            id: 'throne-stalemate-' + contest.pathway + '-' + now,
            type: 'power',
            text: '【世界 · 王座】' + pathwayName + '的位置上，两个人都没能熬过对方 —— 位置继续空着。',
            visibility: 'public',
            createdAt: now,
          });
          continue;
        }
        contestRepo.settle(contest.pathway, claimant.name + '坐上了那个位置。');
        deps.divineThroneState.recordUsurp({
          pathway: contest.pathway,
          seat: claimant.name,
          seatKind: 'god',
          at: now,
          by: 'throne-contest:' + claimant.id,
          note: '有人从下面爬上来了 —— 而祂们没有拦住。',
        });
        deps.worldEvents.insert({
          id: 'throne-settled-' + contest.pathway + '-' + now,
          type: 'power',
          text: '【世界 · 王座】' + pathwayName + '的位置有人了 —— ' + claimant.name +
            '从灰雾之上下来的时候，已经不是原来的祂了。',
          visibility: 'public',
          createdAt: now,
        });
        deps.logger?.info('玩家登神', { pathway: contest.pathway, character: claimant.name });
      }
    }
  }

  /*
   * ═══════ M2.169：**神明的阴谋**（用户口径：「世界级规模，不要小打小闹」）═══════
   *
   * 与 NPC 的阴谋（tick.ts 里那一段）是两件事：
   *   npc_schemes     一个人算计另一个人 —— 街面；后果是玩家吃亏
   *   divine_schemes  一位神算计另一位神 —— **后果是神座易主**
   *
   * 原作里的先例（七正神.yaml）：黑夜女神与大地母神长期结盟，神战中联手暗算战神，
   * 战神陨落，黑夜教会彻底控制战神教会。那是一条跨数年、**有对手**、改变格局的链。
   *
   * 三段：
   *   ① 发起   只有**邪神那一档**（隐秘存在 / 外神）会主动开这一局；
   *            而且只能沿着关系网里 `covet` / `rival` 那两条边动手（不能随机挑目标）
   *   ② 推进   到 due 就进下一阶段（结盟 → 渗透 → 削弱 → 神战 → 陨落，共 390 天）
   *            每推一步都涨暴露度；暴露到一定程度会被**察觉**，察觉之后对方反击
   *   ③ 结算   `fall` 阶段到期时掷一次：成了 ⇒ **神座真的空出来**（改库里的状态），
   *            没成 ⇒ 被掀桌子；目标如果是旧日 ⇒ 最多只能封住（原作明写「无法真正杀死祂」）
   *
   * ⚠️ 播报在 `war` 与 `fall` 两级是**世界级**的（抬头用【世界 · 神战】【世界 · 神座】）——
   *    神打架这件事，全服都该看见天变了。
   */
  const relations = deps.divineRelations ?? [];
  const schemeRepo = deps.divineSchemes;
  const throneStateRepo = deps.divineThroneState;
  if (schemeRepo !== undefined && throneStateRepo !== undefined && relations.length > 0 && thrones.length > 0) {
    const schemeRng = createSeededRng(seedFrom([seed, 'divine-scheme', String(targetHour)]));
    // ① 发起：只有邪神那一档会主动开这一局
    if (schemeRng.next() < DIVINE_SCHEME_URGE_PER_HOUR) {
      const schemers = thrones.filter((t) => isDarkSeat(t.seatKind) && t.state !== 'vacant');
      if (schemers.length > 0) {
        const schemer = schemers[Math.floor(schemeRng.next() * schemers.length)]!;
        const edges = relations.filter((edge) => edge.a === schemer.pathway || edge.b === schemer.pathway);
        const possible = thrones.filter((t) =>
          t.pathway !== schemer.pathway && t.state !== 'vacant' &&
          canSchemeAgainst({ schemer: schemer.pathway, target: t.pathway, edges }) !== null,
        );
        if (possible.length > 0 && schemeRepo.openBySchemer(schemer.pathway) === null) {
          const target = possible[Math.floor(schemeRng.next() * possible.length)]!;
          const goal = schemeRng.next() < 0.5 ? 'usurp' : 'fall';
          const id = 'dscheme:' + schemer.pathway + ':' + target.pathway + ':' + targetHour;
          schemeRepo.create({
            id, schemer: schemer.pathway, target: target.pathway, goal,
            stage: 'ally', progress: 0, exposed: 0, allies: [],
            startedAt: now, dueAt: nextStageAt('ally', now), outcome: '',
          });
          deps.worldEvents.insert({
            id: 'divine-scheme-open-' + id,
            type: 'rumor',
            // 匿名：玩家该感觉到「有什么在动」，而不是收到一份通缉令
            text: '【世界 · 暗流】' + schemer.seat + '开始谋划一件事 —— 而这件事与' + target.seat + '有关。',
            visibility: 'public',
            createdAt: now,
          });
          deps.logger?.info('神明阴谋发动', { schemer: schemer.pathway, target: target.pathway, goal, id });
        }
      }
    }
    // ② 推进（到 due 才动 —— 世界级阴谋大部分时间都在「还没到时候」）
    for (const scheme of schemeRepo.open()) {
      if (now < scheme.dueAt) continue;
      const targetThrone = thrones.find((t) => t.pathway === scheme.target);
      const targetName = targetThrone?.seat ?? scheme.target;
      const next = stageAfter(scheme.stage);
      if (next === null) {
        /*
         * `fall` 到期 = 结算。三条影响结果，都可解释：暴露度（对手有准备）、
         * 同谋数（原作那次是两个打一个）、目标是不是「杀不死的那一档」。
         */
        const unkillable = targetThrone !== undefined && (targetThrone.seatKind === 'outsider' || targetThrone.seatKind === 'pillar');
        const outcome = resolveScheme({ scheme, targetUnkillable: unkillable, rng: schemeRng });
        schemeRepo.close({ id: scheme.id, outcome: outcome.result, at: now });
        if (outcome.result === 'done') {
          throneStateRepo.recordFall({
            pathway: scheme.target,
            /*
             * ⚠️ `seat` 必须显式带过去：它是「**上一任**是谁」，
             * 而「已陨落，疑似留有复活后手」那句话全靠它（原作里战神那一档）。
             * 不带的话库里那一行 seat 是空的 —— 玩家读到的就是「那个位置空着」，
             * 而**没人知道原来是谁**。
             */
            seat: targetThrone?.seat ?? scheme.target,
            at: now,
            by: scheme.id,
            note: targetName + '在神战中倒下 —— 祂的位置空着。',
          });
          /*
           * M2.169：**地上要留下痕迹** —— 否则「世界级后果」只兑现了一半。
           *
           * 【原作】「陨落真神造成的污染物100克」是序列 1 配方的材料，
           *        而它平时**不在任何掉落表里**：只有一位神倒下之后才会出现在地上。
           * 落在祂够得到的第一座城（`resources.reach[0]`）—— 每家不同，不会全挤在一处。
           */
          const scarAt = targetThrone?.resources.reach[0] ?? 'divine_war_ruins';
          deps.worldScars?.record({
            id: 'scar:fall:' + scheme.target,
            kind: 'divine_fall',
            pathway: scheme.target,
            locationId: scarAt,
            since: now,
            note: targetName + '倒下的地方 —— 那里的东西变了。',
            dangerBonus: 2,
            corruption: true,
            lootItem: '辅助材料·陨落真神造成的污染物',
            lootChance: 0.25,
          });
          /*
           * M2.169：**神的死要落到信徒头上**（原作：「战神陨落后黑夜女神教会彻底控制战神教会」）。
           *
           * 谁能接手取决于动手的那一位**有没有教会**：
           *   有教会（正神之间的暗算）⇒ 吞并；没有教会（邪神 / 外神）⇒ 只是塌了。
           * 这一条让不同的赢家留下**不同的局面**，而不是所有陨落都长一个样。
           */
          const schemerThrone = thrones.find((t) => t.pathway === scheme.schemer);
          const allyChurches = scheme.allies
            .map((pathway) => thrones.find((t) => t.pathway === pathway)?.resources.churches ?? [])
            .flat();
          const churchFateLines: string[] = [];
          for (const churchState of fateAfterFall({
            targetChurches: targetThrone?.resources.churches ?? [],
            schemerChurches: schemerThrone?.resources.churches ?? [],
            allyChurches,
            at: now,
            by: scheme.id,
            targetName,
            schemerName: schemerThrone?.seat ?? scheme.schemer,
          })) {
            deps.churchStates?.set(churchState);
            const churchName = deps.churches.byId(churchState.churchId)?.name ?? churchState.churchId;
            const takerName = churchState.controlledBy === ''
              ? ''
              : (deps.churches.byId(churchState.controlledBy)?.name ?? churchState.controlledBy);
            churchFateLines.push(churchFateLineOf(churchName, churchState, takerName));
          }
          if (churchFateLines.length > 0) {
            deps.worldEvents.insert({
              id: 'divine-church-fate-' + scheme.id,
              type: 'power',
              text: '【世界 · 教会】' + churchFateLines.join('\n'),
              visibility: 'public',
              createdAt: now,
            });
          }
        } else if (outcome.result === 'half') {
          throneStateRepo.setState({
            pathway: scheme.target, state: 'sealed', at: now, by: scheme.id,
            seat: targetThrone?.seat ?? scheme.target,
            note: '祂被封住了 —— 但祂还在那儿。',
          });
          /* 【原作】神战遗迹里遗留「真实造物主呓语，以及黑夜、太阳、大地、空想、死神的神力」 */
          deps.worldScars?.record({
            id: 'scar:war:' + scheme.target,
            kind: 'god_war',
            pathway: scheme.target,
            locationId: 'divine_war_ruins',
            since: now,
            note: '神战打过的痕迹 —— 那地方的神力还没散。',
            dangerBonus: 3,
            corruption: false,
            lootItem: '辅助材料·神战遗迹的神力残片',
            lootChance: 0.3,
          });
        }
        deps.worldEvents.insert({
          id: 'divine-scheme-end-' + scheme.id,
          type: 'power',
          text: '【世界 · 神座】' + schemeEndLine({
            schemerName: scheme.schemer, targetName, goal: scheme.goal, outcome,
          }),
          visibility: 'public',
          createdAt: now,
        });
        deps.logger?.info('神明阴谋结算', { id: scheme.id, result: outcome.result, exposed: scheme.exposed });
        continue;
      }
      const exposed = Math.min(100, scheme.exposed + exposureGain({ stage: scheme.stage, allies: scheme.allies.length }));
      schemeRepo.advance({
        id: scheme.id, stage: next, progress: scheme.progress + 1, exposed,
        dueAt: nextStageAt(next, now),
      });
      /*
       * 播报按阶段换调子：渗透与削弱是「有人在底下动」，神战是世界级的天变。
       * 匿名（rumor）—— 除了神战那一级：到那个规模就藏不住了（原作里神战是全世界都知道的事）。
       */
      const stageText: Record<string, string> = {
        ally: '【世界 · 暗流】有两位存在之间达成了某种默契 —— 没有人看见，但有人感觉到了。',
        infiltrate: '【世界 · 暗流】' + targetName + '的教堂里，这几周陆续换掉了几个不该换的人。',
        weaken: '【世界 · 异动】' + targetName + '手下接连出事：不是意外，是有人在收网。',
        war: '【世界 · 神战】天象变了 —— 有两位存在动了手。旧的遗迹就是这么来的。',
        fall: '【世界 · 神座】' + targetName + '的座位在晃。',
      };
      deps.worldEvents.insert({
        id: 'divine-scheme-' + scheme.id + '-' + next + '-' + now,
        type: next === 'war' || next === 'fall' ? 'power' : 'rumor',
        text: stageText[next] ?? ('【世界 · 暗流】' + scheme.id + ' 推进到了 ' + SCHEME_STAGE_LABELS[next]),
        visibility: 'public',
        createdAt: now,
      });
      // ③ 察觉 ⇒ 反击（目标或其盟友先动手 —— 于是这一局可能提前结束）
      if (detected({ exposed, rng: schemeRng })) {
        schemeRepo.close({ id: scheme.id, outcome: 'foiled', at: now });
        deps.worldEvents.insert({
          id: 'divine-scheme-exposed-' + scheme.id + '-' + now,
          type: 'power',
          text: '【世界 · 神座】有人先一步掀了桌子 —— ' + targetName + '知道了。',
          visibility: 'public',
          createdAt: now,
        });
        deps.logger?.info('神明阴谋被察觉', { id: scheme.id, exposed });
      }
    }
  }

  /*
   * ═══════ M2.167：**撑不住的人会变成怪物**（用户点名的那一条）═══════
   *
   * 用户口径：「NPC 堕落了应该堕落成非凡生物，会袭击人，教会组织等正神的组织会去清理堕落者。」
   *
   * ## 触发是「事件」，不是进度条（按原作）
   *
   * 原作里失控从来不是「条满了」：晋升失败、被黑暗笼罩、撑不住灌输……都是**某件事发生了**。
   * 所以这里判定的是「他这会儿还撑不撑得住」——概率用 `npcMutationChance`，
   * 而它**直接复用玩家失控那条公式**（`corrupted` 喂 cor）：
   * 序列 9 的闸门 65、divisor 250 ⇒ 堕落度 70 的人 2%/小时、100 的人 14%/小时。
   * 这个量级不是我拍的，是既有公式在极端输入下的自然结果。
   *
   * ## 他长成哪一只，由**他的途径**决定
   *
   * 非凡者按自己的途径；**普通人按蛊惑他的那位存在的途径**（`npc_life.tempter`）——
   * 这正是「被哪条途径的力量侵蚀，就长成那条途径的怪物」。
   * 转途径者（原作因斯·赞格威尔）按主途径成形，其余途径的形态名拼进播报。
   *
   * ## 变成之后
   *
   *   ① 他从「人」的体系退出：`human = 0`、`beast_id` 指向那一只（不是死 —— 他没死）
   *   ② creatures 里多一只实例：就在他当时站着的那个地点，会迁移、会吃、会被打
   *   ③ 世界播报带上**他原本的名字**：这是这一整套设计的恐怖点 —— 玩家会认出他
   *
   * ⚠️ 一小时最多一个人变（`break`）：与复活那段同一条纪律 —— 世界的坏掉是缓慢的。
   */
  const beastTable = deps.fallenBeasts ?? [];
  const beastForms = deps.lostControlPool?.forms ?? [];
  if (beastTable.length > 0 && beastForms.length > 0) {
    const mutRng = createSeededRng(seedFrom([seed, 'mutation', String(targetHour)]));
    // 血月是原作里「放出无数怪物」的那种夜（全服一份，所以算在循环外）
    const bloodMoon = repo.weatherStates().some((s) => s.weather === 'blood_moon');
    for (const entry of deps.npcRoster.all) {
      if (entry.source !== 'cast') continue;
      const life = deps.npcLife.of(entry.id);
      if (life === null || !life.alive || life.beastId !== '') continue;
      if (corruptionTierOf(life.corrupted) !== 'fallen') continue;
      const locationId = deps.npcProgress.of(entry.id)?.locationId ?? null;
      // 没有位置就没法把他放进世界 —— 下一小时再掷（不猜一个地点出来）
      if (locationId === null) continue;
      /*
       * **环境因子（每个人不同）**：他站在什么地方、天上是什么。
       *
       * 判定层不认识地点表与区域表（那条分法是全项目的），所以在这里查好再传进去 ——
       * 与 `powerIndex` / `zoneIndex` 的用法一致。两层都算：
       *   · 地点被标成堕落源（深渊入口、神战遗迹、迷雾海、东大陆）
       *   · **或者**他所在的城市属于一整片堕落的地方（东大陆＝神弃之地）
       * 少了第二层，白银之国的四座城会被漏掉 —— 而那正是原作里「黑暗让人堕落」的本体。
       */
      const here = deps.locations.get(locationId);
      const city = deps.geo.cityOfLocation(locationId);
      const region = city === null ? undefined : deps.geo.regions.find((r) => r.id === city.region_id);
      const corruptionSource = here?.corruption_source === true || region?.corruption_source === true;
      const sequence = entry.sequence ?? 9;
      const chance = npcMutationChance({
        corrupted: life.corrupted,
        sequence,
        env: { corruptionSource, bloodMoon, promotionFails: 0 },
      });
      if (chance <= 0 || mutRng.next() >= chance) continue;
      /*
       * 他该长成哪条途径的东西：自己的途径优先，普通人用蛊惑他的那一位的途径。
       * 两条都没有（既非凡者又不是被蛊惑的）⇒ 空数组 ⇒ 挑不到形态 ⇒ 他不变。
       */
      const pathways = entry.pathway !== ''
        ? [entry.pathway]
        : (life.tempter === '' ? [] : [life.tempter]);
      const picked = pickFallenBeast({ beasts: beastTable, forms: beastForms, pathways, sequence, rng: mutRng });
      if (picked === null) continue;
      const beastId = 'beast:' + entry.id;
      const beastSeq = beastSequenceOf(sequence, picked.beast);
      const speciesId = 'fallen:' + picked.beast.formId;
      /*
       * ⚠️ **先把这个物种播进库，再插实例** —— creatures.species_id 有外键。
       *
       * 物种平时是生态 tick **懒播种**的（它拿 creatureIndex.all() 一次播完），
       * 而世界 tick 与生态 tick 是两套调度：谁先跑不确定。
       * 少了这一行，异变会在外键上炸掉 —— 而且只在「生态还没跑过」的那段时间里炸，
       * 也就是新库、以及跑批脚本里最常出现的那种状态。
       * `seedSpecies` 是覆盖式的（幂等），每次播一行不值得心疼。
       */
      const species = deps.creatureIndex.byId(speciesId);
      if (species === null) continue;
      deps.creatures.seedSpecies([species], now);
      deps.creatures.insertMany([{
        id: beastId,
        speciesId,
        locationId,
        sequence: beastSeq,
        hp: picked.beast.baseHp,
        maxHp: picked.beast.baseHp,
        status: 'healthy',
        ageHours: 0,
        feedCount: 0,
        lastFedAt: null,
        spawnedAt: now,
        migratedFrom: null,
      }]);
      deps.npcLife.becomeBeast(entry.id, beastId);
      const traits = hybridTraits({
        forms: beastForms,
        pathways,
        primaryPathway: picked.form.pathway,
        sequence,
      });
      deps.npcDeeds.record({
        npcId: entry.id,
        kind: 'mutation',
        detail: entry.name + ' 变成了「' + picked.form.name + '」（' + picked.form.pathway + '）',
        merit: 0,
        at: now,
      });
      deps.worldEvents.insert({
        id: 'npc-mutation-' + entry.id + '-' + now,
        type: 'power',
        text: '【世界 · 异变】' + mutationLineOf(entry.name, picked.form.name, traits),
        visibility: 'public',
        createdAt: now,
      });
      deps.logger?.info('堕落成怪物', {
        npc: entry.id,
        form: picked.form.id,
        beast: beastId,
        location: locationId,
        sequence: beastSeq,
        corrupted: life.corrupted,
        chance: Number(chance.toFixed(4)),
      });
      break;
    }
  }
  /*
   * ═══════ M2.167②：**它们会袭击人** ═══════
   *
   * 原作里的怪物**一直在吃人**（食人之犬、伪人、魅魔……），而项目里 293 个物种从不碰人。
   * 这一条补的是那个缺口 —— 而且它让教会的清剿有了**紧迫性**：清理得越晚，死的人越多。
   *
   * 判定三件事：
   *   ① 它动手吗 —— 基础 8%/小时（约每十二小时一次），饥饿时翻倍
   *   ② 谁在旁边 —— 同地点、还活着、**并且还是人**的居民（已经变成怪物的不算）
   *   ③ 那人活不活得下来 —— 直接复用死亡档位表：`deathChanceOf(序列, 'creature')`
   *      （凡人 50%、天使 4% —— 与上一轮那套完全同一条路，没有第二份公式）
   *
   * ⚠️ 为什么不只威胁玩家：一个只威胁玩家的怪物是「关卡」；一个会吃掉街上居民的怪物
   *    才是「世界在坏掉」。
   */
  const fallenInstances = deps.creatures.all().filter((c) => c.speciesId.startsWith('fallen:'));
  if (fallenInstances.length > 0) {
    const attackRng = createSeededRng(seedFrom([seed, 'beast-attack', String(targetHour)]));
    for (const beast of fallenInstances) {
      const hungry = beast.status === 'hungry';
      const chance = BEAST_ATTACK_PER_HOUR * (hungry ? 2 : 1);
      if (attackRng.next() >= chance) continue;
      const locals = deps.npcProgress
        .atLocation(beast.locationId)
        .filter((p) => {
          const life = deps.npcLife.of(p.npcId);
          // 已经变成怪物的、已经死了的，都不是「人」了 —— 它不吃同类，也不吃尸体
          return deps.npcLife.isAlive(p.npcId) && (life === null || life.beastId === '');
        });
      if (locals.length === 0) continue;
      const victimProgress = locals[Math.floor(attackRng.next() * locals.length)]!;
      const victim = deps.npcRoster.byId(victimProgress.npcId);
      if (victim === null) continue;
      const victimSeq = victim.sequence ?? 9;
      const beastName = deps.npcRoster.nameOf(beast.id.slice('beast:'.length));
      const died = attackRng.next() < deathChanceOf(victimSeq, 'creature');
      if (died) {
        const line = deathLineOf(victim.name, 'creature', beastName);
        deps.npcLife.kill({ npcId: victim.id, kind: 'creature', note: line, killer: beast.id, at: now });
        deps.npcDeeds.record({ npcId: beast.id, kind: 'kill', detail: beastName + ' 吃掉了 ' + victim.name, merit: 0, at: now });
        deps.worldEvents.insert({
          id: 'npc-beast-kill-' + victim.id + '-' + now,
          type: 'power',
          text: '【世界 · 死讯】' + line,
          visibility: 'public',
          createdAt: now,
        });
      } else {
        deps.npcDeeds.record({ npcId: victim.id, kind: 'injury', detail: victim.name + ' 从' + beastName + '手底下跑掉了', merit: 0, at: now });
        deps.worldEvents.insert({
          id: 'npc-beast-hurt-' + victim.id + '-' + now,
          type: 'rumor',
          text: '【世界 · 血迹】' + victim.name + '带着一身伤回来了 —— 他说不清那是什么东西。',
          visibility: 'public',
          createdAt: now,
        });
      }
    }
  }

    if (lightKeys.length > 0) {
      // 水位线记「真实推进到的最后一格」，被补跑上限截断时下次接着补
      repo.update({ lastLightAt: lightUntil - HOUR_MS }, now);
    }
    if (heavyKeys.length > 0) {
      repo.update(
        {
          lastHeavyAt: heavyUntil - DAY_MS,
          dayIndex: today,
          moonPhase: moonPhase(now),
          foggy: isFoggy(now, mark.seed),
        },
        now,
      );
    }
    /*
     * M2.59：势力的警觉随小时衰减。
     *
     * 挂在这里而不是另起定时器：警觉与「有没有出事」是同一件事的两面，
     * 分成两条时间线会出现「警觉掉了但事件还没处理」的中间态。
     * 与 M2.58 的生态恐慌同一个手法（decayZoneFear）。
     */
    if (lightKeys.length > 0) {
      try {
        decayPowerAlert(deps.db, deps.powerIndex, now, lightKeys.length);
      } catch {
        // 警觉衰减出问题不该影响世界推进（与 runWorldEvents 同一条兜底）
      }
    }
  }

  // 水位线写回内存：下一次同小时 / 时钟回跳的调用 O(1) 返回
  watermarks.set(repo, { seed: mark.seed, lightUntil, heavyUntil });

  /*
   * M2.39：**一个 tick 一条播报**。
   *
   * 本 tick 的全部变化（逐格天气异象 / 预告 + 世界事件）在这里合成一条；
   * 批量补跑（一次推进跨了多个小时 / 多个日）时，聚合成一段「过去 N 天」的总结
   * —— 加速 30 天产生的是**一条**世界动态，不是 30 条（更不是 30 × 每格数）。
   */
  const broadcasts = renderTickBroadcasts(deps, {
    feeds: weatherFeeds,
    changes,
    events,
    lightHours: lightKeys.length,
    heavyDays: heavyKeys.length,
  });

  return {
    clock,
    light: { executed: lightKeys.length, keys: lightKeys },
    heavy: { executed: heavyKeys.length, keys: heavyKeys },
    changes,
    broadcasts,
    states,
    events,
    skipped: lightKeys.length === 0 && heavyKeys.length === 0,
  };
}

/**
 * M2.62：跑一次边界输入判定。
 *
 * ## 三个「由调用方查」的输入
 *
 *   zoneOfLocation —— 地点属于哪个生态域（恐慌要加到正确的域上）
 *   powersAt       —— 这个地点上此刻有哪些本地势力（警觉要加给它们）
 *   rollFor        —— 从世界 seed 派生的掷值
 *
 * 前两个交给调用方是因为**判定层不认识域表与领地表**（M2.58 / M2.59 起就守着的分法）；
 * 第三个在这里派生（`seedFrom` 的口径与其它判定一致）——
 * 同一条边界 + 同一个时刻必然得到同一种输入，补跑重放不会变成另一种。
 */
function runBoundaries(deps: RouterDeps, hourStart: number, seed: string): void {
  const result = tickBoundaries({
    db: deps.db,
    boundaryIndex: deps.boundaryIndex,
    worldEvents: deps.worldEvents,
    seed,
    // 地点 → 生态域：恐慌加到那个域上（域表没这条地点时返回 null）
    zoneOfLocation: (locationId) => deps.zoneIndex.of(locationId)?.id ?? null,
    // 地点 → 此刻管着它的本地势力（领地或主场区域都算）
    powersAt: (locationId) => deps.powerIndex.atLocation(locationId).map((power) => power.id),
    at: hourStart,
  });
  if (result.fired.length > 0) {
    deps.logger?.info('边界输入', {
      fired: result.fired.map((entry) => entry.boundaryId + ':' + entry.kind),
    });
  }
}

/**
 * M2.4：世界事件 → 落库 → 播报文本。
 *
 * 分工（硬约束「判定层纯函数」）：
 *   domain/world/events.ts  回答「这一刻该发生什么」（纯函数，不读玩家状态、不进 IO）
 *   这里                    回答「落哪张表、念给谁听」（IO 与投递）
 *
 * 频率控制在这条链路的**生成侧**（domain 的 maxPerHour），所以「生成」与「播报」
 * 永远同一条数 —— 不会出现「库里 5 条、群里 3 条」这种对不上的情况。
 *
 * 可见性（任务书 §3）：public / anonymous 走现有群播报通道；faction 只给该势力成员的群，
 * M2.6 才接 —— 本轮**照样落库**，只是不播（区间口径写在 docs/M2.4-世界事件覆盖.md）。
 */
function runWorldEvents(
  deps: RouterDeps,
  states: readonly WeatherState[],
  at: number,
  seed: string,
  sink: WorldEvent[],
  changes: readonly WeatherChange[],
): void {
  try {
    const changed = changes.map((change) => change.locationId);
    const events = generateWorldEvents(worldEventSnapshot(deps, states, at, seed, changed), at, seed);
    if (events.length === 0) return;
    deps.worldEvents.insertMany(events);
    /*
     * M2.39：这里只落库，**不再直接渲染播报** —— 渲染移到 renderTickBroadcasts，
     * 那里才能把本 tick 的全部素材合成一条。可见性过滤（faction 不播）也一并搬过去。
     */
    sink.push(...events);
    /*
     * M2.59：**势力对世界事件的反应**。
     *
     * 挂在世界事件落地的地方而不是另起一条链路，理由：势力反应本来就是
     * 「对世界事件的一种响应」，分开跑会出现「事件播了但没人动」的窗口，
     * 而那个窗口只在补跑与定时器交错的时刻出现，最难查。
     *
     * 只对**灾厄与环境异象**起反应：
     *   - 目击那一支在 creature-hooks 里（那里才有感知层次），不在这里重复；
     *   - 传闻是匿名且真假难辨的，势力不会为一条传闻出动（但它们的目标里
     *     「封锁真相」仍然会因此涨警觉 —— 那是 rumor 类型进 BASE_RELEVANCE 的原因）。
     * 严重度：灾厄按等级/3，环境异象固定 0.5（它本身就是「世界不对了」的信号）。
     */
    for (const event of events) {
      if (event.type !== 'calamity' && event.type !== 'environment') continue;
      const severity = event.type === 'calamity' ? 0.8 : 0.5;
      /*
       * M2.60：先给这条世界事件建因果节点，再让势力反应挂上去。
       *
       * 顺序不能反：势力反应的 responded 边要指向一个**已经存在**的节点。
       * 反过来的话边上会挂一个悬空的 from_node —— 那种图在复盘时
       * 表现为「这条边指向不存在的东西」，而它只在补跑窗口里出现。
       */
      let nodeId: string | null = null;
      try {
        nodeId = new CausalRepo(deps.db).recordWorldEvent({
          eventId: event.id,
          type: event.type,
          summary: worldEventHeadline(event) + '（' + event.type + '）',
          intensity: severity,
          at,
        });
      } catch {
        // 因果图坏了不影响世界播报
      }
      try {
        notePowerReactions({
          db: deps.db,
          powerIndex: deps.powerIndex,
          worldEvents: deps.worldEvents,
          locationId: null,
          locationName: null,
          kind: event.type === 'calamity' ? 'calamity' : 'environment',
          severity,
          sourceId: event.id,
          ...(nodeId === null ? {} : { sourceNodeId: nodeId }),
          now: at,
        });
      } catch {
        // 势力反应出问题不该影响世界播报（与上面同一条兜底）
      }
    }
  } catch (error) {
    // 世界播报坏了绝不能影响玩家那条指令：记一条日志，继续往下走
    deps.logger?.warn('世界事件生成失败', { error: (error as Error).message });
  }
}

/**
 * 事件生成器看到的世界。
 * **只填世界字段**：clock（时段/月相/雾日/季节）+ 各地点此刻的天气状态 + 地点名。
 * weather / modifiers / exploreUsedToday 是菜单要用的玩家相关字段，这里给中性值 ——
 * 生成器一个都不读（test/m2-4.test.ts 用「改这些字段输出不变」把这条钉住）。
 */
export function worldEventSnapshot(
  deps: RouterDeps,
  states: readonly WeatherState[],
  at: number,
  seed: string,
  changedThisHour: readonly string[] = [],
): WorldSnapshot {
  const clock = worldClock(at, seed);
  const locations: LocationView[] = deps.locations.all().map((location) => ({
    id: location.id,
    name: location.name,
    danger: location.danger,
    minSeq: location.min_seq,
    maxSeq: location.max_seq,
    lootCount: location.loot.length,
  }));
  return {
    clock,
    weather: 'clear',
    modifiers: worldModifiers({ clock, weather: 'clear' }),
    locations,
    weatherStates: states,
    weatherChangedThisHour: changedThisHour,
  };
}

function ensureWeatherRows(
  repo: RouterDeps['world'],
  locations: ReturnType<RouterDeps['locations']['all']>,
  now: number,
  seed: string,
): WeatherState[] {
  const existing = repo.weatherStates();
  const known = new Set(existing.map((state) => state.locationId));
  const missing = locations.filter((location) => !known.has(location.id));
  // 冷启动（或内容新增地点）：从「晴」开始，不广播、不扩散；相位各自错开
  const created = missing.map((location) => initialWeatherState(location.id, now, seed));
  if (created.length === 0) return existing;
  repo.upsertWeather([...existing, ...created], now);
  return repo.weatherStates();
}

/*
 * ⚠️ 这里**没有**「自动打散历史相位」。
 *
 * 我写过一版：判据是「3 个以上地点的到期时刻完全一致」，命中就把它们的 until 各自抖开。
 * 两个理由让它必须拿掉：
 *
 *   1. **判据分不清「旧数据」和「人为对齐」**。测试夹具（test/m2-4.test.ts 的
 *      snapshotWithBloodMoon 把四个地点都设成同一时刻起血月）正好命中，
 *      于是精心构造的天气被提前抽掉，三条 M2.4 用例当场红。
 *   2. 更要紧的是 ensureWeatherRows 也在**只读路径**上被调用
 *      （worldSnapshotFor 组装快照时）。那一版让一个读操作每次都在写库。
 *
 * 正确做法是让世界按新节奏自然错开（每个地点换天气时抖一次，最多 9 小时就散开），
 * 需要立刻见效就跑 scripts/respread-weather.ts —— 迁移是迁移，不该藏在 tick 里。
 */

/**
 * 历史数据的相位是否需要打散。
 *
 * 判据：**所有地点的到期时刻完全一致**。
 * 旧口径下这是必然的（同时起步 + 恒定时长）；新口径下每个地点各自抖动，
 * 三个以上地点碰巧同刻的概率可以忽略。
 *
 * 不打散的话，已经在跑的世界要等整整一轮（最多 9 小时）才会自然错开 ——
 * 而「全服整点一起换天气」正是要修掉的那个现象。
 */


function runWeatherTick(
  deps: RouterDeps,
  states: readonly WeatherState[],
  at: number,
  seed: string,
): WeatherTickOutput {
  const clock = worldClock(at, seed);
  return tickWeather({
    states,
    locations: deps.locations.all(),
    now: at,
    seed,
    ctx: weatherWeightContext(clock),
  });
}

/**
 * M2.39：把本 tick 的全部变化渲染成**最多一条**播报。
 *
 * 两种形态（任务 1 与任务 3）：
 *   - 单 tick（只补了一格）：逐格原文渲染后合并成一条 —— 既有文案一个字不改；
 *   - 批量补跑（跨了多个小时 / 多天）：聚合成一段「过去 N 天」的总结，**不是逐格播报**。
 *     加速 30 天时，逐格播报会产生几千条消息（每条还要乘群数），这正是配额被打爆的原因。
 *
 * 返回 0 或 1 条：`string[]` 的形状是给既有调用方（`for (const text of result.broadcasts)`）
 * 留的，不是「可能有多条」。
 */
/** 一条待发播报：正文 + 可选的底部按钮 */
export interface BroadcastItem {
  text: string;
  buttons?: BroadcastButton[];
}

export function renderTickBroadcasts(
  deps: RouterDeps,
  input: {
    feeds: readonly WeatherFeed[];
    /** 本 tick 的全部天气变化（含不播报的那些，汇总时按 isEpicWeather 过滤） */
    changes: readonly WeatherChange[];
    events: readonly WorldEvent[];
    lightHours: number;
    heavyDays: number;
  },
): BroadcastItem[] {
  /*
   * ═══════ M2.171：**主动推送只留「灾厄与特殊事件」**（用户拍板）═══════
   *
   * 三条口径，每一条都是砍掉一类消息：
   *
   * ```
   * ① 天气变化**不推**    雾、月相、天气异象自己去看 `.世界` ——
   *                      「世界每天在变天」不值得占用一次主动推送的额度
   * ② 批量补跑**不推总结** 原来补跑会发一条「【世界动态】补齐 N 小时 / N 天，以下
   *                      是过去约 N 天的总结」—— 对群里的人来说那是一段回顾，不是新闻
   * ③ 只推三类事件        calamity / environment / power（见 PUSH_EVENT_TYPES）
   * ```
   *
   * ⚠️ 补跑时**仍然推事件本体**（只是最多一条）—— 不能让「服务器停机三天」
   *    表现为「世界死了三天」。停机的代价应该是「错过了中间那些」，
   *    而不是「什么都没发生过」。
   */
  const catchUp = input.lightHours > 1 || input.heavyDays > 1;
  const pushable = input.events.filter(
    (event) => event.visibility !== 'faction' && PUSH_EVENT_TYPES.has(event.type),
  );
  const picked = catchUp ? pushable.slice(-1) : pushable;

  /*
   * 世界事件：public / anonymous 进群播报，faction 只落库（M2.4 的可见性口径）。
   *
   * ⚠️ **这里不放数字菜单**（M2.86 实机修正）。
   *
   * 原来这里写的是 `renderMenu(worldEventMenu(event))`，注释还论证过它「安全」：
   *   「数字回复读的是库里的 latestLive()，不是从文本里对编号，
   *     合并前后的行为完全一致（都只有最新那一条能回）」
   *
   * **那句「只有最新那一条能回」正是 bug 本身。** 用户实机截图：
   *
   *     【世界 · 皇家剧院】  1. 去皇家剧院看看 / 2. 打听消息 / 3. 无视
   *     【世界 · 勇敢者酒吧】 4. 去勇敢者酒吧看看 / 5. 打听消息 / 6. 无视
   *
   * 两条推送各开一张菜单，后者覆盖前者；第二条的编号从 4 起（`openWith` 会重编号），
   * 于是**第一条的 1/2/3 永远点不到**，而回 `1` 会执行**第二条**的第一项 ——
   * 玩家看到的是「去皇家剧院」，执行的是「去勇敢者酒吧」。
   * 这比「点了没反应」更糟：**点错了还看不出来。**
   *
   * 现在群播报**只播报**，末尾给一行指引；真正带编号的交互在 `.世界` 里
   * （`src/router/commands/world.ts` 把事件选项接到**当次回复**的菜单上 —— 那才是安全的位置，
   *   因为它是「一次指令一次菜单」，不会被后来的推送顶掉）。
   */
  const out: BroadcastItem[] = [];

  /* 天气那一段（`input.feeds`）**整段去掉**了 —— 见上面 ①。
     参数保留是为了不动调用方与既有测试；`input.changes` 同理。 */

  // 灾厄与特殊事件：一条一条各自成条，**底部附它自己的按钮**
  for (const event of picked) {
    // 灾厄走**危机感模板**（它是唯一一类「有人正在死」的消息）
    if (event.type === 'calamity') {
      out.push({ text: calamityNotice(event) });
      continue;
    }
    const notice = worldEventNotice(event);
    if (notice.text.trim().length === 0) continue;
    out.push(notice.buttons.length > 0 ? { text: notice.text, buttons: notice.buttons } : { text: notice.text });
  }

  return out;
}


/**
 * 世界事件的**群播报文本**（不带编号，M2.86）。
 *
 * 为什么不复用 `renderMenu(worldEventMenu(event))`：
 * 那个渲染器会带 `1. 2. 3.` 的编号，是给「一次指令一次回复」用的 ——
 * 那种场景下编号有对应的待答菜单，回数字能对上。
 *
 * 而群播报是一条**通知**：玩家可能几分钟后才看到，那时菜单早被后来的推送顶掉了，
 * 编号还在、却指向别的事件。所以这里只留抬头与正文，末尾给一行明确指引。
 */
/**
 * M2.171：**只有这三类事件会推到群里**（用户口径：「只推送灾厄和特殊事件」）。
 *
 * ```
 * calamity     灾厄      —— 世界在出事（有人会死）
 * environment  环境异象  —— 世界不对了（诡异，但不一定伤人）
 * power        特殊事件  —— 神明级：神战 / 王座 / 教会易主（世界格局变了）
 * ```
 *
 * 其余类型（`rumor` 传闻、街面死讯、NPC 之间的算计……）**照旧落库**，只是不进群 ——
 * 它们该在 `.世界` 里被看见，而不是占掉一次主动推送的额度。
 */
const PUSH_EVENT_TYPES: ReadonlySet<string> = new Set(['calamity', 'environment', 'power']);

/** 零宽空格：官方 markdown 里「真的空一行」的唯一写法（docs/QQ-markdown-能力实测.md） */
const ZWSP = '\u200b';

/**
 * **灾厄的推送模板**（M2.171）。用户原话：「灾厄的推送 MD 模板要做出危机感」。
 *
 * ## 危机感从哪来
 *
 * ```
 * ① 第一行就是 ⚠️ + 加粗的地点   —— 一眼看见「哪里出事了」，不用读第二行
 * ② 正文独立成段（前后真空一行）  —— 与平时的播报在视觉上分开，它不该被滑过去
 * ③ 结尾**不说「已经处理」**       —— 危机感来自「还没完」，所以末句是「别站在那儿」
 * ```
 *
 * ⚠️ 只用两种元素：`**加粗**` 与零宽空格空行。
 *    不用 `>` 引用块、不用 `***` 分割线 —— 它们在 **markdown 关着的部署**里
 *    会被原样打出来（`applyMdStyle(plain)` 只剥 `**`），
 *    而「手机上看到一堆星星和尖括号」比不加版式更糟。
 */
function calamityNotice(event: WorldEvent): string {
  const cut = event.text.indexOf('\n');
  const head = cut < 0 ? event.text : event.text.slice(0, cut);
  const body = cut < 0 ? '' : event.text.slice(cut + 1);
  // 抬头形如「【世界 · 廷根市】」—— 分两步剥，只留地点。这里踩过两个坑，都写下来。
  //
  // ① 一条大正则吃不下：括号、空格、间隔号都可能有变体，任何一处对不上就整条不匹配。
  //    实测输出是「⚠️ **灾厄 · 【世界 · 廷根市**」—— 抬头原样留在标题里。
  //    拆成「先剥外壳、再剥前缀」之后每一步都短，哪一步失败一眼能看出来。
  //
  // ② ⚠️ **块注释里绝对不能出现正则字面量**：这一段的上一版写成块注释，里面举例了
  //    一个正则，而那个正则的结尾两个字符正好是注释的结束符 ——
  //    于是注释**提前闭合**，后面半句话变成了代码，tsc 报出 29 个错（其中一句是
  //    「Cannot find name '世界s'」）。文件用编辑器看完全正常，只有编译才知道坏了。
  //    所以这一段改成了行注释。
  //
  // ③ 同一个坑的另一面：正则里的反斜杠在「数组 join 之后再写文件」这种多层构造里会丢。
  //    所以这一步**一个反斜杠都不用**：startsWith + 字符类（`-` 放末尾免转义）。
  const inner = head.replace(/^【/, '').replace(/】$/, '').trim();
  const where = inner.startsWith('世界')
    ? inner.slice(2).replace(/^[ ·・•.-]+/, '').trim()
    : inner;
  const lines = ['⚠️ **灾厄 · ' + (where === '' ? '某处' : where) + '**', ZWSP];
  if (body.trim().length > 0) {
    lines.push(body.trim(), ZWSP);
  }
  lines.push('**这件事还没过去。**', '别站在那儿。');
  return lines.join('\n');
}

function worldEventNotice(event: WorldEvent): { text: string; buttons: BroadcastButton[] } {
  // 抬头与正文按第一个换行拆（与 renderWorldEvent 同一约定，events.ts 的文件头写着）
  const cut = event.text.indexOf('\n');
  const head = cut < 0 ? event.text : event.text.slice(0, cut);
  const body = cut < 0 ? '' : event.text.slice(cut + 1);
  const lines: string[] = [head];
  if (body.length > 0) lines.push(body);
  /*
   * M2.86：底部不放「1. 2. 3.」的数字菜单（那需要待答菜单，多条推送会互相覆盖），
   * 改成**原始按钮**：每个按钮的 data 是完整指令，点下去平台回传、走普通路由。
   */
  const buttons: BroadcastButton[] = (event.options ?? []).map((option) => ({
    label: option.label,
    command: option.command,
  }));
  if (buttons.length === 0) lines.push('发送 .世界 查看并参与。');
  return { text: lines.join('\n'), buttons };
}

/** 显著天气的氛围文案（数据驱动兜底：未知天气给通用句） */
/*
 * M2.171（用户拍板）：这里原本是 `renderCatchUpSummary`（批量补跑的「过去 N 天」总结）
 * 与 `broadcastLines`（天气异象播报渲染）—— **都已删除**。
 *
 * 理由见 `renderTickBroadcasts` 顶部那三条口径：主动推送只留给「灾厄与特殊事件」，
 * 天气变化与补跑回顾从此不进群（它们仍然照常落库、仍然能在 `.世界` 里看到）。
 */

function epicFlavor(weather: string): string {
  switch (weather) {
    case 'blood_moon':
      return '月亮是红的，所有人都在做同一个梦。';
    case 'spirit_creep':
      return '有什么东西从另一边渗了过来，纸上的字在动。';
    default:
      return '空气里有什么东西在变。';
  }
}

/* ---------------- 只读查询（.世界 与测试用） ---------------- */

/** 当前世界状态快照（不做任何推进） */
export function peekWorld(deps: RouterDeps, now: number): {
  clock: WorldClock;
  states: WeatherState[];
} {
  const repo = deps.world;
  repo.ensure(now, deps.worldSeed ?? 'world');
  const seed = repo.seed();
  return {
    clock: worldClock(now, seed),
    states: ensureWeatherRows(repo, deps.locations.all(), now, seed),
  };
}

/** 时段的展示文案（.世界 首行） */
export function clockSummaryLine(clock: WorldClock): string {
  return [
    `时段 ${TIME_OF_DAY_LABELS[clock.timeOfDay]}（${String(clock.hour).padStart(2, '0')}:00 · ${seasonOf(clock.now)}）`,
    `月相 第 ${clock.moonPhase} 日${clock.fullMoon ? ' · 月圆' : ''}`,
    clock.foggy ? '雾日 · 今天' : `雾日 · 还有 ${Math.max(0, clock.nextFogDay - clock.dayIndex)} 天`,
  ].join('　|　');
}

void timeOfDay;