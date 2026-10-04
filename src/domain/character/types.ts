/**
 * 角色领域类型（S1 交付物二 —— src/domain/character/types.ts）
 *
 * 注意：不落库 SAN 字段。SAN 是视图概念，恒等于 100 - mad（S1 §9 决策）。
 */

/**
 * 本版已实现的途径：S1 §2.1 的三条 + **M2.19 落地的 sailor（水手）** + **M2.26 落地的 perfect（完美者）**。
 *
 * ⚠️ 它与 `geo/types.ts` 的 `PathwayIdSchema`（内容表的校验口径）必须同时改 ——
 * 前者是代码里的类型，后者是 YAML 的取值域，漏一处就是「解析得出来、类型不认」。
 * 其余 19 条途径仍是未开放占位（登记在 `PlannedPathwayIdSchema` 里）。
 */
/**
 * M2.76：**22 条正途径全部落地**（此前 7 条）。
 *
 * 口径（与 `诡秘之主原作数据/` 对齐，见 `01-途径与序列/途径总表.yaml`）：
 *   · 已实现的 7 条**沿用历史 id**（`perfect` / `mother` 取的是序列 0 名，属 M2.26 的历史账，
 *     不改 —— 它们出现在存档、内容表与四个域里，改名要动整条链路而收益只是好看）；
 *   · 新落地的 15 条一律取**该途径序列 9 的英文名**（`apothecary` / `assassin` / `secrets_supplicant`…），
 *     这是数据集的 id 口径，也是唯一能让人不看表就猜对的那个。
 *
 * ⚠️ 它与 `geo/types.ts` 的 `PathwayIdSchema`（内容表的校验口径）必须同时改 ——
 * 前者是代码里的类型，后者是 YAML 的取值域，漏一处就是「解析得出来、类型不认」。
 * 《宿命之环》的 10 条外神途径**仍不在其中**（没有魔药配方，本版不做）。
 */
export type PathwayId =
  // —— 已实现的 7 条（历史 id 不改）——
  | 'seer' | 'warrior' | 'sleepless' | 'sailor' | 'perfect' | 'reader' | 'mother'
  // —— M2.76 落地的 15 条（id = 序列 9 英文名）——
  | 'door' | 'sun' | 'corpse_collector' | 'error' | 'mystery_pryer' | 'spectator'
  | 'apothecary' | 'arbiter' | 'assassin' | 'criminal' | 'hunter' | 'lawyer'
  | 'monster' | 'prisoner' | 'secrets_supplicant';

export type CharacterStatus =
  | 'active'
  | 'injured'
  | 'lost_control'
  | 'promoting'
  | 'in_battle'
  | 'trading'
  | 'banned';

/**
 * 初始性别（M2.7.6 补充 §1）。
 *
 * **本版只做存储与显示**：没有任何判定读它。留这个字段是因为后续三件事都要用它 ——
 * 部分 NPC 事件按性别有不同文本、部分势力收人偏好不同、婚姻系统依赖性别。
 * 现在不做机制，但数据结构必须先对，否则将来改表要把所有角色迁移一遍。
 */
export type Gender = 'male' | 'female';

/**
 * 是否已经走上途径（M2.7.6）。
 *
 * 'mortal' —— 普通人：没有途径、没有序列，探索更危险、收获更少，
 *             但也不会失控（MAD/COR 上限低于失控闸门，见 NUMERIC.initiation.mortalCaps）。
 * 'initiated' —— 已入途径：pathway 与 sequence 必然非空。
 *
 * 为什么不靠「pathway === null」自己判断：那样每个读 pathway 的地方都要各自记得
 * 「null 是什么语义」，而其中一处忘了就是线上事故。把它做成一个显式字段，
 * 再配一个类型守卫 isInitiated()，判断点就收敛到一处。
 */
export type PathwayStatus = 'mortal' | 'initiated';

export interface CharacterState {
  id: string;
  userId: string;
  name: string;
  /**
   * M2.7.6：**普通人没有途径**，所以这里可以为 null。
   *
   * 创建时一律是 null —— 玩家要先自己翻到配方线索才会知道
   * 自己走哪条路（原作里普通人根本不知道「途径」是什么）。
   * 所有需要途径的玩法（扮演 / 晋升 / 占卜 / 仪式）在命令层被守卫挡下，
   * 判定层则通过 isInitiated() 收窄类型。
   */
  pathway: PathwayId | null;
  /** 9 最低，0 最高；**普通人没有序列**（null） */
  sequence: number | null;
  /** M2.7.6：mortal = 尚未入途径 */
  pathwayStatus: PathwayStatus;
  /** M2.7.6 补充：初始性别（本版只存不算） */
  gender: Gender;
  /** 生命 0—100，归零为重伤不删卡 */
  hp: number;
  /** 灵性 0—100 */
  mp: number;
  /** 疯狂 0—100 */
  mad: number;
  /** 污染 0—100 */
  cor: number;
  /** 魔药消化度 0—100 */
  dig: number;
  /**
   * M2.85 RPG 化 A：**历练累计经验**。
   *
   * 它**不换技能** —— 技能由序列自带（用户拍板「不需要天赋树，因为技能都是序列自带的」）。
   * 经验只决定「历练档」，历练档给属性上限与抗性加成。见 domain/character/experience.ts。
   *
   * ⚠️ **可选**：老角色卡（以及大量构造点：测试夹具、模拟器、建号命令）都没有这个字段，
   * 缺省即 0。写成必需会逼所有构造点都改一遍 —— 而那与「加一层」的尺度不符。
   */
  exp?: number;
  /**
   * M2.85 RPG 化：**玩家站在哪个地点**（locations.yaml 的 id）。
   *
   * 与 currentCityId 是两级：城市回答「你在哪座城」，这一列回答「你站在哪」。
   * 没有它就描述不出场景 —— 而「场景」正是 RPG 视角的载体。
   * 可选：老存档与建号时都是 null，读取点会退回到城市。
   */
  currentLocationId?: string | null;
  /** 命运点 0—10 */
  dp: number;
  status: CharacterStatus;
  /** 连续晋升失败次数（W4：连续 2 次后第 3 次成功率 +10%，防卡死） */
  promotionFails: number;
  /**
   * M2.7：此刻在哪座城市（城市 id，不是地点 id）。
   *
   * 为什么是可选字段：M2.7 之前的角色卡没有这个概念，而 CharacterState 被大量纯函数
   * 直接构造（能力上限、失控判定、模拟器的 1000 人 sweep）。做成必填会让那些构造点
   * 全部要改一遍，而它们**一个都不关心城市**。缺省（undefined/null）按「还没出生在城市里」
   * 处理：所有城市相关的判定都会退化成"不限制"，与 M2.6 的行为完全一致。
   */
  currentCityId?: string | null;
  /**
   * M2.16：所属正神教会（教会 id）；`null` = 未入教。
   *
   * **硬互斥**：一人一家，本版**不做出退**。这条不是靠数据库约束守的，
   * 是靠 `canJoin` 的第 2 条判据守的（domain/church/membership.ts）。
   *
   * 做成可选字段的理由同 `currentCityId`：大量纯函数直接构造 CharacterState，
   * 而它们不关心教会。缺省（undefined/null）按「未入教」处理。
   */
  churchId?: string | null;
  /**
   * M2.16：累计贡献点（捐献换算而来）。
   *
   * ⚠️ **档位不存**：它由「贡献 + 序列」双门槛算出来（`currentRank`）。
   * 存一份 rank 列会让它与序列脱节 —— 玩家序列升上来了、档位还挂在旧值上，
   * 而那种不一致在数据里看不出来。代价是必须有人定期去算：捐款后 + 每日 tick。
   */
  churchContribution?: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * 已经入途径的角色 —— 一个**类型层面**的保证：pathway 与 sequence 都非空。
 *
 * 所有需要途径的判定（扮演、晋升、仪式、占卜、魔药）都要求这个类型，
 * 于是「普通人不能扮演」不再是散落在各处的 if，而是编译期就挡住的调用。
 */
export type InitiatedCharacter = CharacterState & {
  pathway: PathwayId;
  sequence: number;
};

/** 类型守卫：已入途径（pathway 与 sequence 同时非空） */
export function isInitiated(state: CharacterState): state is InitiatedCharacter {
  return state.pathway !== null && state.sequence !== null;
}

/** 普通人的序列按 9 处理（地点准入：普通人等价于「序列 9 的新人」） */
export function sequenceOrInitiate(state: Pick<CharacterState, 'sequence'>): number {
  return state.sequence ?? 9;
}

/** 可注入随机源：同一种子必须复现同一次判定（S1 §3.2） */
export interface Rng {
  /** 返回 [0, 1) */
  next(): number;
}

/** 领域事件：所有数值改动的唯一审计载体（S1 §3.3） */
export interface DomainEvent {
  type: string;
  characterId: string;
  payload: Record<string, unknown>;
  reason: string;
  /**
   * 判定 seed（铁律 3：每次判定写入可复现）。
   *
   * ⚠️ **不掷骰的事件显式写 `null`，不是 `undefined`**（M2.16 拍板补充二）：
   * `domain_events.seed` 是可空列，而 `undefined` 与 `null` 在类型层是两回事 ——
   * 前者会被读成「这个事件本该有 seed 但丢了」，后者才是「它本来就不掷骰」。
   * M2.16 的 `church_contribute`（捐献是确定性的）就是第一种 `null`。
   */
  seed?: string | null;
  createdAt: number;
}
