/**
 * **神明的思考**（M2.98）—— 用户要求：「神明需要拥有非常强的思考 AI」。
 *
 * ## 与 `divine-decide.ts` 的分工
 *
 *   divine-decide    **要不要动**（稀有性四道门：基础率 / 沉寂 / 状态 / 显现折扣）
 *   divine-mind      **动什么、为什么、下一步是什么**（这个文件）
 *
 * 上一版是「局势命中 ⇒ 那条手段权重 ×5」—— 那是**反应**，不是思考。
 * 这个文件把三个能力加上去：
 *
 * ## ① 观感（Insight）：从关键词**推断**出看不见的东西
 *
 * 局势给的是 `player_digs_sealed` 这样的关键词。神要看到的不是关键词，是**人话**：
 * 「有人在挖封印物 ⇒ 他想拿到那东西 ⇒ 那东西一旦出土，我埋的历史就藏不住了」。
 * `OBSTACLE_OF` / `OPENING_OF` 两张表把关键词翻译成「谁挡了我的哪个目标」。
 *
 * ## ② 记忆（Memory）：祂记得你做过什么
 *
 * 同一个人在同一个地方挖第二次时，祂的反应与第一次不同 —— 因为她记得。
 * 记忆是**每条神一份**、按玩家 id 存的最近 N 件事，带**好恶**（`+` / `-`）。
 * 它同时是「降罚 / 赐福」这类行动的判据：好感度低的人更容易被降罚。
 *
 * ## ③ 规划（Plan）：不是选一步，是排一条链
 *
 * 每个目标可以有多步手段（`methods` 里 `goal` 相同的那些）。
 * 思考会：**挑出收益率最高的目标** → 排出该目标的**步骤顺序**（按 needs 的先后）→
 * 记住「已经走到第几步」⇒ 下一次祂接着往下走，而不是重新掷骰子。
 * 这就是「非常强的思考」在规则引擎里的落点：**有计划的连续性**。
 */
import type { DivineMethod, DivineThrone } from './divine-throne.ts';

/** 局势关键词 → 「谁在动」 */
const ACTOR_OF: Readonly<Record<string, string>> = {
  player_digs_sealed: '某个在挖东西的人',
  rival_gains_followers: '另一位在收信徒的存在',
  pollution_spreads: '从南边漫过来的东西',
  spirit_breach: '灵界的那一侧',
  machine_sabotaged: '动了机器的人',
  knowledge_lost: '把记载抹掉的人',
  crime_spikes: '东区那些做事的人',
  order_breaks_down: '不再守规矩的人',
  bodies_uncollected: '死在街上的人',
  battle_intensifies: '正在打的人',
  tension_high: '两边都在等的人',
  sea_route_disrupted: '海上的事',
  corruption_spreads: '被污染的东西',
  player_despair: '撑不住的人',
  player_tainted: '身上有脏东西的人',
  power_vacuum: '没有主的位置',
  player_resists_temptation: '拒绝诱惑的人',
  record_conflict: '对不上的记录',
  player_breaks_script: '不按剧本走的人',
  bodies_uncollected_alt: '没人收的尸首',
};

/** 局势关键词 → 它**威胁**了哪个目标（目标 id 用 `*` 表示「任何目标」时按目标文本匹配） */
const THREAT_OF: Readonly<Record<string, string>> = {
  player_digs_sealed: 'keep_secrets',
  knowledge_lost: 'know_all',
  pollution_spreads: 'purify',
  crime_spikes: 'make_everyone_fall',
  order_breaks_down: 'restore_order',
  corruption_spreads: 'hold_back_corruption',
  sea_route_disrupted: 'rule_the_sea',
  rival_gains_followers: 'keep_secrets',
};

/** 局势关键词 → 它**有利于**哪个目标（机会） */
const OPENING_OF: Readonly<Record<string, string>> = {
  player_despair: 'embrace_pain',
  player_tainted: 'purify',
  battle_intensifies: 'start_a_war',
  tension_high: 'start_a_war',
  power_vacuum: 'rule_again',
  player_resists_temptation: 'spread_desire',
  bodies_uncollected: 'collect_the_dead',
  player_fights_well: 'honor_strength',
  player_acts_unpredictably: 'write_the_end',
  player_seeks_power: 'rule_again',
};

/** 一位神此刻**看到**的世界（不是关键词，是推断出来的人话） */
export interface DivineInsight {
  /** 谁在动 */
  actors: string[];
  /** 挡路的目标（威胁） */
  threats: Array<{ goalId: string; reason: string; weight: number }>;
  /** 可以借力的目标（机会） */
  openings: Array<{ goalId: string; reason: string; weight: number }>;
}

export interface InsightInput {
  throne: DivineThrone;
  /** 世界局势关键词 */
  keys: readonly string[];
  /** 祂记得这个玩家的好事与坏事（见 `DivineMemory`） */
  affection: number;
}

export function divineInsight(input: InsightInput): DivineInsight {
  const actors = new Set<string>();
  const threats: DivineInsight['threats'] = [];
  const openings: DivineInsight['openings'] = [];
  const goals = new Map(input.throne.goals.map((g) => [g.id, g]));
  for (const key of input.keys) {
    const actor = ACTOR_OF[key];
    if (actor !== undefined) actors.add(actor);
    const threatGoal = THREAT_OF[key];
    const goal = threatGoal === undefined ? undefined : goals.get(threatGoal);
    if (goal !== undefined) {
      threats.push({ goalId: goal.id, reason: actor ?? key, weight: goal.weight * 2 });
    }
    const openingGoal = OPENING_OF[key];
    const open = openingGoal === undefined ? undefined : goals.get(openingGoal);
    if (open !== undefined) openings.push({ goalId: open.id, reason: actor ?? key, weight: open.weight });
  }
  /*
   * 好恶会改变「威胁」的分量：一个祂**已经不喜欢**的人做的同一件事，
   * 在祂眼里更严重（这是「记得」的直接后果，不是另一套规则）。
   */
  if (input.affection < 0) {
    for (const t of threats) t.weight += Math.min(4, -input.affection);
  }
  return { actors: [...actors], threats, openings };
}

/** **祂记得的事**：每条神一份，按玩家 id 存最近几件事（带好恶） */
export interface MemoryEntry {
  key: string;
  /** 正数是好感，负数是恶感 */
  weight: number;
  at: number;
}

export class DivineMemory {
  readonly #bySeat = new Map<string, MemoryEntry[]>();
  readonly #keep: number;

  constructor(keep = 8) {
    this.#keep = keep;
  }

  /** 记下一件事（超出上限就丢最旧的） */
  remember(seat: string, key: string, weight: number, at: number): void {
    const list = this.#bySeat.get(seat) ?? [];
    list.push({ key, weight, at });
    while (list.length > this.#keep) list.shift();
    this.#bySeat.set(seat, list);
  }

  /** 祂对某个人的好恶（累加，衰减由调用方决定） */
  affectionOf(seat: string, key: string): number {
    const list = this.#bySeat.get(seat) ?? [];
    return list.filter((e) => e.key === key).reduce((sum, e) => sum + e.weight, 0);
  }

  /** 这位神记得的全部事迹（调试与日志用） */
  deedsOf(seat: string): readonly MemoryEntry[] {
    return this.#bySeat.get(seat) ?? [];
  }
}

/** **跨 tick 的计划**：这个目标已经走到第几步 */
export interface GoalPlan {
  goalId: string;
  steps: string[];
  step: number;
  startedAt: number;
}

/**
 * **计划的存放处**（M2.168 抽出来的接口）。
 *
 * 在这之前只有一个进程内的 `DivinePlans`（Map），重启就丢 —— 丢的代价是
 * 「祂正要走完的那条链从第三步回到第一步」，看起来像神在反复做同一件事。
 *
 * 抽成接口之后有两种实现，调用方只认这三个方法：
 *   · `DivinePlans`    进程内（测试与跑批用；不落库，快）
 *   · `DivinePlansRepo` 落库（`infra/db/divine.ts`；线上用它）
 *
 * ⚠️ `advance` 的语义要与内存实现**逐字一致**：走完最后一步就清掉，
 * 而不是留在那儿等下一次 `get` —— 两处实现的分叉会让「神的计划」在重启前后行为不同。
 */
export interface DivinePlanStore {
  get(seat: string): GoalPlan | null;
  begin(seat: string, goalId: string, steps: string[], at: number): GoalPlan;
  advance(seat: string): GoalPlan | null;
}

export class DivinePlans implements DivinePlanStore {
  readonly #bySeat = new Map<string, GoalPlan>();

  /*
   * ⚠️ 三个方法都返回**快照**（拷一份），不是内部那个对象。
   *
   * 第一版直接返回了 `#bySeat` 里那个对象，于是调用方拿到的是**活引用**：
   * 「先 get 一次、再 advance 两次、回头看第一次那份」会看到 step 已经变成 2。
   * 而落库版每次都从库里读、天然返回快照 —— **两处实现的行为不一致**，
   * 且只在「持有返回值」的调用方那里暴露（m2-168 的判据当场抓到）。
   *
   * 修的是内存版：接口的语义是「这是那一刻的计划」，不是「这是计划本身」。
   */
  get(seat: string): GoalPlan | null {
    const plan = this.#bySeat.get(seat);
    return plan === undefined ? null : { ...plan, steps: [...plan.steps] };
  }

  /** 起一个新计划（换目标时会覆盖旧计划 —— 神不会同时追两个目标） */
  begin(seat: string, goalId: string, steps: string[], at: number): GoalPlan {
    const plan: GoalPlan = { goalId, steps: [...steps], step: 0, startedAt: at };
    this.#bySeat.set(seat, plan);
    return { ...plan, steps: [...plan.steps] };
  }

  /** 推进一步；走完就清掉（那位神会重新挑目标） */
  advance(seat: string): GoalPlan | null {
    const plan = this.#bySeat.get(seat);
    // ⚠️ `Map.get` 返回的是 `T | undefined`（不是 null）—— 判 null 排除不掉它
    if (plan === undefined) return null;
    plan.step += 1;
    if (plan.step >= plan.steps.length) this.#bySeat.delete(seat);
    return { ...plan, steps: [...plan.steps] };
  }
}

/**
 * **神的出手状态**（上次出手时刻 + 各手段冷却）—— 同样从「进程内 Map」抽成接口。
 *
 * 与计划是一个理由：丢了之后沉寂期与冷却一起清空，**重启那一刻众神可能连着出手**，
 * 而稀有性正是靠这两个数值守着的。
 */
export interface DivineActState {
  lastActAt: number;
  methodUsedAt: Record<string, number>;
}

export interface DivineStateStore {
  get(pathway: string): DivineActState | undefined;
  set(pathway: string, state: DivineActState): void;
}

/** 进程内版（测试与跑批用；`deps.divineState` 不传时世界 tick 自己建一个） */
export class InMemoryDivineState implements DivineStateStore {
  readonly #byPathway = new Map<string, DivineActState>();

  get(pathway: string): DivineActState | undefined {
    return this.#byPathway.get(pathway);
  }

  set(pathway: string, state: DivineActState): void {
    this.#byPathway.set(pathway, state);
  }
}

/** 一条候选行动的评估结果（`why` 是给日志与测试看的 —— 思考必须能解释自己） */
export interface DivineOption {
  method: DivineMethod;
  goalId: string;
  /** 收益：目标权重 + 局势加成 + 记忆加成 */
  gain: number;
  /** 成本：资源代价 + 暴露风险 */
  cost: number;
  score: number;
  why: string[];
}

/** 排出一条目标的步骤顺序：前提少的在前（派得动人，才谈得上让他做事） */
const NEED_ORDER = ['', 'church', 'intel', 'wealth', 'angel', 'artifact'];
function stepRank(method: DivineMethod): number {
  const need = method.needs[0] ?? '';
  const idx = NEED_ORDER.indexOf(need);
  return idx < 0 ? NEED_ORDER.length : idx;
}

/**
 * **思考**：看世界 → 挑目标 → 排步骤 → 评估每条手段的性价比。
 *
 * 它**不掷骰子**（那是 `divine-decide` 的活）—— 给定同样的输入，它给出同样的排序。
 * 这样「祂为什么这么做」是**可复现、可解释**的。
 */
export interface ThinkInput {
  throne: DivineThrone;
  insight: DivineInsight;
  /** 各目标已经走到第几步（来自 `DivinePlans`） */
  plan: GoalPlan | null;
  /** 冷却中的手段 id */
  cooling: ReadonlySet<string>;
  now: number;
}

export interface ThinkResult {
  /** 这一轮祂决定推进的目标（没有可推进的就是 null） */
  goalId: string | null;
  /** 排好序的候选（第一个就是祂会做的） */
  options: DivineOption[];
  /** 为什么挑这个目标（**思考必须能解释自己** —— 它进日志，也是测试的判据） */
  reason: string;
  /**
   * 如果这一轮是**新目标的开始**，这里是它的步骤链（按前提排好序）。
   * 调用方把它记进 `DivinePlans` —— 于是下一次祂接着往下走，而不是重新挑。
   */
  newPlanSteps: string[];
}

export function divineThink(input: ThinkInput): ThinkResult {
  const { throne, insight, plan, cooling, now } = input;
  /* ⚠️ 收窄一次并用到底：`plan` 在闭包与分支里会被 TS 重新放开成 undefined */
  const p = plan ?? null;
  const goalWeight = new Map(throne.goals.map((g) => [g.id, g.weight]));

  // ① 如果手上有一个没走完的计划，**接着走**（这就是「计划的连续性」）
  if (p !== null && p.step < p.steps.length) {
    const nextId = p.steps[p.step]!;
    const method = throne.methods.find((m) => m.id === nextId);
    if (method !== undefined && !cooling.has(method.id)) {
      const options = evaluate(throne, [method], insight, goalWeight, cooling, now);
      return {
        goalId: p.goalId,
        options,
        reason: '接着走计划：' + p.goalId + ' 第 ' + (p.step + 1) + '/' + p.steps.length + ' 步（' + method.id + '）',
        newPlanSteps: [],
      };
    }
    // 下一步的手段在冷却里 ⇒ 这一轮跳过，等它凉（不是换目标）
    if (method !== undefined) return { goalId: p.goalId, options: [], reason: '计划中的 ' + method.id + ' 还在冷却，等', newPlanSteps: [] };
  }

  // ② 没有计划 ⇒ 挑**威胁最大的目标**（威胁优先于机会：先止损，再图利）
  const threatScore = new Map<string, number>();
  for (const t of insight.threats) threatScore.set(t.goalId, (threatScore.get(t.goalId) ?? 0) + t.weight);
  for (const o of insight.openings) {
    const current = threatScore.get(o.goalId);
    // 机会只在「没有威胁」时才压过威胁
    if (current === undefined) threatScore.set(o.goalId, o.weight * (threatScore.size === 0 ? 1 : 0.5));
  }

  if (threatScore.size === 0) {
    // ③ 什么局势都没有 ⇒ 按目标权重挑一个「长期该做的事」
    const top = [...throne.goals].sort((a, b) => b.weight - a.weight)[0];
    if (top === undefined) return { goalId: null, options: [], reason: '祂没有目标', newPlanSteps: [] };
    const methods = throne.methods.filter((m) => m.goal === top.id);
    const options = evaluate(throne, methods, insight, goalWeight, cooling, now);
    const steps0 = [...methods].sort((a, b) => stepRank(a) - stepRank(b)).map((m) => m.id);
    return { goalId: top.id, options, reason: '没有局势，按长期目标推进：' + top.id, newPlanSteps: steps0 };
  }

  const [goalId, score] = [...threatScore.entries()].sort((a, b) => b[1] - a[1])[0]!;
  const methods = throne.methods.filter((m) => m.goal === goalId);
  /*
   * ④ 排步骤：同一个目标的多个手段**按前提排序**，并把顺序记进计划 ——
   *    下一次祂会接着往下走。
   */
  const steps = [...methods].sort((a, b) => stepRank(a) - stepRank(b)).map((m) => m.id);
  const options = evaluate(throne, methods, insight, goalWeight, cooling, now);
  const why = insight.threats.filter((t) => t.goalId === goalId).map((t) => t.reason);
  const reason = why.length > 0
    ? '有人挡了 ' + goalId + '：' + why.join('、') + '（威胁分 ' + score.toFixed(1) + '）'
    : '有一扇门开着：' + goalId + '（机会分 ' + score.toFixed(1) + '）';
  return { goalId, options, reason, newPlanSteps: steps };
}

/** 逐条评估：收益（目标权重 + 局势命中 + 记忆）× 成本（资源 + 暴露） */
function evaluate(
  throne: DivineThrone,
  methods: readonly DivineMethod[],
  insight: DivineInsight,
  goalWeight: ReadonlyMap<string, number>,
  cooling: ReadonlySet<string>,
  now: number,
): DivineOption[] {
  const threatGoals = new Set(insight.threats.map((t) => t.goalId));
  const options: DivineOption[] = [];
  for (const method of methods) {
    if (cooling.has(method.id)) continue;
    const why: string[] = [];
    let gain = goalWeight.get(method.goal) ?? 1;
    why.push('目标权重 ' + gain.toFixed(1));
    if (threatGoals.has(method.goal)) {
      gain *= 2;
      why.push('局势在威胁这个目标（×2）');
    }
    // 资源越足，同一件事做得越漂亮（不是门槛，是加成）
    const power = 1 + throne.resources.angels * 0.1 + throne.resources.wealth * 0.05;
    gain *= power;
    why.push('资源加成 ×' + power.toFixed(2));
    let cost = 0;
    for (const value of Object.values(method.cost)) cost += value;
    cost += method.cooldown_hours / 24;
    why.push('代价 ' + cost.toFixed(1));
    options.push({ method, goalId: method.goal, gain, cost, score: gain - cost, why });
  }
  return options.sort((a, b) => b.score - a.score);
}

/** 冷却判定（与 `divine-decide` 同一口径，集中在这里免得两处漂移） */
export function coolingMethods(
  throne: DivineThrone,
  usedAt: Readonly<Record<string, number>> | undefined,
  now: number,
): Set<string> {
  const cooling = new Set<string>();
  if (usedAt === undefined) return cooling;
  for (const method of throne.methods) {
    const used = usedAt[method.id];
    if (used !== undefined && now - used < method.cooldown_hours * 3_600_000) cooling.add(method.id);
  }
  return cooling;
}
