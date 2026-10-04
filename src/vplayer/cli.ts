/**
 * 虚拟玩家实例测试 CLI（W7）
 *
 *   node src/vplayer/cli.ts --players 200 --days 7 --seed vplayer-w7 --persona all \
 *     --base-url http://localhost:3198 --out docs/W7-虚拟玩家报告.md
 *
 * 不给 --base-url 时会自己拉起一个测试服务进程（带可控时钟），跑完自动清理。
 * 所有游戏行为都走真实 HTTP；服务端时钟由测试固定，因此同一 seed 必然产出同一份结果。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadCards } from '../cards/loader.ts';
import {
  loadCities,
  loadChurches,
  loadCreatures,
  loadItems,
  loadLocations,
  loadRecipes,
  loadRoutes,
} from '../data/loader.ts';
import { batchTierOf, inferTier, type BatchTierId } from '../config/batch-tiers.ts';
import type { GateTier } from './acceptance.ts';
import { potionProductId } from '../domain/potion/recipe.ts';
import { createSeededRng, seedFrom } from '../domain/rng.ts';
import { openDatabase, type Db } from '../infra/db/sqlite.ts';
import { cleanupDb, startTestServer, type TestServer } from '../loadtest/harness.ts';
import { analyze, isRejected } from './analyzer.ts';
import { codeVersionOf, type CodeVersion, type CodeVersionInput } from './code-version.ts';
import {
  SHARD_SCHEMA,
  worldEventEvidenceOf,
  type CharacterFinalValues,
  type ShardJson,
  type SocialMetrics,
} from './shard-json.ts';
import { WorldEventRepo } from '../infra/db/world-events.ts';
import { analyzeCardReachability, computeCiGate, computeCoverage, isConditionalCard } from './coverage.ts';
import { PlayerHttp, createGroupChatLog, harnessInbox, startInbox } from './http.ts';
import { buildProfiles } from './profiles.ts';
import { Recorder } from './recorder.ts';
import { acceptanceOf, renderAnomalyReport, renderCoverageReport, renderMainReport, summarizeProfiles } from './report.ts';
import { MS_PER_DAY, runPlayerDay } from './session.ts';
import { commandNameOf } from './coverage.ts';
import type { AnomalyRecord, ActionRecord, PlayerProfile, WorldKnowledge } from './types.ts';
import { territoryOf } from '../domain/faction/faction.ts';
import { collectGeoStats } from './geo-stats.ts';
import { birthCityIdOf } from '../domain/geo/index.ts';

export interface CliOptions {
  players: number;
  days: number;
  seed: string;
  /**
   * M2.4：世界种子（**不随分片派生**）。
   * 默认取 WORLD_SEED 环境变量，再默认 'world' —— 与 src/main.ts 的 loadConfig 同一口径。
   * 分片脚本会给每片传同一个值，所以 4 片看到的是同一串世界事件。
   */
  worldSeed: string;
  personas: string[];
  baseUrl?: string;
  /** 外部模式（--base-url）下，服务端 SQLite 文件的路径：校验要用，必须给 */
  dbPath?: string;
  /** 假 OneBot API 的固定端口（外部服务要把 ONEBOT_API_BASE 指过来） */
  inboxPort: number;
  /** 报告文件名前缀：边界轮用它避免覆盖主轮产物 */
  reportPrefix: string;
  out: string;
  minPromotions: number;
  minCommandCount: number;
  baseEpoch: number;
  strict: boolean;
  keepDb: boolean;
  /** CI 守门模式：只把「内容配置错了 / 内容完全没被碰到 / P0」当失败 */
  ci: boolean;
  /** CI 逐卡门：任何可达卡 0 触发即失败（建议只在 200×7 这类足量样本上开） */
  ciStrictCards: boolean;
  /** M2.3：把结构化结果另存一份 JSON（分片合并脚本的唯一输入，不许手动拼数字） */
  jsonPath?: string;
  /** M2.13.1：允许覆盖 seed 不同的同名分片 JSON（默认拒绝，见 parseArgs 上方的说明） */
  force: boolean;
  /** M2.3：本片序号 / 总片数（不分片跑时是 0 / 1） */
  shard: number;
  shards: number;
  /**
   * M2.37 任务 1：**这一批按哪一档的验收线判退出码**（M2.35 的三档，见 docs/对照规范.md §四·补三）。
   *
   * · `smoke` —— 只判「链路走得通」（P0 / P1 / 真实 HTTP / 可复现 / 死循环 / 内容可达性）；
   * · `medium` —— 加判**机制信号**（通缉 / 袭击序列差 / 三层货币组合）；
   * · `diagnostic` —— 再加判覆盖率与数值区间（配方 / 地点 / 晋升成功率 / 条件卡）；
   * · **绝对门槛类**（长链路「≥ N 人」×2）**任何档都不参与退出码**（M2.35 已整类取消）。
   *
   * ⚠️ 缺省按规模推断（`inferTier`）；推断不出就是最严的 `diagnostic`（= M2.37 之前的行为）。
   */
  tier: BatchTierId;
  /**
   * M2.32 任务 1（P0）：**这一片跑的是哪份代码。**
   *
   * 写进产物 JSON、主报告与合并报告 —— 往后每一个批都可以归因。
   * 取法见 `src/vplayer/code-version.ts`（显式参数 > 环境变量 > git 现场读）。
   */
  codeVersion: CodeVersion;
}

function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

export function parseArgs(argv: string[]): CliOptions {
  const get = (name: string, fallback?: string): string | undefined => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : fallback;
  };
  const personaRaw = get('persona', 'all') ?? 'all';
  // 主报告文件名跟随 --report-prefix：否则 CI 轮（prefix=W8-CI）会写进上一周的报告文件里
  const reportPrefix = get('report-prefix', 'W8-虚拟玩家')!;
  /*
   * M2.32 任务 1（P0）：代码版本。
   *
   * 优先级：**显式参数 > 环境变量 > git 现场读**。
   * 为什么要显式这一层：复现时可以把 rev 钉死（`--code-rev <sha>`），
   * 在没有 git 的环境（CI 容器、复制出去的产物目录）里也能从外部注入。
   * 为什么不在这里直接读 git：parseArgs 是纯解析，现场读交给 codeVersionOf ——
   * 它自己处理「取不到 git」那种情况（回 'unknown' / true，见该文件的注释）。
   */
  const codeVersionInput: CodeVersionInput = {};
  const codeRev = get('code-rev', process.env.M213_CODE_REV);
  if (codeRev !== undefined) codeVersionInput.codeRev = codeRev;
  const codeDirty = get('code-dirty', process.env.M213_CODE_DIRTY);
  if (codeDirty !== undefined) codeVersionInput.codeDirty = codeDirty;
  const builtAt = get('built-at', process.env.M213_BUILT_AT);
  if (builtAt !== undefined) codeVersionInput.builtAt = builtAt;
  return {
    players: Number(get('players', '200')),
    days: Number(get('days', '7')),
    seed: get('seed', 'vplayer-w8')!,
    worldSeed: get('world-seed', process.env.WORLD_SEED ?? 'world')!,
    personas: personaRaw === 'all' ? [] : personaRaw.split(',').map((entry) => entry.trim()),
    baseUrl: get('base-url'),
    dbPath: get('db'),
    inboxPort: Number(get('inbox-port', '3199')),
    reportPrefix,
    out: get('out') ?? join('docs', `${reportPrefix}报告.md`),
    minPromotions: Number(get('min-promotions', '50')),
    minCommandCount: Number(get('min-command-count', '10')),
    baseEpoch: Date.parse(`${get('base-epoch', '2026-01-01')}T00:00:00+08:00`),
    strict: !argv.includes('--no-strict'),
    keepDb: argv.includes('--keep-db'),
    ci: argv.includes('--ci'),
    ciStrictCards: argv.includes('--ci-strict-cards'),
    ...(get('json') ? { jsonPath: get('json')! } : {}),
    // M2.13.1 任务 D：默认**拒绝**覆盖 seed 不同的同名分片 JSON
    force: argv.includes('--force'),
    shard: Number(get('shard', '0')),
    shards: Number(get('shards', '1')),
    // M2.37 任务 1：显式 --tier 优先；没给就按规模推断（推断不出 = 最严，向后兼容）
    tier: (get('tier') as BatchTierId | undefined) ?? inferTier(Number(get('players', '200')), Number(get('days', '7'))),
    codeVersion: codeVersionOf(codeVersionInput),
  };
}

/** 期末数值全量（合并脚本据此精确算百分位，而不是把分片的百分位再平均一次） */
function collectValues(db: Db): CharacterFinalValues {
  const rows = db
    .prepare('SELECT dig, mad, cor, hp FROM characters')
    .all() as Array<Record<string, unknown>>;
  const column = (key: string): number[] => rows.map((row) => Number(row[key] ?? 0));
  return { dig: column('dig'), mad: column('mad'), cor: column('cor'), hp: column('hp') };
}

/**
 * 社交指标：**只在不分片模式下有意义**（任务书 §6.5）。
 * 分片后 A 片的玩家看不到 B 片的玩家，交易与组队只在本片内发生。
 */
export function collectSocial(db: Db, records: readonly ActionRecord[]): SocialMetrics {
  const count = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;
  return {
    tradesCreated: count('SELECT COUNT(*) AS n FROM trades'),
    tradesConfirmed: count("SELECT COUNT(*) AS n FROM trades WHERE status = 'completed'"),
    tradesExpired: count("SELECT COUNT(*) AS n FROM trades WHERE status = 'expired'"),
    partyActions: records.filter((record) => commandNameOf(record.command) === '队伍').length,
    partyTasks: records.filter((record) => record.command.replace(/^[.。．]/, '').startsWith('队伍 任务')).length,
    partiesWithTwoPlus: count(
      'SELECT COUNT(*) AS n FROM (SELECT party_id FROM party_members GROUP BY party_id HAVING COUNT(*) >= 2)',
    ),
  };
}

export function buildWorld(): WorldKnowledge {
  const recipes = loadRecipes().recipes.map((recipe) => ({
    id: recipe.id,
    pathway: recipe.pathway,
    seq: recipe.seq,
    main: recipe.main,
    aux: recipe.aux,
    productItemId: potionProductId(recipe),
  }));
  // M2.7：地点归到城市。表里没有地点→城市这一列（城市才是父级），所以这里反查一次 ——
  // 与 src/domain/geo/geo.ts 的 GeoIndex 同一套规则（先到先得，一个地点只属于一座城市）。
  const cities = loadCities().cities;
  const locationCity = new Map<string, string>();
  for (const city of cities) {
    for (const locationId of city.locations) {
      if (!locationCity.has(locationId)) locationCity.set(locationId, city.id);
    }
  }
  const locations = loadLocations().locations.map((location) => ({
    id: location.id,
    name: location.name,
    city: locationCity.get(location.id) ?? '',
    minSeq: location.min_seq,
    maxSeq: location.max_seq,
    loot: location.loot.map((entry) => entry.itemId),
    events: [...location.events],
  }));
  /*
   * M2.13：每个地点**可能出现的最强生物序列**（栖息地 → 物种基线序列取**最小**）。
   *
   * ⚠️ 取 min 不是 max：**序列号越小越强**。
   * 「有封印物的人去哪碰运气」要的是「那里可能有比我强的生物」，
   * 所以取那个地点上序列号最小的物种。写成 max 会得到相反的结果
   * （「那里可能有比我弱的东西」），而那种地方去了也没有意义。
   */
  const locationCreatureSequences: Record<string, number> = {};
  for (const species of loadCreatures().creatures) {
    for (const habitatId of species.habitat) {
      const current = locationCreatureSequences[habitatId];
      locationCreatureSequences[habitatId] =
        current === undefined ? species.baseSequence : Math.min(current, species.baseSequence);
    }
  }
  const itemKinds: Record<string, string> = {};
  const extraordinaryKinds: Record<string, string> = {};
  for (const item of loadItems().items) {
    itemKinds[item.id] = item.kind;
    extraordinaryKinds[item.id] = item.type;
  }
  const locationIdByName: Record<string, string> = {};
  for (const location of locations) locationIdByName[location.name] = location.id;
  // M2.6：无主地点 = 安全区。名单来自 numeric.factionTerritory（内容侧只有一份真相）
  const safeIds = new Set(territoryOf('none'));
  return {
    recipes,
    locations,
    itemKinds,
    extraordinaryKinds,
    locationCreatureSequences,
    locationNames: locations.map((location) => location.name),
    locationIdByName,
    safeLocationNames: locations.filter((location) => safeIds.has(location.id)).map((location) => location.name),
    // M2.7：出生城市与航线。虚拟玩家靠 birthCityOf 预判自己落在哪座城市，
    // 从而第一次就把途径选对（否则会在「创建被拒 → 换途径」上烧掉大量动作）。
    birthCities: cities
      .filter((city) => city.birth_weight > 0)
      .map((city) => ({
        id: city.id,
        name: city.name,
        pathways: [...city.pathways],
        birthWeight: city.birth_weight,
      })),
    routes: loadRoutes().routes.map((route) => ({
      id: route.id,
      from: route.from,
      to: route.to,
      type: route.type,
      durationHours: route.duration_hours,
      costPenny: route.cost_penny,
      danger: route.danger,
    })),
    cityNames: Object.fromEntries(cities.map((city) => [city.id, city.name])),
    /*
     * M2.16：正神教会（七家）。
     * 虚拟玩家用它预判「我这条途径在这座城市能不能入教」——
     * 不填的话，它要么不发 .加入教会（入教率恒为 0，验收表里那一条就永远是 0），
     * 要么盲发（被拒率被无谓地抬高）。
     */
    churches: loadChurches().churches.map((church) => ({
      id: church.id,
      name: church.name,
      pathway: church.pathway,
      seats: [...church.seats],
    })),
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const startedAt = new Date().toISOString();
  const started = Date.now();

  /*
   * M2.32 任务 1（P0）：**跑批第一行就报代码版本。**
   *
   * 为什么放在最前面（而不是等报告写完）：报告可能因为中途失败而根本写不出来，
   * 而「这批跑的是哪份代码」是排查那次失败时第一个要问的东西 —— 它必须在日志里。
   *
   * 为什么 dirty 要**分两档**警告：本仓 docs/ 下存着跑批产物本身（不受 .gitignore 保护），
   * 所以跑批自己就会让工作区变脏。把「产物脏」与「判定输入脏」混成一个警告，
   * 等于给了一个**恒为真**的警告 ⇒ 零鉴别力（K11）。只有后者才意味着「不可精确重生成」。
   */
  const code = options.codeVersion;
  console.log(
    `代码版本：${code.codeRev}` +
      (code.codeDirty
        ? `（工作区有未提交改动：判定输入 ${code.codeDirtyDetail.judgement} 处、产物 ${code.codeDirtyDetail.artifacts} 处）`
        : '（工作区干净）'),
  );
  if (code.codeDirtyDetail.judgement > 0) {
    /*
     * ⚠️ **这条警告走 stdout，不走 stderr**（M2.32 实测踩到）：
     * 分片脚本用 `stdio: 'inherit'`，而 PowerShell 在 `2>&1` 混流时会把子进程的 stderr
     * 当成 `NativeCommandError` ⇒ **整个跑批命令的退出码变成 1，而分片本身是成功的**。
     * 这条警告**几乎每批都会出现**（工作区里总有未提交的产物/改动）⇒ 高频污染退出码，
     * 而这个项目里「退出码」是会被拿来看的（K12 连带的「退出码不能当证据」正说明有人看它）。
     */
    console.log(
      `⚠️ 工作区有 ${code.codeDirtyDetail.judgement} 处**判定输入**未提交改动 —— ` +
        `本批产物**不可精确重生成**（重跑会得到另一批数据）。` +
        `样例：${code.codeDirtyDetail.sample.join('、') || '（未采集）'}。` +
        '处置：先 git add 建一个检查点再跑（M2.30 任务 0 的纪律），或在这批的报告里标明 rev 不是完整描述。',
    );
  }

  let server: TestServer | null = null;
  let baseUrl = options.baseUrl ?? '';
  let ownServer = false;

  if (!baseUrl) {
    // allowClockControl + deterministicIds：可复现的两个必要开关
    // （服务端所有判定 seed 都是 messageId:characterId:now 派生的，id 随机就没法复现）
    server = await startTestServer({
      allowClockControl: true,
      deterministicIds: true,
      // M2.7.6：显式给了 --db 就用它（分片长跑要靠这个库出「入途径覆盖」报告）
      ...(options.dbPath ? { dbPath: options.dbPath } : {}),
      // M2.4：世界种子显式传给服务端进程（4 片同一个值 → 同一串世界事件）
      worldSeed: options.worldSeed,
      // 每日结算完全由本工具显式驱动：服务端自己的定时结算会按真实时间插进来，破坏可复现
      startOps: false,
      runTickOnStart: false,
    });
    baseUrl = `http://127.0.0.1:${server.appPort}`;
    ownServer = true;
    console.log(`已启动测试服务：${baseUrl}（db=${server.dbPath}）`);
  }

  // 出站消息：自己起的服务直接复用 harness 的假 OneBot API；
  // 外部实例则起一个固定端口的假 API，由服务端的 ONEBOT_API_BASE 指过来。
  const inbox = server ? harnessInbox(server.onebot) : await startInbox(options.inboxPort);
  if (!server) {
    console.log(`外部实例模式：假 OneBot API 监听 127.0.0.1:${inbox.port}，请确保服务端 ONEBOT_API_BASE 指向它。`);
  }
  const token = server?.token ?? process.env.ONEBOT_TOKEN ?? '';
  const http = new PlayerHttp({ baseUrl, token });
  const world = buildWorld();

  // 目标服务必须开着可控时钟：否则同一 seed 跑出来的东西不可复现，宁可直接失败
  const clockOk = await http.pinClock(options.baseEpoch + 60 * 60 * 1000);
  if (!clockOk) {
    throw new Error(
      `目标服务 ${baseUrl} 拒绝固定时钟（POST /admin/clock）——请以 ALLOW_CLOCK_CONTROL=1 启动它；` +
        '没有固定时钟就没有可复现性，测试中止。',
    );
  }

  const jsonlPath = join('docs', `${options.reportPrefix}-行为日志.jsonl`);
  const recorder = new Recorder(jsonlPath);
  // 方案 C：整轮共用一份群聊台账（群消息对所有人可见，不是每人一份）
  const chat = createGroupChatLog();
  const anomalies: AnomalyRecord[] = [];
  const onAnomaly = (anomaly: AnomalyRecord): void => {
    anomalies.push(anomaly);
    if (anomaly.level === 'P0') console.error(`[P0] ${anomaly.code} 玩家#${anomaly.playerId}：${anomaly.detail}`);
  };

  const profiles: PlayerProfile[] = buildProfiles({
    players: options.players,
    seed: options.seed,
    personas: options.personas as PlayerProfile['persona'][],
  });
  console.log(
    `生成 ${profiles.length} 个虚拟玩家，${options.days} 天，seed=${options.seed}，世界 seed=${options.worldSeed}`,
  );

  // 读库校验：自起服务直接用它的 db；外部实例要显式给 --db（同一个 SQLite 文件，WAL 并发读）
  const db = server
    ? server.openDb()
    : (() => {
        if (!options.dbPath) {
          throw new Error(
            '--base-url 模式必须同时给 --db <服务端 sqlite 路径>：属性越界、负库存、地点覆盖都要读库才验得了。',
          );
        }
        return openDatabase(options.dbPath);
      })();

  try {
    for (let day = 0; day < options.days; day += 1) {
      const dayStart = options.baseEpoch + day * MS_PER_DAY;
      // 每天开始：把时钟拨到当天，跑一次每日结算（第 0 天不结算，直接建号）
      await http.pinClock(dayStart + 60 * 60 * 1000);
      if (day > 0) await http.tick();

      const dayStarted = Date.now();
      let actions = 0;
      for (const profile of profiles) {
        const result = await runPlayerDay(
          { db, http, inbox, recorder, world, baseEpoch: options.baseEpoch, chat, onAnomaly },
          profile,
          day,
          dayStart,
        );
        actions += result.actions.length;
      }
      console.log(`第 ${day} 天完成：${actions} 条指令，耗时 ${((Date.now() - dayStarted) / 1000).toFixed(1)}s，异常累计 ${anomalies.length}`);
    }

    const health = await http.health();
    const commands = (health.commands as string[]) ?? [];
    const loadedCards = loadCards().cards;
    const reachability = analyzeCardReachability(
      loadedCards.map((card) => ({
        id: card.id,
        locations: card.trigger.location ?? [],
        type: card.trigger.type,
      })),
      world.locations,
    );
    const unreachable = reachability.filter((entry) => !entry.reachable);
    const unreachableReasons: Record<string, string> = {};
    for (const entry of unreachable) {
      unreachableReasons[entry.cardId] =
        entry.locations.length > 0
          ? `限定了地点「${entry.locations.join('、')}」，但该地点的 events 名单里没有它：探索按 events 取交集抽不到，.扮演 抽卡不带地点也抽不到`
          : '没有任何一条抽取路径会带上它';
    }
    const coverage = computeCoverage(
      recorder.records,
      db,
      {
        commands,
        cards: loadedCards.map((card) => card.id),
        locations: world.locations.map((location) => ({ id: location.id, name: location.name })),
        recipes: world.recipes.map((recipe) => recipe.id),
        lostControlTexts: [],
      },
      {
        minCommandCount: options.minCommandCount,
        unreachableCards: unreachable.map((entry) => entry.cardId),
        unreachableReasons,
      },
    );

    // M2.6：把虚拟时间线的终点传给分析器 —— 「期末仍然有效的通缉令」要按虚拟时间判，
    // 用墙上时间会把还没到的过期当成已经过期（分片跑批跨小时，误差肉眼可见）
    const analysis = analyze(
      recorder.records,
      db,
      profiles.length,
      options.baseEpoch + options.days * 24 * 60 * 60 * 1000,
    );
    const p0 = anomalies.filter((anomaly) => anomaly.level === 'P0');
    /*
     * M2.7："新号可达地点"这条硬门改为按**本批玩家真的能到的地方**算。
     *
     * 为什么必须改：出生城市是派生的（birthCityOf），20 人的小样本里完全可能
     * 某座城市一个人都没有 —— 实测 seed=smoke 的 20 人落在 4 座城市，特里尔 0 人。
     * 那种情况下「特里尔的地点没被探索过」不是内容缺口，而是**抽样缺口**：
     * 那四个地点结构上不可能被任何玩家走到。按字面口径判，这条门就变成了
     * 「必须恰好抽到每一座城市」的运气门 —— 它会在完全健康的版本上变红，
     * 而 CI 一旦会假红，就没人再看它的红了。
     *
     * 门禁的**原意**（内容不能有孤岛）完整保留：
     * 只要某座城市本批有人，它名下所有 min_seq=9 的地点就仍然必须被走到。
     */
    const bornCityIds = new Set(
      profiles.map((profile) => birthCityIdOf(profile.userId, world.birthCities)),
    );
    const allStarter = world.locations.filter((l) => l.minSeq === 9);
    const starterLocations = allStarter
      .filter((l) => !l.city || bornCityIds.has(l.city))
      .map((l) => l.name);
    const skippedStarter = allStarter
      .filter((l) => l.city && !bornCityIds.has(l.city))
      .map((l) => l.name);
    if (skippedStarter.length > 0) {
      console.log(
        `本批有 ${skippedStarter.length} 个新号可达地点因「这座城市没人出生」而不参与门禁：` +
          `${skippedStarter.join('、')}（出生城市分布见报告）`,
      );
    }

    const gate = computeCiGate({
      coverage,
      starterLocations,
      strictCards: options.ciStrictCards,
      p0Count: p0.length,
      // M2.7.6：门禁要知道窗口有多长 —— 配方要先去拿到（保底 14 天），
      // 3 天窗口里「没人调制过配方」是承诺还没到期，不是内容问题
      windowDays: options.days,
    });
    for (const warning of gate.warnings) console.log('CI 豁免（窗口太短）：' + warning);
    const cardMetas = loadedCards.map((card) => ({
      id: card.id,
      conds: card.trigger.cond ?? [],
      minSeq: card.trigger.min_seq,
      maxSeq: card.trigger.max_seq,
    }));

    // 阶段名取自 --report-prefix（W8-虚拟玩家 → W8），标题与文档路径都从它派生
    const stage = options.reportPrefix.split('-虚拟玩家')[0] ?? options.reportPrefix;
    const acceptanceReportPath = `docs/${stage}-准入报告.md`;

    // 配置回显项（不是判定项）：只在 --strict 下拦「规模不够」这类跑法问题
    const configFailures: string[] = [];
    if (options.strict && options.players < 200) configFailures.push(`玩家数 ${options.players} < 200`);
    if (options.strict && options.days < 7) configFailures.push(`天数 ${options.days} < 7`);
    /*
     * 长链路两段各自判定（M2.13 前置 1）：取代原先的复合指标 `9→8→7 ≥ 50`。
     * 两段都是 200×7 验收包线的一部分，--no-strict 时一并放开
     * （小轮次本来就走不完长链路）。
     */
    if (options.strict) {
      if (!coverage.longChain.toSeq8.pass) {
        configFailures.push(
          `入途径 → 序列 8：${coverage.longChain.toSeq8.count} < ${coverage.longChain.toSeq8.required}`,
        );
      }
      if (!coverage.longChain.toSeq7.pass) {
        configFailures.push(
          `序列 8 → 序列 7：${coverage.longChain.toSeq7.count} < ${coverage.longChain.toSeq7.required}`,
        );
      }
    }

    // M2.7：地理统计。出生分布由 birthCityOf 从 userId 直接派生（不依赖任何玩家动作），
    // 移动与路途事件读 travels 表 —— 三处口径见 src/vplayer/geo-stats.ts。
    const geoStats = collectGeoStats(
      db,
      profiles.map((profile) => profile.userId),
      world.birthCities,
    );

    const input = {
      players: options.players,
      days: options.days,
      seed: options.seed,
      baseUrl,
      startedAt,
      costMs: Date.now() - started,
      analysis,
      coverage,
      anomalies,
      cards: cardMetas,
      stage,
      reportPrefix: options.reportPrefix,
      acceptanceReportPath,
      profileSummary: summarizeProfiles(profiles),
      geo: geoStats,
      cities: world.birthCities,
      code: options.codeVersion,
      acceptance: { pass: true, failures: [] as string[] },
    };

    // M2.0 口径统一：判定只有三栏一份（src/vplayer/acceptance.ts）。
    // 默认（不加 --ci）只由**红项**决定退出码；条件卡未触发按性质分类后记为黄项。
    // --ci 仍然只跑内容硬门（内容配置错 / 内容完全没被碰到 / P0），语义不变。
    const acceptance = acceptanceOf(input);
    /*
     * ===== M2.37 任务 1：**按批次级别判退出码** =====
     *
     * M2.35 定了三档（docs/对照规范.md §四·补三），但**只改了手册** ——
     * 冒烟档（20 人 × 3 天）跑完仍然「红 7 项、退出码 1」（m236s 的现场），
     * 而那七项在 3 天窗口里**本来就测不到**（连入途径都发生不了）。
     *
     * 等级规则见 acceptance.ts 的 \`GateTier\`：
     *   · \`smoke\`      任何档都判 —— 链路走得通 / 故障 / 内容结构错；
     *   · \`medium\`     中批起判 —— 机制的**信号**；
     *   · \`diagnostic\` 诊断档起判 —— 覆盖率与数值区间；
     *   · \`observe\`    **永不参与退出码** —— 绝对门槛类（长链路 ≥ N 人，M2.35 已整类取消）。
     */
    const tierRank: Record<BatchTierId, number> = { smoke: 0, medium: 1, diagnostic: 2 };
    const participates = (item: { tier?: GateTier }): boolean => {
      const tier = item.tier ?? 'diagnostic'; // 缺省按最严（K19 的保守方向）
      if (tier === 'observe') return false;
      return tierRank[tier] <= tierRank[options.tier];
    };
    const allRed = [...acceptance.gates.system, ...acceptance.gates.content, ...acceptance.gates.numeric].filter(
      (item) => item.status === 'red',
    );
    const redNames = allRed.filter(participates).map((item) => item.name);
    const skipped = allRed.filter((item) => !participates(item));
    // M2.3 分片模式：**单片不判退出码**。
    // 一片只有 200/N 人，长链路、地点覆盖这些包线本来就该由合并后的整体来判
    //（合并脚本用同一个 coverageFailures 口径重算）。单片硬失败会让 4 个分片全部红着退出，
    // 主代理就分不清「这片真出问题了」还是「这片人数不够」。
    const shardMode = options.shards > 1;
    const failures: string[] = shardMode
      ? []
      : options.ci
        ? gate.failures
        : [...configFailures, ...redNames.map((name) => `红项：${name}`)];
    input.acceptance.pass = failures.length === 0;
    input.acceptance.failures = failures;

    const conditionalCards = loadedCards.filter((card) =>
      isConditionalCard({ conds: card.trigger.cond ?? [], minSeq: card.trigger.min_seq, maxSeq: card.trigger.max_seq }),
    ).length;
    console.log(
      `内容可达性：${loadedCards.length} 张卡全部可达（条件卡 ${conditionalCards} 张按性质分类记录）` +
        `；CI 守门：${options.ci ? (gate.ok ? '通过' : '失败') : '未启用（加 --ci 开启）'}`,
    );
    console.log(
      `三栏判定：${acceptance.verdict.verdict}（红 ${acceptance.verdict.reds} / 黄 ${acceptance.verdict.yellows} / 绿 ${acceptance.verdict.greens}）` +
        `；对照文件 ${acceptanceReportPath}`,
    );

    /*
     * M2.37 任务 1：把「这一批判的是哪一档」写出来。
     * ⚠️ 并且**把跳过的红项也写出来** —— 静默跳过一项，读的人会以为它绿了（K19 的形状）。
     * 两种「不判」要分清：档位还不够（这一档本来就测不到）vs 绝对门槛（任何档都不判）。
     */
    const tierRow = batchTierOf(options.tier);
    /*
     * ⚠️ 打印要分清**两个规模** —— 这是现场踩出来的：
     * 第一版只打档位规格，于是「--tier medium 跑 20 人 × 3 天」的批会印出「50 人 × 15 天」，
     * 读的人以为跑的是中批规模。**判定口径**（档位）与**实际规模**（--players/--days）是两件事，
     * 不一致时必须说出来 —— 那正是 K12 的形状（少写一个参数不报错，只给你另一种东西）。
     */
    const scaleMismatch = tierRow.players !== options.players || tierRow.days !== options.days;
    console.log(
      '批次级别：' + tierRow.label + '（--tier ' + options.tier +
        (process.argv.includes('--tier') ? '' : ' · **缺省推断**，建议显式写') + '）' +
        ' —— 按「' + tierRow.players + ' 人 × ' + tierRow.days + ' 天」的验收线判' +
        (scaleMismatch
          ? '；⚠️ **本批实际是 ' + options.players + ' 人 × ' + options.days + ' 天**，与档位规格不一致'
          : '') +
        '，验收线「' + tierRow.acceptance + '」',
    );
    if (skipped.length > 0) {
      const observe = skipped.filter((item) => item.tier === 'observe').map((item) => item.name);
      const notYet = skipped.filter((item) => item.tier !== 'observe');
      if (notYet.length > 0) {
        console.log(
          '  ⚠️ 本档不判的红项 ' + notYet.length + ' 项（**不是绿**：它们在' + tierRow.label + '档本来就测不到）：' +
            notYet.map((item) => item.name + '（' + (item.tier ?? 'diagnostic') + ' 档起判）').join('、'),
        );
      }
      if (observe.length > 0) {
        console.log(
          '  ⚠️ 永不参与退出码的红项 ' + observe.length + ' 项（**绝对门槛**，M2.35 已整类取消）：' + observe.join('、'),
        );
      }
    }

    if (shardMode) {
      console.log(
        `分片模式（${options.shard}/${options.shards}）：本片不判退出码，最终判定由 scripts/vplayer-merge.ts 按合并后的整体重算`,
      );
    }

    const anomalyPath = join('docs', `${options.reportPrefix}-异常.md`);
    const coveragePath = join('docs', `${options.reportPrefix}-覆盖率.md`);
    writeFileSync(options.out, renderMainReport(input), 'utf8');
    writeFileSync(anomalyPath, renderAnomalyReport(input), 'utf8');
    writeFileSync(coveragePath, renderCoverageReport(input), 'utf8');
    console.log(`报告已写入：${options.out}、docs/${options.reportPrefix}-异常.md、docs/${options.reportPrefix}-覆盖率.md、${jsonlPath}`);

    /*
     * M2.13.1 任务 D：**不许静默覆盖别的轮次的分片结果。**
     *
     * 背景：分片 JSON 原来叫 shard-N.json（不含 seed），所以同 seed 跑两轮
     * （开/关前置 4）会互相覆盖 —— m213 那一轮的 JSON 就是这么没的，
     * 最后只能从行为日志 + 库重建（见 docs/M2.13.1-交付说明.md §8.3）。
     *
     * 两道防线：
     *   1. **文件名带库前缀**（scripts/vplayer-shard.ts 的 planShards）——
     *      正常跑批根本不会撞名；
     *   2. **这一道**：显式 --json 指到别人的文件上时，比对文件里记的 seed 与 stage，
     *      任一不同就报错退出，除非显式 --force。
     *
     * 为什么写进内容里的字段而不是文件名：文件名可以被改，seed / stage 是内容。
     *
     * **为什么只比 seed 不够**（实测踩到）：**同 seed 的两轮是真实存在的** ——
     * M2.13.1 的 `m213b` / `m213boff` 就是同一个 `--seed m213b`，
     * 只差一个环境变量，两边的 `seed` 字段一模一样；只比 seed 拦不住它们互相覆盖。
     * `stage` 是报告前缀（`m213b-shard0` / `m213boff-shard0`），它把「哪一轮」也编码进去了。
     */
    if (options.jsonPath && existsSync(options.jsonPath) && !options.force) {
      const previous = JSON.parse(readFileSync(options.jsonPath, 'utf8')) as {
        seed?: string;
        stage?: string;
      };
      const seedClash = previous.seed !== undefined && previous.seed !== options.seed;
      const stageClash = previous.stage !== undefined && previous.stage !== stage;
      if (seedClash || stageClash) {
        throw new Error(
          `结构化结果 ${options.jsonPath} 已存在，且它不是本次这一轮` +
            `（文件里 seed=${previous.seed}、stage=${previous.stage}；` +
            `本次 seed=${options.seed}、stage=${stage}）——` +
            `覆盖会让那一轮的合并报告失去输入。要覆盖请显式加 --force。`,
        );
      }
    }

    // M2.3：结构化结果落盘。分片合并脚本只认这一份 —— 报告里的数字不靠人抄
    if (options.jsonPath) {
      const statuses = db.prepare('SELECT status FROM characters').all() as Array<{ status: string }>;
      const personaPlayers: Record<string, number> = {};
      for (const profile of profiles) {
        personaPlayers[profile.persona] = (personaPlayers[profile.persona] ?? 0) + 1;
      }
      const shard: ShardJson = {
        schema: SHARD_SCHEMA,
        shard: options.shard,
        shards: options.shards,
        seed: options.seed,
        // M2.4：世界 seed 与事件序列 —— 4 片一致性由合并脚本按这两项判定
        worldSeed: options.worldSeed,
        worldEvents: worldEventEvidenceOf(new WorldEventRepo(db).all()),
        players: options.players,
        days: options.days,
        baseEpoch: options.baseEpoch,
        startedAt,
        costMs: Date.now() - started,
        stage,
        // M2.32 任务 1（P0）：代码版本落进产物 —— 往后所有批都可归因
        codeRev: code.codeRev,
        codeDirty: code.codeDirty,
        builtAt: code.builtAt,
        codeDirtyDetail: code.codeDirtyDetail,
        analysis,
        coverage,
        anomalies,
        profileSummary: input.profileSummary,
        cards: cardMetas,
        values: collectValues(db),
        personaPlayers,
        lostControl: statuses.filter((row) => row.status === 'lost_control').length,
        characters: statuses.length,
        rejectedActions: recorder.records.filter((record) => isRejected(record.replyTexts)).length,
        thresholds: {
          minCommandCount: options.minCommandCount,
          minPromotions: options.minPromotions,
        },
        geo: geoStats,
        ...(options.shards === 1 ? { social: collectSocial(db, recorder.records) } : {}),
      };
      mkdirSync(dirname(options.jsonPath), { recursive: true });
      writeFileSync(options.jsonPath, JSON.stringify(shard, null, 2), 'utf8');
      console.log(`结构化结果已写入：${options.jsonPath}`);
    }

    const liveEvents = new WorldEventRepo(db).all();
    const worldEvidence = worldEventEvidenceOf(liveEvents);
    const worldReplies = recorder.records.filter((record) => record.worldEvent === true).length;
    console.log(
      `世界事件：${worldEvidence.count} 条（${Object.entries(worldEvidence.byType)
        .map(([type, count]) => `${type} ${count}`)
        .join('、')}），世界 seed=${options.worldSeed}，摘要=${worldEvidence.digest}` +
        `；玩家按世界播报回数字 ${worldReplies} 次`,
    );
    console.log(
      `总结：动作 ${analysis.totalActions} 条、入途径→8 ${coverage.longChain.toSeq8.count} 人、` +
        `8→7 ${coverage.longChain.toSeq7.count} 人、` +
        `P0 ${p0.length} 条、P1 ${anomalies.length - p0.length} 条、拒绝率 ${(analysis.rejectRate * 100).toFixed(1)}%`,
    );
    if (!input.acceptance.pass) {
      console.error('验收未通过：', failures.join('；'));
      process.exitCode = 1;
    } else {
      console.log('验收通过。');
    }
  } finally {
    await recorder.close();
    await inbox.close();
    db.close();
    if (server) {
      const dbPath = server.dbPath;
      await server.stop();
      /*
       * M2.7.6：**显式指定了 --db 的轮次不删库**。
       *
       * --db 的语义本来就是「我要这个库留着」—— 分片长跑之后要靠它出
       * 「入途径覆盖」这类报告（哪条路来的、第几天入的），而那些量只有
       * raw domain_events 算得准，分片 JSON 里塞不下也不该塞。
       * 没指定 --db 的轮次（例如 20×3 CI）行为完全不变：跑完即清理。
       */
      const keepDb = options.keepDb || options.dbPath !== undefined;
      if (!keepDb) cleanupDb(dbPath);
    }
    void ownServer;
    void arg;
    void createSeededRng;
    void seedFrom;
  }
}

const entry = process.argv[1] ? new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href : '';
if (import.meta.url === entry) {
  main().catch((error) => {
    console.error('虚拟玩家测试失败：', error);
    process.exit(1);
  });
}
