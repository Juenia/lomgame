/**
 * 非凡生物（M2.8）—— 领域类型。
 *
 * 这一层的全部东西都是**纯数据 + 纯函数**：没有 IO、没有数据库、没有时钟。
 * 落库由 infra/db/creatures.ts，装配由 router/commands/encounter.ts 负责，
 * 生态 tick 的调度由 infra/creature-tick.ts 负责。
 *
 * ⚠️ 生物**不是事件卡**。事件卡是「抽一张、看一眼、结束」；
 * 生物是**世界实体**：它有位置、会迁移、HP 会因捕食/受伤变化、会成长、会进化、会死。
 * 玩家遇到的是「此时此刻的它」，不是配置好的它 —— 这是 M2.8 与 M2.x 其它内容最大的分别。
 *
 * ⚠️ M2.8 **不做战斗**（那是 M2.9 的活）。遭遇生物只有四个动作：
 * 观察 / 对峙 / 撤退 / 互动（外加普通人专属的「站着不动」）。
 * creatures 表里的 hp / status / sequence 就是 M2.9 战斗的对手来源 —— 数据结构为它留好了。
 */
import type { PathwayId } from '../character/types.ts';

/* ---------------- 物种模板（内容侧，src/data/creatures.yaml） ---------------- */

/**
 * 习性。它同时被两处读：
 *   - 生态 tick（ecology.ts）：群居才繁衍、迁徙的迁移权重更高、夜行的在夜里更活跃
 *   - 遭遇判定（perception.ts）：夜行生物在白天更难被遇到
 */
export type CreatureHabit =
  /** 夜行：只在夜里活跃（深海凝视者） */
  | 'nocturnal'
  /** 群居：会繁衍、会求援（铁血猎犬） */
  | 'social'
  /** 独占：同一地点同类不相容，迁移权重更高（镜中客） */
  | 'territorial'
  /** 迁徙：迁移概率显著更高，这是「惊喜感」的来源（时序蠕虫） */
  | 'migratory';

/** 生物此刻的状态。与 creatures.status 一一对应。 */
export type CreatureStatus =
  /** 健康：最近进食过，无特殊行为 */
  | 'healthy'
  /** 饥饿：超过 feedThresholdHours 没进食，开始找猎物 */
  | 'hungry'
  /** 进化中：攒够了存活时间与捕食次数，正在变强 */
  | 'evolving'
  /** 濒死：长期没进食，HP 持续下滑，滑到 0 就消失 */
  | 'dying';

/* ---------------- 生态关系网（M2.58 阶段一） ---------------- */

/**
 * 生态位角色（M2.58）。**分类，不是数值** —— 它决定这个物种在三张网里站哪一格。
 *
 * 为什么需要它：M2.8 的 11 个物种之间**一个关系都没有**。物种模板的 12 个字段
 * （habitat / pathwayAffinity / drops / baseSequence / habits / …）指向的全是
 * 「物种 → 地点」「物种 → 物品」「物种 → 途径」以及单体属性，
 * **没有任何一个字段指向另一个物种**。于是「捕食」在 ecology.ts 里是一条
 * 与物种无关的通用规则：序列差 ≥ 3 就吃得到，不分你是谁、它是谁。
 *
 * 这一层补的就是那根缺失的轴：物种 → 物种。
 */
export type EcologicalRole =
  /** 生产者：能量/灵性的源头（灵性植物、信仰香火） */
  | 'producer'
  /** 消费者：普通与非凡的捕食者 */
  | 'consumer'
  /** 分解者：食腐、灵界清道夫 */
  | 'decomposer'
  /** 寄生者：寄生灵、污染孢子 */
  | 'parasite'
  /** 共生者：信使、契约生物、灵界商人 */
  | 'symbiont'
  /** 顶级掠食者：高序列非凡生物、神话生物 */
  | 'apex';

/**
 * 一个物种的生态关系（creatures.yaml 的 relations 段）。
 *
 * ## 兼容性：**整个段是可选的**，不写 = 逐位沿用 M2.8 的旧行为
 *
 * 这是本阶段的硬约束（用户拍板「不排斥现有数据」）。缺失时的行为：
 *   - 捕食判定完全走原来的「序列差 ≥ predatorSeqGap」；
 *   - 三张网里这个物种是一个**孤立点**，不参与任何关系。
 * 于是既有的 11 个物种、既有测试、既有跑批报告在**不改内容**时逐位不变。
 *
 * ## `prey` 是判定的**唯一权威**，`predators` 是冗余的反向索引
 *
 *   - `prey`      —— 这个物种吃谁。**判定只读它**（见 ecology.ts 的 canPreyOn）
 *   - `predators` —— 谁吃它。供报告、审计与 loader 的双向一致性校验用，
 *                    运行期一个判定都不读它
 *
 * 为什么不让 predators 也参与判定：那会让一对物种**互相捕食** ——
 * A 的 predators 里有 B，与 B 的 prey 里有 A，是同一件事的两种写法，
 * 两条规则都读就会把一条单向边判成双向。既有测试抓到过这个（见 canPreyOn 的注释）。
 *
 * 同一个坑的另一半教训：**互吃不能靠判定层的隐式门槛去防**。
 * 试过加「猎物序列必须更弱」的可行性检查，两种方向都错 ——
 * 写成「同级或更弱」会挡掉雾鸦吃普通乌鸦（差 1 级），
 * 写成「严格更弱」会挡掉同级捕食（镜中客吃命运幻影就是同级）。
 * 真正该防的那件事在**数据层**防：没有哪两个物种在各自的 prey 里互相点名，
 * 由 loader 的双向校验与 test/m2-58 的内容表用例守着。
 *
 * ## 代价：两边必须手工保持一致
 *
 * 只写一边在功能上是够的（单边声明即生效），但会让「这张网到底长什么样」
 * 变成要看两个地方才知道。所以内容侧的纪律是**两边都写**，
 * 由 loader 的启动校验把它变成一条可检验的断言（见 src/data/loader.ts），
 * 而不是靠人记得。
 *
 * ⚠️ 与「不排斥现有数据」的兼容性关系：整个 relations 段是可选的。
 * 一个物种**完全不写** relations 时，它与任何物种的捕食都走 M2.8 的序列差规则；
 * 一旦它**写了** relations（哪怕四个列表全空），它就进入了关系网 ——
 * 与另一个同样写了 relations 的物种之间，只有声明过的边才吃得到。
 */
export interface CreatureRelations {
  /** 生态位角色。不填 = 'consumer'（非凡生物里最常见的那一类）。 */
  role: EcologicalRole;
  /** 这个物种吃谁（物种 id）。**判定只读这个列表。** */
  prey: readonly string[];
  /**
   * 谁吃它（物种 id）。**运行期不参与判定**，只供报告与 loader 的双向校验。
   *
   * 与 prey 是同一张网的两个方向，两边都写是内容纪律（loader 会校验一致性）。
   */
  predators: readonly string[];
  /** 与谁共生（信使、契约生物）。 */
  symbiosis: readonly string[];
  /** 寄生在谁身上 / 被谁寄生。 */
  parasite: readonly string[];
}

/** 一条掉落（观察本质时采集）。 */
export interface CreatureDrop {
  itemId: string;
  /** 采集到它的概率（0—1）。还要再过一道 NUMERIC.creature.harvest.baseChance。 */
  chance: number;
}

/**
 * 一条行为声明（内容侧写法见任务书 §4.3.4）：
 *   - flee: { trigger: hpLow, chance: 0.6 }
 *   - howl: { trigger: night, chance: 0.2 }
 *
 * 判定层**只读不猜**：trigger 是白名单里的一个词，chance 是这个行为在满足
 * trigger 时被选中的概率。M2.8 里这些行为表现为遭遇回执里的一句旁白 +
 * 是否影响「它对你的注意程度」，不产生战斗效果（M2.9 才接）。
 */
export type BehaviorTrigger =
  /** HP 低于一半 */
  | 'hpLow'
  /** 夜晚 */
  | 'night'
  /** 雾天 */
  | 'fog'
  /** 饥饿 */
  | 'hungry'
  /** 玩家序列高于它（它察觉到威胁） */
  | 'threatened'
  /** 始终（无条件的日常行为） */
  | 'always';

export interface CreatureBehavior {
  /** 行为名（自由文本，用于文案与报告统计） */
  kind: string;
  trigger: BehaviorTrigger;
  chance: number;
}

/** 感知分层的五层（**M2.8 最重要的一条**，见 perception.ts）。 */
export type PerceptionLayer =
  /** 玩家弱 3 级及以上：只看到模糊的一团，只能撤退 */
  | 'blur'
  /** 玩家弱 1—2 级：看到轮廓（大小、朝向），观察有危险 */
  | 'silhouette'
  /** 同序列：完整信息（名字 + 习性 + 核心位置） */
  | 'full'
  /** 玩家强 1—2 级：占优（它甚至没发现你），可以观察 / 互动 / 驱逐 */
  | 'advantage'
  /** 玩家强 3 级及以上：看见本质，可以观察本质 / 互动 / 取材料 */
  | 'essence';

/** 遭遇时可用的动作。前四个是任务书 §4.2 的四个动作；hold 是普通人专属。 */
export type SightingAction = 'observe' | 'confront' | 'retreat' | 'interact' | 'hold';

/**
 * 一个物种模板（creatures.yaml 的一行）。
 *
 * 它是**连接器**：一份声明同时连起四张表 ——
 *   habitat          连地图（栖息地，决定它可能出现在哪）
 *   pathwayAffinity  连途径（与哪些途径亲和，决定谁更容易撞见它）
 *   drops            连物品（观察本质能采到什么）
 *   behaviors        连事件卡（它会做什么，遭遇回执的旁白来源）
 */
export interface CreatureSpecies {
  /** 物种 id（YAML 里的 species 字段） */
  id: string;
  /**
   * M2.85 数据兼容对齐：指回 `bestiary.yaml` 的条目 id（设定层 ↔ 机制层的桥）。
   * null = 这条是项目自造的物种，原作里没有对应记载。
   */
  bestiaryId?: string | null;
  name: string;
  /** 基线序列（数字越小越强）。个体序列从它开始，进化时 -1。 */
  baseSequence: number;
  /** 栖息地（locations.yaml 的地点 id）。迁移也只在这些地点之间发生。 */
  habitat: readonly string[];
  /**
   * 与哪些途径相关。命中时遭遇概率 × pathwayAffinityMultiplier。
   *
   * ⚠️ 这里是 **string 而不是 PathwayId**，是刻意的：
   * 任务书 §4.5 给物种挂的途径里有一半（水手 / 秘法师 / 收尸人 / 阅读者 / 错误 / 占卜家）
   * 在 M2.8 还没实现。用 PathwayId 会逼内容同学要么留空、要么写错 ——
   * 而这一栏只是「谁更容易撞见它」的倍率标记，不影响角色创建，放宽是安全的。
   * 于是内容可以先声明，等那条途径实现的那天**自动生效**，不需要回来改物种表。
   * 拼错的风险由 loader 的启动校验兜住（既不是已实现途径、也不在城市的 planned_pathways 里 → warn）。
   */
  pathwayAffinity: readonly string[];
  drops: readonly CreatureDrop[];
  behaviors: readonly CreatureBehavior[];
  habits: readonly CreatureHabit[];
  /**
   * 生态关系网（M2.58 阶段一）。
   *
   * ⚠️ **可选**。undefined = 这个物种没有声明关系，捕食判定逐位沿用 M2.8 的
   * 序列差规则（见 ecology.ts 的 canPreyOn）。这是「不排斥现有数据」的落点：
   * 内容表可以一个物种一个物种地补关系，补一半也不会让世界半坏。
   */
  relations?: CreatureRelations;
  /** 生态节拍。本版只跑 hourly（轻 tick 每小时一次）。 */
  tickRate: 'hourly' | 'daily';
  /** 基线 HP（也是进化后的 HP 上限基数） */
  baseHp: number;
  /**
   * 五层感知文本。**由内容同学写**——同一只生物在不同层次看到的描述本就不同，
   * 这是内容，不是代码。层与层的差别要能让玩家感到「我看到的东西变了」。
   */
  perception: Readonly<Record<PerceptionLayer, string>>;
  /**
   * 遭遇回执的标题氛围（「【遭遇 · 老码头 · 雾天】」里那句地点之外的描述）。
   * 不给就退回物种名。
   */
  flavor: string;
  /**
   * 战斗侧的内容声明（M2.9 追加）。
   *
   * ⚠️ **TypeScript 里是可选的，YAML 里是必填的**（见 schema.ts）。
   * 这个不对称是刻意的：
   *   - 内容侧必填 —— 「一只没有伤害数字的生物」不该靠兜底默默打起来，
   *     那样八种物种会全部退化成同一个木桩，而这件事在启动时就能拦住；
   *   - TS 侧可选 —— M2.8 的既有测试与报告脚本大量手写物种对象，
   *     把它们全部改一遍只会让「M2.8 的断言有没有被偷偷改过」变得无从判断。
   */
  battle?: CreatureBattleProfile;
}

/**
 * 一个物种在战斗里的那几样（creatures.yaml 的 battle 段）。
 *
 * 只放「打架用得上的」：伤害区间、命中、专属行为、逃跑成功率。
 * 感知文本 / 掉率 / 栖息地一概不进战斗 —— 它们是遭遇与生态的事。
 */
export interface CreatureBattleProfile {
  /** 基础伤害区间 [最小, 最大]（序列差与暴走倍率在这个之上再乘） */
  damage: readonly [number, number];
  /** 基础命中率（同序列时） */
  hit: number;
  /** 物种专属行为名（见 domain/battle/specials.ts 的 SPECIAL_IDS） */
  special: string | null;
  /** 专属行为的中文名（回执里显示） */
  specialName: string | null;
  /** 逃跑成功率；缺省用 numeric.battle.creatureAi.fleeChance */
  fleeChance?: number;
}

/* ---------------- 生物实例（世界状态，跑在 tick 上） ---------------- */

/**
 * 一只具体的生物。
 *
 * 与物种模板的分别：模板是「低语者是什么」，实例是「老码头那只饿了两天的低语者」。
 * 玩家遇到的一律是实例 —— 它此刻在哪、还剩多少 HP、是不是已经变强过一次。
 */
export interface Creature {
  id: string;
  speciesId: string;
  locationId: string;
  /** 个体序列。从物种基线开始，进化 -1（最少到 1）。 */
  sequence: number;
  hp: number;
  maxHp: number;
  status: CreatureStatus;
  /** 存活小时数（每次生态 tick +1） */
  ageHours: number;
  /** 累计捕食次数（进化条件之一） */
  feedCount: number;
  /** 上次进食的绝对时刻（毫秒）；从没吃过是 null */
  lastFedAt: number | null;
  spawnedAt: number;
  /** 从哪个地点迁来的（审计 + 报告里的「迁移次数」） */
  migratedFrom: string | null;
}

/* ---------------- 遭遇判定（perception.ts 的输入输出） ---------------- */

/** 判定层的世界输入：调用方查库/查世界后喂进来，判定层不认识数据库。 */
export interface SightingWorld {
  /** 此刻的地点 id */
  locationId: string;
  /** 地点显示名（回执标题用） */
  locationName: string;
  /** 此刻的天气（M2.2）：雾天影响遭遇倍率，也进回执文案 */
  foggy: boolean;
  /** 此刻是不是夜晚（M2.2 世界时钟）：夜行生物与 nightMultiplier 都看它 */
  night: boolean;
  /** 天气名（回执标题用，例如「雾天」） */
  weatherLabel: string;
}

/** 一次遭遇的判定结果。 */
export interface SightingResult {
  ok: true;
  seed: string;
  creatureId: string;
  speciesId: string;
  /** 感知层次：决定玩家看到什么、能做什么 */
  layer: PerceptionLayer;
  /** 玩家实际看到的文本（就在这个层次上） */
  text: string;
  /** 这一层允许的动作（按顺序渲染成菜单） */
  allowedActions: readonly SightingAction[];
  /**
   * 层次够高才看得见的数值。blur / silhouette 两层是 null ——
   * 「你看不清」不能只体现在文案里，**数值也必须真的看不见**，
   * 否则玩家能从「HP 12/40」反推出那是什么东西。
   */
  visible: {
    name: string | null;
    sequence: number | null;
    hp: number | null;
    status: CreatureStatus | null;
  };
  /** 留档用的原始掷值（复现与审计） */
  rolls: { layer: number };
  /** 依 behaviors 掷出来的旁白（没有则 null） */
  behavior: { kind: string; text: string } | null;
}

/* ---------------- 生态 tick（ecology.ts 的输入输出） ---------------- */

/** 生态 tick 的一次迁移记录。 */
export interface CreatureMigration {
  creatureId: string;
  speciesId: string;
  from: string;
  to: string;
}

/** 生态 tick 的一次进化记录（序列 -1）。 */
export interface CreatureEvolution {
  creatureId: string;
  speciesId: string;
  fromSequence: number;
  toSequence: number;
}

/** 生态 tick 的一次捕食记录。 */
export interface CreatureFeed {
  predatorId: string;
  preyId: string;
  locationId: string;
}

/** 生态 tick 的一次繁衍 / 衰亡记录。 */
export interface CreatureBirth {
  creatureId: string;
  speciesId: string;
  locationId: string;
  sequence: number;
}

export interface CreatureDeath {
  creatureId: string;
  speciesId: string;
  locationId: string;
  /** 死因：饿死 / 被捕食 / 自然衰亡 */
  cause: 'starved' | 'preyed' | 'decayed';
}

/**
 * 世界补充（M2.9 前置 1）的一次记录。
 *
 * 与「繁衍」分开记，因为它们是**两条不同的流**：
 *   繁衍 —— 生物自己生（只对群居物种生效，且要有亲代）
 *   补充 —— **世界**往这个地点放一只（不依赖亲代，任何物种都可能）
 * 混在一起记，「世界补充到底有没有生效」就无从回答。
 */
export interface CreatureReplenish {
  creatureId: string;
  speciesId: string;
  locationId: string;
  sequence: number;
}

/** tickCreatures 的输出：世界在这一小时里做了什么。 */
export interface CreatureTickResult {
  /** 本次 tick 处理的生物数 */
  ticked: number;
  migrations: CreatureMigration[];
  evolutions: CreatureEvolution[];
  feeds: CreatureFeed[];
  births: CreatureBirth[];
  deaths: CreatureDeath[];
  /** 世界补充进来的个体（M2.9 前置 1）：全新 id，调用方按 births 同一手法 INSERT */
  replenishes: CreatureReplenish[];
  /** tick 之后的完整生物列表（调用方整体写回） */
  creatures: Creature[];
  /** 状态发生了变化的生物 id（只有这些需要 UPDATE，其余不动） */
  changed: string[];
}
