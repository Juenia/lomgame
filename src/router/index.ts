import type { Adapter, InternalMessage, MessageHeader, Scene } from '../adapter/types.ts';
import type { Shop } from '../domain/economy/shop.ts';
import { commandBanAt } from '../domain/world/authority-effects.ts';
import type { PriceTable } from '../domain/economy/price.ts';
import type { BroadcastButton } from '../infra/broadcast.ts';
import type { CardService } from '../card/service.ts';
import type { CharacterRepo } from '../infra/db/characters.ts';
import type { Db } from '../infra/db/sqlite.ts';
import type { IdempotencyStore } from '../infra/idempotency.ts';
import { RateLimiter } from '../infra/ratelimit.ts';
// M2.172：管理员指令的两块地基 —— 服务器开关与管理员名单
import { ServerSwitchRepo } from '../infra/db/server-switches.ts';
import { AdminRegistry } from '../domain/admin/registry.ts';
import type { KeyedQueue } from '../infra/queue.ts';
import type { AuditLog } from '../infra/audit.ts';
import type { SensitiveFilter } from '../infra/sensitive.ts';
import { consoleLogger, type Logger } from '../infra/logger.ts';
import type { EventEngine } from '../domain/event/engine.ts';
import type { TagUsageRepo } from '../infra/db/tag-usage.ts';
import type { FlagRepo } from '../infra/db/flags.ts';
import type { EventTriggerRepo } from '../infra/db/event-triggers.ts';
import type { ItemRepo } from '../infra/db/items.ts';
import type { ItemIndex } from '../domain/item/item.ts';
import type { HistoryIndex } from '../domain/world/history.ts';
import type { InventoryRepo } from '../infra/db/inventory.ts';
import type { LocationRepo } from '../infra/db/locations.ts';
import type { RecipeRepo } from '../infra/db/recipes.ts';
import type { ChurchConflictRepo } from '../infra/db/church-conflict.ts';
import type { ExploreDailyRepo } from '../infra/db/explore-daily.ts';
import type { TradeRepo } from '../infra/db/trades.ts';
import type { FragmentPools } from '../cards/template.ts';
import type { AbilityRepo } from '../infra/db/abilities.ts';
import type { DailyCounterRepo } from '../infra/db/daily-counters.ts';
import type { PartyRepo } from '../infra/db/parties.ts';
import type { FingerprintProvider } from '../infra/fingerprint.ts';
import type { DailyTickRepo } from '../infra/db/daily-ticks.ts';
import type { CooldownRepo } from '../infra/db/cooldowns.ts';
import type { LostControlPool } from '../cards/lost-control.ts';
import type { LostControlRepo } from '../infra/db/lost-control-events.ts';
import type { Monitor } from '../infra/monitor.ts';
import type { FeedbackRepo } from '../infra/db/feedback.ts';
import type { UserActivityRepo } from '../infra/db/user-activity.ts';
import type { WorldRepo } from '../infra/db/world.ts';
import type { WorldEventRepo } from '../infra/db/world-events.ts';
import type { RitualRepo } from '../infra/db/rituals.ts';
import type { FactionRepo, WantedRepo } from '../infra/db/wanted.ts';
import type { CityRepo, RegionRepo, RouteRepo, TravelRepo } from '../infra/db/geo.ts';
import type { GeoIndex } from '../domain/geo/index.ts';
import type { RecipeClueRepo } from '../infra/db/initiation.ts';
import type { InitiationIndex } from '../domain/initiation/index.ts';
import type { ChurchIndex } from '../domain/church/index.ts';
import type { CreatureRepo } from '../infra/db/creatures.ts';
import type { BattleRepo } from '../infra/db/battles.ts';
import type { CreatureIndex } from '../domain/creature/content.ts';
import type { ZoneIndex } from '../domain/world/zone.ts';
import type { PowerIndex } from '../domain/world/power.ts';
import type { BoundaryIndex } from '../domain/world/boundary.ts';
import { createMenuOwner } from './commands/create-menu.ts';
import type { CommunityBundle } from '../data/community.ts';
import { dateKey } from '../infra/date.ts';
import { advanceWorld } from '../infra/world-tick.ts';
import { advanceCreatureEcology } from './commands/creature-hooks.ts';
import { settleBattleTimeout } from './commands/battle-hooks.ts';
import { settlePvpTimeout } from './commands/pvp-hooks.ts';
import type { RuntimeSwitches } from '../config/switches.ts';
import type { MenuService } from './menu.ts';
import { cutMenuOptions, type InteractiveMessage } from '../adapter/interactive.ts';
// M2.109：未决状态不许被绕过 —— 清单在 domain（Record<MenuType, boolean>，漏写一个 tsc 就红）
import { MENU_ALLOWED_COMMANDS, MENU_BLOCKS_OTHER_COMMANDS, VIEW_ONLY_COMMANDS, type MenuType } from '../domain/menu/types.ts';
// M2.120：日常遭遇（取代 .扮演）—— 菜单构造、计数键、触发上下文
import { encounterMenuOf } from '../domain/play/encounter.ts';
import { ENCOUNTER_COUNTER_KEY } from './commands/encounter-cmd.ts';
import type { TriggerContext } from '../domain/event/trigger.ts';
import type { EventCard } from '../cards/schema.ts';
import { NUMERIC } from '../config/numeric.ts';
import { createSeededRng, seedFrom } from '../domain/rng.ts';
import { pendingTravelEvent, settleArrival, travelProgressText } from './commands/arrival.ts';
import { travelEventMenu } from './commands/move.ts';
import { menuCharacterFor, worldSnapshotFor } from './menu.ts';
import { NO_CHARACTER_TEXT } from './commands/common.ts';
import { GENDER_TAGS } from './commands/status.ts';
import { PATHWAY_LABELS } from '../domain/character/rules.ts';
import type { RitualProfile } from '../domain/ritual/profile.ts';
import type { AuthorityDef } from '../domain/world/authority.ts';
// M2.99：神座与神的记忆（世界 tick 用前者抽行动，命令层用后者回答「祂记得你」）
import type { DivineThrone } from '../domain/world/divine-throne.ts';
import type { DivineMemory, DivinePlanStore, DivineStateStore } from '../domain/world/divine-mind.ts';
import type { DivineThroneStateRepo } from '../infra/db/divine-throne-state.ts';
import type { DivineSchemeRepo } from '../infra/db/divine-scheme.ts';
import type { WorldScarRepo } from '../infra/db/world-scar.ts';
import type { ChurchStateRepo } from '../infra/db/church-state.ts';
import type { DivineMeddlingRepo } from '../infra/db/divine-meddling.ts';
import type { ThroneContestRepo } from '../infra/db/throne-contest.ts';
import type { DivineRelation } from '../domain/world/divine-relation.ts';
import type { TarotCard } from '../domain/divination/tarot.ts';
import type { Deity } from '../domain/world/pantheon.ts';
import type { Organization } from '../domain/world/organization.ts';
import type { Figure } from '../domain/world/figure.ts';
import type { BestiaryEntry } from '../domain/world/bestiary.ts';
import type { DivineAuthority } from '../domain/world/divine-authority.ts';
import type { AdvancementRite } from '../domain/ritual/advancement-rite.ts';
import type { OriginalMaterial } from '../domain/world/original-material.ts';
import type { PathwayAbility } from '../domain/world/pathway-ability.ts';
import type { NpcTrack } from '../domain/world/npc-track.ts';
import { NpcRoster, type NpcCast } from '../domain/world/npc-cast.ts';
import type { FallenBeast } from '../domain/world/fallen-beast-schema.ts';
import type { PathwayDeed } from '../domain/world/pathway-deed.ts';
import type { NpcDeedRepo, NpcProgressRepo } from '../infra/db/npc-progress.ts';
import type { NpcLifeRepo } from '../infra/db/npc-life.ts';
import type { GodhoodRepo } from '../infra/db/godhood.ts';
import type { EventHandlingRepo } from '../infra/db/event-handling.ts';
import type { NpcRelationRepo, NpcSchemeRepo } from '../infra/db/npc-relations.ts';
import type { NpcDisposition } from '../domain/world/npc-disposition-schema.ts';
import type { EquipmentRepo } from '../infra/db/equipment.ts';
import type { Equipment } from '../domain/item/equipment.ts';
import type { BattleSkill } from '../domain/battle/skill-schema.ts';
import type { QuestRepo } from '../infra/db/quests.ts';
import type { Quest } from '../domain/world/quest-schema.ts';
import type { Fortune } from '../domain/world/fortune-schema.ts';
import { isInitiated, type CharacterState } from '../domain/character/types.ts';
import { buildNextMenu, pathwayKit } from '../domain/menu/index.ts';

/**
 * 消息头里「途径 · 序列」那一行（M2.45）。
 *
 * 未入途径的人**不能**写成「序列 null」—— 那会把「他还没走上任何一条路」
 * 说成「他是一个序列 9 的人」（M2.7.6 定下的口径，.状态 里也是这么写的）。
 */
export function pathwayLineOf(character: CharacterState): string {
  /*
   * 未入途径 → **这一行不写**（返回空串，调用方按空值省略）。
   *
   * 这里原来写的是「还没有途径」五个字。但正文里本来就有一句
   * 「还没有途径 —— 去探索翻线索」（M2.85 前说的是发 .引导），而那一句不能删：
   * OneBot 这类**没有消息头**的通道，正文是玩家唯一能看到它的地方。
   * 官方 MD 通道再在头上写一遍，真机上就是同一句话说两次 ——
   * 用户反馈的「霸屏」有一部分正来自这种重复（M2.45 第十版）。
   */
  if (!isInitiated(character)) return '';
  const label = PATHWAY_LABELS[character.pathway];
  return `${label} · 序列 ${character.sequence}`;
}

export interface Reply {
  scene: Scene;
  targetId: string;
  text: string;
  /**
   * M2.45：这条回执的**消息头**（头像那一段由通道侧补，见 adapter/types.ts 的 MessageHeader）。
   *
   * 为什么放在 Reply 上而不是让通道自己查：通道只认识 platform 侧的 id，
   * 「这个人是哪个角色、什么性别、走到哪一步」只有路由知道（它拿着 characters 仓储）。
   */
  header?: MessageHeader;
  /**
   * M2.7：这条消息附带的选项。
   * 支持按钮的通道（官方机器人）直接摆原生按钮；不支持的通道（OneBot）忽略它，
   * 发 text —— 而 text 里本来就有同一份选项的文本形态（M2.3 的数字回复体系）。
   */
  interactive?: InteractiveMessage;
}

/**
 * 指令返回值（对 S1 的一处扩展）：
 * S1 的 CreateResult 只有 message；而 S1 §7 要求「群聊只播报摘要，细节走私聊」，
 * 所以这里显式区分 privateText / groupText，由路由统一分流。
 */
export interface CommandResult {
  privateText: string;
  groupText?: string;
  /** 本结果是否需要私聊明细；服务端 RouterDeps.detailToPrivate 为 false 时一律不发 */
  detailToPrivate?: boolean;
  /**
   * 额外投递（W3 交易需要私聊通知「对方」）。
   * 只用于跨玩家通知，业务明细仍走 privateText。
   */
  extra?: Reply[];
  /**
   * M2.3：handler 自己已经开过菜单（.扮演 无参、.探索 无参、.今日…），
   * 路由层不要再追加「下一步」把它覆盖掉。
   */
  menuOpened?: boolean;
  /** 不要追加「下一步」（未识别指令、敏感词拦截这类没有下一步的情况） */
  suppressMenu?: boolean;
  /** M2.3：写进「下一步」菜单首屏的结果摘要，例如 ['DIG 52.0 → 53.2（+1.2）'] */
  menuNotes?: string[];
  /**
   * M2.7：带选项的消息（按钮交互）。
   * 与 privateText 是**同一件事的两种形态**：privateText 给不支持的通道，
   * interactive 给支持的通道。两者必须描述同一批选项（见 adapter/interactive.ts）。
   */
  interactive?: InteractiveMessage;
  /**
   * M2.86：**这条指令产生的「能去哪」清单**（`.看` / `.走` 会给）。
   *
   * 为什么要它：`buildLookNextMenu` 一开始拿 `world.locations`（全城地点表）拼按钮，
   * 于是正文说「能往迷雾街区 / 蒸汽车站」，按钮却给「走往灰雾之上 / 赤道雨林」——
   * **两批地方对不上**。按钮必须与正文说同一批，所以由产生正文的那一层交出来。
   */
  nextExits?: readonly { name: string; danger: number }[];
  /**
   * M2.86：**这条指令自己的「下一步」按钮**（通用形态）。
   *
   * 用户定的原则：「**其他模板也应该做按钮适应化**」—— 按钮要反映当前上下文，
   * 而不是一套固定四件套。但每个指令都去 `next-menu` 里加一个 `after === 'xx'` 分支，
   * 那个文件会变成一长串 if；而且它拿不到指令内部的上下文（比如「第几个委托可选」）。
   *
   * 所以做成**由产生正文的那一层交出来**：谁最清楚自己能做什么，就由谁给按钮。
   * `nextExits` 是本字段的特例（`.看` 用），保留是为了地点那套的排序/预览逻辑。
   */
  nextActions?: readonly { label: string; command: string; preview?: string }[];
  /**
   * M2.86：handler **已经自己把消息发出去了**（例如 `.角色` 直接调了通道的 `sendImage`），
   * 路由层**不要再发 privateText**。
   *
   * 为什么要一个显式开关，而不是「privateText 为空就不发」：
   * 空字符串在别处很可能是一次**忘了填正文的 bug** —— 用「空就不发」的规则会把那种 bug
   * 静默藏起来（玩家什么都不收到，日志里也没有异常）。显式开关则只对**故意的**那一条生效。
   *
   * 需求来自用户口径：
   *   「角色卡的情况下 不需要信息头和正文尾，只需要角色卡和几个常用指令的按钮」
   */
  selfSent?: boolean;
}

export interface CommandContext {
  msg: InternalMessage;
  args: string[];
  now: number;
  deps: RouterDeps;
  /**
   * M2.7：刚刚结算掉的「到达」信息。
   * 由 requireCharacter 写入（到达是惰性的：任何指令前都会先结算到期的行程），
   * 路由层把它附到「下一步」菜单上。做成可变字段而不是返回值，
   * 是为了不动 requireCharacter 的 128 处调用点。
   */
  arrivalNotes?: string[];
}

export type CommandHandler = (ctx: CommandContext) => Promise<CommandResult> | CommandResult;

export interface RouterDeps {
  db: Db;
  characters: CharacterRepo;
  idempotency: IdempotencyStore;
  rateLimiter: RateLimiter;
  audit: AuditLog;
  queue: KeyedQueue;
  sensitive: SensitiveFilter;
  /** W2：扮演标签用量、角色 flag、事件触发记录、事件卡引擎 */
  tagUsage: TagUsageRepo;
  flags: FlagRepo;
  eventTriggers: EventTriggerRepo;
  engine: EventEngine;
  /** W3：物品 / 背包 / 地点 / 配方 / 探索计数 / 交易 */
  items: ItemRepo;
  /**
   * M2.72：**历史索引**（回答「这里有过什么事」与「这底下埋着什么」）。
   *
   * 它原本只被后台的世界面板用；M2.72 起探索结算也要问它（挖掘封印物），
   * 所以它进了 RouterDeps —— 与 geo / zoneIndex / powerIndex 并列。
   */
  historyIndex: HistoryIndex;
  /**
   * M2.65：**物品的内容索引**（含 `variants`）。
   *
   * `items`（仓储）读的是库，而库里没有 variants 那一列 ——
   * 「这件东西能改成什么 / 能和什么装在一起」只能问这一份（见 domain/item/item.ts 的 ItemIndex）。
   */
  itemIndex: ItemIndex;
  inventory: InventoryRepo;
  locations: LocationRepo;
  recipes: RecipeRepo;
  exploreDaily: ExploreDailyRepo;
  trades: TradeRepo;
  /** 卡片文本片段池（模板渲染用） */
  fragments: FragmentPools;
  /** W4：能力表 / 每日计数 / 队伍 / 失控文本 / 设备指纹 */
  abilities: AbilityRepo;
  dailyCounters: DailyCounterRepo;
  parties: PartyRepo;
  /** 失控文本池（按途径分 + 余波，W5） */
  lostControlPool: LostControlPool;
  lostControlEvents: LostControlRepo;
  fingerprint: FingerprintProvider;
  dailyTicks: DailyTickRepo;
  cooldowns: CooldownRepo;
  /** 运行监控（W5）：指令耗时与错误率 */
  monitor?: Monitor;
  /** W6 封测：玩家反馈与行为埋点 */
  feedback: FeedbackRepo;
  userActivity: UserActivityRepo;
  /** 运营物料（FAQ / 群规则 / 封测公告） */
  community: CommunityBundle;
  /** W6 应急开关（封测期热修用，不改数值） */
  switches: RuntimeSwitches;
  /**
   * M2.172：**服务器开关**（游戏 / 主动推送 / 主动事件推送）。
   *
   * 它是管理员指令改的那份状态，也是 `handle()` 第一道闸门的依据 ——
   * 放在 deps 里而不是让 app 层拦，是因为「游戏关着」这个判断需要的
   * 群号（`msg.sceneId`）只有路由层拿得到。
   */
  serverSwitches?: ServerSwitchRepo;
  /** M2.172：管理员名单（.env 的 ADMIN_IDS 与上游插件上报的并集） */
  admins?: AdminRegistry;
  /** M2.2：世界时钟与地区天气（world_state / world_ticks / location_weather） */
  world: WorldRepo;
  /** M2.4：世界公共事件流（world_events），播报与数字回复都读它 */
  worldEvents: WorldEventRepo;
  /**
   * M2.76：**晋升仪式档位**（内容表 rituals.yaml 装载出来的）。
   *
   * 与下面的 `rituals`（仪式**仓储**，读写 rituals 表）是两件事，名字像、层次不同：
   * 这一份是「序列 6—4 该走几关、每关多难」的**内容**，那一份是「谁正在办仪式」的**状态**。
   */
  ritualProfiles: readonly RitualProfile[];
  /**
   * M2.76：**权柄**（世界级能力）。世界 tick 用它抽「这一次有没有存在出手」。
   *
   * 空数组 = 世界里不会有权柄事件（测试与跑批可以显式关掉）。
   */
  authorities: readonly AuthorityDef[];
  /**
   * M2.99：**神座**（22 条途径的序列 0 —— 谁在位、谁空着、谁正在被争夺）。
   *
   * 世界 tick 会拿它问「这一次有没有哪位神要动」（`divineStance`），
   * 命令层拿它回答「这条途径的序列 0 现在是谁」（`.图鉴 途径`）。
   * 空数组 = 众神沉寂（测试与跑批可以显式关掉）。
   */
  divineThrones: readonly DivineThrone[];
  /**
   * M2.169：**神座的运行时状态**（谁现在坐在那儿 —— 阴谋会改变它）。
   *
   * 内容是底、状态覆盖，合并在 `mergeThroneState` 里（唯一一处实现）。
   * 不传 = 世界按内容层那 22 条跑（测试与跑批的默认）。
   */
  divineThroneState?: DivineThroneStateRepo;
  /** M2.169：**神与神的关系网**（阴谋只能沿着这些边发生，不能随机挑目标） */
  divineRelations?: readonly DivineRelation[];
  /** M2.169：**神明的阴谋**（跨月推进；结局会改神座状态） */
  divineSchemes?: DivineSchemeRepo;
  /**
   * M2.169：**世界伤痕**（神陨落 / 神战在地上留下的东西）。
   *
   * 探索读它：更危险、可能变成堕落源、能捡到原本拿不到的材料。
   * 不传 = 这个世界没有伤痕（测试与跑批可以显式关掉）。
   */
  worldScars?: WorldScarRepo;
  /**
   * M2.169：**教会的命运**（神倒下之后，祂的教会归谁、还剩多少气力）。
   *
   * 机制后果之一：失了庇护的教会**不再出清剿队** —— 于是那座城里的怪物没人清理。
   */
  churchStates?: ChurchStateRepo;
  /** M2.169：**玩家插手神明阴谋的账**（`.神战` 写它；成神仪式读它） */
  divineMeddling?: DivineMeddlingRepo;
  /** M2.170：**神位争夺**（空出来的位置怎么争 —— 登位 7 天，期间可被打断） */
  throneContests?: ThroneContestRepo;
  /**
   * M2.99：**神的记忆**（每条神一份：祂记得谁做过什么）。
   *
   * 它是**运行期状态**而不是内容 —— 由 main 建一个实例注入，测试不传就是空的。
   */
  divineMemory?: DivineMemory;
  /**
   * M2.99：**神明行动的运行期状态**（每条途径一份：上次出手在什么时候、用过哪些手段）。
   *
   * ⚠️ 它是**进程内状态**，重启会丢 —— 第一版这样是刻意的：
   * 落库要新加一张表，而「神上一次出手是什么时候」丢一次的代价只是「祂可能早一点再动」。
   * 真要持久化时，这里换成仓储实现即可（调用方只认这两个字段）。
   */
  divineState?: DivineStateStore;
  /** 神的**计划**（跨 tick 的步骤链）；不传就由世界 tick 自己维持一份进程内的 */
  divinePlans?: DivinePlanStore;
  /**
   * M2.85 内容填充 P1：**塔罗牌 22 张大阿卡那**（原作数据直出）。
   * 读取点：`.占卜` 的回执 —— 抽一张牌，显示牌名 / 编号 / 对应途径 / 象征。
   */
  tarot: readonly TarotCard[];
  /** M2.85 内容填充 P1：**神明**（原作数据直出）。读取点：`.图鉴 神明` */
  pantheon: readonly Deity[];
  /** M2.85 内容填充 P1：**组织与势力**（原作数据直出）。读取点：`.图鉴 组织` */
  organizations: readonly Organization[];
  /** M2.85 内容填充 P1：**人物**（原作数据直出）。读取点：`.图鉴 人物` */
  figures: readonly Figure[];
  /** M2.85 内容填充 P1：**生物名录**（材料来源 + 生态）。读取点：`.图鉴 生物` */
  bestiary: readonly BestiaryEntry[];
  /** M2.85 内容填充 P1：**权柄与象征**（原作设定层，与 authorities 玩法表不同）。读取点：`.图鉴 权柄` */
  divineAuthorities: readonly DivineAuthority[];
  /** M2.85 内容填充 P6：**晋升仪式要求**（原作数据直出）。读取点：`.仪式 准备` */
  advancementRites: readonly AdvancementRite[];
  /** M2.85 内容填充 P4：**原作材料全表**（设定层）。读取点：`.图鉴 材料` */
  originalMaterials: readonly OriginalMaterial[];
  /** M2.85 内容填充 P5：**原作能力清单**（设定层）。读取点：`.图鉴 能力` */
  pathwayAbilities: readonly PathwayAbility[];
  /** M2.85 世界演化：**NPC 晋升轨道**。读取点：`.图鉴 途径 <名>` */
  npcTracks: readonly NpcTrack[];
  /** M2.164：**世界居民名册**（身份 / 常驻 / 性情 / 用途标签）—— 见 domain/world/npc-cast.ts */
  npcCast: readonly NpcCast[];
  /**
   * M2.167：**堕落生物**（形态 → 强度 / 掉落 / 行为 / 感知）。
   *
   * 世界 tick 用它把「撑不住的堕落者」变成一只真的生物（creatures 那套现成的世界实体）。
   * 空数组 = 这个世界不会有人堕落成怪物（测试与跑批可以显式关掉）。
   */
  fallenBeasts?: readonly FallenBeast[];
  /**
   * M2.164：**名册的统一查询入口**（轨道 + 名册两张表合成一个）。
   *
   * ⚠️ 「npcId → 中文名」一律走它（`npcRoster.nameOf`）。在这之前每个命令各查一次
   * `npcTracks.find(...)`，那种写法在名册铺开之后会**安静地退化成显示 id**
   * （查不到就 `?? npcId`）—— 玩家会在回执里读到一串英文，而没有东西会报错。
   */
  npcRoster: NpcRoster;
  /** M2.85 世界演化：**途径行为**（NPC 会做符合自己途径的事） */
  pathwayDeeds: readonly PathwayDeed[];
  /** M2.85 世界演化：**NPC 进度**（会随时间变的世界状态，与静态的原作记载分开存） */
  npcProgress: NpcProgressRepo;
  /**
   * M2.164：**NPC 的生死与堕落**（用户拍板「NPC 死亡是真的死亡，永久，不刷新」）。
   *
   * ⚠️ 与 npcProgress 分开：那一个答「他走到哪一档」，这一个答「他还在不在」。
   * 读取点：场景（街上站着谁）、阴谋与晋升（死者不参与）、世界 tick（复活）、图鉴（死者名单）。
   */
  npcLife: NpcLifeRepo;
  /** M2.85 世界演化：**NPC 大事记**（晋升 / 登神 / 猎杀 / 化解灾厄） */
  npcDeeds: NpcDeedRepo;
  /** M2.85 世界演化：**神位归属**（玩家击败序列 0 之后，这个位置就归他） */
  godhood: GodhoodRepo;
  /** M2.85 世界演化：**NPC 处理世界事件**（一件事只被处理一次） */
  eventHandling: EventHandlingRepo;
  /** M2.85 RPG 化：**NPC 对玩家的态度**（-100 死敌 … +100 挚友） */
  npcRelations: NpcRelationRepo;
  /** M2.85 RPG 化：**NPC 的阴谋**（布局 → 端倪 → 发动） */
  npcSchemes: NpcSchemeRepo;
  /** M2.85 RPG 化：**NPC 的立场与性情**（npc-dispositions.yaml） */
  npcDispositions: readonly NpcDisposition[];
  /** M2.85 RPG 化 B：**装备**（他穿在身上的） */
  equipment: EquipmentRepo;
  /** M2.85 RPG 化 B：**装备表**（内容层） */
  equipmentTable: readonly Equipment[];
  /** M2.85 RPG 化 C：**战斗技能表**（内容层，技能池合并读它） */
  battleSkillTable: readonly BattleSkill[];
  /** M2.85 RPG 化 D：**委托**（接下的存在库里，模板在内容层） */
  quests: QuestRepo;
  questTable: readonly Quest[];
  /** M2.85：**奇遇**（.探索 有小概率碰上） */
  fortuneTable: readonly Fortune[];
  /*
   * M2.87 交易体系：**商店表与物价表进 deps**。
   *
   * 它们是**内容**（YAML），所以按仓库惯例注入 `deps` 而不是让命令自己读盘 ——
   * 与 `equipmentTable` / `questTable` / `fortuneTable` 同一套做法。
   */
  shops: readonly Shop[];
  /** 物价表可能读不到（文件坏了）—— 那时买东西一律拒绝，而不是按 0 便士卖 */
  prices: PriceTable | null;
  /**
   * M2.86：这个通道**支不支持字体颜色**（markdown 通道支持）。
   *
   * 用户拍板要「重要信息高亮显示」，而 docs/QQ-markdown-能力实测.md 里有一条**旧**记录
   * 说手机端不支持 —— 用户在手机端亲眼看到了颜色，所以默认开、但留这个开关一键回退。
   * 颜色只做增强：关掉之后每条信息靠加粗与符号照常分得开。
   */
  supportsColor?: boolean;
  /**
   * M2.86：正文样式档（`plain` / `bold-italic` / `keep`）。
   *
   * 官方 markdown 文档列了 `**加粗**`，但用户实机确认**手机端不渲染**（星号原样显示）。
   * 所以给三档由真机决定：`QQ_BOT_MD_STYLE=bold-italic` 可切成官方清单里的 `***加粗斜体***` 再试。
   */
  mdStyle?: 'plain' | 'bold-italic' | 'keep';
  /** M2.5：晋升仪式与干扰（rituals / ritual_interferences） */
  rituals: RitualRepo;
  /** M2.6：势力范围（factions）与通缉令 / 赏金（wanted_states / bounty_claims） */
  factions: FactionRepo;
  wanted: WantedRepo;
  /**
   * M2.7：世界地理。
   * geo 是**只读索引**（纯数据），三张表各有一个仓储是为了播种与报告取证。
   * 判定层一律只读 geo —— 它不认识数据库，所以出生派生与移动判定能在测试侧
   * 不启服务地跑（虚拟玩家要预判自己落在哪座城市）。
   */
  geo: GeoIndex;
  regions: RegionRepo;
  cities: CityRepo;
  routes: RouteRepo;
  travels: TravelRepo;
  /**
   * M2.7.6 / M2.85：入途径的线索路。
   *   initiation —— 只读内容索引（哪座城市有哪家势力，线索的途径落点权重）
   *   clues —— 运行时状态（谁翻到了什么；M2.85 起引导邀约表已删）
   */
  initiation: InitiationIndex;
  /**
   * M2.15 内容 + M2.16 命令层：正神教会的只读索引。
   * 「这家教会在哪些城市有堂口、绑哪条途径、第几档叫什么」全部从它读 ——
   * 命令层不认识 churches.yaml，只认识这个索引（与 geo / initiation 同一手法）。
   */
  churches: ChurchIndex;
  /** M2.18：势力争夺的增量表（归属 = seed 底图 + 这里的 Σ delta） */
  churchConflict: ChurchConflictRepo;
  clues: RecipeClueRepo;
  /** M2.2：世界种子（天气与雾日序列的确定性来源）；M2.4 起事件也由它派生 —— 全服一个，不随分片派生 */
  worldSeed?: string;
  /** M2.2：显著天气的全群播报通道（main 注入；测试里可换成收集器） */
  /** 世界播报：正文 + 可选的底部按钮（M2.86 主动推送带原始按钮） */
  /** 世界播报：正文 + 可选的底部按钮（M2.86：主动推送附原始按钮） */
  broadcast?: (text: string, buttons?: BroadcastButton[]) => void;
  /** M2.3：菜单状态（pending_menus）与数字回复的分发 */
  /**
   * M2.8：非凡生物 —— 实例仓储（世界状态）与物种模板索引（内容）。
   *
   * 两者分开是有意的：实例是**世界状态**（那只饿了两天的低语者现在在哪），
   * 模板是**内容**（低语者是什么）。判定层只读模板，写状态只走仓储。
   */
  creatures: CreatureRepo;
  creatureIndex: CreatureIndex;
  /**
   * M2.58 阶段二：生态域索引（地点 → 域的生态参数）。
   *
   * 与 creatureIndex 并列但回答不同的问题：一个是「这是什么生物」，
   * 一个是「这块地方的世界是什么脾气」。生态 tick 两个都要。
   */
  zoneIndex: ZoneIndex;
  /**
   * M2.59：文明势力索引（属地判定）。
   *
   * 世界出了事之后，命令层用它回答「谁的地盘上出的事、谁该动」。
   * 与 zoneIndex 并列：一个回答「这块地方的世界是什么脾气」，
   * 一个回答「这块地方归谁管」。
   */
  powerIndex: PowerIndex;
  /**
   * M2.62：边界索引（世界从这里与外面接触）。
   *
   * 世界 tick 用它判断哪条边界攒够了张力、该来一次外来输入。
   */
  boundaryIndex: BoundaryIndex;
  /**
   * M2.9：战斗状态机（battles / battle_rounds）。
   *
   * 与 creatures 是**两张表两条线**，和「世界状态 vs 内容」的分法一致：
   *   creatures —— 那只生物在世界里的样子（位置 / HP / 序列）
   *   battles   —— 你与它之间那一场还没打完的事（回合 / 双方状态 / 谁先动）
   * 战斗结束时由 battle-hooks 把结果写回 creatures，**这是战斗改世界的唯一一条路**。
   */
  battles: BattleRepo;
  pendingMenus: MenuService;
  clock: () => number;
  logger?: Logger;
  /** 群聊场景默认是否附带私聊明细 */
  detailToPrivate?: boolean;
  /**
   * M2.47：角色卡出图服务（`.角色`）。
   *
   * **可选**是有意的：渲染要起 PowerShell 进程、写文件，测试不该被它拖慢。
   * 没配时 `.角色` 不发图，只回一句「这条通道没开出图」+ 文字状态卡 ——
   * 与按钮/图片降级同一条纪律：缺能力只是少一种形态，不是错误。
   */
  card?: CardService;
  /**
   * M2.47：通道本身（发图要问它支不支持）。
   *
   * 为什么放进 deps 而不是让路由自己持有：路由已经在 main 里被创建成单例，
   * 而 adapter 是同一层的东西 —— main 里 `deps.adapter` 本来就在手边。
   * 可选是为了不动既有测试（它们不构造 adapter，也不发图）。
   */
  adapter?: Adapter;
}

/** 支持 . 。 ． 三种前缀，QQ 手机端中文输入法容易打出后两种 */
export function parseCommand(text: string): { name: string; args: string[] } | null {
  const trimmed = text.trim();
  if (!/^[.。．]/.test(trimmed)) return null;
  const body = trimmed.slice(1).trim();
  if (!body) return null;
  const parts = body.split(/\s+/);
  const name = parts[0] ?? '';
  if (!name) return null;
  return { name, args: parts.slice(1) };
}

/**
 * 数字回复的内部指令名。
 * 玩家打不出这个字符串（以 \u0000 开头），所以它永远不会和真实指令撞名。
 */
export const MENU_REPLY = '\u0000menu';

/**
 * 未决状态下别的指令被拦下时说的话（M2.109）。
 *
 * 三条纪律：
 *   ① **说清楚是什么事占着**（「你正遭遇着一只东西」比「操作无效」有用一百倍）
 *   ② **给出口** —— 不能把玩家困死在那儿（回数字处理它，或者发 `.放弃` 之类）
 *   ③ **告诉他能做什么** —— 查看类指令是放行的，否则他连自己还剩多少血都看不到
 */
function pendingBlockText(menuType: MenuType): string {
  const what: Record<string, string> = {
    encounter: '你正遭遇着一只东西 —— 它还站在那里',
    battle: '战斗还没打完（回合制，你不出手它也不会走）',
    challenge: '有人正等着你应战',
    travel: '你还在路上，这件事不处理完就到不了',
    ritual: '仪式做到一半，手不能松',
    create: '角色还没建完（先回答眼前这一问）',
    freeform: '你刚说「自己写一个行为」—— 那一句还没写',
  };
  const line = what[menuType] ?? '你手头有一件事还没了';
  return [
    line + '。',
    '> 先在眼前这件事里选一个（回复数字），或者发 `.放弃` 把它放掉。',
    '> 想看别的：`.状态` `.帮助` `.菜单` `.今日` `.世界` `.图鉴` —— 这些照常。',
  ].join('\n');
}

/**
 * 数字回复（M2.2 引入，M2.3 扩大）：裸回一个数字 = 对上一条菜单的选择。
 *
 * **不再限定私聊**（原判据是 `if (msg.scene !== 'private') return null;`）。
 *
 * 那条限制建立在一个已经消失的前提上：M2.3 §3.6 说「群里'1''+1''11'是聊天内容，
 * 把聊天当指令是骚扰」。它当时成立，是因为接入层把群里**每一条**消息都送进路由，
 * 路由只能靠「干脆不认数字」来避免误触。
 *
 * 现在群聊里一个裸数字要过两道闸才可能被当成指令：
 *   ① 调用方先确认**这个人此刻确实有待命菜单** —— 没有就根本不进这里（见 handle 里的闸门）；
 *   ② 菜单按 `character_id` 存、消息自带唯一成员标识，所以「是谁回的数字」没有歧义。
 *
 * 合起来就是：**只有正在跟机器人玩的那个人，回出的那个数字才会被接住**。
 * 群里别人随口打的「1」既不满足 ①，也就不会有任何响应 —— 骚扰问题在闸门处解决，
 * 不需要牺牲群聊的可玩性。
 */
export function parseNumericReply(msg: InternalMessage): { name: string; args: string[] } | null {
  const text = msg.rawText.trim();
  if (!/^\d{1,2}$/.test(text)) return null;
  return { name: MENU_REPLY, args: [text] };
}

/** 菜单过期清扫的节流间隔（表里每角色最多一行，一分钟一次足够） */
const MENU_SWEEP_INTERVAL_MS = 60_000;

/**
 * 「下一步」里会出现地点选项的指令 —— 只有这些才值得查一次 locations 全表。
 * 其余指令走的是「继续扮演 / 恢复 / 看状态」那一组，不需要地点。
 */
/**
 * 「下一步」里会出现地点选项的指令 —— 只有这些才值得查一次 locations 全表。
 * 其余指令走的是「继续扮演 / 恢复 / 看状态」那一组，不需要地点。
 *
 * ⚠️ M2.86：**`.看` / `.走` 必须在这里**（用户：「`.看` 显示了能走的地方，
 * 按钮就应该变成走往 XXX」）。漏了它们的后果很隐蔽：`buildLookNextMenu` 拿不到
 * `world.locations`，于是返回 null、静默退回通用四件套 —— **代码看着是对的，就是没生效**。
 */
const MENU_WITH_LOCATIONS = new Set(['探索', '晋升', '确认', '取消', '交易', '今日', '移动', '看', '走']);

/**
 * M2.7：**在路上**时仍然放行的指令。
 *
 * 为什么要有这张白名单：移动的语义是「这段时间你不在场」，
 * 如果玩家在路上还能 .扮演 / .探索 / .晋升，那「消耗游戏内小时」就只是一行文案。
 *
 * 放行的是**查看类**与**处理路途事件本身**：
 *   - 状态 / 今日 / 背包 / 帮助 / 世界：看一眼不改变世界，没有理由拦；
 *   - 移动：正是处理路途事件（.移动 抉择 …）与看进度的那条指令；
 *   - 反馈：封测期玩家要能吐槽，这条永远不该被挡。
 */
const TRAVEL_ALLOWED = new Set(['状态', '今日', '背包', '帮助', '世界', '移动', '反馈', '角色']);

export class CommandRouter {
  #deps: RouterDeps;
  #handlers = new Map<string, CommandHandler>();
  #logger: Logger;
  #lastMenuSweep = 0;
  /** 上一条消息的发送者：超时战斗结算需要「是谁在动」（见 #settleBattle） */
  #lastUserId: string | null = null;

  constructor(deps: RouterDeps) {
    /*
     * M2.172：**给两个新依赖兜底**。
     *
     * 全仓有上百处构造 RouterDeps（测试夹具、模拟器、建号脚本），它们一个都不关心
     * 「谁是管理员」。写成必需字段就得挨个改一遍 —— 而那是纯噪音。
     * 所以构造时补一份内存档：开关**全开**（新增开关不许改变既有行为）、
     * 管理员名单**为空**（谁都不是管理员）。
     */
    this.#deps = {
      ...deps,
      serverSwitches: deps.serverSwitches ?? new ServerSwitchRepo(),
      admins: deps.admins ?? new AdminRegistry(),
    };
    this.#switches = this.#deps.serverSwitches!;
    this.#admins = this.#deps.admins!;
    this.#logger = deps.logger ?? consoleLogger;
  }

  /**
   * 管理员指令名（M2.171）。
   *
   * ⚠️ **从注册处派生，不另抄一份名单**（AGENTS §3.1）：手抄的那份最贵的失败方式
   * 是不报错 —— 新加一条管理员指令而忘了加进名单，它就会在「游戏关闭」时被一起挡掉，
   * 而测试和类型都看不出问题。
   */
  #adminCommands = new Set<string>();
  /** M2.172：构造时兜底过的两个依赖（见构造函数） */
  #switches: ServerSwitchRepo;
  #admins: AdminRegistry;

  register(name: string, handler: CommandHandler, options: { admin?: boolean } = {}): this {
    this.#handlers.set(name, handler);
    if (options.admin === true) this.#adminCommands.add(name);
    return this;
  }

  /** 管理员指令清单（供测试与「游戏关闭时放行」判断） */
  get adminCommands(): string[] {
    return [...this.#adminCommands];
  }

  get commands(): string[] {
    return [...this.#handlers.keys()];
  }

  /** 只读依赖视图：main 的定时任务（交易超时清扫）需要 */
  get deps(): RouterDeps {
    return this.#deps;
  }

  /**
   * 主管线：解析 → 幂等 → 入站敏感词 → 查指令 → 频控 → 串行执行 → 审计 → 分流回复
   * 返回需要发送的回复列表（空数组 = 静默丢弃，例如重复推送）。
   *
   * M2.3 起「解析」有三种来源，优先级从高到低：
   *   1. 显式指令（以 . 开头）
   *   2. 裸数字 → 菜单选项（MENU_REPLY）
   *   3. 自由输入待命中的纯文本 → 等价于补一个点号（任务书 §5.3）
   */
  async handle(msg: InternalMessage): Promise<Reply[]> {
    const now = this.#deps.clock();
    this.#lastUserId = msg.userId;

    /*
     * M2.86：**群的登记必须在这里做，在任何 return 之前。**
     *
     * 用户实测：「主动推送不是所有群都会推送，他只推送了一个群，是否是被动推送的问题」。
     *
     * 原来这段在下面 —— 在 `if (!parsed) return []` **之后**。后果是：
     * 群里有人**闲聊**（不是指令、不是数字、不在待命状态）时，那条消息在解析阶段就被
     * 丢掉了，`touchGroup` 根本执行不到。于是群列表里只留得下「有人跟机器人玩过」的群，
     * 世界播报自然只往那一两个群发。
     *
     * 而「见过这个群」这件事，判据本来就该是**收到过它的消息**，
     * 与那条消息是不是指令无关。
     *
     * ⚠️ 两条顺序要求保留（原来注释里写着，照旧）：
     *   ① 登记要在**世界推进之前** —— 否则本次推进产生的播报会因为 groups 为空而发不出去；
     *   ② `ensure` 要在 `touchGroup` 之前 —— world_state 是单行表，行不存在时 UPDATE 影响 0 行。
     */
    if (msg.scene === 'group') {
      this.#deps.world.ensure(now, this.#deps.worldSeed ?? 'world');
      /*
       * M2.87：**新群登记留一行日志。**
       *
       * 用户三次报「主动推送只到了部分群」。前两次都只能靠推断回答，因为日志里
       * 只有「播报发给了几个群」这个数字，而没有「是哪几个」也没有「它们什么时候进来的」。
       *
       * 有了这一行 + 「世界播报」的 ids 字段，问题就变成可对照的：
       *   群里看到推送的时间 vs 这一行的时间 → 谁先谁后，一眼分得开。
       */
      if (this.#deps.world.touchGroup(msg.sceneId, now)) {
        this.#logger.info('新群登记', {
          groupId: msg.sceneId.slice(0, 8),
          total: this.#deps.world.groups().length,
        });
      }
    }

    const explicit = parseCommand(msg.rawText);

    /*
     * ═══ M2.172：**游戏总开关与封禁** ═══
     *
     * 两条闸门，都只在**解析出指令之后**才查库 —— 群里大量的闲聊不该为它查一次角色。
     *
     *   1. 游戏关着（全局或本群）⇒ 除管理员指令外一律**静默**。
     *      静默而不是回一句「游戏已关闭」，是因为那句提示会跟世界播报一样刷屏，
     *      而关服期间群里本来就该安静。
     *   2. 被封禁的人 ⇒ 同样静默。判据是角色状态（`characters.status = 'banned'`），
     *      与后台 GM 那个「封禁」是同一个字段。
     *
     * ⚠️ 管理员指令**永远放行**，包括在游戏关闭时 —— 否则关掉游戏之后就再也没法开回来，
     * 那是个不能自愈的状态。
     */
    if (explicit !== null && !this.#adminCommands.has(explicit.name)) {
      const sceneKey = msg.scene === 'group' || msg.scene === 'channel' ? msg.sceneId : null;
      if (!this.#switches.isOn('game', sceneKey)) return [];
      if (!this.#admins.isAdmin(msg.userId)) {
        const banned = this.#deps.characters.findByUserId(msg.userId);
        if (banned !== null && banned.status === 'banned') return [];
      }
    }
    /*
     * ═══ M2.109：**未决状态不许被绕过** ═══
     *
     * 用户的原话：「玩家数据状态的处理**绑定太弱**了，包括遭遇了非凡事件的触发 ——
     * 倘若不小心点了别的按钮，也**直接无视接下去了**。状态绑定极差」。
     *
     * 事实确实如此：在它之前，路由只对**裸数字**查待答菜单，
     * 而**显式指令一律直接执行** —— 遭遇了一只生物、打到一半的战斗、仪式进行中，
     * 随手发一条别的指令就绕过去了，那件事从此不再被提起。
     *
     * 判据在 `MENU_BLOCKS_OTHER_COMMANDS`（`Record<MenuType, boolean>` —— 加类型不表态就 tsc 红）。
     * 放行的只有**查看类**指令（`VIEW_ONLY_COMMANDS`，有意保持最小）。
     */
    if (explicit !== null && !VIEW_ONLY_COMMANDS.includes(explicit.name)) {
      const blockedBy = this.#blockingMenuOf(msg, now);
      /*
       * 放行两类：**查看类**（不改变世界）与**这件事自己的指令**（遭遇里的 `.遭遇`、
       * 战斗里的 `.战斗`）—— 第一版只放了前者，把处理当前事务的指令也拦了，20 条用例当场红。
       */
      const ownCommands = blockedBy === null ? [] : MENU_ALLOWED_COMMANDS[blockedBy];
      if (blockedBy !== null && !ownCommands.includes(explicit.name)) {
        this.#logger.info('未决状态拦下指令', { command: explicit.name, menuType: blockedBy });
        return [{
          scene: msg.scene,
          targetId: msg.scene === 'private' ? msg.userId : msg.sceneId,
          text: pendingBlockText(blockedBy),
        }];
      }
    }
    /*
     * 数字回复的闸门。规则**按会话性质**分两种，不是按「群聊 / 私聊」分两种：
     *
     *   - 私聊：机器人是这个会话里唯一的对话对象，玩家打出的一定是在回它。
     *     所以无条件接 —— 菜单过期了也要接，否则玩家收到的是**彻底静默**，
     *     他不知道是过期了还是机器人坏了。（.今日 是重新开始的入口，
     *     提示他发这个正是这条路径存在的意义。）
     *
     *   - 群聊：对话对象是**其他人**，裸数字多半是聊天（「1」「+1」「11」）。
     *     所以要求这个人**此刻确实有待命菜单**才认 ——
     *     没在跟机器人玩的人打出的数字一声不响，不产生任何骚扰。
     *
     * 顺序是有意的：先用廉价正则挡掉绝大多数群消息，
     * 只有「长得像数字」才去查一次库（群消息量大，别为每句话查一次）。
     */
    const numeric =
      explicit || !/^\d{1,2}$/.test(msg.rawText.trim())
        ? null
        : msg.scene === 'private' || this.#hasPendingMenu(msg, now)
          ? parseNumericReply(msg)
          : null;
    const freeform = !explicit && !numeric ? this.#parseFreeform(msg, now) : null;
    const parsed = explicit ?? numeric ?? freeform;
    if (!parsed) return [];

    /*
     * ═══ M2.120：**日常遭遇**（取代 `.扮演`）═══
     *
     * 用户：「扮演本来就是**日常行为**，所以扮演指令没什么用」。
     *
     * 于是它不再是玩家要主动发的命令，而是**每天自己找上门来的事** ——
     * 在玩家下一次发任何指令时兑现：抽一张「只有他这条途径的人撞得到」的卡，
     * 把选择摆出来，消化度按他选的那一支涨。
     *
     * 三条排除：
     *   · `遇见` 自己（正在结算）
     *   · 菜单回执（玩家正在回答，别插队）
     *   · 没入途径的人（途径卡对他来说不存在）
     */
    /*
     * ⚠️ **查看类命令不触发**（`.状态` `.背包` `.帮助` `.菜单` `.今日` `.世界` `.图鉴`）：
     * 它们不改变世界，玩家发它们就是想看一眼 —— 在那时候塞一件事过去，
     * 连「看一眼」都做不到。遭遇要落在**做正事**的时候。
     */
    if (parsed.name !== '遇见' && parsed.name !== MENU_REPLY && !VIEW_ONLY_COMMANDS.includes(parsed.name)) {
      const daily = this.#dailyEncounter(msg, now);
      if (daily !== null) return [daily];
    }

    const startedAt = Date.now();

    // 幂等：数字回复与完整指令共用同一张 idempotency_keys，
    // 所以「同一条 message_id 回两次」两次都只处理一次（任务书 §5.2）。
    if (!this.#deps.idempotency.tryMark(msg.messageId, msg.userId, now)) {
      this.#logger.warn('重复推送已忽略', { messageId: msg.messageId, userId: msg.userId });
      return [];
    }

    const blocked = this.#deps.sensitive.hit(msg.rawText);
    if (blocked) {
      this.#deps.audit.write({
        userId: msg.userId,
        command: '拦截',
        input: msg.rawText,
        output: `敏感词：${blocked}`,
        createdAt: now,
      });
      return this.#reply(msg, {
        privateText: '消息包含违规内容，已拦截。',
        groupText: `【${msg.nickname || msg.userId}】的消息含违规内容，已拦截。`,
      });
    }

    // M2.2：世界先动，玩家再动。
    // 惰性推进（幂等 + 进程内小时缓存）：真实 HTTP 实例测试里的时钟是虚拟的，
    // 不能指望墙上时间的定时器，所以每条指令前顺手把世界推到"现在"。
    // （群的登记已提到方法开头 —— 见那里的说明）
    this.#advanceWorld(now);
    // M2.8：生物的节拍跟着玩家动作走（与 #advanceWorld 同一理由，也是同一种兜底）
    this.#advanceCreatureEcology(now);
    /*
     * M2.9：**超时的战斗先补完，玩家再动**。
     *
     * 放在这里的理由与 #advanceWorld / #advanceCreatureEcology 一样：
     * 定时器在实例测试与压测里根本不跑，而「5 分钟不回自动防御」这件事
     * 必须与玩家的动作同一个时钟 —— 否则「关掉 QQ 五分钟再回来」这条链路
     * 就只在真实服务器上成立，跑批里永远验不到。
     *
     * 顺序也有意：生物生态先动（世界不等你），然后才是你那场没打完的架。
     */
    this.#settleBattle(now);
    this.#sweepMenus(now);

    if (numeric) return this.#handleMenuReply(msg, now, startedAt, numeric.args[0]!);

    /*
     * M2.87：**权柄的禁令** —— 神出手时，某条命令在这一带不灵。
     *
     * ## 为什么这是「直白感受到权柄」最有效的一处
     *
     * 用户的要求是「让玩家都能直白的感受到神明权柄的强大」。
     * 播报是**别人告诉你**发生了什么（可以划过去），而这是**你自己动手时被按住**：
     * 玩家发 `.占卜`，系统回「这里不行」，而且明说**不行的原因是有人在这里** ——
     * 那一下的体感，比读十条世界异象都强。
     *
     * ## ⚠️ 三条不许被禁的命令
     *
     * 玩家必须永远能**搞清楚发生了什么**：
     *   · `.世界` —— 否则他看不见是哪位神明在出手；
     *   · `.状态` —— 否则他不知道自己被改了什么；
     *   · `.帮助` —— 否则他连能做什么都不知道了。
     *
     * 把这三个也禁掉，权柄就从「强大」变成了「游戏坏了」。
     * 这条白名单是**硬编码**的，不放进 YAML —— 它是可用性底线，不是内容。
     */
    const ALWAYS_ALLOWED = ['世界', '状态', '帮助', '菜单'];
    if (!ALWAYS_ALLOWED.includes(parsed.name)) {
      const me = this.#deps.characters.findByUserId(msg.userId);
      const here = me?.currentLocationId ?? me?.currentCityId ?? null;
      const ban = commandBanAt(this.#deps.world, here, parsed.name, now);
      if (ban !== null) {
        this.#logger.info('权柄禁令拦下', { userId: msg.userId, command: parsed.name, location: here });
        return this.#reply(msg, {
          privateText:
            '你试着' + parsed.name + '，但这一带有什么东西压着 —— 那件事做不成。\n' +
            '> 这不是你的问题。是**这里**的问题 —— 发 `.世界` 看看现在是谁在出手。',
        });
      }
    }

    return this.#execute(msg, parsed.name, parsed.args, now, startedAt);
  }

  /**
   * 自由输入待命（任务书 §5.3）：玩家回了 0 之后，下一条**纯文本**按完整指令解析。
   *
   * 只在**确实有待命**时生效（`awaitingFreeform`），所以平时聊天不会被当成指令。
   * 不限定私聊：这道安全阀与场景无关 —— 没进过待命状态的人，说什么都不会被当指令。
   */
  #parseFreeform(msg: InternalMessage, now: number): { name: string; args: string[] } | null {
    const text = msg.rawText.trim();
    if (!text || /^[.。．]/.test(text)) return null;
    const character = this.#deps.characters.findByUserId(msg.userId);
    if (!character) return null;
    if (!this.#deps.pendingMenus.awaitingFreeform(character.id, now)) return null;
    return parseCommand(`.${text}`);
  }

  /**
   * 这个人此刻有没有待命菜单 —— 数字回复的闸门（见 handle）。
   *
   * 用 `current()` 而**不是** `pick()`：判断阶段绝不能动状态。
   * 拿 pick 去试一次的话，「查一下有没有」本身就把菜单消费掉了，
   * 那会是一条极难查的 bug（玩家回数字时菜单正好被上一次判断吃掉）。
   *
   * owner 的算法与 #handleMenuReply 保持一致：有角色按 character.id，
   * 没有角色按 `create:<userId>`（新玩家创建流程里选性别的那个菜单）。
   */
  /**
   * **今天还该遇到几次途径事件**（M2.120）—— 该遇就弹一张卡，不用就返回 null。
   *
   * 次数固定（`NUMERIC.play.dailyEncounters`）、**卡片随机**（`engine.eligible` 里按 weight 抽）：
   * 次数也随机就会出现「今天一次都没有」的空白日，那对一个「日常行为」来说不是惊喜，是故障。
   *
   * ⚠️ 只抽**带 `options` 的卡** —— 663 张老卡是「遇到就自动生效」，
   * 那类应当在玩家做事的过程中自然触发（探索 / 扮演等既有路径），不该在这里抢一条消息。
   */
  #dailyEncounter(msg: InternalMessage, now: number): Reply | null {
    const character = this.#deps.characters.findByUserId(msg.userId);
    if (!character || character.pathway === null) return null;
    /*
     * 已经有**未决的事** ⇒ 不插队（M2.109 会把后续指令拦下来，玩家会先处理它）。
     *
     * ⚠️ 判据必须是 `#blockingMenuOf`（只看「正在进行的事」），**不能**是「有没有菜单」——
     * 实测踩过：建号之后路由会挂一张 `result` 的「下一步菜单」，而它**几乎总是存在**
     *（每条命令执行完都会开一张）。用「有没有菜单」当判据，这个钩子**一次都不会走到**。
     */
    if (this.#blockingMenuOf(msg, now) !== null) return null;
    const date = dateKey(now);
    const seen = this.#deps.dailyCounters.countOf(character.id, date, ENCOUNTER_COUNTER_KEY);
    const quota = NUMERIC.play.dailyEncounters;
    if (seen >= quota) return null;
    /*
     * `TriggerContext` 就地构造（`domain/event/trigger.ts` 的字段就这几个）。
     *
     * ⚠️ `flags` 给**空集**：flag 条件（`cond: flag:xxx`）在途径卡里用得很少，
     * 而逐条查库要按 key 一个个读（`FlagRepo` 没有「全部」这个接口）。
     * 代价是「带 flag 条件的日常卡」抽不到 —— 那类卡走它原本的触发路径，不靠这里。
     *
     * `location` 用角色此刻所在的城市 id：带 `location` 限制的卡不传地点**永远抽不到**，
     * 那是一条静默失效。
     */
    const ctx: TriggerContext = {
      character,
      flags: new Set<string>(),
      date,
      ...(character.currentCityId !== null ? { location: character.currentCityId } : {}),
    };
    /*
     * 只在**带 options 的卡**里挑。
     *
     * ⚠️ 这里**不能**直接 `engine.pick`：它是在**整个合格池**里按 weight 抽的，
     * 而池子里绝大多数卡没有 `options`（663 张里只有个位数有）。
     * 第一版写了「抽不到就再抽一次、最多五次」—— 实测**一次都没中**：
     * 途径池 50 张里只有 1 张带 options，五次全落空的概率约 90%。
     *
     * 正确做法就是这里：**先把池子筛成「带 options 的」**，再在**这个池子**里按 weight 加权抽。
     * `PickOptions` 没有「只要这几张」这一项（它只有 `types` 与 `location`），所以加权放在这里。
     */
    const pool = this.#deps.engine.eligible(ctx, { date, ...(ctx.location !== undefined ? { location: ctx.location } : {}) })
      .filter((c) => (c.options?.length ?? 0) > 0);
    if (pool.length === 0) return null;
    const rng = createSeededRng(seedFrom([character.id, date, String(seen), 'daily-encounter']));
    const totalWeight = pool.reduce((sum, c) => sum + (c.trigger.weight ?? 10), 0);
    let roll = rng.next() * totalWeight;
    let card: EventCard | null = null;
    for (const candidate of pool) {
      roll -= candidate.trigger.weight ?? 10;
      if (roll <= 0) { card = candidate; break; }
    }
    if (card === null) card = pool[pool.length - 1]!;
    const opened = this.#deps.pendingMenus.openWith(
      character.id,
      'encounter',
      encounterMenuOf({ card, nth: seen + 1 }),
      now,
    );
    /*
     * ⚠️ **弹出来就算遇到过**（计数在这里 +1，而不是等玩家选完）。
     *
     * 实测踩过：只在结算时加计数 ⇒ 玩家**不选**（继续发别的命令）时，
     * 这个钩子每一条命令都会再弹一次同一张卡 —— 玩家被卡在遭遇里出不去，
     * 而所有既有用例也跟着红（它们从没期待过「发一条指令先弹一张卡」）。
     */
    this.#deps.dailyCounters.increment(character.id, date, ENCOUNTER_COUNTER_KEY);
    // 引子 + 选项：两段都要有 —— 只有选项的话玩家不知道自己在选什么
    const text = [card.texts.priv.trim(), '', opened.text].join('\n');
    return {
      scene: msg.scene,
      targetId: msg.scene === 'private' ? msg.userId : msg.sceneId,
      text,
      interactive: opened.interactive,
    };
  }

  /**
   * 这个人此刻是不是被一件**未决的事**占着（M2.109）。
   *
   * 与 `#hasPendingMenu` 的区别：那个问「有没有菜单」（数字回复的闸门），
   * 这个问「这张菜单拦不拦别的指令」—— 只有 `MENU_BLOCKS_OTHER_COMMANDS` 里为 true 的才算。
   *
   * 返回菜单类型（给提示文案用），没有就是 null。
   */
  #blockingMenuOf(msg: InternalMessage, now: number): MenuType | null {
    const character = this.#deps.characters.findByUserId(msg.userId);
    const owner = character ? character.id : createMenuOwner(msg.userId);
    const pending = this.#deps.pendingMenus.current(owner, now);
    if (pending === null) return null;
    return MENU_BLOCKS_OTHER_COMMANDS[pending.menuType] ? pending.menuType : null;
  }

  #hasPendingMenu(msg: InternalMessage, now: number): boolean {
    const character = this.#deps.characters.findByUserId(msg.userId);
    const owner = character ? character.id : createMenuOwner(msg.userId);
    return this.#deps.pendingMenus.current(owner, now) !== null;
  }

  /** 数字 → 菜单项 → 完整指令 → 走与直接发指令**完全相同**的执行路径 */
  async #handleMenuReply(
    msg: InternalMessage,
    now: number,
    startedAt: number,
    key: string,
  ): Promise<Reply[]> {
    const character = this.#deps.characters.findByUserId(msg.userId);
    /*
     * M2.7.6：还没有角色的时候，数字回复落到「创建角色的性别选择」上。
     *
     * 这是**唯一**一条「没有角色也必须跑通」的数字回复路径 ——
     * 新玩家建号的第一步就是回一个 1 或 2（任务书补充 §1.1），
     * 而 pending_menus 是按 character_id 存的，此时还没有 characterId。
     * 归属键改用 'create:<userId>'（见 commands/create-menu.ts）。
     *
     * 找不到那张菜单时，仍然回原来的「你还没有角色」——不新增任何话术。
     */
    if (!character) {
      const owner = createMenuOwner(msg.userId);
      const pending = this.#deps.pendingMenus.pick(owner, key, now);
      if (!pending.ok || pending.kind !== 'option') {
        return this.#reply(msg, { privateText: NO_CHARACTER_TEXT, detailToPrivate: true });
      }
      const createTarget = parseCommand(`.${pending.option.command}`);
      if (!createTarget) {
        return this.#reply(msg, { privateText: NO_CHARACTER_TEXT, detailToPrivate: true });
      }
      return this.#execute(msg, createTarget.name, createTarget.args, now, startedAt, {
        menuType: pending.menuType,
        key,
        command: pending.option.command,
      });
    }
    const picked = this.#deps.pendingMenus.pick(character.id, key, now);
    if (!picked.ok) {
      this.#deps.audit.write({
        userId: msg.userId,
        command: '菜单',
        input: msg.rawText,
        output: picked.reason,
        createdAt: now,
      });
      this.#deps.monitor?.record('菜单', Date.now() - startedAt, true);
      return this.#reply(msg, { privateText: picked.reason, detailToPrivate: true });
    }
    if (picked.kind === 'freeform') {
      const text = this.#deps.pendingMenus.beginFreeform(character.id, now);
      this.#deps.audit.write({
        userId: msg.userId,
        command: '菜单',
        input: msg.rawText,
        output: '自由输入待命',
        createdAt: now,
      });
      return this.#reply(msg, { privateText: text, detailToPrivate: true });
    }

    const target = parseCommand(`.${picked.option.command}`);
    if (!target) {
      return this.#reply(msg, {
        privateText: `这条选项暂时不能用（${picked.option.label}），发 .今日 重新开始。`,
        detailToPrivate: true,
      });
    }
    return this.#execute(msg, target.name, target.args, now, startedAt, {
      menuType: picked.menuType,
      key: picked.option.key,
      command: picked.option.command,
    });
  }

  /** 真正的执行：频控 → 串行队列 → 审计 → 监控 → 分流回复 */
  async #execute(
    msg: InternalMessage,
    name: string,
    args: string[],
    now: number,
    startedAt: number,
    menuPick?: { menuType: string; key: string; command: string },
  ): Promise<Reply[]> {
    const handler = this.#handlers.get(name);
    if (!handler) {
      /*
       * M2.85：**未识别指令不再刷屏**。
       *
       * 用户的原话：「如果是未知指令 直接无视 不要回复 形成骚扰」——
       * 群里有人手滑打个句号、或者聊天里出现「.xxx」这种写法，
       * 机器人每一条都回一长串「未识别指令：… 可用指令：.创建 .状态 .背包 …」，
       * 那是实打实的刷屏。
       *
       * 所以按场景分开：
       *   · **群里静默** —— 这正是"骚扰"发生的地方，一个字都不回；
       *   · **私聊回一句极简** —— 一对一不打扰任何人，而完全静默会让人以为机器人坏了
       *     （「打错了」和「机器人挂了」在玩家那边长得一样，这一句是用来分开它们的）。
       */
      if (msg.scene === 'group') return [];
      return this.#reply(msg, {
        privateText: '没有 .' + name + ' 这条指令。发送 .帮助 看全部指令。',
        groupText: undefined,
        detailToPrivate: false,
      });
    }

    // 审计里的 input 要能还原「玩家到底按了什么」：菜单路径把选项也记上
    const input = menuPick ? `${msg.rawText}  →  菜单#${menuPick.key}：.${menuPick.command}` : msg.rawText;

    // ctx 提前建出来：在途闸门要往里写「刚到达」的信息，而 handler 也要用同一个对象
    const context: CommandContext = { msg, args, now, deps: this.#deps };

    // M2.7：到达结算 + 在路上时挡掉「需要在地」的指令（白名单见 TRAVEL_ALLOWED）
    const travelBlocked = this.#travelBlock(msg, name, now, context);
    if (travelBlocked) {
      this.#deps.audit.write({
        userId: msg.userId,
        command: name,
        input,
        output: travelBlocked.privateText,
        createdAt: now,
      });
      this.#deps.monitor?.record(name, Date.now() - startedAt, true);
      return this.#reply(msg, travelBlocked);
    }

    const decision = this.#deps.rateLimiter.check(name, msg.userId, now);
    if (!decision.ok) {
      const text = RateLimiter.describe(decision);
      this.#deps.audit.write({
        userId: msg.userId,
        command: name,
        input,
        output: `频控拒绝：${text}`,
        createdAt: now,
      });
      this.#deps.monitor?.record(name, Date.now() - startedAt, true);
      return this.#reply(msg, { privateText: text, groupText: undefined, detailToPrivate: true });
    }

    try {
      const raw = await this.#deps.queue.run(`user:${msg.userId}`, () => handler(context));
      const result = this.#attachNextMenu(msg, name, raw, now, context.arrivalNotes);
      this.#deps.audit.write({
        userId: msg.userId,
        command: name,
        input,
        output: raw.privateText,
        createdAt: now,
      });
      this.#deps.monitor?.record(name, Date.now() - startedAt, true);
      /*
       * 埋点记的是「玩家按了什么」：
       *   数字回复 → 菜单（M2.7.6：创建流程的第一步就是回一个数字，
       *   如果记成「创建」，那 DAU 报表里一次建号会被算成两次 .创建）；
       *   完整指令 → 那条指令本身。
       */
      this.#trackActivity(msg.userId, menuPick ? '菜单' : name, now);
      return this.#reply(msg, result);
    } catch (error) {
      this.#logger.error('指令执行异常', {
        command: name,
        userId: msg.userId,
        error: (error as Error).message,
      });
      this.#deps.audit.write({
        userId: msg.userId,
        command: name,
        input,
        output: `异常：${(error as Error).message}`,
        createdAt: now,
      });
      this.#deps.monitor?.record(name, Date.now() - startedAt, false);
      return this.#reply(msg, { privateText: '系统繁忙，请稍后再试。' });
    }
  }

  /**
   * M2.3 任务二：**每条指令执行完，主动给下一步选项**。
   *
   * 放在路由层是有意的：生成「下一步该给什么」是纯函数的事（domain/menu/next-menu.ts），
   * 而「给不给、给谁、要不要落库」是投递策略 —— 后者才是路由的活。
   * 好处是任何一条指令（含将来新加的）都自动获得「下一步」，不会因为忘了加一行而出现死胡同。
   *
   * 两条不做的情况：handler 自己开过菜单、结果声明了不需要。
   *
   * （原先是三条，第三条是「群聊不做」—— 那条随 §3.6 一起取消了：
   *  群聊现在和私聊走同一条路，所以群里也有「下一步」。）
   */
  #attachNextMenu(
    msg: InternalMessage,
    name: string,
    result: CommandResult,
    now: number,
    arrivalNotes?: readonly string[],
  ): CommandResult {
    if (result.menuOpened || result.suppressMenu) return result;
    try {
      const character = this.#deps.characters.findByUserId(msg.userId);
      if (!character) return result;
      const state = menuCharacterFor(this.#deps, character, now);
      const world = worldSnapshotFor(this.#deps, now, character, undefined, {
        // 只有「下一步」里真的会出现地点选项的指令才去查地点表
        withLocations: MENU_WITH_LOCATIONS.has(name),
      });
      // M2.7：刚到达的那几句排在最前面 —— 它是玩家此刻最想知道的事
      const notes = [...(arrivalNotes ?? []), ...(result.menuNotes ?? [])];
      const menu = buildNextMenu({
        state,
        world,
        // M2.7.6：普通人没有途径，工具包用「新人」那套（菜单会自己判断该给什么）
        pathway: character.pathway ? pathwayKit(character.pathway) : undefined,
        after: name,
        command: msg.rawText.replace(/^[.。．]/, ''),
        // M2.86：`.看` 交出的出口清单 —— 按钮要与正文说同一批地方
        ...(result.nextExits !== undefined ? { exits: result.nextExits } : {}),
        // M2.86：指令自己交出的下一步按钮（适应化的通用形态）
        ...(result.nextActions !== undefined ? { actions: result.nextActions } : {}),
        ...(notes.length > 0 ? { notes } : {}),
      });
      const opened = this.#deps.pendingMenus.openWith(character.id, 'result', menu, now);
      /*
       * ⚠️ M2.110：**按钮通道下不再把菜单文本追加到正文**（用户：「状态的信息尾，不需要存在」）。
       *
       * 那一刻的实情：`.状态` 的正文后面被接上了
       *
       *     【下一步 · 还没有途径】
       *     晴 · 黄昏 · HP 0 · MAD 21
       *     你还不知道自己会变成什么。
       *
       * 而下面紧接着就是四个按钮（看线索 / 休息一下 / 今日 / 翻翻背包）——
       * **同一件事说了两遍**，第二遍还更长。
       *
       * 判据用 `supportsColor`：它就是「是不是 markdown 通道」（项目里既有的一条口径），
       * 而那正是「有按钮可以承载选项」的那一类通道。非按钮通道（OneBot / 内存）照旧追加 ——
       * 那边没有按钮，菜单文本是**唯一**的选项载体。
       */
      const buttonsCarryMenu = this.#deps.supportsColor === true && opened.interactive.options.length > 0;
      /*
       * ⚠️ 但**事实要留下**：`notes`（「你抵达了贝克兰德」「今天已经探过这里」这类）
       * 不是菜单的装饰，是玩家必须知道的事 —— 去掉了它，玩家到达之后一声不响。
       *
       * 所以两段分开处理：
       *   title / context / options  按钮已经承载 ⇒ 按钮通道下不追加
       *   notes                      事实 ⇒ 永远追加
       */
      const notesText = notes.join('\n');
      const body = [result.privateText, notesText].filter((part) => part !== '').join('\n\n');
      return {
        ...result,
        privateText: buttonsCarryMenu ? body : `${result.privateText}\n\n${opened.text}`,
        interactive: opened.interactive,
      };
    } catch (error) {
      // 菜单是体验增强，坏了绝不能影响主流程
      this.#logger.warn('下一步菜单生成失败', { command: name, error: (error as Error).message });
      return result;
    }
  }

  /**
   * M2.7：玩家在路上的时候，拦下「需要在地」的指令。
   *
   * 三种回应，按优先级：
   *   1. 有到点未决的路途事件 → 把事件摆出来（带按钮），让玩家先决定；
   *   2. 只是还在路上 → 报进度（还剩几小时）；
   *   3. 不在路上 → null（放行）。
   *
   * 为什么这一层要有 try/catch：移动是 M2.7 新加的链路，
   * 它坏掉绝不能把「.扮演」这种主链路一起拖下水 —— 拦住就当作没拦。
   */
  #travelBlock(
    msg: InternalMessage,
    name: string,
    now: number,
    context: CommandContext,
  ): CommandResult | null {
    try {
      const character = this.#deps.characters.findByUserId(msg.userId);
      if (!character) return null;
      /*
       * 到达结算放在**路由层**，而不是只放在 requireCharacter 里。
       * 为什么：不是每条指令都走 requireCharacter（.状态 就是自己查库的），
       * 而那正是玩家在旅途中唯一会用的几条指令之一 ——
       * 「到了没」如果取决于玩家发了哪条指令，那是个几乎无法复现的 bug。
       */
      const settled = settleArrival(this.#deps, character, now);
      if (settled.arrived && settled.lines.length > 0) {
        context.arrivalNotes = [...(context.arrivalNotes ?? []), ...settled.lines];
      }
      if (TRAVEL_ALLOWED.has(name)) return null;
      if (!settled.character) return null;
      const travel = this.#deps.travels.activeOf(settled.character.id);
      if (!travel) return null;
      const pending = pendingTravelEvent(this.#deps, character.id, now);
      if (pending) {
        // 菜单必须落 pending_menus：玩家点按钮 / 回数字之后要能查出选项是什么
        const opened = this.#deps.pendingMenus.openWith(
          settled.character.id,
          'travel',
          travelEventMenu(pending.eventId, `【路上 · ${pending.label}】`, pending.text),
          now,
        );
        return {
          privateText: `你在路上 —— 先处理这件事。\n\n${opened.text}`,
          detailToPrivate: true,
          interactive: opened.interactive,
          menuOpened: true,
        };
      }
      return {
        privateText: `你还在路上，做不了这件事。\n\n${travelProgressText(this.#deps, travel, now)}`,
        detailToPrivate: true,
      };
    } catch (error) {
      this.#logger.warn('在途拦截失败', { command: name, error: (error as Error).message });
      return null;
    }
  }

  /** 菜单过期行清理：一分钟最多一次，避免每条指令都写一次 DELETE */
  #sweepMenus(now: number): void {
    if (now - this.#lastMenuSweep < MENU_SWEEP_INTERVAL_MS) return;
    this.#lastMenuSweep = now;
    try {
      const cleared = this.#deps.pendingMenus.clearExpired(now);
      if (cleared > 0) this.#logger.info('过期菜单已清理', { cleared });
    } catch (error) {
      this.#logger.warn('过期菜单清理失败', { error: (error as Error).message });
    }
  }

  /** 推进世界时钟与天气；显著天气变化全群播报。任何异常都不该影响玩家这条指令 */
  #advanceWorld(now: number): void {
    try {
      const result = advanceWorld(this.#deps, now);
      for (const item of result.broadcasts) this.#deps.broadcast?.(item.text, item.buttons);
    } catch (error) {
      this.#logger.warn('世界 tick 推进失败', { error: (error as Error).message });
    }
  }

  /**
   * 推进生态 tick：迁移 / 捕食 / 进化 / 繁衍 / 衰亡。
   *
   * 不管有没有人在线，生物都在动 —— 但推进的**时机**挂在玩家动作上，
   * 理由与世界时钟一样：定时器在实例测试里根本不跑。
   */
  #advanceCreatureEcology(now: number): void {
    try {
      advanceCreatureEcology(this.#deps, now);
    } catch (error) {
      this.#logger.warn('生态 tick 推进失败', { error: (error as Error).message });
    }
  }

  /**
   * M2.9：超时战斗的自动防御（逐格补齐，一格 playerTimeoutMs）。
   *
   * 只结算**当前这个人**的战斗：一场战斗只有它的主人能推进，
   * 而没有人在线的那一场本来也不会被任何人看见（回到对话时再补）。
   * 任何异常都不该影响玩家这条指令 —— 与两条 tick 同样的兜底。
   */
  #settleBattle(now: number): void {
    try {
      const character = this.#deps.characters.findByUserId(this.#lastUserId ?? '');
      if (!character) return;
      /*
       * M2.10：PVP 的超时是**双方各自计时**的 —— 所以这里替的可能是对方。
       * 「每次轮到谁，谁超时，战斗就往前走一格」，于是两个人都挂机也不会僵在原地。
       */
      const pvpRounds = settlePvpTimeout(this.#deps, character, now);
      if (pvpRounds > 0) {
        this.#logger.info('PVP 超时自动防御', { characterId: character.id, rounds: pvpRounds });
      }
      const outcome = settleBattleTimeout(this.#deps, character, now);
      if (outcome.rounds > 0) {
        this.#logger.info('战斗超时自动防御', { characterId: character.id, rounds: outcome.rounds });
      }
    } catch (error) {
      this.#logger.warn('战斗超时结算失败', { error: (error as Error).message });
    }
  }

  /** 封测埋点：只记指令名与次数，不记内容（content 已在 audit_logs 留档）；失败绝不影响游戏 */
  #trackActivity(userId: string, command: string, now: number): void {
    try {
      this.#deps.userActivity.touch(userId, dateKey(now), command, now);
    } catch (error) {
      this.#logger.warn('行为埋点失败', { command, error: (error as Error).message });
    }
  }

  /**
   * 把结果变成要发出去的回复。
   *
   * **群聊与私聊走同一条路**（原来不是：群聊只发 groupText 摘要，明细走私聊）。
   *
   * 为什么可以合并：玩家在哪说话，完整内容就回哪里 —— 私聊回给人（userId），
   * 群聊回给群（sceneId），**只有目标不同，内容一样**。
   *
   *   1. 菜单必须跟着内容一起到玩家眼前。原来群里只给摘要 + 一句「选项在私聊里」，
   *      而菜单按 character_id 落库、消息自带唯一成员标识，群里回数字并不比私聊含糊，
   *      没有理由把玩家赶去私聊。
   *   2. 「群里刷屏」的顾虑不成立：能走到这里的群消息都已经被识别成了指令，
   *      是玩家主动要的那份内容（.世界 要明细就给他明细），不是机器人自说自话。
   *   3. `groupText` 字段保留但不再参与分流 —— 留一个字段比改 8 个命令文件的
   *      返回结构风险小得多，将来若要按场景分口径，钩子还在。
   *
   * 注意 targetId 的算法：私聊是 `msg.userId`（人），其余是 `msg.sceneId`
   * （群 / 子频道）。这里**不能**用 scene 判断去决定发什么内容，只能决定发给谁 ——
   * 那正是这次改动要消掉的那种耦合。
   */
  #reply(msg: InternalMessage, result: CommandResult): Reply[] {
    const header = this.#headerFor(msg);
    const replies: Reply[] = [];
    /*
     * M2.86：handler 自己发过了（`.角色` 的「图 + 常用按钮」那条）——这里**不产生回执**。
     *
     * 于是这条回复连 header 也不会带上（header 是随这条 reply 一起交给通道的）——
     * 这正是用户要的「不要信息头」。而且空数组走到 sendReplies 是**什么都不发**，
     * 不会像 M2.45 那次一样变成群里一条空消息。
     */
    if (result.selfSent !== true) {
      replies.push({
        scene: msg.scene,
        targetId: msg.scene === 'private' ? msg.userId : msg.sceneId,
        text: result.privateText,
        ...(header ? { header } : {}),
        ...(result.interactive ? { interactive: result.interactive } : {}),
      });
    }
    if (result.extra) replies.push(...result.extra);
    return replies;
  }

  /**
   * 组装消息头（M2.45）。
   *
   * **昵称以角色卡为准**（M2.86 改口径）。
   *
   * 原来这里优先用 QQ 侧传来的昵称（理由：「群里分辨是谁的信息」）。
   * 用户实机反馈：**同一个人的名字一会是 QQ 昵称、一会是游戏昵称** ——
   * 因为他「注册了」，游戏里已经有身份了，两套名字并存只会让人认不出谁是谁。
   * 所以改成：**有角色卡就用角色名，没有（还没 .创建）才退回 QQ 昵称。**
   *
   * 性别、途径、序列、地点都只有角色卡知道，一并放进信息条的图里。
   */
  #headerFor(msg: InternalMessage): MessageHeader | null {
    const nickname = (msg.nickname || '').trim();
    const character = this.#deps.characters.findByUserId(msg.userId);
    if (!nickname && !character) return null;
    const genderTag = character ? (GENDER_TAGS[character.gender] ?? '') : '';
    // 未入途径时 pathwayLineOf 返回空串 ⇒ 这里不写那一行（去重，见 pathwayLineOf 的注释）
    /*
     * M2.86：**信息条里凡人也要有途径行**（用户：「凡人途径也要显示啊」）。
     *
     * `pathwayLineOf` 对未入途径的人返回空串，理由是 M2.45 的「别和正文重复」（正文已经有一句
     * 「还没有途径 —— 去探索翻线索」）。但那条理由针对的是**文字头**：
     * 文字头与正文都在同一个阅读流里，说两遍确实吵。
     * 而现在信息头是**一张图** —— 它是身份条，本来就是「一眼看清这个人是谁」，
     * 图里写「还没有途径」与正文那句**引导**是两件事：一个说身份，一个说下一步。
     */
    const pathwayLine = character !== null && character !== undefined
      ? (pathwayLineOf(character) || '还没有途径')
      : '';
    /*
     * M2.86：**所在地点**（顶部信息条图片的第二行）。
     *
     * 通道不认识角色卡，所以这一项只能从业务侧给 —— 而这里是唯一能同时拿到
     * 「角色」与「仓储」的地方（`#headerFor` 本来就查了角色）。
     * 角色还没安置位置时不给它，信息条就少一行、仍然出图。
     */
    const hereId = character?.currentLocationId ?? character?.currentCityId ?? null;
    const hereName = hereId === null ? '' : (this.#deps.locations.get(hereId)?.name ?? '');
    return {
      // M2.86：**注册了就用游戏昵称**（用户实机反馈「昵称一会 QQ 名一会游戏名」）
      nickname: character?.name || nickname || msg.userId,
      // M2.86：**发言人的平台 id** —— 群里 targetId 是群 id，取头像只能靠这个
      ...(msg.userId.length > 0 ? { avatarUserId: msg.userId } : {}),
      ...(genderTag ? { genderTag } : {}),
      ...(pathwayLine ? { pathwayLine } : {}),
      ...(hereName.length > 0 ? { locationName: hereName } : {}),
    };
  }
}

/** 把路由产出的回复真正发出去；发送失败只记录不抛出，避免一条失败拖垮整轮 */
export async function sendReplies(
  adapter: Adapter,
  replies: readonly Reply[],
  logger: Logger = consoleLogger,
): Promise<void> {
  for (const reply of replies) {
    try {
      // M2.7：通道支持按钮就摆按钮，否则发文本。
      // 两条路的**选项语义完全一致**（按钮的 action.data 就是选项 id），
      // 所以「同一份 InteractiveMessage 在两种 Adapter 下行为一致」是结构性成立的，
      // 不是靠对齐文案（详见 src/adapter/interactive.ts）。
      /*
       * ⚠️ M2.102：**`quickButtons` 单独给时也要走这条路。**
       *
       * 原来的条件是 `options.length > 0` —— 而「点了把指令插进输入框」的那种按钮
       * （`QuickButton` → `commandButton`，`action.type = 2`）**没有 options**，
       * 于是整块被丢掉（`.看` 与 `.角色` 都踩过这个坑，见 next-menu.ts 的注释）。
       *
       * 两种按钮的语义不同（interactive.ts 的注释）：
       *   options      选项：平台回传 id，后端走 MENU_REPLY（需要待答状态）
       *   quickButtons 快捷入口：平台只把指令插进输入框，没有待答状态
       */
      const quick = reply.interactive?.quickButtons?.length ?? 0;
      if (reply.interactive && (reply.interactive.options.length > 0 || quick > 0) && adapter.sendInteractive) {
        /*
         * ⚠️ M2.85：**正文必须与选项一起发出去**。
         *
         * 这里原来直接把 \`reply.interactive\` 交出去（然后 continue），于是
         * \`reply.text\` —— 也就是 handler 产出的**正文**（.状态 的状态详情、.背包 的物品列表…）
         * —— **被整个丢掉了**。支持按钮的通道（QQ 官方）上，玩家永远只能看到菜单那一屏。
         *
         * 为什么一直没被发现：不支持按钮的通道（OneBot / 内存）会走下面那行发 \`reply.text\`，
         * 一切正常；而**测试用的是内存适配器**（supportsButtons 为假）。
         * 症状因此只出现在真机上 —— 这一轮排查绕的远路，根子就在这里。
         *
         * 合并规则（顺序与去重都按「正文在前、菜单在后」）：
         *   · 两边都有且不同 → 正文 + 空行 + 菜单；
         *   · 菜单正文已经包含在正文里（或本来就相等）→ 只发正文，不重复；
         *   · 只有一边有 → 发那一边。
         */
        const body = reply.text ?? '';
        const menuText = reply.interactive.text ?? '';
        /*
         * M2.45 第二十版：按钮通道下**正文里那段文字菜单要切掉**（用户：
         * 「信息尾太墨迹了，他太长了，他应该放置在按钮里」）——
         * 选项已经在按钮上了，正文再列一遍 `1./2./3.` 就是纯冗余。
         *
         * 拼接点在这儿是确定的（`#reply`：`privateText + '\n\n' + opened.text`），
         * 所以先按后缀把菜单摘出来、切掉它的选项清单、再拼回去。
         * ⚠️ 切不动就原样发：绝不误伤正文。
         */
        /*
         * 三种情况都要照顾到（前两次都栽在这儿）：
         *
         *   ① **菜单是正文的完整后缀**（真实链路就是这样：`#reply` 拼的
         *      `privateText + '\n\n' + opened.text`）⇒ 把那段**换成精简版**（切掉选项清单）。
         *      ⚠️ 第一版写成「body 里已含**精简**菜单就直接用 body」——而 body 里含的是
         *      **完整**菜单，于是等于什么都没切，用户的回复是「还有尾巴你切哪了」。
         *   ② **正文里已经有这句话**（内容重复、结构不同）⇒ 原样发正文，不重复拼
         *      （M2.85 的去重，别丢）。
         *   ③ 两边都有、且互不包含 ⇒ 正文 + 菜单（正文不许被菜单顶掉，也是 M2.85 的）。
         *      ⚠️ 第二版用 `lastIndexOf` 找菜单位置，结果撞上「正文里恰好含这几个字」，
         *      把正文截断了 —— 所以只能用 **endsWith** 判断"是不是完整后缀"。
         */
        /*
         * ⚠️ M2.112：**按钮通道下不再合并菜单文本**（用户第三次报「信息尾依旧存在」）。
         *
         * 上一版我只在 `#attachNextMenu` 里「不把 `opened.text` 追加到 privateText」，
         * 但**渲染层这里**又把 `reply.interactive.text`（同一份菜单文本）合并回来了 ——
         * 于是标题行（`【下一步 · 还没有途径】`）与环境行（`晴 · 黄昏 · HP 0 · MAD 21`）
         * 照样出现在按钮上方。
         *
         * 判据是 `adapter.supportsButtons`：那个通道**有按钮**，选项与标题都在按钮上，
         * 正文再抄一遍就是纯冗余。没有按钮的通道（OneBot）照旧合并 —— 那边它是唯一的选项载体。
         */
        const buttonsCarryMenu = adapter.supportsButtons === true && reply.interactive.options.length > 0;
        const slimMenu = buttonsCarryMenu ? '' : cutMenuOptions(menuText);
        const mergedText = buttonsCarryMenu
          ? // 正文里若整段抄了菜单（老路径的产物），整段去掉；否则只切掉自带的选项清单
            menuText !== '' && body.includes(menuText)
            ? body.slice(0, body.indexOf(menuText)).trim()
            : cutMenuOptions(body) || body
          : menuText === ''
          ? body
          : body.endsWith(menuText)
            ? `${body.slice(0, body.length - menuText.length)}${slimMenu}`.replace(/\n{3,}/g, '\n\n')
            : body === ''
              ? menuText
              : body.includes(menuText)
                ? // 正文里已经有菜单了 ⇒ 原样发，顺手把正文自带的选项清单也切掉
                  //（有些调用方把选项直接拼在正文里，interactive.text 反而只是标题）
                  cutMenuOptions(body) || body
                : `${body}\n\n${menuText}`;
        const merged = {
          ...reply.interactive,
          text: mergedText === '' ? menuText : mergedText,
        };
        const sent = await adapter.sendInteractive(reply.scene, reply.targetId, merged, reply.header);
        if (sent) continue;
      }
      if (reply.scene === 'private') await adapter.sendPrivate(reply.targetId, reply.text, reply.header);
      else if (reply.scene === 'group') await adapter.sendGroup(reply.targetId, reply.text, reply.header);
      else await adapter.sendChannel(reply.targetId, reply.text, reply.header);
    } catch (error) {
      logger.error('消息发送失败', { scene: reply.scene, targetId: reply.targetId, error: (error as Error).message });
    }
  }
}
