import { MemoryAdapter, type SentMessage } from '../../src/adapter/memory.ts';

/*
 * ⚠️ M2.120：**测试夹具默认关掉「日常遭遇」**。
 *
 * 那个钩子会在玩家做正事时先弹一张卡（设计如此：用户的「每天随机遇到几次」），
 * 而绝大多数用例只关心「这条命令的回执是不是它该有的样子」——
 * 一条遭遇会把回执整条换掉（前 2 条正事各被占一次）。
 *
 * 所以夹具把它设成 0；**需要测遭遇的用例**自己把它改回来（见 m2-120）。
 */
NUMERIC.play.dailyEncounters = 0;

import type { InternalMessage, Scene } from '../../src/adapter/types.ts';
import { NUMERIC } from '../../src/config/numeric.ts';
import { silentLogger, type Logger } from '../../src/infra/logger.ts';
import type { RateLimitConfig } from '../../src/infra/ratelimit.ts';
import type { FingerprintProvider } from '../../src/infra/fingerprint.ts';
import { createApp, type App } from '../../src/main.ts';
import type { CardService } from '../../src/card/service.ts';
import { birthCityOf } from '../../src/domain/geo/index.ts';
import { CURRENCY_ITEM_ID } from '../../src/domain/item/item.ts';
import { FLAG_LOCATION } from '../../src/infra/db/flags.ts';
import { CharacterRepo } from '../../src/infra/db/characters.ts';
import type { CharacterState, PathwayId } from '../../src/domain/character/types.ts';
import { ExploreDailyRepo } from '../../src/infra/db/explore-daily.ts';
import { FlagRepo } from '../../src/infra/db/flags.ts';
import { ChurchConflictRepo } from '../../src/infra/db/church-conflict.ts';
import { InventoryRepo } from '../../src/infra/db/inventory.ts';
import { ItemRepo } from '../../src/infra/db/items.ts';
import { LocationRepo } from '../../src/infra/db/locations.ts';
import { RecipeRepo } from '../../src/infra/db/recipes.ts';
import { TradeRepo } from '../../src/infra/db/trades.ts';
import { PartyRepo } from '../../src/infra/db/parties.ts';
import { AbilityRepo } from '../../src/infra/db/abilities.ts';
import { DailyCounterRepo } from '../../src/infra/db/daily-counters.ts';
import { CooldownRepo } from '../../src/infra/db/cooldowns.ts';
import { DailyTickRepo } from '../../src/infra/db/daily-ticks.ts';
import { EventTriggerRepo } from '../../src/infra/db/event-triggers.ts';
import { TagUsageRepo } from '../../src/infra/db/tag-usage.ts';
import { FeedbackRepo } from '../../src/infra/db/feedback.ts';
import { UserActivityRepo } from '../../src/infra/db/user-activity.ts';
import { WorldEventRepo } from '../../src/infra/db/world-events.ts';
import { RitualRepo } from '../../src/infra/db/rituals.ts';
import { FactionRepo, WantedRepo } from '../../src/infra/db/wanted.ts';
import { CityRepo, RouteRepo, TravelRepo } from '../../src/infra/db/geo.ts';
import { RecipeClueRepo } from '../../src/infra/db/initiation.ts';
import { CreatureRepo } from '../../src/infra/db/creatures.ts';
import { BattleRepo } from '../../src/infra/db/battles.ts';

export interface SendInput {
  rawText: string;
  scene?: Scene;
  userId?: string;
  nickname?: string;
  messageId?: string;
  groupId?: string;
}

export interface HarnessRepos {
  characters: CharacterRepo;
  inventory: InventoryRepo;
  items: ItemRepo;
  locations: LocationRepo;
  recipes: RecipeRepo;
  trades: TradeRepo;
  exploreDaily: ExploreDailyRepo;
  flags: FlagRepo;
  /** M2.18：势力争夺的增量表（归属 = seed 底图 + Σ delta） */
  churchConflict: ChurchConflictRepo;
  parties: PartyRepo;
  abilities: AbilityRepo;
  dailyCounters: DailyCounterRepo;
  cooldowns: CooldownRepo;
  dailyTicks: DailyTickRepo;
  eventTriggers: EventTriggerRepo;
  tagUsage: TagUsageRepo;
  feedback: FeedbackRepo;
  userActivity: UserActivityRepo;
  /** M2.4：世界公共事件（world_events） */
  worldEvents: WorldEventRepo;
  /** M2.5：晋升仪式与干扰（rituals / ritual_interferences） */
  rituals: RitualRepo;
  /** M2.6：势力范围（factions）与通缉令 / 赏金（wanted_states / bounty_claims） */
  factions: FactionRepo;
  wanted: WantedRepo;
  /** M2.7：世界地理（城市 / 航线 / 行程） */
  cities: CityRepo;
  routes: RouteRepo;
  travels: TravelRepo;
  /** M2.7.6：势力引导邀约与配方线索 */
  clues: RecipeClueRepo;
  /** M2.8：非凡生物实例（世界状态）—— 测试里要能直接摆布它们 */
  creatures: CreatureRepo;
  /** M2.9：战斗状态机 —— 测试里要能直接摆布未决战斗（含造一场超时的） */
  battles: BattleRepo;
}

export interface Harness {
  app: App;
  adapter: MemoryAdapter;
  repos: HarnessRepos;
  now(): number;
  advance(ms: number): void;
  send(input: SendInput): Promise<SentMessage[]>;
  /** 返回落库的回复数但不发送到适配器，用于并发压测 */
  deliver(input: SendInput): Promise<number>;
  /** 建号并返回角色（测试准备用） */
  /** M2.19：途径清单跟着 PathwayId 走 —— 加了 sailor 之后这里也必须有它 */
  createCharacter(userId: string, name: string, pathway?: PathwayId): Promise<{ id: string; userId: string }>;
  /**
   * M2.7.6：建一个**普通人**（不校正途径、不校正城市）。
   * 普通人阶段的所有用例都从这里起步 —— 它拿到的就是玩家刚发完 .创建 时的那张卡。
   */
  createMortal(userId: string, name: string, gender?: 'male' | 'female'): Promise<CharacterState>;
}

export const GROUP_ID = '10001';
export const DEFAULT_USER = '20001';

export function createHarness(
  options: {
    detailToPrivate?: boolean;
    rateLimits?: Record<string, RateLimitConfig>;
    /** W4：注入设备指纹来源（默认 OneBot，恒为 null） */
    fingerprint?: FingerprintProvider;
    /**
     * M2.3：id 确定性派生（角色 id / 交易单号 / 队伍号）。
     * 「菜单路径与完整指令路径结果一致」的对照测试必须开它 ——
     * 判定 seed 是 messageId:characterId:now 派生的，角色 id 随机就无从对照。
     */
    deterministicIds?: boolean;
    /** 调试用：默认静默；排查「系统繁忙」这类被路由吞掉的异常时传 consoleLogger */
    logger?: Logger;
    /**
     * M2.47：换成别的通道（例如 `supportsImages: true`），验证图片能力的升降级。
     * 不传就是默认的 MemoryAdapter（不能发图）——那才是内测通道的真实形态。
     */
    adapter?: MemoryAdapter;
    /** M2.47：注入假的出图服务，避免每条用例都真起 PowerShell */
    card?: CardService;
    /** M2.47：真出图时把它指到临时目录，免得往工作区里堆 PNG */
    cardOutDir?: string;
  } = {},
): Harness {
  const adapter = options.adapter ?? new MemoryAdapter();
  let clock = Date.UTC(2026, 8, 21, 12, 0, 0);
  const app = createApp(
    {
      dbPath: ':memory:',
      port: 0,
      onebotApiBase: 'http://127.0.0.1:3000',
      detailToPrivate: options.detailToPrivate ?? true,
      // 每日结算与运维服务由用例显式调用，避免建 harness 时就把当天抢占掉、或写出备份文件
      runTickOnStart: false,
      startOps: false,
      ...(options.deterministicIds ? { deterministicIds: true } : {}),
      ...(options.cardOutDir !== undefined ? { cardOutDir: options.cardOutDir } : {}),
    },
    {
      adapter,
      logger: options.logger ?? silentLogger,
      ...(options.card !== undefined ? { card: options.card } : {}),
      now: () => clock,
      rateLimits: options.rateLimits,
      fingerprint: options.fingerprint,
    },
  );

  let seq = 0;
  const build = (input: SendInput): InternalMessage => {
    const scene = input.scene ?? 'private';
    const userId = input.userId ?? DEFAULT_USER;
    seq += 1;
    return {
      messageId: input.messageId ?? `test:${seq}`,
      platform: 'onebot',
      scene,
      sceneId: scene === 'private' ? userId : (input.groupId ?? GROUP_ID),
      userId,
      nickname: input.nickname ?? `玩家${userId.slice(-2)}`,
      rawText: input.rawText,
      timestamp: clock,
    };
  };

  const repos: HarnessRepos = {
    characters: new CharacterRepo(app.db),
    inventory: new InventoryRepo(app.db),
    items: new ItemRepo(app.db),
    locations: new LocationRepo(app.db),
    recipes: new RecipeRepo(app.db),
    trades: new TradeRepo(app.db),
    exploreDaily: new ExploreDailyRepo(app.db),
    flags: new FlagRepo(app.db),
  // M2.18：势力争夺的增量表（归属 = seed 底图 + Σ delta）
  churchConflict: new ChurchConflictRepo(app.db),
    parties: new PartyRepo(app.db),
    abilities: new AbilityRepo(app.db),
    dailyCounters: new DailyCounterRepo(app.db),
    cooldowns: new CooldownRepo(app.db),
    dailyTicks: new DailyTickRepo(app.db),
    eventTriggers: new EventTriggerRepo(app.db),
    tagUsage: new TagUsageRepo(app.db),
    feedback: new FeedbackRepo(app.db),
    userActivity: new UserActivityRepo(app.db),
    worldEvents: new WorldEventRepo(app.db),
    rituals: new RitualRepo(app.db),
    factions: new FactionRepo(app.db),
    wanted: new WantedRepo(app.db),
    cities: new CityRepo(app.db),
    routes: new RouteRepo(app.db),
    travels: new TravelRepo(app.db),
    creatures: new CreatureRepo(app.db),
    battles: new BattleRepo(app.db),
    clues: new RecipeClueRepo(app.db),
  };

  /**
   * 走**真实的两步创建流程**建一个普通人：
   *   .创建 姓名   → 机器人问「你是男性还是女性？」（回执带选项）
   *   1 / 2        → 建号
   *
   * 为什么不直接 insert：建号牵动的远不止 characters 一行 ——
   * ensureUser、启程盘缠、flags.loc、character_created 事件、以及路由层的
   * 数字回复分发（M2.7.6 新增的「没有角色时也要能回数字」那条路径）。
   * 绕过指令就等于把这一整条链路从测试里删掉了。
   */
  const createMortal = async (
    userId: string,
    name: string,
    gender: 'male' | 'female' = 'male',
  ): Promise<CharacterState> => {
    await adapter.deliver(build({ rawText: `.创建 ${name}`, userId }));
    adapter.take();
    await adapter.deliver(build({ rawText: gender === 'female' ? '2' : '1', userId }));
    adapter.take();
    const created = repos.characters.findByUserId(userId);
    if (!created) throw new Error(`建号失败：${userId}`);
    return created;
  };

  return {
    app,
    adapter,
    repos,
    now: () => clock,
    advance: (ms) => {
      clock += ms;
    },
    /**
     * 测试准备：建一张角色卡。
     *
     * **仍然走 .创建 指令**（这条不能省）：建号牵动的远不止 characters 一行 ——
     * ensureUser、启程盘缠、flags.loc、character_created 事件、以及路由层顺手做的
     * 世界推进与行为埋点。绕过指令直接 insert 会让 world-command / w6 这些
     * 「世界在跑、埋点在记」的断言集体失去前提。
     *
     * 但 M2.7 的出生是**派生**的（birthCityOf(userId)），派生出来的城市未必传承
     * 测试想要的途径，而现有测试探索的九个地点又全都在廷根都会区里。所以建号之后
     * 做三处**夹具校正**（都写在下面，一眼可见）：
     *
     *   1. 途径：生产里该城市不开放这条途径时会被拒，夹具直接改回测试要的那条；
     *   2. 城市：一律落在廷根城，这样 .探索 老码头 这类既有调用全部照常可用；
     *   3. 钱包：把启程盘缠扣回 0 —— 既有断言的初始钱包都是 0
     *      （trade-command.test.ts 的「买家付出 100」是绝对数值），夹具保持这个基线。
     *
     * 生产的出生校验与盘缠本身由 test/m2-7-geo.test.ts 单独覆盖。
     */
    async createCharacter(userId, name, pathway = 'seer') {
      const created = await createMortal(userId, name, 'male');

      /*
       * 夹具校正（M2.7.6 重写）：
       *
       * 生产里的创建流程**只给一张白纸**（pathway / sequence 都是 null），
       * 而这一整套既有用例（扮演 / 魔药 / 晋升 / 仪式 / 探索）研究的都是
       * **已经入途径之后**的玩法。所以这里把「入途径」这一步直接补上 ——
       * 补的方式与生产完全一致：pathway + sequence + pathway_status 三联一起写。
       *
       * 普通人阶段本身由 createMortal() 与 test/m2-7-6.test.ts 覆盖，
       * 那一批用例**不做**这三处校正（它们要的就是那张白纸）。
       */
      const home = app.geo.cityByNameOrId('廷根市')!;
      if (
        created.pathway !== pathway ||
        created.sequence !== 9 ||
        created.pathwayStatus !== 'initiated' ||
        created.currentCityId !== home.id
      ) {
        repos.characters.update({
          ...created,
          pathway,
          sequence: 9,
          pathwayStatus: 'initiated',
          currentCityId: home.id,
          updatedAt: clock,
        });
      }
      /*
       * 属性也拉回「入途径之后的标准开局」。
       *
       * 为什么必须做：普通人创建时 MP 上限就是 50（NUMERIC.initiation.mortalCaps.mp），
       * 而入途径之后是 100 —— 只改 pathway 不改 mp 的话，夹具建出来的角色
       * 会比生产里的新号少 50 点灵性，而既有断言（.占卜 后 MP 92）全部建立在那 100 上。
       */
      if (
        created.hp !== 100 ||
        created.mp !== 100 ||
        created.dig !== 0 ||
        created.mad !== 0 ||
        created.cor !== 0
      ) {
        const current = repos.characters.findByUserId(userId)!;
        repos.characters.update({
          ...current,
          hp: 100,
          mp: 100,
          dig: 0,
          mad: 0,
          cor: 0,
          updatedAt: clock,
        });
      }
      // 落地点：既有断言全部建立在「廷根城区的某个地点」上（探索 / 通缉都读 flags.loc）
      repos.flags.set(created.id, FLAG_LOCATION, clock, home.center);
      // 钱包扣回 0：既有断言的初始钱包都是 0（trade-command 的「买家付出 100」是绝对数值）
      const wallet = repos.inventory.count(created.id, CURRENCY_ITEM_ID);
      if (wallet > 0) repos.inventory.tryRemove(created.id, CURRENCY_ITEM_ID, wallet, clock);

      return { id: created.id, userId };
    },
    async createMortal(userId, name, gender = 'male') {
      return createMortal(userId, name, gender);
    },
    async send(input) {
      await adapter.deliver(build(input));
      return adapter.take();
    },
    async deliver(input) {
      await adapter.deliver(build(input));
      return adapter.take().length;
    },
  };
}
