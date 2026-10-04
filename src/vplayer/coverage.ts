/**
 * 覆盖率统计（W7）：指令 / 事件卡 / 地点 / 配方 / 失控文本 / 晋升链路完成率。
 * 数据来源：行为日志（指令）+ 数据库（事件触发、探索记录、领域事件、失控记录）。
 */
import type { Db } from '../infra/db/sqlite.ts';
import { longChainFailures, readLongChain, type LongChainReport } from './longchain.ts';
import type { ActionRecord } from './types.ts';

export interface CoverageItem {
  key: string;
  count: number;
  pass: boolean;
  /** 因内容配置而根本抽不到（不计入达标要求，但必须记录成缺口） */
  excluded?: boolean;
  /** 备注：为什么没达标 */
  note?: string;
}

/** 卡片可达性：内容配置决定某张卡到底能不能被抽到 */
export interface CardReachability {
  cardId: string;
  /** 卡片自身限定的地点 */
  locations: string[];
  /** 探索只从 location.events 里抽卡；不在任何地点 events 名单里 → 探索永远抽不到 */
  reachableByExplore: boolean;
  /** .扮演 暴露抽卡时不带地点 → 带 location 限制的卡在扮演里永远抽不到 */
  reachableByPlay: boolean;
  /** .事件 [地点] 抽 daily / hidden，可以带地点 → 这类卡就算带地点限制也还有路 */
  reachableByEvent: boolean;
  /** 三条路都走不通 = 写进内容也永远不会出现在玩家面前 */
  reachable: boolean;
}

/**
 * 静态可达性分析（W7 发现的第一个内容缺口就是用这个定位的）。
 * 判定依据是运行时真实的两条抽卡路径，不是猜的：
 *   - 探索：router/commands/explore.ts → candidateEventIds 先跟 location.events 取交集
 *   - 扮演暴露：router/commands/play.ts → engine.pick(..., { types: ['random'] })，不带 location
 */
export function analyzeCardReachability(
  cards: ReadonlyArray<{ id: string; locations: readonly string[]; type: string }>,
  locations: ReadonlyArray<{ name: string; events: readonly string[] }>,
): CardReachability[] {
  const listed = new Set<string>();
  for (const location of locations) for (const id of location.events) listed.add(id);

  return cards.map((card) => {
    const gated = card.locations.length > 0;
    const reachableByExplore = listed.has(card.id);
    const reachableByPlay = card.type === 'random' && !gated;
    // .事件 可以带地点参数（.事件 老码头），所以 daily / hidden 就算写了地点限制也还有路
    const reachableByEvent = card.type === 'daily' || card.type === 'hidden';
    return {
      cardId: card.id,
      locations: [...card.locations],
      reachableByExplore,
      reachableByPlay,
      reachableByEvent,
      reachable: reachableByExplore || reachableByPlay || reachableByEvent,
    };
  });
}

/**
 * 条件卡识别（W8）：靠 flag / 组队 / 失控状态 / 序列门槛才能遇到的卡。
 * 这类卡在短样本（20×3）里凑不齐前置条件，不能拿"0 触发"当 CI 失败 —— 否则 CI 永远是红的。
 */
export function isConditionalCard(card: {
  conds: readonly string[];
  minSeq?: number | undefined;
  maxSeq?: number | undefined;
}): boolean {
  if (card.minSeq !== undefined && card.minSeq < 9) return true;
  if (card.maxSeq !== undefined && card.maxSeq > 0) return true;
  return card.conds.some((cond) => /^(flag|party|status)\s*:/.test(cond.trim()));
}

import { INITIATION } from '../config/numeric.ts';

export interface CiGateInput {
  coverage: CoverageReport;
  /** 新号（序列 9）就能去的地点名字 */
  starterLocations: readonly string[];
  /** 是否把「任何可达卡 0 触发」也当成失败（只有 200×7 级别的样本才建议开） */
  strictCards: boolean;
  p0Count: number;
  /**
   * M2.7.6：这一轮跑了多少天。
   *
   * 为什么门禁需要知道窗口长度：**配方不再是从天上掉下来的**。
   * 这一轮之前，玩家建号就带途径、当天就能调序列 9 魔药，所以「配方 0 调制」
   * 是一条合理的硬门。M2.7.6 起配方要先拿到 —— M2.85 起线索保底 5 天（cluePityDays）
   * （平均第 6.5 天被找上），或者探索时 5% 翻到线索。
   * 于是 3 天窗口里**统计上不可能**有人走到调制那一步：继续硬门 = CI 永远红 = 等于没有 CI，
   * 与「条件卡 0 触发」是同一个理由（见上面那段注释）。
   */
  windowDays?: number;
}

export interface CiGateResult {
  ok: boolean;
  failures: string[];
  /** 因为窗口太短而不参与硬门、但照常写进报告的项 */
  warnings: string[];
}

/**
 * CI 守门（W8）：只保留"内容配置错了"或"内容完全没被碰到"这类硬失败。
 *
 * 为什么不是"任何可达卡 0 触发即失败"：可达卡里有一批依赖稀有条件
 * （`flag:owes_favor`、`party:size>=2`、`status:lost_control`、`min_seq: 8`…），
 * 20×3 的千余条动作根本凑不齐；而 `lost_*` 依赖失控，失控在 7—14 天窗口内本来就不会发生
 * （M2 决策项）。按字面口径 CI 会永远红，等于没有 CI。
 * 所以：
 *   - 硬门（永远失败）：静态不可达卡 > 0 / 新号可达地点 0 探索 / 配方 0 调制 / P0 > 0；
 *   - 逐卡门（--ci-strict-cards，建议只在 200×7 用）：任何可达卡 0 触发即失败。
 */
export function computeCiGate(input: CiGateInput): CiGateResult {
  const { coverage } = input;
  const failures: string[] = [];
  const warnings: string[] = [];

  if (coverage.contentGaps.length > 0) {
    failures.push(
      `内容配置错误：${coverage.contentGaps.length} 张卡抽不到（${coverage.contentGaps.map((c) => c.key).join('、')}）`,
    );
  }

  const starterSet = new Set(input.starterLocations);
  const missedStarter = coverage.locations.filter((item) => starterSet.has(item.key) && item.count === 0);
  if (missedStarter.length > 0) {
    failures.push(`新号可达地点没被探索过：${missedStarter.map((item) => item.key).join('、')}`);
  }

  /*
   * 配方门：窗口够长时是硬门，窗口短于线索保底时降级为黄项。
   *
   * 阈值取 INITIATION.cluePityDays（保底承诺本身），而不是随便一个数：
   * 「满 5 天探索必出线索」是 M2.85 对玩家的承诺，窗口短于它的时候，
   * 「没人调制过配方」不是内容问题，而是**承诺还没到期**。
   */
  const missedRecipes = coverage.recipes.filter((item) => item.count === 0);
  if (missedRecipes.length > 0) {
    const names = missedRecipes.map((item) => item.key).join('、');
    const shortWindow =
      input.windowDays !== undefined && input.windowDays < INITIATION.cluePityDays;
    if (shortWindow) {
      warnings.push(
        `配方没被调制过：${names}（窗口 ${input.windowDays} 天 < 线索保底 ${INITIATION.cluePityDays} 天，` +
          '普通人还没拿到配方，不作为 CI 门禁 —— 用 200×14 的窗口查它）',
      );
    } else {
      failures.push(`配方没被调制过：${names}`);
    }
  }

  if (input.p0Count > 0) failures.push(`P0 异常 ${input.p0Count} 条`);

  if (input.strictCards) {
    const missed = coverage.cards.filter((item) => item.excluded !== true && item.count === 0);
    if (missed.length > 0) {
      failures.push(`可达卡里有 ${missed.length} 张 0 触发：${missed.map((item) => item.key).join('、')}`);
    }
  }

  return { ok: failures.length === 0, failures, warnings };
}

export interface CoverageReport {
  commands: CoverageItem[];
  cards: CoverageItem[];
  locations: CoverageItem[];
  recipes: CoverageItem[];
  lostControlTexts: CoverageItem[];
  /** 静态判定为「抽不到」的卡（内容缺口，需在 M2 修） */
  contentGaps: CoverageItem[];
  /**
   * 长链路两段（M2.13 前置 1）。
   *
   * **取代原先的复合指标 `9→8→7 ≥ 50`** —— 那一行要求两个转化同时达到各自的
   * 最高水位，在数学上就是紧的。门槛与取数口径只写在 src/vplayer/longchain.ts。
   */
  longChain: LongChainReport;
  /** 整体是否达标 */
  pass: boolean;
  failures: string[];
}

export interface CoverageOptions {
  minCommandCount: number;
  /** 静态判定为「抽不到」的卡：列出来但不计入达标要求 */
  unreachableCards?: readonly string[];
  /** 抽不到的卡的原因（卡 id → 原因） */
  unreachableReasons?: Readonly<Record<string, string>>;
  /** 只统计这些卡（默认全部）；用于把失控卡单独拆出去 */
  cardIds?: readonly string[];
}

/** 从指令原文里取出指令名（去掉点号与参数） */
export function commandNameOf(rawText: string): string {
  const trimmed = rawText.trim().replace(/^[.。．]/, '');
  return trimmed.split(/\s+/)[0] ?? '';
}

/**
 * 覆盖率失败清单 —— 单轮（computeCoverage）与分片合并（src/vplayer/merge.ts）**共用同一份口径**。
 * 抽出来的原因很实际：合并报告如果不按同一套话术判定，读报告的人会以为两轮结论不一致。
 */
export function coverageFailures(input: {
  commands: readonly CoverageItem[];
  cards: readonly CoverageItem[];
  locations: readonly CoverageItem[];
  recipes: readonly CoverageItem[];
  lostControlTexts: readonly CoverageItem[];
  longChain: LongChainReport;
  minCommandCount: number;
}): string[] {
  const failures: string[] = [];
  const shortCommands = input.commands.filter((item) => !item.pass);
  if (shortCommands.length > 0) {
    failures.push(
      `${shortCommands.length} 条指令未达到 ${input.minCommandCount} 次：${shortCommands
        .map((item) => `${item.key}(${item.count})`)
        .join('、')}`,
    );
  }
  const uncoveredCards = input.cards.filter((item) => !item.pass);
  if (uncoveredCards.length > 0) {
    failures.push(`${uncoveredCards.length} 张事件卡未被触发：${uncoveredCards.map((item) => item.key).join('、')}`);
  }
  const gaps = input.cards.filter((item) => item.excluded === true);
  if (gaps.length > 0) {
    failures.push(
      `${gaps.length} 张事件卡因内容配置抽不到（不计入达标，属于内容缺口）：${gaps.map((item) => item.key).join('、')}`,
    );
  }
  const uncoveredLocations = input.locations.filter((item) => !item.pass);
  if (uncoveredLocations.length > 0) {
    failures.push(`${uncoveredLocations.length} 个地点未被探索`);
  }
  const uncoveredRecipes = input.recipes.filter((item) => !item.pass);
  if (uncoveredRecipes.length > 0) {
    failures.push(`${uncoveredRecipes.length} 个配方未被调制：${uncoveredRecipes.map((item) => item.key).join('、')}`);
  }
  if (input.lostControlTexts.length === 0) failures.push('没有任何失控文本被触发');
  // 长链路：两段各自判（M2.13 前置 1）—— 不再是 `9→8→7 ≥ 50` 那一个复合指标
  for (const line of longChainFailures(input.longChain)) failures.push(line);
  return failures;
}

export function computeCoverage(
  records: readonly ActionRecord[],
  db: Db,
  world: {
    commands: readonly string[];
    cards: readonly string[];
    /** 地点按 id 取数（explore_daily 存的是 id），报告里显示名字 */
    locations: ReadonlyArray<{ id: string; name: string }>;
    recipes: readonly string[];
    lostControlTexts: readonly string[];
  },
  options: CoverageOptions,
): CoverageReport {
  const commandCounts = new Map<string, number>();
  for (const record of records) {
    const name = commandNameOf(record.command);
    commandCounts.set(name, (commandCounts.get(name) ?? 0) + 1);
  }

  const cardRows = db
    .prepare('SELECT event_id, COUNT(*) AS n FROM event_triggers GROUP BY event_id')
    .all() as Array<{ event_id: string; n: number }>;
  const cardCounts = new Map(cardRows.map((row) => [row.event_id, row.n]));

  const locationRows = db
    .prepare('SELECT location_id, SUM(count) AS n FROM explore_daily GROUP BY location_id')
    .all() as Array<{ location_id: string; n: number }>;
  const locationCounts = new Map(locationRows.map((row) => [row.location_id, Number(row.n)]));

  const recipeRows = db
    .prepare("SELECT reason, COUNT(*) AS n FROM domain_events WHERE reason LIKE '魔药:%' GROUP BY reason")
    .all() as Array<{ reason: string; n: number }>;
  const recipeCounts = new Map<string, number>();
  for (const row of recipeRows) {
    const id = row.reason.replace('魔药:', '');
    recipeCounts.set(id, (recipeCounts.get(id) ?? 0) + row.n);
  }

  const lostControlRows = db
    .prepare('SELECT text, COUNT(*) AS n FROM lost_control_events GROUP BY text')
    .all() as Array<{ text: string; n: number }>;

  /*
   * 长链路两段（M2.13 前置 1）：从 characters 表数**人数**。
   *
   * 这里原先数的是 `domain_events` 里 `promotion_success` 的**事件条数** ——
   * 那既不是人数（一个人可以晋升两次），也不区分 `9→8` 与 `8→7`，
   * 所以它没法拆成两段。改成按期末序列数人之后，两段各自的人数就是现成的。
   */
  const longChain = readLongChain(db);

  const minOne = 1;
  const build = (keys: readonly string[], counts: Map<string, number>, min: number): CoverageItem[] =>
    keys.map((key) => {
      const count = counts.get(key) ?? 0;
      return { key, count, pass: count >= min };
    });

  const excluded = new Set(options.unreachableCards ?? []);
  const reasons = options.unreachableReasons ?? {};

  const commands = build(world.commands, commandCounts, options.minCommandCount);
  const cards = (options.cardIds ?? world.cards).map((key) => {
    const count = cardCounts.get(key) ?? 0;
    const bad = excluded.has(key);
    return {
      key,
      count,
      pass: count >= minOne || bad,
      excluded: bad,
      note: bad ? (reasons[key] ?? '内容配置导致抽不到') : count >= minOne ? undefined : '本轮没抽到',
    };
  });
  const locations = world.locations.map((location) => {
    const count = locationCounts.get(location.id) ?? 0;
    return { key: location.name, count, pass: count >= minOne, note: count >= minOne ? undefined : '本轮没走到' };
  });
  const recipes = build(world.recipes, recipeCounts, minOne);
  const lostControlTexts = lostControlRows.map((row) => ({
    key: row.text.slice(0, 24),
    count: row.n,
    pass: row.n >= minOne,
  }));

  const failures = coverageFailures({
    commands,
    cards,
    locations,
    recipes,
    lostControlTexts,
    longChain,
    minCommandCount: options.minCommandCount,
  });

  return {
    commands,
    cards,
    locations,
    recipes,
    lostControlTexts,
    contentGaps: cards.filter((item) => item.excluded === true),
    longChain,
    pass: failures.length === 0,
    failures,
  };
}
