import { dirname, join } from 'node:path';
import { dataPath } from './infra/paths.ts';
import { loadCardsOrThrow } from './cards/loader.ts';
import { loadLostControlOrThrow } from './cards/lost-control.ts';
import type { EventCard } from './cards/schema.ts';
import { loadCommunity } from './data/community.ts';
import { loadSwitches } from './config/switches.ts';
import { loadContent, loadContentOrThrow, loadTagPhrases } from './data/loader.ts';
// M2.99：神座（世界 tick 会拿它问「这一小时有没有哪位神要动」）
import { loadDivineThrones } from './data/loader.ts';
import { DIVINE_THRONES_FILE } from './data/loader.ts';
import { installTagPhrases } from './domain/menu/phrases.ts';
import { EventEngine } from './domain/event/engine.ts';
import { setDefaultAutoSelectFamily } from 'node:net';
/*
 * M2.88：**随机间隔的世界节奏。**
 *
 * `loadOpsSettings` 读 `src/data/ops-settings.yaml`（后台可改），
 * `nextDelayMs` 从配置范围里掷下一次的延迟 —— 纯函数、以「上一次跑的时刻」为种子，
 * 所以同一个时刻在任何进程里都得到同一个延迟（跑批可复现）。
 */
import { loadOpsSettings } from './data/loader.ts';
import { nextDelayMs } from './domain/ops/settings.ts';
import { runDailyTick } from './infra/tick.ts';
import { OneBotFingerprintProvider, type FingerprintProvider } from './infra/fingerprint.ts';
import type { Adapter, InternalMessage } from './adapter/types.ts';
import { createCardService, type CardService } from './card/service.ts';
import type { GithubUploadConfig, UploadProvider } from './card/uploader.ts';
import { AuditLog } from './infra/audit.ts';
import { CharacterRepo } from './infra/db/characters.ts';
import { AbilityRepo } from './infra/db/abilities.ts';
import { DailyCounterRepo } from './infra/db/daily-counters.ts';
import { applyNumericOverrides } from './config/numeric.ts';
import { validateNumericOrThrow } from './config/validate.ts';
import { archiveStats, archiveAuditLogs } from './infra/archive.ts';
import { backupDatabase, listBackups } from './infra/backup.ts';
import { Monitor } from './infra/monitor.ts';
import { runStartupRecovery } from './infra/recovery.ts';
import { FeedbackRepo } from './infra/db/feedback.ts';
import { UserActivityRepo } from './infra/db/user-activity.ts';
import { LostControlRepo } from './infra/db/lost-control-events.ts';
import { CooldownRepo } from './infra/db/cooldowns.ts';
import { DailyTickRepo } from './infra/db/daily-ticks.ts';
import { WorldRepo } from './infra/db/world.ts';
import { WorldEventRepo } from './infra/db/world-events.ts';
import { NpcDeedRepo, NpcProgressRepo } from './infra/db/npc-progress.ts';
import { NpcLifeRepo } from './infra/db/npc-life.ts';
import { DivinePlansRepo, DivineStateRepo } from './infra/db/divine.ts';
import { DivineThroneStateRepo } from './infra/db/divine-throne-state.ts';
import { DivineSchemeRepo } from './infra/db/divine-scheme.ts';
import { WorldScarRepo } from './infra/db/world-scar.ts';
import { ChurchStateRepo } from './infra/db/church-state.ts';
import { DivineMeddlingRepo } from './infra/db/divine-meddling.ts';
import { ThroneContestRepo } from './infra/db/throne-contest.ts';
import { GodhoodRepo } from './infra/db/godhood.ts';
import { EventHandlingRepo } from './infra/db/event-handling.ts';
import { NpcRelationRepo, NpcSchemeRepo } from './infra/db/npc-relations.ts';
import { EquipmentRepo } from './infra/db/equipment.ts';
import { QuestRepo } from './infra/db/quests.ts';
import { CreatureRepo } from './infra/db/creatures.ts';
import { BattleRepo } from './infra/db/battles.ts';
import { ChurchConflictRepo } from './infra/db/church-conflict.ts';
import { CreatureIndex } from './domain/creature/content.ts';
import { withFallenSpecies } from './domain/world/fallen-beast.ts';
import { ZoneIndex } from './domain/world/zone.ts';
import { PowerIndex } from './domain/world/power.ts';
import { HistoryIndex, historyEffects, mergeWithDeclaredRelations } from './domain/world/history.ts';
import type { HistoryRelation } from './domain/world/history.ts';
import { BoundaryIndex } from './domain/world/boundary.ts';
import type { ZonePatch } from './domain/world/zone.ts';
import type { PowerRelationKind } from './domain/world/power.ts';
import { RitualRepo } from './infra/db/rituals.ts';
import { advanceWorld } from './infra/world-tick.ts';
import { BROADCAST_FLUSH_INTERVAL_MS, BroadcastThrottle, mergeBroadcastParts, type BroadcastButton } from './infra/broadcast.ts';
import { EventTriggerRepo } from './infra/db/event-triggers.ts';
import { PartyRepo } from './infra/db/parties.ts';
import { ExploreDailyRepo } from './infra/db/explore-daily.ts';
import { FlagRepo } from './infra/db/flags.ts';
import { InventoryRepo } from './infra/db/inventory.ts';
import { ItemRepo } from './infra/db/items.ts';
import { ItemIndex } from './domain/item/item.ts';
import { PowerRelationRepo, PowerStateRepo } from './infra/db/power-state.ts';
import { LocationRepo } from './infra/db/locations.ts';
import { RecipeRepo } from './infra/db/recipes.ts';
import { TagUsageRepo } from './infra/db/tag-usage.ts';
import { TradeRepo } from './infra/db/trades.ts';
import { migrate, openDatabase, type Db } from './infra/db/sqlite.ts';
import { enableDeterministicIds } from './infra/ids.ts';
import { IdempotencyStore } from './infra/idempotency.ts';
import { consoleLogger, type Logger } from './infra/logger.ts';
import { KeyedQueue } from './infra/queue.ts';
import { RateLimiter, type RateLimitConfig } from './infra/ratelimit.ts';
import { SensitiveFilter } from './infra/sensitive.ts';
import { registerW1Commands } from './router/commands/index.ts';
import { FactionRepo, WantedRepo } from './infra/db/wanted.ts';
import { CityRepo, RegionRepo, RouteRepo, TravelRepo } from './infra/db/geo.ts';
import { RecipeClueRepo } from './infra/db/initiation.ts';
import { InitiationIndex } from './domain/initiation/index.ts';
import { ChurchIndex } from './domain/church/index.ts';
import { GeoIndex } from './domain/geo/index.ts';
import { FACTIONS, territoryOf } from './domain/faction/faction.ts';
import { expireStaleTrades } from './router/commands/common.ts';
import { CommandRouter, sendReplies } from './router/index.ts';
import { NpcRoster } from './domain/world/npc-cast.ts';
import { MenuService } from './router/menu.ts';
import { PendingMenuRepo } from './infra/db/pending-menus.ts';
// M2.114：把「没有主动推送凭证」与「网络失败」分开 —— 前者的日志里要有明确的中文原因
// 只为一个 instanceof 判断。它以前住在 adapter/qq-official 里 ——
// 值导入那个文件会把整个官方网关拉进本版的模块图，bridge-api 的守卫测试会红。
import { NoReplyTicketError } from './infra/reply-errors.ts';

/*
 * ⚠️ M2.87：**关掉 happy-eyeballs，让 Node 走系统解析器。**
 *
 * ## 现场
 *
 * 用户报「主动推送又失败了」，日志里三个群同时：
 *
 * ```
 *   error: 'fetch failed'   cause: 'ECONNREFUSED'
 *   errno: -4078            syscall: 'connect'
 * ```
 *
 * 而同一台机器上：
 *
 * ```
 *   fetch('https://api.sgroup.qq.com/')  → HTTP 404   ← TCP+TLS 完全通
 *   dns.resolve4('api.sgroup.qq.com')    → ECONNREFUSED
 * ```
 *
 * **同一个错误码出现在 DNS 查询上，不是 TCP 连接上。** 差别在于解析路径：
 *   · `fetch` 走**系统解析器**（getaddrinfo，带缓存）→ 通；
 *   · `dns.resolve*` **直连 nameserver**（这台机器上是路由器 192.168.1.1）→ 被拒。
 *
 * 而这台机器上的显式查询实测是「An existing connection was forcibly closed」，
 * 也就是**路由器的 DNS 服务间歇性掐连接**。
 *
 * ## 为什么这会打到线上
 *
 * Node 22 默认 `autoSelectFamily: true` —— 连接前会**并发**查 A 与 AAAA（happy-eyeballs），
 * 而那一步内部用的是 `dns.resolve*`。所以：**只要路由器那一秒不稳，`fetch` 就死在 DNS 上，
 * 而报出来的是 `connect` 阶段的 `ECONNREFUSED`** —— 看起来像对方拒绝，其实是自己家门口。
 *
 * 关掉之后走系统解析器（那条路实测是通的），并把选择权交回操作系统。
 * 代价：失去 happy-eyeballs 的 IPv6 回退优化 —— 对一个只会连国内 HTTPS 端点的机器人，
 * 那点优化远不如「不随机失败」重要。
 *
 * ⚠️ **这是绕开，不是治好。** 根子在路由器上，彻底解决要把它换掉
 * （或给这台机器配一个稳的 DNS）。这里做的是让程序不因为环境缺陷而随机失败。
 */
setDefaultAutoSelectFamily(false);

export interface AppConfig {
  dbPath: string;
  port: number;
  onebotApiBase: string;
  onebotToken?: string;
  /** 群聊是否把明细同时私聊给玩家（S1 §7） */
  detailToPrivate: boolean;
  /** 启动时是否立刻补跑一次每日结算（默认开，测试里可关） */
  runTickOnStart?: boolean;
  /** 备份目录（默认 DB 同级的 backups/） */
  backupDir?: string;
  /** 备份保留天数（默认 7） */
  backupRetainDays?: number;
  /** 审计日志保留天数（默认 7，超出的搬到归档表） */
  auditRetainDays?: number;
  /** 是否启用运维服务（备份 / 归档 / 启动自检）；测试与演示里关掉 */
  startOps?: boolean;
  /** 管理端点令牌（默认复用 OneBot token） */
  adminToken?: string;
  /** 演练用时间偏移（天）：只改服务端时钟，生产环境必须保持 0 */
  timeTravelDays?: number;
  /** 是否允许测试通过 /admin/clock 固定服务端时钟（生产必须关闭） */
  allowClockControl?: boolean;
  /** M2.2：世界种子（雾日与天气序列的确定性来源；默认 world） */
  worldSeed?: string;
  /**
   * M2.47：角色卡出图目录（默认 `data/cards`）。
   * 测试里指到临时目录，免得每跑一次就在工作区留下一堆 PNG。
   */
  cardOutDir?: string;
  /**
   * M2.47：角色卡图片的**公网基址**（如 `https://bot.example.com`）。
   *
   * 配了它，卡面就会带一个 `<基址>/cards/<文件名>` 的 URL：
   *   · QQ 官方 Markdown 用它显示图片（平台会下载转存）；
   *   · 没配就只出本地文件，官方通道回落成文字卡（不报错）。
   * 末尾斜杠会被归一化掉。
   */
  cardPublicBaseUrl?: string;
  /**
   * 临时图床（M2.47）。**默认不传** = 只走自建托管。
   *
   * 传 `'uguu'` 时：没配 `cardPublicBaseUrl` 就把卡图 POST 给 uguu.se 换一个公网 URL。
   * 代价是**卡面交给第三方**、且链接会过期（官方转存后无所谓，没转存就会裂）。
   */
  /**
   * 卡图上传用哪个图床（`CARD_IMAGE_UPLOAD`）。
   *
   * 取值跟着 `UploadProvider` 走，不在这里再抄一份联合类型 ——
   * 加一个图床时，抄过的那份会「类型上齐全、运行期收不到」（本仓库 §3.1 的老坑）。
   */
  cardImageUpload?: UploadProvider;
  /** GitHub 图床配置（`CARD_IMAGE_UPLOAD=github` 时用）：仓库 + token，不需要部署方自建服务 */
  cardGithubUpload?: GithubUploadConfig;
  /**
   * M2.48：卡面底图目录（默认 `data/artwork`），按途径取 `<pathway>.png`。
   *
   * 见 docs/角色卡-卡面规范.md §3：做旧黄铜、灰雾、油画质感那一层**由出图工具出**，
   * 渲染器只负责叠头像与数据。目录不存在、或某条途径缺图 → 退回程序化星盘，**不报错**。
   */
  cardArtworkDir?: string;
  /**
   * 测试专用：id 用确定性派生（角色 id / 交易单号 / 队伍号）。
   * 判定 seed 全是 `messageId:characterId:now` 派生的，id 随机的话
   * 「同一 seed 输出一致」不成立。生产必须关闭（默认关）。
   */
  deterministicIds?: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const dbPath = env.DB_PATH ?? join(process.cwd(), 'data', 'game.db');
  return {
    dbPath,
    backupDir: env.BACKUP_DIR ?? join(dirname(dbPath), 'backups'),
    backupRetainDays: Number(env.BACKUP_RETAIN_DAYS ?? 7),
    auditRetainDays: Number(env.AUDIT_RETAIN_DAYS ?? 7),
    port: Number(env.PORT ?? 3100),
    onebotApiBase: env.ONEBOT_API_BASE ?? 'http://127.0.0.1:3000',
    onebotToken: env.ONEBOT_TOKEN,
    detailToPrivate: env.DETAIL_TO_PRIVATE !== '0',
    ...(env.CARD_OUT_DIR !== undefined ? { cardOutDir: env.CARD_OUT_DIR } : {}),
    // 默认目录可以不存在：缺素材等价于「还没出图」，不是配置错误
    cardArtworkDir: env.CARD_ARTWORK_DIR ?? dataPath('artwork'),
    ...(env.CARD_PUBLIC_BASE_URL !== undefined
      ? { cardPublicBaseUrl: env.CARD_PUBLIC_BASE_URL }
      : {}),
    /*
     * `.trim()` 不是多余的：Windows 上 `set VAR=value && ...` 会把 value 后面的空格
     * 一起算进值里（实测 `CARD_IMAGE_UPLOAD` 拿到的是 `"uguu "`），
     * 严格相等就会**静默忽略**这个配置 —— 症状是「配了图床却一直没有上传动作」，
     * 而且日志里什么都不报。凡是从环境变量读「枚举值」的地方都该先 trim ——
     * 本文件与 qq-official / switches 里同类读取一并加了（同一类坑，只修一处等于没修）。
     */
    /*
     * 图床：**picui 是默认**（国内站、无需 key，QQ 平台抓得到）；
     * uguu 留着 —— 它能传，但域名在平台那一侧抓不到，写进正文就是裂图（真机实测）。
     */
    ...(env.CARD_IMAGE_UPLOAD?.trim() === 'github' ? { cardImageUpload: 'github' as const } : {}),
    ...(env.CARD_IMAGE_UPLOAD?.trim() === 'picui' ? { cardImageUpload: 'picui' as const } : {}),
    ...(env.CARD_IMAGE_UPLOAD?.trim() === 'uguu' ? { cardImageUpload: 'uguu' as const } : {}),
    /*
     * GitHub 图床（推荐）：**一个仓库 + 一个 token**，不需要部署方自建任何服务。
     * 实测 `cdn.jsdelivr.net/gh/…` 与 `raw.githubusercontent.com/…` 都回 200 / image/png。
     * 两个变量缺一不可 —— 缺了就当没配（回落平台富媒体直发），不报错。
     */
    ...(env.GITHUB_IMAGE_REPO !== undefined && env.GITHUB_IMAGE_TOKEN !== undefined
      ? {
          cardGithubUpload: {
            repo: env.GITHUB_IMAGE_REPO.trim(),
            token: env.GITHUB_IMAGE_TOKEN.trim(),
            ...(env.GITHUB_IMAGE_BRANCH !== undefined
              ? { branch: env.GITHUB_IMAGE_BRANCH.trim() }
              : {}),
            ...(env.GITHUB_IMAGE_CDN?.trim() === 'raw' ? { cdn: 'raw' as const } : {}),
          },
        }
      : {}),
    runTickOnStart: env.RUN_TICK_ON_START !== '0',
    adminToken: env.ADMIN_TOKEN ?? env.ONEBOT_TOKEN,
    timeTravelDays: Number(env.TIME_TRAVEL_DAYS ?? 0),
    allowClockControl: env.ALLOW_CLOCK_CONTROL?.trim() === '1',
    worldSeed: env.WORLD_SEED ?? 'world',
    deterministicIds: env.DETERMINISTIC_IDS?.trim() === '1',
    // 之前 loadConfig 根本没读这个开关，于是 harness 传 startOps:false 也关不掉运维服务：
    // 定时结算照跑，会在测试跑到一半时按真实时间插进来恢复 AP/MP（不可复现的元凶之一）
    startOps: env.START_OPS !== '0',
  };
}

export interface AppDeps {
  adapter: Adapter;
  logger?: Logger;
  /** 运行监控（可选，测试里可以注入自己的实例） */
  monitor?: Monitor;
  /** 可注入时钟，便于测试与回放（S1 §3.2） */
  now?: () => number;
  /** 可覆盖频控配置：压测需要把 AP 硬约束与防刷频控分开验证 */
  rateLimits?: Record<string, RateLimitConfig>;
  /** 设备指纹来源（默认 OneBot：恒为 null，钩子已留） */
  fingerprint?: FingerprintProvider;
  /**
   * M2.47：角色卡出图服务。
   *
   * 可注入是为了测试——真渲染要起 PowerShell 进程（约 300—500ms/张），
   * 而路由那三条降级路径（发图 / 发不出图 / 出图失败）**一条都不该靠真进程去验**。
   * 不传就用真实现（见下面 createCardService 的构造）。
   */
  card?: CardService;
}

/** 热重载的结果：给后台回执用，让人知道发生了什么、有没有问题 */
export interface ContentReloadResult {
  ok: boolean;
  /** 重建了哪几个索引 */
  rebuilt: string[];
  /** 内容校验里的 error（有 error 时不替换索引 —— 宁可跑旧的，也不跑一份坏的） */
  errors: string[];
  /** 内容校验里的 warn（不阻塞替换，但要说出来） */
  warnings: string[];
}

export interface App {
  config: AppConfig;
  db: Db;
  router: CommandRouter;
  adapter: Adapter;
  logger: Logger;
  /** M2.7：世界地理的只读索引（测试与报告脚本要按同一份数据算出生分布） */
  geo: GeoIndex;
  /** 已加载的事件卡（W2） */
  cards: EventCard[];
  engine: EventEngine;
  /** 运行监控（W5） */
  monitor: Monitor;
  /** 测试用：固定/解除服务端时钟（生产由 allowClockControl 关闭） */
  setClock(now: number | null): void;
  /**
   * M2.63：**热重载内容**（后台数据编辑器保存后调它）。
   *
   * 重新读 src/data/*.yaml、重建内容索引、把内容投影重播种进库，
   * 然后回一份「哪些索引换掉了」。**不重启进程、不断网关。**
   */
  reloadContent(): ContentReloadResult;
  /** 当前服务端时间（被 /admin/clock 固定过就是那个时间，否则是墙上时间） */
  now(): number;
  close(): void;
}

export function createApp(config: AppConfig, deps: AppDeps): App {
  const logger = deps.logger ?? consoleLogger;
  // 可控时钟：/admin/clock 固定后，所有判定（冷却、每日计数、每日结算）都以它为准
  let pinnedNow: number | null = null;
  // 测试专用：id 确定性派生（生产默认关，行为与 W1—W6 一致）
  enableDeterministicIds(config.deterministicIds === true);
  const now = deps.now ?? (() => pinnedNow ?? Date.now());
  const setPinnedNow = (value: number | null): void => {
    pinnedNow = value;
  };
  // 监控实例只建一次：路由与 /metrics 必须共用同一个
  const monitor = deps.monitor ?? new Monitor({ startedAt: now() });
  /*
   * M2.14 对照批开关：M214_CALAMITY=off 时灾厄完全不生效。
   *
   * 用途只有一个 ——「同一份代码、同一个 seed、只差灾厄」的对照批。
   * 灾厄是纯 seed 派生的，所以「关掉它」只需让 calamityAt 恒返回 null：
   * 五处下游调用点自动全关，且不改变任何随机数的消耗。
   *
   * 与 switches.ts 的应急开关分开：那些是封测热修（净化半价之类），
   * 这一条是**跑批口径**，默认永远 on。
   */
  if (process.env.M214_CALAMITY === 'off') applyNumericOverrides({ calamity: { enabled: false } });

  // W5 运维：配置校验放最前面，坏配置不该把服务带起来
  validateNumericOrThrow();

  const db = openDatabase(config.dbPath);
  const applied = migrate(db);
  if (applied.length > 0) logger.info('已应用迁移', { files: applied });

  // 内容错误不带进线上：有 error 级 lint 问题直接拒绝启动
  const { cards, fragments } = loadCardsOrThrow();
  const engine = new EventEngine(cards);
  logger.info('事件卡已加载', { count: cards.length, fragments: Object.keys(fragments).length });

  // 内容数据（物品/地点/配方）：交叉引用校验通过后播种进库
  /*
   * 标签文案表（M2.56）：从内容层加载，注入给 domain/menu/phrases.ts。
   *
   * **用 OrThrow 的语义** —— 文案里没有它自己的标签词就直接让服务起不来。
   * 理由与 loadContentOrThrow 完全一样：判定层按关键词匹配算消化度，
   * 文案少了那两个字，玩家选了不涨分，而这件事**不会报任何错**。
   * 静默失效比启动失败难查一百倍。
   */
  const tagPhrases = loadTagPhrases();
  const tagPhraseErrors = tagPhrases.issues.filter((issue) => issue.level === 'error');
  if (tagPhraseErrors.length > 0) {
    throw new Error(
      '标签文案表有问题（' + tagPhraseErrors.length + ' 条）：\n' +
        tagPhraseErrors.map((issue) => '  ' + issue.message).join('\n'),
    );
  }
  installTagPhrases(tagPhrases.table);

  /*
   * ⚠️ content 与下面那几个内容索引都是 `let` —— 它们要能被**热重载**替换。
   *
   * 后台的数据编辑器改完 src/data/*.yaml 之后会调 reloadContent()（见 createApp 尾部），
   * 而 RouterDeps 里那几个索引字段是 **getter**（读的正是这些变量）——
   * 于是判定层下一次读 deps.geo 就拿到了新的那份，不需要重启进程。
   *
   * 这条链上任何一环写回 `const`，热重载就会静默失效（改了没反应），
   * 而那正是这个项目在适配器那边已经踩过一次的坑（见 admin/index.ts 的注释）。
   */
  let content = loadContentOrThrow({ cardIds: new Set(cards.map((card) => card.id)) });
  /*
   * M2.65：物品的**内容索引**（含 variants）。与 items 仓储并存不是重复：
   * 仓储是「库里的投影」（名字 / 能否交易 / 使用效果），索引是「YAML 里那一份」
   *（还有变体 —— 库里没这一列）。.行动 的改装 / 总装读索引，别的一律照旧读仓储。
   */
  let itemIndex = new ItemIndex(content.items);
  const items = new ItemRepo(db);
  const locations = new LocationRepo(db);
  const recipes = new RecipeRepo(db);
  items.seed(content.items);
  locations.seed(content.locations);
  recipes.seed(content.recipes);
  const abilities = new AbilityRepo(db);
  abilities.seed(content.abilities);
  // M2.7：世界地理。三张表与 locations 一样是 YAML 的投影（改内容改 YAML，重启即生效）；
  // GeoIndex 是给判定层用的只读索引 —— 出生派生、城市过滤、路线查询全部读它。
  const regions = new RegionRepo(db);
  const cities = new CityRepo(db);
  const routes = new RouteRepo(db);
  const travels = new TravelRepo(db);
  regions.seed(content.regions);
  cities.seed(content.cities);
  routes.seed(content.routes);
  let geo = new GeoIndex(content.regions, content.cities, content.routes);
  // M2.7.6 / M2.85：本地势力的只读索引（与 GeoIndex 同性质：纯数据、无 IO）
  let initiationIndex = new InitiationIndex(content.factions);
  /*
   * M2.15：正神教会的只读索引。
   *
   * ⚠️ **不落库** —— 与 factions.yaml 的 InitiationIndex 一样只在内存里。
   * 教会骨架不随世界演化；会演化的那一半（据点的扩张 / 收缩）是纯函数现场算的。
   */
  let churchIndex = new ChurchIndex(content.churches, content.cities, content.locations);
  /*
   * M2.8：非凡生物。
   *
   * 与前面几张表的**关键分别**：其它内容表（items / locations / recipes …）
   * 都是「YAML 的投影」，每次启动覆盖式重播种；
   * 而 creatures **不是纯内容表** —— 它是世界状态（那只生物此刻在哪、还剩多少血），
   * 一旦被重启重置，「世界一直在动」这件事就是假的。
   * 所以：物种模板每次覆盖式重播种（内容改了要生效），生物**实例**只在库里一只都没有时才播种。
   */
  const creatures = new CreatureRepo(db);
  /*
   * M2.167：形态池与物种索引**必须在这里合并**。
   *
   * 它原来在 659 行才加载 —— 而物种索引在这一行就建好了，
   * 于是「堕落生物也是一种物种」这件事对生态 tick（读 creatureIndex.all()）不成立；
   * 不报错，只是那些怪物没有模板：打死它读不到掉落，遭遇也退化成兜底。
   */
  const lostControlPool = loadLostControlOrThrow();
  let creatureIndex = new CreatureIndex(
    withFallenSpecies(content.creatures, content.fallenBeasts, lostControlPool.forms),
  );
  /*
   * M2.61：初始历史 —— 「历史生成现在」真正发生的地方。
   *
   * ⚠️ **必须排在 zoneIndex / powerIndex 之前**：
   * 历史压出来的四份「现在」要喂给它们（地点伤痕 → 域参数偏移；
   * 势力旧仇 → 属地关系）。顺序反了的话，历史就只是躺在那里的文本。
   *
   * 四份：势力旧仇 / 地点伤痕 / 封印物 / 禁忌知识。
   * 前两份接进判定，后两份本轮只落数据（见交付说明 §五）。
   */
  /*
   * M2.72：**索引同时带上「埋在地点下的封印物」** —— 探索结算要读它
   *（`historyIndex.sealedAt(locationId)`）。历史索引在此之前只回答「这里有过什么事」，
   * 现在也回答「这底下埋着什么」。
   *
   * ⚠️ `historyFacts` 因此要**先算**（它原本在下面几行才算）：它是纯函数，
   *    提前算不影响任何既有顺序，而这一个参数让「后两份只落数据」的那条账少了一半。
   */
  const historyFacts = historyEffects(content.history);
  let historyIndex = new HistoryIndex(content.history, historyFacts.sealed);
  /*
   * M2.62：边界索引（哪条边挨着外面、对面是谁）。
   *
   * 与 zoneIndex / powerIndex 并列：一个回答「这块地方的世界是什么脾气」，
   * 一个回答「这块地方归谁管」，一个回答「这块地方挨着谁」。
   */
  let boundaryIndex = new BoundaryIndex(content.boundaries, content.foreignPowers);
  /*
   * 地点伤痕 → 两张表的两种改法：
   *
   *   1. **危险度加成**落到内容对象上（在这里改一次，播种与判定都跟着变）——
   *      「大雾灾之后那片街区更危险了」必须对所有读 danger 的地方成立，
   *      而不是只在某一个判定里成立。
   *   2. **域参数偏移**交给 ZoneIndex（它本来就管「这块地方的世界是什么脾气」）。
   *
   * 夹在 0—5：danger 的合法区间是 0—5，而历史不该把它推出界。
   */
  const scarByLocation = new Map(historyFacts.scars.map((scar) => [scar.location, scar]));
  const zonePatches = new Map<string, ZonePatch>();
  for (const scar of historyFacts.scars) zonePatches.set(scar.location, scar.zonePatch);
  const bucketedLocations = content.locations.map((location) => {
    const scar = scarByLocation.get(location.id);
    if (scar === undefined || scar.dangerBonus === 0) return location;
    return { ...location, danger: Math.min(5, location.danger + scar.dangerBonus) };
  });
  /*
   * 危险度加成要真的落进 locations 表：判定层读的是库里的那一行，
   * 而不是 content.locations 这个内存对象。
   *
   * 重新播种一次而不是把上面的播种往后挪：
   * locations.seed 是**覆盖式且幂等**的（本来就是每次启动全量重写），
   * 所以在历史算完之后再播一次，结果与「一开始就播带伤痕的那份」完全相同，
   * 而不用把整个初始化顺序重排（那会牵动 churchIndex 等一串读 content.locations 的地方）。
   */
  const scarredCount = bucketedLocations.filter(
    (location, index) => location.danger !== content.locations[index]!.danger,
  ).length;
  if (scarredCount > 0) locations.seed(bucketedLocations);
  /*
   * M2.58 阶段二：生态域索引（地点 → 域 → 生态参数）。
   *
   * 与 creatureIndex 并列：物种索引回答「这是什么生物」，
   * 域索引回答「这块地方的世界是什么脾气」。
   * 内容表没写 zones 段时 zones 是空数组，ZoneIndex.of() 一律 undefined，
   * 于是生态 tick 走全局基线 —— 与加这一层之前逐位相同。
   *
   * M2.61：第二个参数是历史伤痕压出来的域参数偏移（空表 = 没有历史）。
   */
  let zoneIndex = new ZoneIndex(content.zones, zonePatches);
  /**
   * M2.68：关系的**三层合并 + 按势力分组**（**一处定义**，启动与热重载共用）。
   *
   *   ① powers.yaml 的默认外交底图（内容）
   *   ② history.yaml 压出来的旧仇（历史 —— 「实际发生过什么」）
   *   ③ power_relations 表（运行时 —— GM 或剧情改的）
   *
   * ⚠️ 第三层是这一轮加的。在此之前那张表**只被后台的只读页面读**（admin/world.ts），
   * 判定层完全看不到它 —— 而 powers.yaml 的文件头早就写着
   * 「stance 与 relations 是默认值，会被运行时状态覆盖（power_relations 表）」。
   * 那句话在此之前是**不成立的**：写进去的关系不会改变任何玩法。
   *
   * 现在：GM 写一条 → 热重载/重启后真的进判定（与历史旧仇走同一条链，只是优先级更高）。
   */
  const relationsByPowerOf = (
    powers: readonly { id: string; relations: ReadonlyArray<{ to: string; kind: PowerRelationKind }> }[],
    facts: readonly HistoryRelation[],
  ): Map<string, Array<{ to: string; kind: PowerRelationKind }>> => {
    const runtime = new PowerRelationRepo(db)
      .all()
      .map((relation) => ({
        from: relation.fromPowerId,
        to: relation.toPowerId,
        kind: relation.kind,
        // 与历史同形：这条关系的出处（合并按 from+to 去重，后者覆盖前者）
        because: '运行时改写',
      }));
    /*
     * ⚠️ **合并前先归一化方向**（M2.68 实测踩到的一处真 bug）。
     *
     * 盟友与敌对是**无序对**：内容表里 police→gang 与 gang→police 各写了一次 hostile，
     * 而运行时那一层只写一个方向（GM 写「gang→police = ally」）。
     * 按方向合并的话，police→gang 那一条 hostile **还在**，
     * 于是 index 里的「同一对冲突时敌对优先」会把它判成敌对 ——
     * **GM 改完什么也没发生**（一个「写着能覆盖、实际覆盖不了」的洞）。
     *
     * 归一化之后：一对势力在合并结果里只剩一条，层与层之间由先后顺序决定谁赢
     * （内容 → 历史 → 运行时），运行时那一层因此真的说了算。
     * 人情（debt）**不归一化** —— 它是单向的亏欠，方向就是它的全部含义。
     */
    const canonical = (entry: { from: string; to: string; kind: PowerRelationKind; because?: string }): {
      from: string;
      to: string;
      kind: PowerRelationKind;
      because: string;
    } =>
      entry.kind === 'debt' || entry.from < entry.to
        ? { ...entry, because: entry.because ?? '内容表默认关系' }
        : { from: entry.to, to: entry.from, kind: entry.kind, because: entry.because ?? '内容表默认关系' };

    const merged = mergeWithDeclaredRelations(
      powers
        .flatMap((power) =>
          power.relations.map((relation) => ({ from: power.id, to: relation.to, kind: relation.kind })),
        )
        .map(canonical),
      [...facts, ...runtime].map(canonical),
    );
    const byPower = new Map<string, Array<{ to: string; kind: PowerRelationKind }>>();
    const add = (owner: string, to: string, kind: PowerRelationKind): void => {
      const list = byPower.get(owner) ?? [];
      list.push({ to, kind });
      byPower.set(owner, list);
    };
    for (const relation of merged) {
      add(relation.from, relation.to, relation.kind);
      // 归一化把方向抹平了，这里**双向展开**回来（盟友与敌对本来就是对等的）
      if (relation.kind !== 'debt') add(relation.to, relation.from, relation.kind);
    }
    return byPower;
  };

  /*
   * M2.59：文明势力索引（势力 → 属地判定）。
   *
   * 属地是**两级**的，所以这里喂进去两个查法：
   *   territoryOf     —— M2.6 的领地（那 4 家里有 3 家有逐点名单）
   *   regionOfLocation—— 地点所属区域（教会与王室按区域算主场）
   * 领地仍然只有一处定义（numeric.factionTerritory），这里只是转成查法。
   *
   * M2.61：势力表喂的是**合并后的关系** —— 历史写的是「实际发生过什么」，
   * 比 powers.yaml 的默认外交底图更该算数，所以历史覆盖同名的那几条，
   * 而没被历史提到的默认关系原样保留。
   */
  const relationsByPower = relationsByPowerOf(content.powers, historyFacts.relations);
  // 合并后的关系**条数**（内容默认 → 历史 → 运行时，后者覆盖前者）—— 只用于启动日志
  const mergedRelationCount = [...relationsByPower.values()].reduce((sum, list) => sum + list.length, 0);
  let powerIndex = new PowerIndex(
    content.powers.map((power) => ({
      ...power,
      relations: relationsByPower.get(power.id) ?? [],
    })),
    (powerId) => territoryOf(powerId),
    (locationId) => geo.cityOfLocation(locationId)?.region_id ?? null,
  );
  // M2.9：PVE 战斗的状态机（未决战斗 + 回合记录）
  const battles = new BattleRepo(db);
  logger.info('文明势力已装载', {
    powers: powerIndex.size,
    // 势力关系条数（三层合并后：默认底图 + 历史旧仇 + 运行时改写）
    relations: mergedRelationCount,
  });
  logger.info('边界输入已装载', {
    boundaries: boundaryIndex.size,
    foreignPowers: content.foreignPowers.length,
    // 三种边界各几条（港口 / 边境 / 裂隙）
    ports: content.boundaries.filter((boundary) => boundary.kind === 'port').length,
    rifts: content.boundaries.filter((boundary) => boundary.kind === 'rift').length,
  });
  logger.info('初始历史已装载', {
    events: historyIndex.size,
    // 四份「现在」各自的条数 —— 为 0 说明那张历史表没有真的改变什么
    relations: historyFacts.relations.length,
    scars: historyFacts.scars.length,
    sealed: historyFacts.sealed.length,
    taboos: historyFacts.taboos.length,
    // 有多少个地点的危险度真的被历史改过（0 = 历史没接进危险度）
    scarredLocations: scarredCount,
  });
  logger.info('生态域已装载', {
    zones: zoneIndex.zones.length,
    // 域覆盖到的地点数：少于地点总数说明还有地方落在全局基线上（这是允许的）
    covered: zoneIndex.size,
  });
  logger.info('非凡生物已装载', {
    species: creatureIndex.count(),
    // 栖息地覆盖到的地点数：为 0 的话整个世界都不会有生物（内容表会在加载时报错）
    habitats: new Set(content.creatures.flatMap((species) => species.habitat)).size,
  });
  logger.info('世界地理已播种', {
    regions: regions.count(),
    cities: cities.count(),
    routes: routes.count(),
    birthCities: geo.birthCities().length,
  });
  logger.info('本地势力已装载', {
    factions: initiationIndex.count(),
    // 每座能出生的城市都必须有本地势力：没有的话那里的玩家翻不到线索（内容表会在加载时报错）
    citiesCovered: content.cities.filter((city) => initiationIndex.factionsOfCity(city.id).length > 0).length,
  });
  logger.info('正神教会已装载', {
    churches: churchIndex.count(),
    // 途径**已实现**的那几家 —— M2.16 的入教只会看到这一批
    bound: churchIndex.bound().map((church) => church.id).join(','),
    // 途径**待定**的那几家：内容表已声明，等途径实现之后搬进 pathway
    pending: churchIndex.pending().length,
  });
  const community = loadCommunity();
  if (community.issues.length > 0) {
    logger.warn('运营物料有问题', { issues: community.issues });
  }
  logger.info('内容数据已播种', {
    items: content.items.length,
    locations: content.locations.length,
    recipes: content.recipes.length,
    abilities: content.abilities.length,
    lostControlTexts: lostControlPool.all.length,
  });

  // M2.2：世界时钟与地区天气。世界 tick 由三处驱动：启动补跑、定时器、以及每条指令前的惰性推进
  const world = new WorldRepo(db);
  world.ensure(now(), config.worldSeed ?? 'world');
  // M2.4：世界公共事件流（world_events）。世界种子是**全局一个**（config.worldSeed），
  // 事件由它派生 —— 分片跑时 4 片共用同一个种子，看到的是同一串事件。
  const worldEvents = new WorldEventRepo(db);
  // M2.6：势力范围（factions）。四家势力 × 十一个地点，来源是 numeric.factionTerritory
  const factionRepo = new FactionRepo(db);
  factionRepo.seed(FACTIONS);
  logger.info('势力范围已播种', {
    factions: factionRepo.count(),
    police: territoryOf('police').length,
    church: territoryOf('church').length,
    gang: territoryOf('gang').length,
    none: territoryOf('none').length,
  });

  /** 世界播报的实际投递（所有主动消息都从这里出网） */
  /*
   * M2.86：世界播报**不带信息头**（用户：「主动推送不应该带信息头」）。
   *
   * 信息头本来是给「某玩家发了一条指令」的回执用的（头像 + 昵称 + 地点），
   * 而世界播报是世界在说话、不是某个玩家在说话 —— 上面顶一个玩家头像
   * 会让人以为那条是「他自己的消息」。
   *
   * 但注意：这个头**不是这里加上的**。`#buildReplyBody` 会从被动回复凭证里
   * 取 `ticket.userId` 生成头像直链 —— 而主动推送根本没有凭证。
   * 所以真正要改的是通道侧（见 qq-official 的 sendProactive）。
   */
  /*
   * M2.87：**一次重试。**
   *
   * 用户实测：某个群一直 `fetch failed`（连 TCP 都没建起来），而同一时刻另外两个群成功。
   * 这类失败**绝大多数是瞬时的** —— 一次重试就能救回大半，而重试的代价只是 600ms。
   *
   * ⚠️ **只重试一次**，而且只在网络层失败时重试：
   *   · 重试太多次会把「平台侧真的坏了」演成「消息延迟几分钟」；
   *   · 业务错误（机器人非群成员 / 无权限）重试一万次也没用，那是**永久失败**，
   *     走下面的 `forgetGroup` 逻辑。
   */
  /*
   * ⚠️ M2.113：**改成串行**（用户报「主动推送依旧只有一个群成功」）。
   *
   * 原来的写法是 fire-and-forget：`for (const groupId of groups) sendGroupText(...)`
   * ⇒ **所有群同一瞬间出网**。而 M2.87 查出的根子是「这台机器的路由器 DNS 会间歇性掐连接」
   * （happy-eyeballs 走 `dns.resolve*` ⇒ 报成 `ECONNREFUSED`）——
   * 三个群同时打，正好一起撞上那把不稳的闸，于是**三个全失败**。
   *
   * 串行 + 群之间 400ms：同一个时刻只有一个出网请求，DNS 那一步不再被并发放大。
   * 代价是三个群的播报要花 1.2 秒 —— 与「世界在说话」这件事完全相容。
   */
  const BROADCAST_GAP_MS = 400;
  /** 重试的三次退避（M2.113：原来只有一次 600ms —— 用户日志显示那一次也全失败） */
  const RETRY_DELAYS_MS = [600, 2000, 6000] as const;
  let broadcastQueue: Promise<void> = Promise.resolve();
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); });
  /** 主动推送的唯一出口（见调用点的说明） */
  const sendProactive = async (groupId: string, text: string, buttons?: BroadcastButton[]): Promise<void> => {
    if (deps.adapter.sendProactive) return deps.adapter.sendProactive('group', groupId, text, buttons);
    return deps.adapter.sendGroup(groupId, text, null, buttons);
  };
  const sendGroupText = (groupId: string, text: string, buttons?: BroadcastButton[]): void => {
    broadcastQueue = broadcastQueue.then(async () => {
      try {
        /*
         * M2.125：主动推送的**唯一出口**。
         *
         * 通道自己实现了 `sendProactive` 就用它（QQ 官方那边就是「不带凭证」那条路，
         * 见 #buildProactiveBody）；没实现的老通道回退到 `sendGroup(..., null, ...)` ——
         * 在 QQ 官方那边这**同样是**不带凭证的路径（`header === null` ⇒ 主动消息体）。
         *
         * 名字写显式，是为了别让下一个人顺手把 `null` 改成某个 header：
         * 那会把播报从「主动消息」变成「借玩家凭证」，而症状是玩家自己的回执发不出来。
         */
        await sendProactive(groupId, text, buttons);
      } catch (error) {
        handleSendFailure(error, groupId, text, buttons);
      }
      await sleep(BROADCAST_GAP_MS);
    });
  };

  /** 一次失败的处置（重试 / 永久失败摘群 / 日志）—— 从原来的 catch 里搬出来，行为不变 */
  const handleSendFailure = (error: unknown, groupId: string, bodyText: string, buttons?: BroadcastButton[]): void => {
    /*
     * ⚠️ M2.114：**先把「不是网络问题」的那一类挑出来**（用户提的：不该只往 DNS 上想）。
     *
     * 两类失败长得完全不一样，处置也完全不一样：
     *
     *   ① `NoReplyTicketError` —— **回复条数用光**（同一个 msg_id 群聊最多回 5 条、单聊 4 条）。
     *      ⇒ **重试没有意义**：同一张凭证的额度不会因为等待而恢复。
     *
     *      ⚠️ M2.115 更正：这一类**与「权限」无关**。曾经这里写着「主动推送要单独申请权限，
     *      本项目未申请」—— 那是**错的**（官方：主动消息「无任何条件」）。
     *      现在没有凭证时直接退化成主动消息，不再抛错。
     *
     *   ② 网络层（`fetch failed` + cause 是 ECONNREFUSED / ETIMEDOUT / ENOTFOUND…）——
     *      请求**真的发出去了**，死在连接或 DNS 上。这一类才值得退避重试。
     *
     * 判据用具体错误类（`instanceof`），不靠字符串匹配 ——
     * 那条错误信息以后可能改字，而类型不会。
     */
    if (error instanceof NoReplyTicketError) {
      logger.warn('世界播报失败：没有主动推送凭证（不是网络问题，重试无意义）', {
        groupId: groupId.slice(0, 8),
        reason: error.message.slice(0, 160),
        hint: '同一张被动回复凭证的条数用光了（群聊 5 条 / 单聊 4 条）—— 重试无意义',
      });
      return;
    }
      /*
       * M2.87：**把 `cause` 也打出来。**
       *
       * 用户实测的日志里只有一句 `error: 'fetch failed'` —— 而 `fetch failed` 是
       * Node 的 `fetch` 在最外层包的一句通用话，**真正的原因在 `error.cause` 里**：
       *   ENOTFOUND      域名解析不了（网络断了 / DNS 挂了）
       *   ECONNRESET     连接被重置（常见于机器人已被移出该群）
       *   ETIMEDOUT      超时（网络慢，或平台侧没响应）
       *   ECONNREFUSED   连接被拒
       *
       * 四种原因的处置完全不同（等一等 / 把机器人拉回来 / 查网络），
       * 而只打最外层那句话时它们长得一模一样 —— 排查只能靠猜。
       */
      /*
       * M2.87：**永久失败就把这个群摘掉。**
       *
       * 用户实测日志里有两个群在失败，而它们是两种性质：
       *   · `74282908…` → QQ API 回 code 11293「机器人非群成员」—— **永久**；
       *   · `5A292831…` → `fetch failed` —— **临时**（网络层）。
       *
       * 前者留着没有任何意义：每次播报都重试、每次都失败、日志被刷满，
       * 而真正需要被看见的那条（临时失败）反而淹在里面。
       *
       * 判据取平台原文里的「非群成员」与 code 11293：**认平台说的话，不猜。**
       */
      const text = (error as Error).message;
      const gone = text.includes('非群成员') || text.includes('11293') || text.includes('40034101');
      if (gone) {
        const removed = world.forgetGroup(groupId, now());
        logger.warn('机器人已不在该群，已从播报列表移除', {
          groupId: groupId.slice(0, 8),
          removed,
          groups: world.groups().length,
        });
        return;
      }
      /*
       * M2.87：**把整个 error 摊开。**
       *
       * 用户报的现场：一个群`fetch failed`、没有 `cause` —— 也就是**连 TCP 都没建起来**，
       * 而同一时刻给另外两个群发是成功的（所以不是本机网络整体断了）。
       *
       * 上一版只打了 `message` 和 `cause`，而这次 cause 是空的 —— 于是信息为零。
       * 所以现在把 error 上**所有自带的字段**都摊出来：`name` / `errno` / `syscall` /
       * `code` / `cause`，以及一个兜底的字符串化。
       *
       * 为什么值得摊这么开：这类错误**只出现一次、无法复现**，
       * 而日志是唯一的现场。少打一个字段，下次还得再问一轮。
       */
      const e = error as { name?: string; message?: string; errno?: unknown; syscall?: unknown; code?: unknown; cause?: unknown };
      const cause = e.cause;
      const causeInfo =
        cause !== undefined && cause !== null && typeof cause === 'object'
          ? (cause as { code?: unknown; errno?: unknown; syscall?: unknown; message?: unknown })
          : undefined;
      logger.warn('世界播报发送失败', {
        groupId: groupId.slice(0, 8),
        name: e.name ?? '(无)',
        error: e.message ?? String(error),
        // 错误对象自带的技术字段：有就全打，没有就一个都不打
        ...(e.errno !== undefined ? { errno: String(e.errno) } : {}),
        ...(e.syscall !== undefined ? { syscall: String(e.syscall) } : {}),
        ...(e.code !== undefined ? { code: String(e.code) } : {}),
        ...(causeInfo !== undefined
          ? {
              cause: String(causeInfo.code ?? causeInfo.message ?? cause).slice(0, 80),
              ...(causeInfo.errno !== undefined ? { causeErrno: String(causeInfo.errno) } : {}),
              ...(causeInfo.syscall !== undefined ? { causeSyscall: String(causeInfo.syscall) } : {}),
            }
          : cause !== undefined
            ? { cause: String(cause).slice(0, 80) }
            : {}),
        // 兜底：某些错误（如跨 realm 的）上面那些字段一个都取不到
        ...(e.errno === undefined && e.code === undefined && cause === undefined
          ? { raw: String(error).slice(0, 160) }
          : {}),
      });
      /*
       * 网络层失败 → **隔 600ms 再试一次**。
       *
       * 判据是「不是业务错误」：平台明确回话的（非群成员 / 无权限 / 参数错）重试无意义，
       * 而那些连 cause 都没有的 `fetch failed` 恰恰最可能是瞬时的。
       */
      /*
       * ⚠️ M2.113：**重试三次、退避加大**（原来只重试一次、固定 600ms）。
       *
       * 依据是用户这一轮的日志：三个群**同时** ECONNREFUSED，而 600ms 后那一次重试
       * 也全部失败 —— 说明那把不稳的闸不是一个瞬间，而是一小段窗口。
       * 600ms / 2s / 6s 三次能把窗口跨过去，总代价 8.6 秒（播报晚到几秒，无所谓）。
       */
      void retrySend(groupId, bodyText, buttons, 0);
  };

  /** 网络层失败的重试（退避 600ms / 2s / 6s） */
  const retrySend = async (
    groupId: string,
    text: string,
    buttons: BroadcastButton[] | undefined,
    attempt: number,
  ): Promise<void> => {
    if (attempt >= RETRY_DELAYS_MS.length) {
      /*
       * M2.171：**重试全失败 ⇒ 把这个群从播报列表里摘掉**。
       *
       * 用户口径：「倘若有发送失败的群 ID，将其删除」。
       *
       * 为什么这条是对的：一个**一直发不进去**的群留在列表里没有任何用处 ——
       * 每次播报都重试三次、每次都失败、日志被刷满，而真正需要被看见的那条
       * （某个还能收到的群失败了）淹在里面。
       *
       * ⚠️ 代价是**一次网络抖动就可能丢群** —— 而这是可以接受的，因为：
       *   对方群里**只要有人说一句话**，`touchGroup` 立刻会把它登记回来
       *   （见 router/index.ts 的「群的登记必须在任何 return 之前」）。
       *   也就是说这张表是**自愈**的：丢掉的群会自己回来，收不到的群不会赖着不走。
       */
      const removed = world.forgetGroup(groupId, now());
      logger.warn('世界播报重试全部失败，已从播报列表移除', {
        groupId: groupId.slice(0, 8),
        removed,
        groups: world.groups().length,
        hint: '那个群再说一句话就会重新登记（touchGroup）—— 这张表是自愈的',
      });
      return;
    }
    await sleep(RETRY_DELAYS_MS[attempt]!);
    try {
      await deps.adapter.sendGroup(groupId, text, null, buttons);
    } catch (again) {
      logger.warn('世界播报重试仍然失败', {
        groupId: groupId.slice(0, 8),
        attempt: attempt + 1,
        error: (again as Error).message.slice(0, 120),
      });
      await retrySend(groupId, text, buttons, attempt + 1);
    }
  };

  /**
   * M2.39 任务 2：**主动消息限流**。
   *
   * 配额被打爆的根因是「同一 tick 内逐条推」（已由任务 1/3 的合并解决）；
   * 剩下的风险在**加速跑批**：连续 tick 时播报仍会一条接一条地出网。
   * 这里给每个群一个令牌桶（capacity 1、每分钟补 1），超限的入队攒批、下一分钟并成一条发。
   *
   * key 用 `group_openid`（也就是 world.groups() 里的那个字符串）——
   * QQ 官方通道的群标识是 openid，OneBot 那边是群号，两者在这里都只是不透明字符串。
   */
  const broadcastThrottle = new BroadcastThrottle();

  const flushBroadcasts = (): void => {
    for (const item of broadcastThrottle.flush(now())) sendGroupText(item.groupId, item.text, item.buttons);
  };

  /** 显著天气的全群播报：发给所有见过的群（world_state.groups_json 维护） */
  const broadcast = (text: string, buttons?: BroadcastButton[]): void => {
    /*
     * 先把到点的积压发掉。
     *
     * 定时器只在 ops 打开时跑（它是运维服务），而 startOps=false 的跑批 / 实例测试里
     * 一条事件都不该被静默丢掉 —— 所以再给一条**惰性**出口：只要世界还在说话，
     * 积压就会在它下一条播报之前被冲掉。
     */
    flushBroadcasts();

    const groups = world.groups();
    if (groups.length === 0) return;
    const at = now();
    let queued = 0;
    for (const groupId of groups) {
      if (broadcastThrottle.offer(groupId, text, at, buttons) === 'sent') sendGroupText(groupId, text, buttons);
      else queued += 1;
    }
    logger.info('世界播报', {
      groups: groups.length,
      /*
       * M2.87：**把群列出来，不只给个数。**
       *
       * 用户第三次报「只推了两个群」—— 而前两次都只能靠推断回答，因为日志里只有一个数字。
       * 现在这一行能直接回答「当时列表里是谁」：与「哪几个群收到了」一对照，
       * 缺的那个是**没登记**还是**发送失败**，一眼分得开。
       *
       * 只取前 8 位：openid 太长会把一行日志撑到看不清，而前 8 位已经够区分。
       */
      ids: groups.map((g) => g.slice(0, 8)),
      // 被限流攒批的群数：正常运行恒为 0，加速跑批时才 > 0（排查配额问题时看它）
      ...(queued > 0 ? { queued } : {}),
      head: text.split('\n')[0] ?? '',
    });
  };

  const router = new CommandRouter({
    db,
    characters: new CharacterRepo(db),
    idempotency: new IdempotencyStore(db),
    rateLimiter: new RateLimiter(deps.rateLimits),
    audit: new AuditLog(db),
    queue: new KeyedQueue(),
    sensitive: new SensitiveFilter(),
    tagUsage: new TagUsageRepo(db),
    flags: new FlagRepo(db),
    eventTriggers: new EventTriggerRepo(db),
    engine,
    items,
    // M2.63 热重载：同 geo —— getter，后台改完 items.yaml 立刻生效
    get itemIndex() {
      return itemIndex;
    },
    inventory: new InventoryRepo(db),
    locations,
    recipes,
    exploreDaily: new ExploreDailyRepo(db),
    trades: new TradeRepo(db),
    fragments,
    abilities,
    dailyCounters: new DailyCounterRepo(db),
    parties: new PartyRepo(db),
    lostControlPool,
    // M2.76：晋升仪式档位（按序列分档的阶段表）
    ritualProfiles: content.rituals,
    // M2.76：权柄（世界级能力）—— 世界 tick 用它抽「有没有存在出手」
    authorities: content.authorities,
    /*
     * M2.99：**神座**（22 条途径的序列 0）。
     *
     * ⚠️ M2.164：装载点搬进了 `loadContent`（这里只取结果）。
     * 原来写的是 `loadDivineThrones(...).divineThrones` —— **校验结果被丢掉了**：
     * reach 里写着地点 id、factions 里写着哨兵值 none，全都一声不吭地放过去。
     * 现在那些 error 会并进内容 issues，`loadContentOrThrow` 直接让服务端起不来。
     */
    divineThrones: content.divineThrones,
    // M2.169：神座的运行时状态（阴谋会改变「谁坐在那儿」）
    divineThroneState: new DivineThroneStateRepo(db),
    // M2.169：神明阴谋（关系网是依据，阴谋表是状态 —— 它会改神座）
    divineRelations: content.divineRelations,
    divineSchemes: new DivineSchemeRepo(db),
    // M2.169：世界伤痕（神陨落 / 神战在地上留下的东西 —— 探索读它）
    worldScars: new WorldScarRepo(db),
    // M2.169：教会的命运（神的死落到信徒头上）
    churchStates: new ChurchStateRepo(db),
    // M2.169：玩家插手神明阴谋的账（.神战 写它）
    divineMeddling: new DivineMeddlingRepo(db),
    // M2.170：神位争夺（空出来的位置）
    throneContests: new ThroneContestRepo(db),
    /*
     * M2.168：**神的记忆落库** —— 计划与出手状态跨重启还在。
     *
     * 不注入的话它们落到进程内实现，重启之后：计划链从第三步回到第一步、
     * 沉寂期与手段冷却一起清空 —— 两种都像设计，实际是丢状态。
     */
    divinePlans: new DivinePlansRepo(db),
    divineState: new DivineStateRepo(db),
    // M2.85 内容填充 P1：塔罗牌（.占卜 的牌面来源）
    tarot: content.tarot,
    // M2.85 内容填充 P1：神明（.图鉴 神明）
    pantheon: content.pantheon,
    // M2.85 内容填充 P1：组织与势力（.图鉴 组织）
    organizations: content.organizations,
    // M2.85 内容填充 P1：人物（.图鉴 人物）
    figures: content.figures,
    // M2.85 内容填充 P1：生物名录（.图鉴 生物）
    bestiary: content.bestiary,
    // M2.85 内容填充 P1：权柄与象征（.图鉴 权柄）
    divineAuthorities: content.divineAuthorities,
    // M2.85 内容填充 P6：晋升仪式要求（.仪式 准备）
    advancementRites: content.advancementRites,
    // M2.85 内容填充 P4：原作材料全表（.图鉴 材料）
    originalMaterials: content.originalMaterials,
    // M2.85 内容填充 P5：原作能力清单（.图鉴 能力）
    pathwayAbilities: content.pathwayAbilities,
    // M2.85 世界演化：NPC 晋升轨道（.图鉴 途径）
    npcTracks: content.npcTracks,
    /*
     * M2.164：**世界居民名册**（120 位：巡警、码头工、教士、医生……）。
     *
     * `npcRoster` 是两张表的**统一查询入口** —— 命令层只认它，不许自己去 find。
     */
    npcCast: content.npcCast,
    npcRoster: new NpcRoster(content.npcTracks, content.npcCast, content.npcDispositions),
    // M2.167：堕落生物（撑不住的堕落者会变成它们中间的一只）
    fallenBeasts: content.fallenBeasts,
    // M2.85 世界演化：NPC 的途径行为（愚者占卜、猎人猎杀、死神收尸……）
    pathwayDeeds: content.pathwayDeeds,
    // M2.85 世界演化：NPC 进度与大事记
    npcProgress: new NpcProgressRepo(db),
    // M2.164：NPC 的生死与堕落（死了就是真的死了 —— 唯一一条回来的路是神明复活）
    npcLife: new NpcLifeRepo(db),
    npcDeeds: new NpcDeedRepo(db),
    // M2.85 世界演化：神位归属（玩家夺位）
    godhood: new GodhoodRepo(db),
    // M2.85 世界演化：NPC 处理世界事件
    eventHandling: new EventHandlingRepo(db),
    // M2.85 RPG 化：NPC 的态度与阴谋
    npcRelations: new NpcRelationRepo(db),
    npcSchemes: new NpcSchemeRepo(db),
    npcDispositions: content.npcDispositions,
    // M2.85 RPG 化 B：装备（穿在身上的 + 内容表）
    equipment: new EquipmentRepo(db),
    equipmentTable: content.equipment,
    // M2.85 RPG 化 C：战斗技能（技能池与内容表合并）
    battleSkillTable: content.battleSkills,
    // M2.85 RPG 化 D：委托（接下的存库里，模板在内容层）
    quests: new QuestRepo(db),
    questTable: content.quests,
    // M2.85：奇遇
    fortuneTable: content.fortunes,
    // M2.87 交易体系：商店（一个商店就是一个地点）+ 物价表
    shops: content.shops,
    prices: content.prices,
    // M2.86：颜色跟着 markdown 能力走（纯文本通道看到 <font> 字面量比不加色更糟）
    /*
     * M2.86：**颜色默认关**（`QQ_BOT_MD_COLOR=1` 才开）。
     *
     * 用户提过「手机端有字体颜色」，但给的截图里那些「颜色」是**纯文本的颜色名**
     * （`填写背景颜色：黄 (ffcc00)`），另一张里同一个 bot 用 LaTeX 上色则**裸着打出来了** ——
     * 两件事都证明不了 `<font color>` 在手机端能渲染。
     *
     * 而 `docs/QQ-markdown-能力实测.md` 有一条旧实测说手机端会**显示成字面量**。
     * 裸标签比不上色难看得多，所以：**默认关，验证通过再开**。
     * 关着的时候信息层次完全不受影响 —— 每条高亮都另有**符号 + 加粗（已去掉）+ 引用块**
     * 在说同一件事（见 adapter/highlight.ts 的 HL_MARKS）。
     */
    /*
     * M2.86：**默认开**（`QQ_BOT_MD_COLOR=0` 才关）。
     *
     * 之前默认关，理由是「官方文档没写颜色、旧实测说手机端不支持」——
     * 用户跑了 `.探针 latex` 之后确认：**`$\textcolor{#RRGGBB}{文字}$` 在手机端是彩色的**，
     * 而 `<font color>` 才会漏原始标签。既然验证过了，就不该再让用户手动开。
     *
     * 关掉的口子留着（`=0`）：万一某些客户端不认 LaTeX，输出仍会逐字退回旧版。
     */
    /*
     * 两个变量都要看：
     *   · LOM_PLAIN_TEXT=1 —— 通道根本不渲染 markdown（BEE 那类上游用这个）；
     *   · QQ_BOT_MD_COLOR=0 —— 原本就有的口子，留给"客户端不认 LaTeX 时逐字退回"。
     * 只要有一个要求纯文本，就出纯文本。
     */
    supportsColor: process.env['LOM_PLAIN_TEXT'] !== '1' && process.env['QQ_BOT_MD_COLOR'] !== '0',
    // 正文样式档：默认 plain（手机端最保险）；QQ_BOT_MD_STYLE=bold-italic 可改用 ***加粗斜体***
    mdStyle: ((): 'plain' | 'bold-italic' | 'keep' => {
      const v = process.env['QQ_BOT_MD_STYLE'];
      return v === 'bold-italic' || v === 'keep' ? v : 'plain';
    })(),
    lostControlEvents: new LostControlRepo(db),
    fingerprint: deps.fingerprint ?? new OneBotFingerprintProvider(),
    dailyTicks: new DailyTickRepo(db),
    cooldowns: new CooldownRepo(db),
    monitor,
    feedback: new FeedbackRepo(db),
    userActivity: new UserActivityRepo(db),
    community,
    switches: loadSwitches(),
    world,
    worldEvents,
    rituals: new RitualRepo(db),
    // M2.6：势力范围与通缉。factions 表的行由 numeric.ts 播种 —— 表是投影，不是第二份真相
    factions: factionRepo,
    wanted: new WantedRepo(db),
    // M2.7：世界地理（区域 / 城市 / 航线 / 行程）
    // M2.63 热重载：getter 而不是值 —— 后台改完内容后 reloadContent() 换掉闭包变量，
    // 判定层下一次读 deps.geo 就是新的一份（详见 createApp 尾部的 reloadContent）
    get geo() {
      return geo;
    },
    regions,
    cities,
    routes,
    travels,
    // M2.7.6：入途径的两条路（内容索引 + 两张运行时表）
    get initiation() {
      return initiationIndex;
    },
    // M2.15 内容 + M2.16 命令层：教会索引（入教判据读它，命令层不读 YAML）
    get churches() {
      return churchIndex;
    },
    // M2.18：势力争夺的增量（归属 = churchTerritoryAt 的 seed 底图 + 这里的 Σ delta）
    churchConflict: new ChurchConflictRepo(db),
    clues: new RecipeClueRepo(db),
    // M2.8：非凡生物（实例仓储 + 物种模板索引）
    creatures,
    get creatureIndex() {
      return creatureIndex;
    },
    // M2.58 阶段二：生态域（地点 → 域参数）—— 生态 tick 读它把全局常量换成域参数
    get zoneIndex() {
      return zoneIndex;
    },
    // M2.59：文明势力（属地判定 + 反应引擎的输入）
    get powerIndex() {
      return powerIndex;
    },
    // M2.62：边界（哪条边挨着外面）
    get boundaryIndex() {
      return boundaryIndex;
    },
    // M2.72：历史索引（getter：热重载换掉闭包变量，探索下一次读就是新的那份）
    get historyIndex() {
      return historyIndex;
    },
    // M2.9：战斗状态机（未决战斗 + 回合记录）
    battles,
    worldSeed: config.worldSeed ?? 'world',
    broadcast,
    // M2.4：MenuService 多认一个来源 —— 玩家没有个人菜单时，数字回复落到世界事件上
    pendingMenus: new MenuService(new PendingMenuRepo(db), worldEvents),
    clock: now,
    logger,
    detailToPrivate: config.detailToPrivate,
    /*
     * M2.47：`.角色` 的两块依赖。
     *
     * 出图服务在这里**只做构造**（记下目录），真正的 PowerShell 渲染发生在
     * 玩家发 `.角色` 的那一刻 —— 启动期不该为一张可能没人要的图付 300ms。
     *
     * 出图目录默认 `data/cards/`：它落在已被 .gitignore 的 `/data/` 之下，
     * 且与头像缓存（`data/avatars/`）同在一处，排查时不用满盘找。
     */
    card:
      deps.card ??
      createCardService({
        ...(config.cardOutDir !== undefined ? { outDir: config.cardOutDir } : {}),
        ...(config.cardArtworkDir !== undefined ? { artworkDir: config.cardArtworkDir } : {}),
        ...(config.cardPublicBaseUrl !== undefined
          ? { publicBaseUrl: config.cardPublicBaseUrl }
          : {}),
        ...(config.cardImageUpload !== undefined
          ? { uploadProvider: config.cardImageUpload }
          : {}),
        ...(config.cardGithubUpload !== undefined
          ? { githubUpload: config.cardGithubUpload }
          : {}),
        logger,
      }),
    adapter: deps.adapter,
  });
  registerW1Commands(router);

  deps.adapter.onMessage(async (msg: InternalMessage) => {
    const started = Date.now();
    const replies = await router.handle(msg);
    await sendReplies(deps.adapter, replies, logger);
    logger.info('指令处理完成', {
      command: msg.rawText,
      userId: msg.userId,
      replies: replies.length,
      costMs: Date.now() - started,
    });
  });

  const opsEnabled = config.startOps !== false;

  // 崩溃恢复：自检 + 解冻超时交易 + 补跑每日结算
  const recovery = opsEnabled
    ? runStartupRecovery(router.deps, now())
    : { integrity: 'ok' as const, pendingTrades: 0, expiredTrades: 0, tickSkipped: true, date: '', notes: ['运维服务已关闭'] };
  logger.info('启动自检完成', {
    integrity: recovery.integrity,
    pendingTrades: recovery.pendingTrades,
    expiredTrades: recovery.expiredTrades,
    tickSkipped: recovery.tickSkipped,
    notes: recovery.notes,
  });

  // 备份：每小时检查一次，当天没备份就备一份（保留 N 天）
  const backupOnce = (): void => {
    try {
      const result = backupDatabase(
        db,
        config.backupDir ?? join(dirname(config.dbPath), 'backups'),
        now(),
        { retainDays: config.backupRetainDays ?? 7 },
      );
      if (result.created) {
        logger.info('数据库备份完成', {
          file: result.file,
          bytes: result.bytes,
          pruned: result.pruned.length,
        });
      }
    } catch (error) {
      logger.error('数据库备份失败', { error: (error as Error).message });
    }
  };
  const backupTimer = setInterval(backupOnce, 60 * 60 * 1000);
  backupTimer.unref?.();
  if (opsEnabled) backupOnce();

  // 审计日志轮转：把过期记录搬到归档表
  const archiveOnce = (): void => {
    try {
      const retainDays = config.auditRetainDays ?? 7;
      const result = archiveAuditLogs(db, now() - retainDays * 24 * 60 * 60 * 1000, now());
      if (result.moved > 0) {
        logger.info('审计日志已归档', {
          moved: result.moved,
          hot: result.hotRemaining,
          archived: result.archivedTotal,
        });
      }
    } catch (error) {
      logger.error('审计日志归档失败', { error: (error as Error).message });
    }
  };
  const archiveTimer = setInterval(archiveOnce, 24 * 60 * 60 * 1000);
  archiveTimer.unref?.();
  if (opsEnabled) archiveOnce();

  // 每日 tick：启动先补跑一次（服务器跨过 0 点没重启的情况），之后每分钟检查
  const tickOnce = (): void => {
    try {
      const summary = runDailyTick(router.deps, now());
      if (!summary.skipped) {
        logger.info('每日结算完成', {
          date: summary.date,
          characters: summary.characters,
          recovered: summary.recovered,
          lostControl: summary.lostControl,
          tradesExpired: summary.tradesExpired,
          eventsPruned: summary.eventsPruned,
        });
        for (const notice of summary.notifications) {
          void deps.adapter.sendPrivate(notice.userId, notice.text).catch((error: unknown) => {
            logger.error('失控通知发送失败', { error: (error as Error).message });
          });
        }
      }
    } catch (error) {
      logger.error('每日结算失败', { error: (error as Error).message });
    }
  };
  // 定时结算属于运维服务：startOps=false（压测 / 实例测试）时必须一起关掉。
  // 否则它会在测试跑到一半时按**真实时间**插进来结算一次（虚拟时钟下就是"凭空恢复 AP/MP"），
  // 同一 seed 两次运行的插入点不同 → 结果不可复现。
  if (opsEnabled) {
    const tickTimer = setInterval(tickOnce, 60 * 1000);
    tickTimer.unref?.();
    if (config.runTickOnStart !== false) tickOnce();
  }

  // M2.2 世界 tick：每 5 分钟推进一次（轻 tick 每小时才真的结算一次，靠 world_ticks 幂等）。
  // 与每日结算一样属于运维服务：startOps=false（压测 / 实例测试）时关掉，
  // 那两种场景改由路由的惰性推进驱动，避免墙上时间插进来破坏可复现。
  let worldTimer: NodeJS.Timeout | null = null;
  /*
   * 运维节奏（`src/data/ops-settings.yaml`，后台可改）——
   * 它决定「世界多久主动说一次话」。读不到就用内置默认值（见 loadOpsSettings）。
   */
  const ops = loadOpsSettings();
  if (opsEnabled) {
    const worldOnce = (): void => {
      try {
        const result = advanceWorld(router.deps, now(), { force: true });
        if (!result.skipped) {
          logger.info('世界 tick 完成', {
            light: result.light.executed,
            heavy: result.heavy.executed,
            changes: result.changes.length,
            timeOfDay: result.clock.timeOfDay,
          });
        }
        for (const item of result.broadcasts) broadcast(item.text, item.buttons);
      } catch (error) {
        logger.error('世界 tick 失败', { error: (error as Error).message });
      }
    };
    /*
     * M2.88：**随机间隔，不是固定轮询。**
     *
     * 改之前是 `setInterval(worldOnce, 5 分钟)`，而世界 tick 内部按整点对齐 ——
     * 于是玩家看到的规律是「每个整点过几分钟，群里必然出现一条【世界异象】」。
     * 而它要营造的是「这个世界自己在动」。**一个能被预测的世界不是活的。**
     *
     * 改法：每次跑完，从 `ops-settings.yaml` 的范围里掷下一次的间隔。
     * 间隔本身有分布，累积两次以上之后任何时刻都不再可预测。
     *
     * ⚠️ **种子是「上一次跑的时刻」**，不是 `Math.random()`：
     * 项目的其余部分（天气、事件、战斗）全是 seed 派生的，跑批必须逐位可复现。
     * 用时钟当种子，同一个 tick 时刻在任何进程里都得到同一个下一次延迟。
     */
    let lastWorldTickAt = now();
    const scheduleWorld = (): void => {
      const delay = nextDelayMs(ops.world_tick, lastWorldTickAt);
      worldTimer = setTimeout(() => {
        lastWorldTickAt = now();
        worldOnce();
        scheduleWorld();
      }, delay);
      worldTimer.unref?.();
    };
    // 启动时先跑一次（跨过停机的那段要补），然后开始掷
    worldOnce();
    scheduleWorld();
    logger.info('世界节奏已定', {
      min: ops.world_tick.min_minutes,
      max: ops.world_tick.max_minutes,
      firstDelayMs: nextDelayMs(ops.world_tick, lastWorldTickAt),
    });
  }

  /*
   * M2.39 任务 2：限流攒批的定时派发（每分钟一次）。
   * 与其它定时器一样属于运维服务：startOps=false 时不起，
   * 那时的兜底是 broadcast() 里的惰性 flush（见它的注释）。
   */
  let broadcastTimer: NodeJS.Timeout | null = null;
  if (opsEnabled) {
    // 出队节拍（5 秒）≠ 长期速率（1 条/分钟，由令牌桶管）—— 见 infra/broadcast.ts 的说明
    broadcastTimer = setInterval(flushBroadcasts, BROADCAST_FLUSH_INTERVAL_MS);
    broadcastTimer.unref?.();
  }

  // 交易超时兜底：指令入口已有懒清扫（走的是可控时钟，可复现），
  // 这个定时器只是防止长期无人操作时交易挂着不清理 —— 同样属于运维服务。
  let tradeSweeper: NodeJS.Timeout | null = null;
  if (opsEnabled) {
    tradeSweeper = setInterval(() => {
      try {
        const expired = expireStaleTrades(router.deps, now());
        if (expired > 0) logger.info('超时交易已清理', { expired });
      } catch (error) {
        logger.error('交易清扫失败', { error: (error as Error).message });
      }
    }, 5 * 60 * 1000);
    tradeSweeper.unref?.();
  }

  /*
   * ==================================================================
   * M2.63：**内容热重载**
   * ==================================================================
   *
   * ## 它解决的那件事
   *
   * 数据编辑器一直是「改完磁盘、人自己去重启进程」。而重启会断网关、
   * 清掉被动回复凭证 —— 玩家那边的表现就是「机器人忽然不理人一会儿」。
   * 这件事**在适配器那边已经修过一次**（见 admin/index.ts 的注释：「改了不用重启进程」），
   * 而数据编辑这一半一直是旧的。
   *
   * ## 为什么它能做到
   *
   * 判定层读的从来不是 YAML，而是**内存索引**（geo / zoneIndex / powerIndex …），
   * 而这些索引全部由上面的 `let` 变量持有，RouterDeps 里对应字段是 **getter**。
   * 于是「重载」= 重新建一份索引 + 换掉那个变量，下一次判定自然读到新的。
   *
   * ## 三条安全约束
   *
   *   1. **有 error 就不换** —— 宁可继续跑旧的（它至少是能跑的），
   *      也不把一份校验不过的内容推进生产；
   *   2. **只重播内容投影**，不动任何世界状态 ——
   *      creatures / world_events / zone_state … 一行都不碰；
   *   3. **失败不抛**，回一份带 errors 的结果 ——
   *      后台要能把它显示给人看，而不是让人对着一个 500 猜。
   */
  function reloadContent(): ContentReloadResult {
    let fresh: ReturnType<typeof loadContent>;
    try {
      fresh = loadContent({ cardIds: new Set(cards.map((card) => card.id)) });
    } catch (error) {
      return { ok: false, rebuilt: [], errors: [(error as Error).message], warnings: [] };
    }
    const errors = fresh.issues.filter((issue) => issue.level === 'error').map((issue) => issue.message);
    const warnings = fresh.issues.filter((issue) => issue.level === 'warn').map((issue) => issue.message);
    if (errors.length > 0) {
      // 有 error 就整份不换：部分替换会让世界处在「一半新一半旧」的状态，那比不换更糟
      return { ok: false, rebuilt: [], errors, warnings };
    }

    // ---- 内容对象 ----
    content = fresh;
    const facts = historyEffects(fresh.history);
    const scarByLoc = new Map(facts.scars.map((scar) => [scar.location, scar]));
    const patches = new Map<string, ZonePatch>();
    for (const scar of facts.scars) patches.set(scar.location, scar.zonePatch);

    // ---- 索引：一个个换掉（顺序有依赖：geo 要在 churchIndex 之前） ----
    const rebuilt: string[] = [];
    geo = new GeoIndex(fresh.regions, fresh.cities, fresh.routes);
    rebuilt.push('geo');
    itemIndex = new ItemIndex(fresh.items);
    rebuilt.push('items');
    initiationIndex = new InitiationIndex(fresh.factions);
    rebuilt.push('initiation');
    churchIndex = new ChurchIndex(fresh.churches, fresh.cities, fresh.locations);
    rebuilt.push('churches');
    creatureIndex = new CreatureIndex(
      withFallenSpecies(fresh.creatures, fresh.fallenBeasts, lostControlPool.forms),
    );
    rebuilt.push('creatures');
    zoneIndex = new ZoneIndex(fresh.zones, patches);
    rebuilt.push('zones');
    // M2.72：热重载也把「埋着什么」带上（否则改完 history.yaml 后挖掘判定还是旧的那份）
    historyIndex = new HistoryIndex(fresh.history, facts.sealed);
    rebuilt.push('history');

    /*
     * 势力关系要重新合并 —— 三层（内容 / 历史 / 运行时），与启动时**同一套算法**
     *（`relationsByPowerOf` 一处定义，K22）。
     * 热重载也要重读 `power_relations`：GM 刚改的那一条应当立刻生效。
     */
    const byPower = relationsByPowerOf(fresh.powers, facts.relations);
    powerIndex = new PowerIndex(
      fresh.powers.map((power) => ({ ...power, relations: byPower.get(power.id) ?? [] })),
      (powerId) => territoryOf(powerId),
      (locationId) => geo.cityOfLocation(locationId)?.region_id ?? null,
    );
    rebuilt.push('powers');
    boundaryIndex = new BoundaryIndex(fresh.boundaries, fresh.foreignPowers);
    rebuilt.push('boundaries');

    /*
     * ---- 内容投影重播种 ----
     *
     * 这几张表是「内容在库里的副本」，本来就是每次启动覆盖式重写的，
     * 所以这里再播一次与「重启一次」结果完全相同。
     *
     * ⚠️ 只播**内容**表。creatures（生物实例）/ world_events / zone_state 这些
     * 是世界状态，重播种会把它们清掉 —— 那是「重启」才会有的副作用，
     * 而热重载的全部意义就是不要那个副作用。
     */
    try {
      const scarred = fresh.locations.map((location) => {
        const scar = scarByLoc.get(location.id);
        if (scar === undefined || scar.dangerBonus === 0) return location;
        return { ...location, danger: Math.min(5, location.danger + scar.dangerBonus) };
      });
      locations.seed(scarred);
      items.seed(fresh.items);
      recipes.seed(fresh.recipes);
      abilities.seed(fresh.abilities);
      regions.seed(fresh.regions);
      cities.seed(fresh.cities);
      routes.seed(fresh.routes);
      factionRepo.seed(FACTIONS);
      /*
       * M2.167：**堕落生物也要播种成物种**（但栖息地为空 = 没有出生点）。
       *
       * 不播种的后果不是报错，而是玩家打死它时读不到模板 —— 遭遇、战斗、掉落
       * 会一起降级成兜底值（而界面上看不出哪里不对）。
       *
       * 而 `habitat: []` 保证生态的两条路（初始播种、按地点的补充池）都不会碰它：
       * 它只由「某个人撑不住」产生。
       */
      creatures.seedSpecies(
        withFallenSpecies(fresh.creatures, fresh.fallenBeasts, lostControlPool.forms),
        now(),
      );
      rebuilt.push('落库：locations/items/recipes/abilities/geo/factions/物种模板');
    } catch (error) {
      // 索引已经换好了，落库失败只影响「重启之后还在不在」—— 要说出来但不回滚
      warnings.push('内容索引已替换，但重播种失败：' + (error as Error).message);
    }

    return { ok: true, rebuilt, errors: [], warnings };
  }

  return {
    config,
    db,
    router,
    adapter: deps.adapter,
    logger,
    geo,
    cards,
    engine,
    monitor,
    setClock: setPinnedNow,
    now,
    reloadContent,
    close: () => {
      // 世界 tick 现在用 setTimeout 自排程（随机间隔），所以 clearTimeout
  if (worldTimer) clearTimeout(worldTimer);
      if (broadcastTimer) clearInterval(broadcastTimer);
      if (tradeSweeper) clearInterval(tradeSweeper);
      clearInterval(backupTimer);
      clearInterval(archiveTimer);
      db.close();
    },
  };
}
