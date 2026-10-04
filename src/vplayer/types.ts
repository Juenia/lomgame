/**
 * 虚拟玩家实例测试的类型（W7）
 *
 * 定位：**长链路实例测试**，不是封测替代。
 * 能证明：长链路跑通、数值分布、覆盖率、死循环、并发边界。
 * 不能证明：留存、手感、付费意愿。
 */
import type { Gender, PathwayId } from '../domain/character/types.ts';

/**
 * 玩家画像。
 *
 * M2.17 起了第六条 **secular（世俗者）**：与 steady **逐项相同**，只差一条 ——
 * 它整段跳过教会分支（不入教、不捐献）。它的用途是「不信教的那一类人」，
 * 而不是一个可以随手改参数的画像（改它就破坏了对照组的意义）。
 * 见 docs/M2.17-教义flag.md §五。
 */
export type Persona = 'steady' | 'aggressive' | 'chaotic' | 'light' | 'perfectionist' | 'secular';
export type Goal = 'promote' | 'explore' | 'social' | 'casual';

export interface PlayerProfile {
  id: number;
  /** 稳定标识：QQ 号由它派生，便于复现 */
  userId: string;
  name: string;
  persona: Persona;
  goal: Goal;
  /**
   * profile 里偏好的途径。
   *
   * M2.7.6 起它**不再是建号参数** —— 玩家在创建时根本不给途径。
   * 它现在的用途是「这个人以后想走哪条路」：在翻到线索时，
   * 虚拟玩家会优先沿着它走（等价于真人「我心里想当愚者」）。
   */
  pathway: PathwayId;
  /**
   * M2.7.6：初始性别，50/50 由 seed 派生（同一 profile 永远同一个性别，跑两遍可复现）。
   * 本版没有任何机制读它 —— 存在这里只是为了让「随机分配性别」这条验收可核。
   */
  gender: Gender;
  /** 每天登录次数（含首次） */
  loginTimesPerDay: number;
  /** 每次登录的指令条数 */
  actionsPerLogin: number;
  /** 风险偏好 0—1：越高越愿意在 MAD/COR 高时继续冒进 */
  riskAppetite: number;
  /** 耐心 0—1：越低越容易在长链路中途放弃/换目标 */
  patience: number;
  /** 画像级随机源种子（由全局 seed + id 派生） */
  seed: string;
  /** 本批虚拟玩家总数：交易对象从这里挑，保证对手真的存在 */
  fleetSize: number;
}

/** 玩家视角的角色快照（等价于他发 .状态 / .背包 能看到的自己） */
export interface PlayerSnapshot {
  exists: boolean;
  characterId: string;
  name: string;
  sequence: number;
  hp: number;
  mp: number;
  mad: number;
  cor: number;
  dig: number;
  dp: number;
  status: string;
  promotionFails: number;
  inventory: Array<{ itemId: string; quantity: number; bindType: string }>;
  flags: Set<string>;
  /** M2.16：所属教会（null = 未入教）；虚拟玩家靠它决定「该入教还是该捐献」 */
  churchId?: string | null;
  /** M2.16：教内累计贡献点（判断离下一档还差多少） */
  churchContribution?: number;
  /** 当日已用次数（rest/purify/divination 等） */
  dailyCounters: Record<string, number>;
  /** 当日各地探索次数 */
  exploreCounts: Record<string, number>;
  /** 今日已触发过的事件卡 */
  /** M2.69：今天每张卡出过几次（卡片的 daily_limit 读它，不是「出过没有」） */
  triggeredToday: Map<string, number>;
  /** 自己名下待确认的交易单数量（交易冻结会改数量，不会改栏位数） */
  pendingTradeCount: number;
  /** M2.5：手上有没有一份攒着但还没开始的仪式配置 */
  ritualPreparing: boolean;
  /** M2.5：有没有一场已经 .仪式 开始、等着 .仪式 融合 的仪式 */
  ritualRunning: boolean;
  /** M2.5：准备态里锁定的地点（null = 还没挑）。判断「下一步该挑地点还是该开始」要用它 */
  ritualLocationId: string | null;
  /** 所在队伍（没有则为 null） */
  partyId: string | null;
  partySize: number;
  /** 是否队伍队长 */
  isPartyLeader: boolean;
  /**
   * M2.6：自己此刻的通缉等级（0 = 没被通缉）。
   * 真人从 .状态 的那一行"通缉：1 级（警察厅，剩 3 天）"读得出来，虚拟玩家读同一个库。
   */
  wantedLevel: number;
  /** M2.6：正在通缉自己的势力（没有则为 null） */
  wantedFactionId: string | null;
  /** M2.6：自己此刻所在的地点 id（真实玩家靠"上次探索去了哪"自己记得） */
  currentLocationId: string | null;
  /**
   * M2.8：脚下这个地点**此刻有哪几只生物**（只给判定层认得的那几个字段）。
   *
   * 真人看不见这份清单 —— 他要走进去才知道。虚拟玩家读它，是为了让「要不要去那个地方」
   * 这个决定**不是瞎掷**：雾里有一只序列 5 的东西时，稳健型的人会换条路。
   * 与其它 snapshot 字段同一个口径：读的是同一个库，只是比真人多看一眼。
   */
  nearbyCreatures?: Array<{ speciesId: string; sequence: number; hp: number; status: string }>;
  /**
   * M2.9：此刻**有没有一场没打完的战斗**（以及打到哪了）。
   *
   * 真人从 .战斗 的那一屏读得到（「【战斗 · 第 3 回合】低语者 · HP 12/40」）；
   * 虚拟玩家读同一个库（battles 表里 status='active' 的那一行）。
   *
   * 为什么要这么多位：战斗决策是**按双方血量做的**（任务书 §4.7）——
   * 「自己 HP < 30% 就撤」「它 HP < 30% 就往死里打」这两条都读不出血就打不出来，
   * 而打不出来的后果是虚拟玩家在战斗里只会重复同一个动作，
   * 报告里「玩家动作分布」会退化成一根柱子（那正是「伪随机」的样子）。
   */
  activeBattle?: {
    battleId: string;
    round: number;
    speciesId: string;
    speciesName: string;
    creatureHp: number;
    creatureMaxHp: number;
    creatureSequence: number;
    /** 它是不是已经暴走了 —— 暴走之后打它更疼，也更该趁现在打 */
    creatureBerserk: boolean;
    /** 自己这一侧的血与灵力（战斗状态里的那一份，与角色卡同源） */
    playerHp: number;
    playerMp: number;
    /** 自己身上挂着几个负面状态（被放逐 / 失控时该知道） */
    playerStatuses: string[];
    /** 它是不是正躺在地上装死 */
    creaturePlayingDead: boolean;
    /** M2.10：这一场是不是 PVP（决定要不要考虑认输） */
    isPvp: boolean;
    /** M2.10：对手的显示名（PVP 才有） */
    opponentName: string | null;
    /** M2.10：**现在是不是轮到我出招**（异步 PVP 里弄错这个会一路撞墙） */
    yourTurn: boolean;
    /** M2.10：我是不是发起者（发起者先手） */
    isChallenger: boolean;
  };
  /**
   * M2.13 前置 4：**有没有一只「还没处置」的生物站在那里**。
   *
   * 遭遇是一个**未决状态**（M2.8：`sightings` 里 `action` 为 NULL 的那一行）——
   * 它不会自己消失。真人在私聊里看着那张遭遇菜单；
   * 虚拟玩家读同一个库（`sightings` 表里 action IS NULL 的那一行）。
   *
   * 为什么要它：M2.13 前置 4 要求「虚拟玩家在等待期做有意义的事」，
   * 而「处置未决遭遇」是那四档里的第一档 —— 没有这一位就只能靠菜单路径认，
   * 而完整指令路径的玩家根本没有菜单。
   */
  pendingSighting?: boolean;
  /**
   * M2.7：自己此刻在哪座城市。
   * 真人从 .创建 回执的「出生地」那一行、以及 .移动 的到达回执里读得到；
   * 虚拟玩家读同一个库（characters.current_city_id）。
   */
  currentCityId?: string | null;
  /**
   * M2.7：此刻是不是在路上。
   * 真人从 .移动 的回执知道（「你正在去 X 的路上，还剩 N 小时」）；
   * 虚拟玩家读同一个库（travels 表里 status='traveling' 的那一行）。
   * 这一位很关键：在路上时服务端只放行查看类指令，
   * 不知道自己在路上的虚拟玩家会把当天的动作全部撞在墙上。
   */
  traveling?: boolean;
  /** M2.7：还有几小时到（不在路上时是 0） */
  travelRemainingHours?: number;
  /** M2.6：信誉（举报失败 -5）。真人从 .举报 的回执里读得到 */
  reputation: number;
  /**
   * M2.7.6：他**实际**入的是哪条途径（null = 还没入）。
   *
   * 与 PlayerProfile.pathway 是两件事：那一个是「他想走哪条路」，
   * 这一个才是「他走到了哪条路上」。M2.85 起途径由翻到的配方线索决定，
   * 两者**可以不一致** —— 而不一致的时候，按 profile 去查能力上限会算错
   * （战士序列 8 的 HP 上限是 110，用愚者去查只有 100，于是合法的 110 被误报成 P0）。
   */
  pathwayId?: PathwayId | null;
  /**
   * M2.7.6：**还没有途径**（普通人）。
   * 真人从 .状态 的第一行（「XXX · 还没有途径」）读得到，虚拟玩家读同一个库。
   * 这一位决定了今天能做哪些事：扮演 / 晋升 / 占卜 / 仪式 对他都是关闭的。
   */
  mortal?: boolean;
  /**
   * M2.7.6：已经发过 .创建 姓名、正等着回一个 1 或 2。
   * 服务端把那张菜单挂在 'create:<userId>' 上（他此刻还没有 characterId）。
   */
  genderPending?: boolean;
  /** M2.7.6：手上还没用掉的配方线索条数（决定要不要去凑材料） */
  clueCount?: number;
  /**
   * M2.7.7：他手上**有没有配方**（M2.85 起来源只有线索）。
   *
   * 这一位是给普通人阶段的决策用的：M2.7.6 起「.魔药」只在有配方时才有意义，
   * 而虚拟玩家原来只能看 clueCount —— 「材料齐了但根本没配方」时它又会去试
   * （被命令层拒，然后卡住空转）。
   */
  hasRecipe?: boolean;
  /**
   * M2.7.7：那张配方**指向哪条途径**（null = 手上没有配方）。
   *
   * 为什么光有 hasRecipe 不够：虚拟玩家拿到线索之后，要挑一份配方去调。
   * 它原来挑的是「材料齐了的那条途径」—— 而线索可能指向**另一条**，
   * 于是打出一条必然被拒的「.魔药 warrior_9」（回执「没有这份配方」）。
   * 实测这一处浪费了 5188 次动作（占全部动作的 13%）。
   */
  recipePathway?: PathwayId | null;
}

/** 世界知识：配方 / 地点掉落 / 物品类型。属于内容，不是判定逻辑 */
export interface WorldKnowledge {
  recipes: Array<{
    id: string;
    pathway: PathwayId;
    seq: number;
    main: Array<{ itemId: string; qty: number }>;
    aux: Array<{ itemId: string; qty: number }>;
    productItemId: string;
  }>;
  locations: Array<{
    id: string;
    name: string;
    /** M2.7：属于哪座城市（.探索 只能去自己脚下的城市，虚拟玩家必须知道这一点） */
    city: string;
    minSeq: number;
    maxSeq: number;
    loot: string[];
    /** 这个地点能抽到的事件卡（探索只从这份名单里抽） */
    events: string[];
  }>;
  /**
   * M2.7：可作为出生城市的那些。
   * 虚拟玩家要**预判**自己落在哪座城市 —— 否则它会拿 profile.pathway 去建号，
   * 而那座城市未必传承这条途径，于是把动作烧在「创建失败 → 换途径重试」上，
   * 连地点覆盖率一起打穿。服务端与测试侧用的是同一个 birthCityOf（纯函数）。
   */
  birthCities: Array<{
    id: string;
    name: string;
    pathways: PathwayId[];
    birthWeight: number;
  }>;
  /** M2.7：全部航线（移动决策按「从我在的城市出发」筛） */
  routes: Array<{
    id: string;
    from: string;
    to: string;
    type: 'land' | 'sea';
    durationHours: number;
    costPenny: number;
    danger: number;
  }>;
  /** M2.7：城市 id → 中文名（.移动 后面要跟中文名） */
  cityNames: Record<string, string>;
  /**
   * M2.16：正神教会（id / 途径 / 据点在哪些城市）。
   *
   * 虚拟玩家用它自己算「这座城市有没有与我途径对应的教会」——
   * 与服务端 `canJoin` 同一份判据。算错了会被拒（不会静默走偏），
   * 但**算对了才不会把动作烧在必然被拒的 .加入教会 上**。
   */
  churches: Array<{
    id: string;
    name: string;
    /** 强绑的途径；null = 这条途径还没实现（七家里五家如此），入不了 */
    pathway: PathwayId | null;
    /** 有堂口的城市 id */
    seats: string[];
  }>;
  /** itemId → kind（用于判断能不能 .使用） */
  itemKinds: Record<string, string>;
  /**
   * M2.13：物品 id → **非凡物类型**（material / wonder / sealed / charm）。
   *
   * 与 itemKinds 分开而不是合并：两者回答的是两个问题 ——
   *   itemKinds         —— 「它怎么用」（材料 / 消耗品 / 货币 / 魔药 / 杂物）
   *   extraordinaryKinds —— 「它是不是封印物 / 神奇物品 / 符咒」（M2.13 的第二个维度）
   * 虚拟玩家要认的是后者（「我包里有封印之刃吗」），而前者已经够它判断「这件能不能吃」。
   */
  extraordinaryKinds: Record<string, string>;
  /**
   * M2.13：地点 id → **那里可能出现的最强生物序列**（栖息地物种的基线序列取**最小** ——
   * 序列号越小越强）。
   *
   * 为什么要它：封印物的定位是「让序列 9 的玩家有可能打赢序列 8 的生物」，
   * 而这句话的第一步是「**去有那种东西的地方**」——
   * 手里握着封印之刃却继续在安全的地方转悠，等于把它白放着。
   * 真人玩家手里的情报来自「听说老码头有低语者」，虚拟玩家读的是内容表
   * （与 nearbyCreatures 同一个口径：读同一个世界，只是比真人多看一眼）。
   */
  locationCreatureSequences: Record<string, number>;
  /** 地点 id → 名称 */
  locationNames: string[];
  /** 地点名称 → id（用于查当天的探索次数上限） */
  locationIdByName: Record<string, string>;
  /**
   * M2.6：无主地点（安全区）的名字。
   * 被通缉的玩家要往这里躲 —— 这是"逃到势力范围外"那条设计在虚拟玩家侧的唯一落点，
   * 所以它属于世界知识（内容），由 cli.ts 从 numeric.factionTerritory 派生。
   */
  safeLocationNames: string[];
}

/** M2.3：服务端菜单里的一项（/admin/menu 返回的结构化选项） */
export interface MenuChoice {
  key: string;
  label: string;
  command: string;
  preview?: string;
  disabled?: string;
}

export interface DecisionContext {
  profile: PlayerProfile;
  snapshot: PlayerSnapshot;
  /** 今天已经成功打出去的 .扮演 次数（标签每日上限按这个数轮换） */
  playsToday: number;
  /** 当天序号（0 = 建号日） */
  day: number;
  /** 当天的第几次登录（0 起）：目标在一场会话内稳定，跨会话才可能漂移 */
  login: number;
  /** 本次登录内的第几条指令（从 0 开始） */
  step: number;
  /** 已经去过的地点 */
  visitedLocations: Set<string>;
  /** 收件箱里等待处理的交易单号 */
  pendingTrades: Array<{ id: string; fromUserId: string; price: number }>;
  /** 上一条被系统拒绝的指令名（冷却/资源不足…），用于换招；没有则为 null */
  lastRejected: string | null;
  /**
   * 群里公告过、且还没过期的队伍 id（方案 C）。
   *
   * 原来虚拟玩家只 drain 私聊、读不到群里的组队公告，于是只能靠 otherUserId()
   * 瞎猜 QQ 去打 .队伍 加入 —— 240 个角色里只有 14 个进过 2 人以上队伍，
   * 依赖 party:size>=2 的卡片（lost_006/007、random_007/008）触发率被压到接近 0。
   */
  knownParties: readonly string[];

  /**
   * M2.3（任务书 §7.3 的对照实验）：
   * 一半虚拟玩家走**菜单路径**（收到菜单 → 回数字），一半走**完整指令路径**（直接发指令）。
   * 两条路必须得到一致的判定结果 —— 不一致就说明菜单映射有 bug。
   */
  menuPath?: boolean;
  /** M2.3：服务端此刻挂着的菜单（没有则为 null） */
  pendingMenu?: { menuType: string; options: MenuChoice[] } | null;
  /**
   * M2.5：此刻谁在举行仪式（角色名）。
   *
   * 这是**测试工具的特权**：真实玩家只能从群里那条匿名播报知道「有人在做仪式」，
   * 不知道是谁（那正是匿名的意义）。虚拟玩家不知道是谁就永远打不中干扰，
   * 干扰这条链路也就永远走不到 —— 所以这里让测试侧直接看库拿名字。
   */
  runningRituals?: readonly string[];

  /**
   * M2.6：此刻全服被通缉的人（角色名，不含自己）。
   *
   * 和 runningRituals 同一类东西 —— **测试工具特权**，不是游戏机制：
   * 真人只能从群播报知道"某处有人被通缉"，不知道是谁（那正是匿名播报的意义）。
   * 不给这个视角，.举报 这条链路在实例测试里永远打不到人，覆盖率会永远缺一项。
   */
  wantedNames?: readonly string[];

  /**
   * M2.6.1：同批玩家的序列（不含自己）。
   *
   * 同样是**测试工具特权**：真人只能从群里的只言片语推测别人到什么序列了。
   * 但袭击的成败完全由序列差决定（弱 3 级根本打不动），
   * 虚拟玩家不知道对手序列的话，袭击就会变成"随机撞墙"，
   * 「被拦 / 抗性 / 命中」三类统计也会全部失真。
   */
  peers?: ReadonlyArray<{
    userId: string;
    name: string;
    sequence: number;
    /** M2.10：他在哪个地点（挑战要求同地点 —— 这是「不跨地点挑战」的实现方式） */
    locationId?: string | null;
    /** M2.10：他的状态（重伤的人不能打） */
    status?: string;
    /** M2.10：他是不是正在打（正在打的人不能挑战 —— 服务端会拒） */
    inBattle?: boolean;
  }>;
}

export interface Decision {
  /** 发送的指令原文（不含前缀点号，内部统一加）；skip 时是空串 */
  command: string;
  /** 决策理由，写进行为日志，便于人工复核 */
  reason: string;
  /** M2.3：这条决策是「回数字选菜单」（command 就是那个数字） */
  menuPath?: boolean;
  /**
   * M2.7.6：**这次登录到此为止**（不发任何指令，直接下线）。
   *
   * 为什么需要它：普通人阶段是会有「今天真的没事可做」的时刻 ——
   * 线索还没有、休息也用完、还没人来找你。真人这时候会关掉聊天窗口；
   * 而一个不停发纯只读指令的机器人只会制造一堆「连续 10 次指令后状态没有变化」
   * 的假异常（实测 50 人 × 14 天能刷出两千多条，把真正的异常淹掉）。
   */
  skip?: true;
}

export interface ActionRecord {
  playerId: number;
  persona: Persona;
  goal: Goal;
  day: number;
  login: number;
  step: number;
  /** 虚拟时间（毫秒）：由测试驱动，便于复现 */
  virtualNow: number;
  /** 与上一条指令的虚拟间隔（秒） */
  intervalSec: number;
  /**
   * 真实执行的完整指令。
   * 菜单路径下决策发出去的是一个数字，但日志里记的必须是它**实际执行的那条指令** ——
   * 否则覆盖率、拒绝率、卡死检测会全部按「1」统计，报告就废了。
   */
  command: string;
  /** M2.3：这条动作是走菜单路径发出数字触发的 */
  menuPath?: boolean;
  /** M2.3：玩家实际发出的文本（菜单路径下就是数字） */
  rawSent?: string;
  /** M2.4：这条数字回复来自**世界播报**（而不是玩家自己的个人菜单）—— 世界参与度的实测证据 */
  worldEvent?: true;
  reason: string;
  status: number;
  costMs: number;
  replies: number;
  /** 出站消息文本（便于断言与人工复核） */
  replyTexts: string[];
}

export interface AnomalyRecord {
  level: 'P0' | 'P1';
  code:
    | 'HTTP_STATUS'
    | 'STAT_OUT_OF_RANGE'
    | 'RESOURCE_INCONSISTENT'
    | 'SLOW_RESPONSE'
    | 'NO_STATE_CHANGE'
    | 'DEADLOCK';
  playerId: number;
  day: number;
  virtualNow: number;
  command: string;
  detail: string;
}
