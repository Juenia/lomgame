/**
 * PVE 回合制战斗（M2.9）—— 领域类型。
 *
 * 这一层全是**纯数据 + 纯函数**：没有 IO、没有数据库、没有时钟。
 * 落库由 infra/db/battles.ts，装配由 router/commands/battle.ts 负责。
 *
 * ⚠️ 战斗**不是一次判定**。M2.6.1 的 `.袭击` 是一次判定（打一下、结算、结束），
 * 那是它该有的样子；战斗是**状态机**：遭遇 → 多回合博弈 → 结算 → 落库。
 * 「玩家可以关掉 QQ，5 分钟后回来接着打」这条异步性质，就是状态机存在的原因 ——
 * 一次判定没有「回来接着打」这回事。
 *
 * ⚠️ M2.9 **不做 PVP**（那是 M2.10）。但结构已经为它留好：
 *   BattleSide 描述「一边」的全部状态，玩家与生物各是一边；
 *   M2.10 只需要把 opponent 从「生物实例」换成「另一个玩家的角色卡」，
 *   状态机的其余部分（回合制、超时、状态、技能）一个字都不用改。
 */
import type { PathwayId, Rng } from '../character/types.ts';

/* ---------------- 状态（任务书 §4.3.4） ---------------- */

/**
 * 五种状态。**每一种都有真实的来源**（不是「配置里有、跑批里 0 次」）：
 *   bleed       攻击暴击 / 铁血猎犬的撕咬
 *   fear        高序列生物的气场 / 低语者的低语 / 梦魇
 *   poison      骨语者的骨尘
 *   lostControl 玩家 MAD ≥ 80
 *   banish      时序蠕虫的时间凝滞
 */
export type BattleStatusId = 'bleed' | 'fear' | 'poison' | 'lostControl' | 'banish';

/** 挂在一边身上的一个状态。rounds 归零即脱落。 */
export interface BattleStatusEffect {
  id: BattleStatusId;
  /** 还剩几回合（每回合结算时 -1，归零脱落） */
  rounds: number;
  /** 谁给的（审计与文案：「低语者的低语」） */
  source: string;
}

/* ---------------- 玩家的动作（任务书 §4.3.2） ---------------- */

/** 每回合选**一个**。QQ 异步场景里「每回合点一下」最自然，同时选多个不成立。 */
export type PlayerActionKind =
  | 'attack'
  | 'defend'
  | 'skill'
  | 'item'
  | 'retreat'
  /**
   * M2.10：**认输**（PVP 特有）。
   *
   * 它在命令层就被处理掉（直接结束战斗，不进判定层的回合结算）——
   * 因为「认输」不是一个回合：双方各出一个动作再一起结算那条路上，
   * 认输没有对手可言（对方做什么都改变不了结果）。
   */
  | 'surrender'
  /**
   * M2.13：**用一件封印物**（封印之刃 / 血月之刃 / 命运骰子）。
   *
   * 它与 `item` 分开而不是合并，因为两者是**两种东西**（M2.9 的注释里写过同一件事）：
   *   `item`          —— 消耗品与符咒：用了之后**对面**怎么样（灼烧 / 定身 / 净除）
   *   `extraordinary` —— 封印物：用了之后**你这一下**怎么样（无视序列差 / 伤害翻倍 / 重抽）
   *
   * 合并的表现会是「封印之刃和符咒·灼烧在代码里长得一样，但一个是借序列差、一个是直接掉血」——
   * 等下一轮要调「封印之刃到底值多少代价」时，没人能一眼看出该动哪一支。
   */
  | 'extraordinary';

export interface PlayerAction {
  kind: PlayerActionKind;
  /** kind = 'skill' 时的技能 id（见 numeric.battle.skills） */
  skillId?: string;
  /** kind = 'item' 时的物品 id */
  itemId?: string;
  /** kind = 'extraordinary' 时的封印物 id（命令层查内容表后把效果喂进 options.extraordinary） */
  extraordinaryId?: string;
  /** 玩家没在 5 分钟内回话 → 系统代打「防御」。**不惩罚，但也不利** */
  auto?: boolean;
}

/* ---------------- 生物的动作（任务书 §4.3.3） ---------------- */

/**
 * 六种行为 + 默认的攻击。
 *
 * 判定顺序（在 ai.ts 里）：evolve → berserk → play_dead → call_ally → flee → special → attack。
 * 顺序本身是设计：被逼到墙角先蜕壳（变强），再暴走，再装死，再求援，最后才逃。
 */
export type CreatureActionKind =
  /** 攻击（默认） */
  | 'attack'
  /** 暴走：伤害 ×2、防御 ×0.5，**且不再逃跑** */
  | 'berserk'
  /** 逃跑：HP < 30% */
  | 'flee'
  /** 求援：群居 + HP < 50%，2—3 回合后增援到达 */
  | 'call_ally'
  /** 装死：部分生物（镜中客 / 命运幻影）。玩家若在装死时停手，它偷袭 */
  | 'play_dead'
  /** 进化：濒死存活 → 序列 -1（永久变强） */
  | 'evolve'
  /** 物种专属（低语者的低语 / 深海凝视者的注视 / 时序蠕虫的时间凝滞……） */
  | 'special'
  /**
   * M2.10（PVP）：**防御** —— 本回合受到的伤害减半。
   *
   * 生物的 AI 不会用它（「防御」是一种玩家才有的策略性选择），
   * 但 PVP 的对手是玩家，他的动作里就有这一项。
   */
  | 'defend'
  /**
   * M2.10（PVP）：**认输** —— 直接结束战斗，认输的一方判负。
   *
   * 它是 PVP 特有的：PVE 里「我打不过」的出口是撤退（成功就脱身），
   * 而 PVP 里对手不会让你从容走掉 —— 认输是「我不打了，你赢，但你别通缉我」。
   */
  | 'surrender';

/**
 * 一方的动作。
 *
 * ⚠️ 名字里的 "Creature" 是**历史**（M2.9 只有 PVE，对手一定是生物）。
 * M2.10 起它的语义是「**对手方**的动作」：PVE 时由 `decideCreatureAction` 决定，
 * PVP 时由**另一个玩家**的动作翻译而来（见 domain/battle/pvp.ts）。
 * 字段名沿用不改，是为了不动 0018 的列与 M2.9 的既有代码 —— 但下面这组
 * 「只有 PVP 会填」的可选字段，正是「形状对 PVE 与 PVP 是同一件事」的落点。
 */
export interface CreatureAction {
  kind: CreatureActionKind;
  /** 显示用的中文名（回执与报告都用它） */
  label: string;
  /** kind = 'special' 时的特殊行为名（物种内容侧声明） */
  special?: string;
  /** 这一回合旁白（「它退开了半步」「它的声音钻进你的耳朵」……） */
  note: string;

  /* ---- 以下字段 PVE 的生物 AI 一个都不填；PVP 用它表达「对手的玩家动作」 ---- */
  /** 对手用的技能 id（PVP：与玩家侧同一张技能表） */
  skillId?: string;
  /** 伤害倍率（PVP：强攻 ×1.5） */
  damageMultiplier?: number;
  /** 这一下打几次（PVP：连击 ×2） */
  hits?: number;
  /** 命中加成（PVP：夜视在夜里的 +20%） */
  hitBonus?: number;
  /**
   * 固定伤害（PVP：符咒的 25 点直接伤害）。
   *
   * 与 damageMultiplier 分开是因为两者问的不是同一个问题：
   *   倍率 —— 在这一方的**基础伤害**上乘（强攻 1.5×）
   *   固定 —— 与基础伤害无关的一笔（符咒烧掉的就是那 25 点）
   * 混成一个字段会让「符咒在强的人手里更疼」这种说不通的事悄悄发生。
   */
  flatDamage?: number;
  /** 给自己挂的状态（PVP：梦魇给对手挂恐惧时，写的是「对手会给**你**挂」） */
  applyToOpponent?: readonly BattleStatusId[];
  /** 吞掉对手几次行动（PVP：幻觉干扰） */
  negateOpponentActions?: number;
}

/* ---------------- 战斗状态 ---------------- */

/**
 * 战斗的终局（任务书 §4.3.6 的五种）。
 * 'active' = 还没结束（第 1—7 回合之间）。
 */
export type BattleStatusKind =
  | 'active'
  /** 玩家胜：生物 HP 归零 → 掉落 + DIG +2 */
  | 'player_win'
  /** 玩家败：玩家 HP 归零 → 重伤（不删卡）+ AP 扣光 + MAD +5 */
  | 'player_lose'
  /** 僵持：8 回合结束 → 双方撤退，无奖励无惩罚 */
  | 'stalemate'
  /** 玩家逃：撤退成功 */
  | 'fled'
  /** 生物逃：生物逃跑成功（可能带伤逃脱） */
  | 'creature_fled';

/**
 * 战斗所处的世界（战斗开始时定下来，整场不变）。
 *
 * 为什么把它冻在战斗里而不是每回合现算：**这样「当时是雾天 -10%」是可复现的**。
 * 如果每回合现算，玩家投诉「我明明打中了」时，回放会因为天气变了而对不上。
 */
export interface BattleWorld {
  locationId: string;
  locationName: string;
  /** 此刻是不是夜晚（夜视技能 / 夜行生物看它） */
  night: boolean;
  /** 该地点的危险度 0—5（撤退难度的来源） */
  danger: number;
  /** 天气带来的命中修正（雾天 -0.1；没有就是 0） */
  weatherHitPenalty: number;
  /** 天气名（回执标题用，例如「雾天」） */
  weatherLabel: string;
  /**
   * M2.85 RPG 化 B：**装备带来的命中加成**（0.03 = +3%）。
   *
   * 为什么放在 world 而不是 state：world 是「开局定下、整场不变」的那一份快照，
   * 而装备正是那种整场不该变的东西（打一半换刀？那是另一场战斗）。
   */
  equipmentHitBonus?: number;
  /**
   * M2.85 B（重做）：**身上那些非凡物品的代价**（每回合流血 / 每次使用掉理智）。
   *
   * 原著的规则是必然伴随：有增幅就一定有副作用。所以要真的扣 ——
   * 只写在文字里、判定层不读，那就不叫代价，叫风味描述。
   */
  equipmentDebuffs?: { madPerUse?: number; corGain?: number; hpDrain?: number; statPenalty?: number };
  /**
   * M2.85 RPG 化 C：**内容表里那些技能的效果**（id → 效果）。
   *
   * 与 equipmentHitBonus 同一个模式：开局折进快照，判定层只读 world。
   * 这样 resolve.ts 不必知道内容表的存在（它至今是纯函数、零 IO）。
   */
  skillEffects?: Record<string, Record<string, number | boolean>>;
}

/**
 * 战斗的状态机本体。
 *
 * 一边一个 player / creature，各自有 HP 与状态列表 —— 结构上是**对称**的，
 * 这正是 M2.10 的 PVP 所需要的形状（把 creature 换成另一个玩家的角色卡即可）。
 */
export interface BattleState {
  id: string;
  characterId: string;
  /**
   * 对手的生物实例 id。
   *
   * M2.9 里必填；**M2.10 起可空**（PVP 的对手是另一个玩家，没有 creature_id）。
   * 类型上留成 string 而不是 string | null，是因为判定层（resolve.ts）从不读它 ——
   * 它只在仓储与命令层用于「写回世界」。真正的判据是下面的 `isPvp`。
   */
  creatureId: string;
  speciesId: string;
  /** 生物的物种名（报告与文案不必再回查内容表） */
  speciesName: string;
  /** 生物此刻的序列（战斗里会因为「进化」而变，最终要写回 creatures 表） */
  creatureSequence: number;
  /** 生物是不是长期没进食（濒死）—— 生物没有 MAD 字段，饥饿是「疯狂」的等价物 */
  creatureDying: boolean;

  /* ---- M2.10：PVP ---- */
  /**
   * 这一场是不是 PVP。
   *
   * 有了它，`creature*` 那一串字段的语义就明确了：
   *   isPvp = false → 它们是「那只生物」
   *   isPvp = true  → 它们是「**对手玩家**」（血量 / 序列 / 状态），PVE 的生物专属行为一律不适用
   *
   * ⚠️ **为什么沿用 creature* 这个名字而不是改成 opponent***：
   * 判定层（resolve.ts）对两边是完全对称的 —— 它从来不关心对面是人还是生物。
   * 改名要动 0018 的全部列、仓储的全部 SQL 与 M2.9 的全部测试，
   * 而收益只是「读起来顺一点」。代价与收益不成比例，所以名字留着、语义写在这里。
   */
  isPvp: boolean;
  /** PVP 对手的角色 id（PVE 时为 null） */
  opponentCharacterId: string | null;
  /** PVP 对手的显示名（回执里写「@某玩家」而不是物种名） */
  opponentName: string | null;
  /**
   * PVP：**现在轮到谁出招**。
   *
   * 'challenger' = `characterId` 那一方；'opponent' = `opponentCharacterId` 那一方。
   * PVE 恒为 'challenger'（生物永远在线，不存在「等它出招」）。
   */
  turnOf: 'challenger' | 'opponent';
  /**
   * PVP：**对方已经出招、在等自己**时，暂存的那个动作。
   *
   * 异步 PVP 的形状是「两人各选一个动作 → 一起结算」：
   * 先手的那个人出招时不该立刻结算（对手还没选），所以他的动作要在这里躺着，
   * 等对手出招的那一刻再一起跑一个回合。
   */
  pendingAction: PlayerAction | null;
  /**
   * 这场战斗所处的世界。**开局定下、整场不变** ——
   * 这样「当时是雾天 -10%」是可复现的；每回合现算的话，
   * 玩家投诉「我明明打中了」时，回放会因为天气变了而对不上。
   */
  world: BattleWorld;

  /** 当前回合号（1 起） */
  round: number;
  /**
   * M2.85 世界演化：**这一场最多几个回合**。
   *
   * 普通战斗 8（`BATTLE.maxRounds`）；**挑战神是 40**（`BATTLE.godMaxRounds`）。
   * 为什么必须放在状态里而不是每回合去查常量：神是序列 0、HP 300，
   * 照 8 回合算「僵持」，玩家在数学上**永远赢不了** ——「神明并非不可战胜」就成了空话。
   */
  maxRounds?: number;
  status: BattleStatusKind;

  /* ---- 玩家一边 ---- */
  playerHp: number;
  playerMp: number;
  playerStatuses: BattleStatusEffect[];
  /** 强攻留下的后遗症：下一回合防御 -30% */
  playerDefensePenalty: number;

  /* ---- 生物一边 ---- */
  creatureHp: number;
  creatureMaxHp: number;
  creatureStatuses: BattleStatusEffect[];
  /** 是否已经暴走（暴走是不可逆的：**不再逃跑**） */
  creatureBerserk: boolean;
  /**
   * 镜中客的「镜像」：下一次打向它的伤害减半。
   * 做成一个**跨回合的一次性标记**而不是「本回合减半」——
   * 生物在玩家之后行动，所以「本回合」对它来说只能是「你的下一击」。
   * 写成「本回合」会让这个技能在实现上默默失效（数值表里有、战斗里一次都不生效）。
   */
  creatureShield: boolean;
  /** 是否已经进化过（一场战斗只进化一次） */
  creatureEvolved: boolean;

  /* ---- 求援 ---- */
  /** 已经叫过援军没有（每场一次） */
  allyCalled: boolean;
  /** 援军到达的回合号（null = 没叫过） */
  allyArrivesAtRound: number | null;
  /** 已经到了几个援军 */
  allyCount: number;

  /* ---- 装死 ---- */
  /** 上一回合它是不是在装死（玩家这一回合停手就会挨偷袭） */
  creaturePlayingDead: boolean;

  /* ---- 幻觉干扰 / 占卜预判 ---- */
  /** 对手还有几次行动会被「幻觉干扰」吞掉 */
  negateCreatureActions: number;
  /**
   * M2.10（PVP）：**自己**还有几次行动会被对手的「幻觉干扰」吞掉。
   *
   * 与 negateCreatureActions 是一对：那个记「我打断了对手几次」，这个记「我被对手打断了几次」。
   * 分成两个字段而不是一个正负号，是因为视角转换（PVP 里双方轮流用同一份状态机）
   * 只需要交换它们 —— 一个数字加符号会让交换变成取反，而取反是很容易写错的一步。
   */
  negatePlayerActions: number;
  /** 占卜预判的结果（下一回合显示「它要做什么」） */
  foresight: { round: number; action: CreatureAction } | null;

  /* ---- 用于「模仿」这类招式 ---- */
  /** 上一回合玩家打出的伤害（命运幻影的模仿要用它） */
  lastPlayerDamage: number;

  /* ---- 时间 ---- */
  startedAt: number;
  lastRoundAt: number;
  resolvedAt: number | null;
}

/* ---------------- 一回合的结果 ---------------- */

/** 回合里发生的每一件事（报告与回执都从它生成，不再二次推断） */
export interface RoundEvent {
  kind:
    | 'player_attack'
    | 'player_skill'
    | 'player_defend'
    | 'player_item'
    /** M2.13：用了一件封印物（封印之刃 / 血月之刃 / 命运骰子） */
    | 'player_extraordinary'
    | 'player_retreat'
    | 'creature_attack'
    | 'creature_flee'
    | 'creature_call_ally'
    | 'creature_play_dead'
    | 'creature_evolve'
    | 'creature_special'
    | 'status_tick'
    | 'status_apply'
    | 'ambush'
    | 'negated'
    | 'foresight'
    | 'ended';
  text: string;
  /** 这条事件造成的伤害（有就带，没有就是 0） */
  damage?: number;
  /** 相关的状态 id */
  status?: BattleStatusId;
}

/**
 * resolveBattleRound 的输出。
 *
 * 它同时服务三件事：**回执文本**（lines）、**审计**（rolls/seeds）、**报告**（统计字段）。
 * 三者共用一份结果而不是各算一遍 —— 「报告里的生物行为分布」与「玩家看到的旁白」
 * 因此永远说的是同一件事。
 */
export interface RoundResult {
  battleId: string;
  round: number;
  playerAction: PlayerAction;
  /** 生物这一回合做了什么（含它是不是被「幻觉干扰」吞掉了） */
  creatureAction: CreatureAction;
  /** 生物这一回合是否真的行动了（被吞掉 / 被放逐就是 false） */
  creatureActed: boolean;
  events: RoundEvent[];
  /** 结算之后的双方数值 */
  playerHp: number;
  playerMp: number;
  creatureHp: number;
  playerStatuses: BattleStatusEffect[];
  creatureStatuses: BattleStatusEffect[];
  /** 这一回合打出的伤害（报告要统计） */
  playerDamageDealt: number;
  creatureDamageDealt: number;
  /**
   * M2.85 B（重做）：**这一回合因为动用非凡物品付出的代价**。
   *
   * 战斗状态里没有 MAD / COR（它们住在角色卡上），所以判定层只记账，
   * 由命令层在回合结算时落到角色身上 —— 与「结算层不碰角色卡」的既定分工一致。
   */
  equipmentCost?: { mad: number; cor: number };
  /** 这一回合结束后战斗的状态（'active' = 还要继续） */
  status: BattleStatusKind;
  /** 是否发生了这些可统计的事件（报告直接读，不从文案里正则） */
  flags: {
    crit: boolean;
    /** 触发了「流血」 */
    bleed: boolean;
    /** 增援到达 */
    allyArrived: boolean;
    /** 这次行动是 5 分钟超时自动防御 */
    autoDefend: boolean;
    /** 占卜预判生效 */
    foresight: boolean;
  };
  /**
   * 「使用物品」带来的 MAD 净变化。
   *
   * 单独一个字段而不是塞进 battle 状态：MAD 属于**角色卡**，不属于战斗。
   * 判定层不认识角色卡（它只读一个不可变的 state 快照），所以它只负责记账，
   * 由命令层把这一笔与 HP / MP 的净变化**一起**走唯一数值入口提交。
   */
  itemMadDelta: number;
  /** M2.13：使用封印物带来的 COR 净变化（与 itemMadDelta 同一手法） */
  itemCorDelta: number;
  /**
   * M2.13：这一回合**真的用上了「无视序列差拦截」**没有。
   * 报告里「封印之刃救了几次」直接数它（与 attack 的 `ignoredSequenceGap` 同源）。
   */
  ignoredSequenceGap: boolean;
  /**
   * M2.65：这一回合**真的用掉**了哪几条行动标记。
   *
   * 判定层只回报名字（它不做 IO）；命令层拿 `battleMarkFlag(mark, 地点, 日期)`
   * 把对应的 flag 删掉。没有这一条，「用完即消」就无从实现 ——
   * 而一条不会消失的标记与「永久加成」长得一模一样（K19）。
   */
  consumedActionMarks?: ReadonlyArray<'nextAttack' | 'guardDamage' | 'enemyDamage'>;
  /**
   * M2.65：**对手那一侧**这一回合用掉的标记名。
   *
   * 与上面那一条分开两个数组，是因为「删谁的 flag」这件事只有命令层知道：
   * PVE 里 foe 恒为空；PVP 里 self 属于发起者、foe 属于应战者。
   */
  consumedFoeMarks?: ReadonlyArray<'nextAttack' | 'guardDamage' | 'enemyDamage'>;
  /** 判定留档（写进 domain_events，复现用） */
  rolls: Record<string, number>;
  /** 结算之后的完整战斗状态（调用方整体写回） */
  battle: BattleState;
}

/**
 * 生物在战斗里需要知道的关于「自己是什么」的那几件事。
 *
 * 刻意**只给这几样**：判定层不该认识完整的物种模板（那会把感知文本、掉率、
 * 栖息地一起拖进战斗判定里）。这里要的全是「打架用得上的」。
 */
export interface BattleSpeciesView {
  id: string;
  name: string;
  /** 群居会求援（habits 里的 social） */
  habits: readonly string[];
  /** 物种专属行为名（creatures.yaml 的 battle.special）；没有就是 null */
  special: string | null;
  /** 特殊行为的中文名（文案用） */
  specialName: string | null;
  /** 这个物种的基础伤害区间；缺省用序列兜底 */
  damage: readonly [number, number];
  /** 这个物种的基础命中率 */
  hit: number;
  /** 这个物种的逃跑成功率（缺省用 numeric 的 fleeChance） */
  fleeChance?: number;
}

/** 「使用物品」这一回合用的物品效果（命令层查内容表后喂进来；判定层不认识 items.yaml） */
export interface BattleItemEffect {
  itemId: string;
  name: string;
  /** 对玩家自身的数值（与 items.yaml 的 effect 同名） */
  self?: { hp?: number; mp?: number; mad?: number; cor?: number };
  /** 战斗专用效果（符咒） */
  battle?: {
    /** 直接伤害 */
    damage?: number;
    /** 清掉自己的全部负面状态 */
    cleanse?: boolean;
    /** 本回合命中加成 */
    hitBonus?: number;
    /** 给生物挂的状态（符咒·定身 = banish） */
    applyToCreature?: readonly BattleStatusId[];
  };
}

/** resolveBattleRound 的可选输入（不给也能跑：生物动作用内部 rng 现掷） */
export interface BattleRoundOptions {
  /** 生物这一回合的动作。命令层先算好再传进来，好让「占卜预判」看到的就是真的 */
  creatureAction?: CreatureAction;
  /**
   * 「占卜预判」用来预览下一回合的随机源。
   * 与生物动作同一个 seed 派生，所以**看到的和真发生的一定是同一件事** ——
   * 一个会说谎的预知技能比没有预知更糟。
   */
  aiRng?: Rng;
  /**
   * M2.66：**先手点数**（`AbilityEffect.initiativeBonus`，命令层从能力表读出来喂进来）。
   *
   * 判定层不认识「能力」这个词 —— 与 item / extraordinary / relation 同一手法。
   * 不传 = 0（中性）⇒ 既有战斗路径一个字节都不变。
   *
   * 落点在**第一回合的命中**上（见 `BATTLE.initiative`）：你抢到了这一下，它慢了半拍。
   */
  initiative?: number;
  /**
   * M2.66：**对手的先手点数**（只有 PVP 会传）。
   *
   * 与 `action.foe` 同一个理由：判定层的 player 侧永远是发起者，
   * 两侧都接才不会出现「当发起者时有用、当应战者时没用」。
   * 两条都传时取**差值** —— 先手本来就是相对量。
   */
  initiativeFoe?: number;
  /** 物种视图（生物 AI 要用） */
  species?: BattleSpeciesView;
  /** 「使用物品」用的物品效果 */
  item?: BattleItemEffect;
  /** M2.13：「使用封印物」用的效果（命令层查内容表后喂进来；判定层不认识 items.yaml） */
  extraordinary?: BattleExtraordinaryEffect;
  /**
   * M2.18（C/D）：**势力关系带来的战斗修正**。
   *
   * 由命令层算好喂进来（判定层不认识 churches.yaml，与 item / extraordinary 同一手法）：
   *
   *   hit    —— 命中**加成**，走相加那条链（`hitPenaltyOf + 天气 + extraHit + hit`），
   *             所以它与封印物的命中修正是**累加**、不会互相覆盖。
   *   damage —— 伤害**加成**（0.05 = +5%、-0.1 = -10%），内部按 `× (1 + damage)` 换算成倍率，
   *             与封印物的 `damageMultiplier`（本身就是倍率）相乘。
   *
   * 不传 = 中性（hit 0 / damage 0）—— **默认行为与 M2.17 逐位相同**。
   *
   * ⚠️ 两个字段都是「加成」而不是「倍率」，因为 NUMERIC 里的 sameChurchBonus / hostilePenalty
   * 就是这么写的（+0.05 / -0.1）；换算只在这一处做一次。
   */
  relation?: { hit?: number; damage?: number };
  /**
   * M2.65：**途径行动留下的战斗标记**（`.行动` 写的 flags，由命令层读出来喂进来）。
   *
   * 与 `item` / `extraordinary` / `relation` 同一手法：判定层不认识 flags，
   * 也不认识「行动」这个词 —— 它只拿到三个算好的数。
   *
   * ⚠️ **三项都「用完即消」**（在真的用掉的那一下清零），所以一场战斗里
   * 一条标记只生效一次。哪几条真被用掉了由 `RoundResult.consumedActionMarks` 回报，
   * 命令层据此删掉对应的 flag ——「删」是 IO，判定层不做。
   *
   * 不传 = 三项中性（1 / 1 / 0）⇒ 既有战斗路径一个字节都不变。
   */
  action?: {
    /** 本回合**第一次真的打中**的伤害倍率（不是「每一次出手」——多段技能只吃一次） */
    nextAttack?: number;
    /** 本回合**挨的第一下**的伤害倍率（0.5 = 卸掉一半） */
    guardDamage?: number;
    /** 本回合**对方第一次打中你**的伤害削减（0.4 = 打七折） */
    enemyDamage?: number;
    /**
     * M2.65：**对手那一侧挂的同一组标记**（只有 PVP 会传）。
     *
     * 方向是反的，逐条对着看：
     *   `nextAttack`  —— 上面那一条加在**你**的出手伤害上，这一条加在**它/他**的出手伤害上；
     *   `guardDamage` / `enemyDamage` —— 上面两条削减「你受到的伤害」，
     *                       这两条削减「**你打出去**的那一下」。
     *
     * ⚠️ 为什么非要两侧都写：PVP 的结算**永远以发起者为 player 侧**（见 domain/battle/pvp.ts 文件头）。
     * 只接一侧的话，「我当发起者时立阵有用、当应战者时没用」—— 那是一条只有一半人踩得到的规则，
     * 比不接更糟。
     */
    foe?: {
      nextAttack?: number;
      guardDamage?: number;
      enemyDamage?: number;
    };
  };
}

/**
 * M2.13：**战斗中的一件封印物**。
 *
 * 与 `BattleItemEffect` 同一手法（命令层查内容表 → 喂进判定层），
 * 但问的是另一个问题：`BattleItemEffect` 说「对面会怎么样」，
 * 这一份说「**我这一下**会怎么样」。
 *
 * 三项加成都是可选的，**默认全部中性** —— 不传它时判定层的路径与 M2.9/M2.10 逐位一致
 * （这是既有战斗用例一条都不用改的前提）。
 */
export interface BattleExtraordinaryEffect {
  itemId: string;
  name: string;
  /** 封印之刃：这一回合的攻击**无视一次序列差拦截** */
  ignoreSequenceGap?: boolean;
  /** 这一回合的命中修正（封印之刃 +1.0 = 必中；与 M2.9 的 hitModifier 同一口径） */
  hitModifier?: number;
  /** 这一回合的伤害倍率（血月之刃 2） */
  damageMultiplier?: number;
  /** 命运骰子：这一回合打空后**重抽一次** */
  reroll?: boolean;
  /**
   * 使用代价。判定层**只记账**，由命令层走唯一数值入口提交 ——
   * 与 `itemMadDelta` 同一条纪律（判定层不认识角色卡）。
   */
  cost?: { mad?: number; cor?: number };
}

/** 报告与菜单都要的「这一场战斗长什么样」 */
export interface BattleView {
  battleId: string;
  round: number;
  maxRounds: number;
  status: BattleStatusKind;
  headline: string;
  creatureName: string;
  creatureHp: number;
  creatureMaxHp: number;
  creatureStatuses: readonly BattleStatusEffect[];
  playerHp: number;
  playerMaxHp: number;
  playerMp: number;
  playerMaxMp: number;
  playerMad: number;
  playerStatuses: readonly BattleStatusEffect[];
  /** 玩家的途径与序列（决定技能池） */
  pathway: PathwayId | null;
  sequence: number;
  /** M2.10：这一场是不是 PVP（决定菜单里有没有「认输」、文案里写「他」还是「它」） */
  isPvp: boolean;
  /** M2.10：PVP 时**该谁出招**（轮到对方时菜单只显示「等他出招」） */
  yourTurn: boolean;
  /** 可用技能的 id 列表（已按途径/序列过滤） */
  skills: readonly string[];
  /** 背包里能用的物品 */
  items: readonly { itemId: string; name: string; quantity: number }[];
  world: BattleWorld;
  /** 占卜预判看到的东西 */
  foresight: CreatureAction | null;
  lines: string[];
}
