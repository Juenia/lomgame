/**
 * 结果分析（W7）：把行为日志与库数据汇总成可用于决策的数字。
 */
import { NUMERIC } from '../config/numeric.ts';
import { parseCurrency } from '../domain/currency/index.ts';
import type { Db } from '../infra/db/sqlite.ts';
import { PATHWAY_TAGS } from '../domain/play/tags.ts';
import { OPEN_PATHWAYS } from '../domain/character/rules.ts';
import type { PathwayId } from '../domain/character/types.ts';
import { commandNameOf } from './coverage.ts';
import type { ActionRecord, Persona } from './types.ts';

export interface PersonaStats {
  persona: Persona;
  players: number;
  actions: number;
  promotionsAttempted: number;
  promotionsSucceeded: number;
  lostControls: number;
  reachedSequence8: number;
  avgDig: number;
  avgMad: number;
  avgCor: number;
  /** 被拒绝的指令比例（冷却/资源不足/条件不满足） */
  rejectRate: number;
}

export interface FunnelStage {
  stage: string;
  count: number;
  rate: number;
}

export interface Analysis {
  totalActions: number;
  totalPlayers: number;
  byPersona: PersonaStats[];
  promotion: { attempted: number; succeeded: number; rate: number; completions: number };
  /** 长链路漏斗：建号 → 调制 → 服用 → DIG 达标 → 晋升成功 */
  funnel: FunnelStage[];
  finals: {
    sequenceDistribution: Record<string, number>;
    digAvg: number;
    madAvg: number;
    corAvg: number;
    hpAvg: number;
  };
  percentiles: { dig: { p50: number; p90: number }; mad: { p50: number; p90: number }; cor: { p50: number; p90: number } };
  rejectRate: number;
  rejectSamples: Array<{ command: string; text: string }>;
  rejectionByCommand: Array<{ command: string; count: number }>;
  /**
   * 指令 × 回执首行 的分布（前若干条）。
   * 这是「玩家实际看到了什么」的最直接证据：交易过期、金镑不足、
   * 冷却挡住多少条，都能在这里一眼看出来，而不是靠猜。
   */
  replyOutcomes: Array<{ command: string; outcome: string; count: number }>;
  /** M2.6 前置项二：三层货币组合格式在真实链路上的实测 */
  currencyCombo: CurrencyComboStats;
  /** M2.6：通缉系统的实测数字（与 wanted_states 表同源） */
  wanted: WantedStats;
  /** M2.6.1：袭击的三类结果（被拦 / 抗性 / 命中） */
  assault: AssaultStats;
}

/** 组合格式报价的一条实测记录 */
export interface ComboTradeSample {
  /** 玩家发出去的报价原文（如 1g5s3p） */
  token: string;
  /** 按解析器算出来的应付便士 */
  expectedPenny: number;
  /** 从**服务端回执**里读回来、再解析成便士的金额 */
  actualPenny: number | null;
  ok: boolean;
}

export interface CurrencyComboStats {
  /** 组合格式报价次数 */
  attempts: number;
  /** 其中「交易单已创建」的次数 */
  created: number;
  /**
   * 金额对不上的次数。
   * **必须恒为 0** —— 非 0 就说明 input 解析与回执复述这两条路给出的便士数不一致，
   * 那是货币系统的真 bug，不是覆盖率问题。
   */
  mismatched: number;
  /** 按报价原文分组 */
  byToken: Record<string, { attempts: number; created: number; penny: number }>;
  /** 成功样本（供报告逐条列出"发了什么、算成多少便士"） */
  samples: ComboTradeSample[];
  /** 纯数字报价的对照次数（证明组合格式不是唯一路径，比例接近 30%） */
  plainAttempts: number;
}

/**
 * M2.6.1：袭击的三类结果（任务书 §七 要求写进报告）。
 *
 * 数据源是 domain_events，不是回执文本 —— 回执的措辞会随文案迭代而变，
 * 而事件里的 blockedBy / hit 是判定层的结构化产物，稳定可查。
 */
export interface AssaultStats {
  /** 判定次数（含被拦 —— 被拦也是一次判定，只是没动成手） */
  attempts: number;
  /** 被序列差直接拦下（「你根本近不了他的身。」） */
  blockedByGap: number;
  /** 被高序列抗性挡下（「伤害被什么东西挡下了。」） */
  resisted: number;
  /** 命中并造成伤害 */
  hit: number;
  /** 扑空 */
  missed: number;
  /**
   * 命中骰的命中率 = (hit + resisted) / (hit + missed + resisted)。
   *
   * ⚠️ 口径：**抗性判定发生在命中之后**，所以被抗性挡下的一击在命中骰上算命中过。
   * 第一版把被拦的两类混在一起扣分母，结果"实测命中率"对不上公式
   * （矩阵脚本的蒙特卡洛自检抓到的，见 docs/M2.6.1-袭击矩阵.md 第三节）。
   */
  hitRate: number;
  /** 造成的伤害总量 */
  damage: number;
  /** 序列差直方图（diff → 次数），报告里用来看"大家都在越级打谁" */
  byDiff: Record<string, number>;
  /**
   * 本批角色的序列跨度（最低 / 最高）。
   *
   * 为什么需要它：「序列差 ≥ 3 被拦」这条规则**在本版内容边界内不可达** ——
   * MVP 最高只能升到序列 8（9→8 是唯一一段配方），与最低的序列 9 只差 1。
   * 也就是说 20×3 和 200×14 里都不可能出现 diff ≥ 3 的对阵，
   * 「被拦」永远是 0 次。门如果不认这件事，就会永远黄着，
   * 而读报告的人会以为规则没生效 —— 那是**假警报**，和 M2.1 的失控依赖卡是同一类问题。
   * 所以把跨度报出来，让门能区分「规则没生效」与「本批不存在可拦的对阵」。
   */
  sequenceMin: number;
  sequenceMax: number;
}

export interface WantedStats {
  /** 累计签发过的通缉令 */
  issued: number;
  /** 期末仍然有效的 */
  active: number;
  /** 按等级 */
  byLevel: Record<string, number>;
  /** 遭遇判定次数（wanted_encounter 事件） */
  encounters: number;
  /** 赏金领取次数与总额（便士） */
  claims: number;
  claimedPenny: number;
  /** 被判过遭遇的角色数 */
  characters: number;
}

/**
 * 系统拒绝话术（只匹配回执首行开头，避免把叙事文本里的「已经/没有」误判成拒绝）
 */
const REJECT_PREFIXES = [
  // 系统拒绝话术一律以「首行开头」精确匹配：命中就说明这条指令没生效，
  // 既不算「卡死」（玩家已经拿到原因），也不该算进有效动作。
  '冷却中，请',
  '卜象还没散去', // 占卜冷却（30 秒 > 出招间隔，必然撞上）
  // M2.85：'行动点不足' 随行动值机制移除（这条拒绝话术已经不存在了）
  '今天已经',
  '今天的',
  '你还没有角色',
  '未开放途径',
  '没有这个地方',
  '没有这份配方',
  '材料不足',
  '净化材料不足',
  '晋升材料不足',
  '灵性不足',
  '不能直接使用',
  '找不到这个队伍',
  // 队长一离开队伍就解散（W4 规则），这条话术一直在漏判 —— 200 次加入里 194 次是它
  '这个队伍已经解散了',
  '只有队长',
  '队伍已满',
  '你已经在一个队伍里',
  '你不在任何队伍里',
  '不能和自己交易',
  '不能交易',
  '数量不足',
  '没有这笔交易',
  '这笔交易已经结束',
  '这笔交易与你无关',
  '只有买家能确认',
  '你已经创建过角色',
  '你手上没有魔药',
  '未识别指令',
  '写得太短',
  '反馈太长了',
  '姓名长度需',
  '你现在的状态',
  '你现在处于失控',
  '消化度不足',
  '你还没有服下',
  '消息包含违规内容',
  '用法：',
  '请用 @ 指定',
  '价格必须是正整数',
  // 以下都是实例测试里真实撞到过的拒绝话术（补在这里，避免误判成卡死）
  '背包是空的',
  '对方还没有角色',
  '你还有 ', // 待确认交易额度用满（W7 漏掉的一条，W8 补）
  '你只有 ',
  '没有这件物品',
  '不是魔药',
  '不适合你的途径',
  '数量不足',
  '物品冻结失败',
  '材料扣除失败',
  '晋升材料扣除失败',
  '货币不足',
  '货币扣除失败',
  '这瓶魔药',
  '这个序列暂时没有对应的晋升',
  '队伍人数不够',
  '这个姓名包含违规内容',
  '这笔交易已超过',
  /*
   * M2.7.6：普通人阶段新增的拒绝话术。
   *
   * 漏掉「今天已经在……待了 3 次」这一条的代价特别大：它是**探索撞上限**时的回执，
   * 而虚拟玩家在普通人阶段一天要探索十几次 —— 没被识别成拒绝，就会被当成
   * 「成功但状态没变」，连发十次刷一条 NO_STATE_CHANGE。
   * 实测 50 人 × 14 天刷出两千多条，足以把真异常淹掉。
   */
  '今天已经在',
  /* M2.85：原来这里还有一条「行动点不足」（普通人最容易撞的一堵墙）——
     行动值机制移除后这条拒绝话术不再存在，词条随之下线。 */
  '你手上没有配方',
  // M2.7.7：普通人入口守卫的文案（.魔药 那条）
  '你还没有走上途径',
  /*
   * M2.7.7：仪式链路的几条「条件没满足」。
   *
   * 「你把仪式定在了夜晚，现在是黎明 —— 到点再来 .仪式 开始。」这条最要命：
   * 它是个**时间条件**，玩家在到点之前每试一次都被拒，
   * 而拒绝不被识别 → 换招机制拉不动 → 一个玩家日刷一条 P1。
   * 另外几条是仪式没准备 / 没选地点 / 没有进行中的仪式 —— 同一个机制。
   */
  '你把仪式定在了',
  '你还没有在准备仪式',
  '还没有选地点',
  '你现在没有正在进行的仪式',
  '你不知道这瓶东西',
  '没有这份配方',
  '没有「',
  '你想模仿什么',
  '你没有序列',
  '你手上没有任何能用来占卜的东西',
  '你还没有资格举行仪式',
  '你看不见别人在做什么',
  '你还没有角色',
  '这瓶魔药不是给你现在准备的',
];

/**
 * 句式型拒绝（M2.7.7）。
 *
 * 为什么前缀表不够：有一类回执的**开头是变量**，句式却是固定的。典型是
 * 「warrior_9 属于战士途径，你是愚者。」—— 开头是配方 id，
 * 前缀匹配一个都抓不住，于是被当成「成功但状态没变」。
 *
 * 后果不是少记一条拒绝，而是**换招机制失效**：虚拟玩家靠 isRejected 更新
 * lastRejected，识别不出来就会一整天反复发同一条必然失败的指令，
 * 一天之内刷满 NO_STATE_CHANGE（M2.7.6 那 5 条 P1 里有 4 条是它）。
 */
const REJECT_PATTERNS: readonly RegExp[] = [
  /^.+ 属于.+途径，你是.+。$/,
  /^没有「.+」这个选项。$/,
  /^.+不是你现在能选的东西。$/,
  /*
   * 跨城探索：「普利兹港在普利兹港，你现在在贝克兰德。」
   *
   * 这一条漏掉的代价很大：玩家一旦离开任务所在的城市，那条任务就永远做不完，
   * 而换招机制（lastRejected）拉不动 —— 于是他会一天三四十次地重试同一条，
   * 每个玩家日刷一条 P1。
   */
  /^.+，你现在在.+。$/,
];

export function isRejected(replyTexts: readonly string[]): boolean {
  return replyTexts.some((text) => {
    const firstLine = text.split('\n')[0]?.trim() ?? '';
    if (REJECT_PREFIXES.some((prefix) => firstLine.startsWith(prefix))) return true;
    return REJECT_PATTERNS.some((pattern) => pattern.test(firstLine));
  });
}

function percentile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
}

/**
 * M2.6 前置项二：三层货币的**组合格式**在真实 HTTP 链路上的实测。
 *
 * 判据是「玩家发了什么 → 服务端算出多少 → 回执里复述的是多少」这条闭环：
 *   1. 命令原文最后一段就是报价（`.交易 @qq 物品 1 1g5s3p`）；
 *   2. 用**同一个** parseCurrency 算出应付便士（expectedPenny）；
 *   3. 从回执的「价格：1 金镑 5 苏勒 3 便士（税 …）」里把金额抠回来、
 *      再用 parseCurrency 解析（actualPenny）；
 *   4. 两者不等 = 货币系统真 bug（不是覆盖率问题）。
 *
 * 第 3 步是这条测试的价值所在：它验证的不只是"输入被接受了"，
 * 而是"输入经过解析、存库、格式化、再次解析之后仍然是同一个便士数"。
 */
// ⚠️ 这两个正则曾因为一处转义事故变成 /交易s+S+.../（模板字符串把 \s 吞成了 s），
// 结果整整一轮 CI 的「组合格式 0 笔」看起来像功能没做，实际是探针自己失明。
// 现在改成「只判指令名 + 取最后一段」这种不依赖转义的写法。
const RE_TRADE_COMMAND = /^[.。．]交易\s/;
const RE_PRICE_LINE = /价格：([^（]+)（/;

export function collectCurrencyCombo(records: readonly ActionRecord[]): CurrencyComboStats {
  const stats: CurrencyComboStats = {
    attempts: 0,
    created: 0,
    mismatched: 0,
    byToken: {},
    samples: [],
    plainAttempts: 0,
  };

  for (const record of records) {
    const trimmed = record.command.trim();
    if (!RE_TRADE_COMMAND.test(trimmed)) continue;
    // 价格永远是指令的最后一段：.交易 @qq 物品 [数量] 价格
    const token = trimmed.split(/\s+/).pop() ?? '';
    // 纯数字 = 对照组；组合格式才是本项要验的东西
    if (/^[0-9]+$/.test(token)) {
      stats.plainAttempts += 1;
      continue;
    }
    const expectedPenny = parseCurrency(token);
    if (expectedPenny === null) continue;

    stats.attempts += 1;
    const joined = record.replyTexts.join('\n');
    const created = joined.includes('交易单已创建');
    // ⚠️ **只从自己这条回执里取价格**。
    // replyTexts 里可能先排着别人发来的交易通知（"XX 想和你交易：… 价格：6 便士…"），
    // 直接对整段 exec 会抓到**别人的报价**，于是"金额不符"被误报。
    // 200×14 分片实测：3076 笔里 4 笔因此被判成不符，逐条看下来全是这个原因
    // —— 又一次"探针自己失明"，不是货币系统的 bug。
    // 锚点是"交易单已创建"：那是**卖家自己**新建成功的回执，它之后跟着的才是本笔的价格。
    const tail = created ? joined.slice(joined.indexOf('交易单已创建')) : joined;
    const priceMatch = RE_PRICE_LINE.exec(tail);
    const actualPenny = priceMatch ? parseCurrency(priceMatch[1]!.trim()) : null;

    const bucket = (stats.byToken[token] ??= { attempts: 0, created: 0, penny: expectedPenny });
    bucket.attempts += 1;

    if (created) {
      stats.created += 1;
      bucket.created += 1;
    }
    if (created && actualPenny !== null && actualPenny !== expectedPenny) {
      stats.mismatched += 1;
    }
    if (created && stats.samples.length < 12) {
      stats.samples.push({ token, expectedPenny, actualPenny, ok: actualPenny === expectedPenny });
    }
  }

  return stats;
}

/** M2.6：通缉系统的实测数字（与 wanted_states / bounty_claims 同源） */
export function collectWantedStats(db: Db, now: number): WantedStats {
  const issued = (db.prepare('SELECT COUNT(*) AS n FROM wanted_states').get() as { n: number }).n;
  const active = (
    db.prepare('SELECT COUNT(*) AS n FROM wanted_states WHERE expires_at > ?').get(now) as { n: number }
  ).n;
  const levelRows = db
    .prepare('SELECT level, COUNT(*) AS n FROM wanted_states GROUP BY level')
    .all() as Array<{ level: number; n: number }>;
  const byLevel: Record<string, number> = {};
  for (const row of levelRows) byLevel[String(row.level)] = row.n;

  const encounters = (
    db.prepare("SELECT COUNT(*) AS n FROM domain_events WHERE type = 'wanted_encounter'").get() as {
      n: number;
    }
  ).n;
  const characters = (
    db
      .prepare("SELECT COUNT(DISTINCT character_id) AS n FROM domain_events WHERE type = 'wanted_encounter'")
      .get() as { n: number }
  ).n;
  const claim = db
    .prepare('SELECT COUNT(*) AS n, COALESCE(SUM(reward_penny), 0) AS s FROM bounty_claims')
    .get() as { n: number; s: number };

  return {
    issued,
    active,
    byLevel,
    encounters,
    claims: Number(claim.n),
    claimedPenny: Number(claim.s),
    characters,
  };
}

/** M2.6.1：从 domain_events 里数袭击的三类结果 */
export function collectAssaultStats(db: Db): AssaultStats {
  const rows = db
    .prepare(
      "SELECT type, payload FROM domain_events WHERE type IN ('assault_blocked', 'assault_resolved')",
    )
    .all() as Array<{ type: string; payload: string }>;

  const spread = db
    .prepare('SELECT MIN(sequence) AS lo, MAX(sequence) AS hi FROM characters')
    .get() as { lo: number | null; hi: number | null };

  const stats: AssaultStats = {
    attempts: rows.length,
    blockedByGap: 0,
    resisted: 0,
    hit: 0,
    missed: 0,
    hitRate: 0,
    damage: 0,
    byDiff: {},
    sequenceMin: Number(spread.lo ?? 9),
    sequenceMax: Number(spread.hi ?? 9),
  };

  for (const row of rows) {
    let payload: {
      blockedBy?: string | null;
      hit?: boolean;
      damage?: number;
      diff?: number;
    };
    try {
      payload = JSON.parse(row.payload) as typeof payload;
    } catch {
      continue;
    }
    if (typeof payload.diff === 'number') {
      const key = String(payload.diff);
      stats.byDiff[key] = (stats.byDiff[key] ?? 0) + 1;
    }
    if (row.type === 'assault_blocked') {
      if (payload.blockedBy === 'resist') stats.resisted += 1;
      else stats.blockedByGap += 1;
      continue;
    }
    if (payload.hit === true) {
      stats.hit += 1;
      stats.damage += Number(payload.damage ?? 0);
    } else {
      stats.missed += 1;
    }
  }

  const decided = stats.hit + stats.missed + stats.resisted;
  stats.hitRate = decided === 0 ? 0 : (stats.hit + stats.resisted) / decided;
  return stats;
}

export function analyze(
  records: readonly ActionRecord[],
  db: Db,
  players: number,
  now: number = Date.now(),
): Analysis {
  const characters = db.prepare('SELECT * FROM characters').all() as Array<Record<string, unknown>>;
  const personas = [...new Set(records.map((record) => record.persona))];

  const byPersona: PersonaStats[] = personas.map((persona) => {
    const subset = records.filter((record) => record.persona === persona);
    const playerIds = new Set(subset.map((record) => record.playerId));
    const rejected = subset.filter((record) => isRejected(record.replyTexts));
    const personaCharacters = characters.filter((row) =>
      playerIds.has(Number(String(row.user_id)) - 700000),
    );
    return {
      persona,
      players: playerIds.size,
      actions: subset.length,
      promotionsAttempted: subset.filter((record) => record.command.startsWith('.晋升')).length,
      promotionsSucceeded: personaCharacters.filter((row) => Number(row.sequence) < 9).length,
      lostControls: personaCharacters.filter((row) => String(row.status) === 'lost_control').length,
      reachedSequence8: personaCharacters.filter((row) => Number(row.sequence) <= 8).length,
      avgDig: average(personaCharacters.map((row) => Number(row.dig))),
      avgMad: average(personaCharacters.map((row) => Number(row.mad))),
      avgCor: average(personaCharacters.map((row) => Number(row.cor))),
      rejectRate: subset.length === 0 ? 0 : rejected.length / subset.length,
    };
  });

  const outcomeCounts = new Map<string, number>();
  for (const record of records) {
    const first = (record.replyTexts[0] ?? '').split('\n')[0]?.trim() ?? '';
    if (!first) continue;
    const key = `${commandNameOf(record.command)} | ${first.slice(0, 48)}`;
    outcomeCounts.set(key, (outcomeCounts.get(key) ?? 0) + 1);
  }
  const replyOutcomes = [...outcomeCounts.entries()]
    .map(([key, count]) => {
      const [command, outcome] = key.split(' | ');
      return { command: command ?? '', outcome: outcome ?? '', count };
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);

  const attempted = (
    db
      .prepare("SELECT COUNT(*) AS n FROM domain_events WHERE type IN ('promotion_success','promotion_fail')")
      .get() as { n: number }
  ).n;
  const succeeded = (
    db.prepare("SELECT COUNT(*) AS n FROM domain_events WHERE type = 'promotion_success'").get() as {
      n: number;
    }
  ).n;

  // 长链路漏斗：每一层都用库里的真实痕迹
  const created = characters.length;
  const brewed = new Set(
    (
      db
        .prepare("SELECT DISTINCT character_id FROM domain_events WHERE reason LIKE '魔药:%'")
        .all() as Array<{ character_id: string }>
    ).map((row) => row.character_id),
  ).size;
  const drank = (
    db
      .prepare("SELECT COUNT(DISTINCT character_id) AS n FROM flags WHERE flag = 'first_potion_taken'")
      .get() as { n: number }
  ).n;
  const digReady = characters.filter((row) => Number(row.dig) >= NUMERIC.promotion.digThreshold).length;
  const promoted = new Set(
    (
      db
        .prepare("SELECT DISTINCT character_id FROM domain_events WHERE type = 'promotion_success'")
        .all() as Array<{ character_id: string }>
    ).map((row) => row.character_id),
  ).size;

  const digValues = characters.map((row) => Number(row.dig));
  const madValues = characters.map((row) => Number(row.mad));
  const corValues = characters.map((row) => Number(row.cor));

  const rejectedRecords = records.filter((record) => isRejected(record.replyTexts));
  const rejectionCounts = new Map<string, number>();
  for (const record of rejectedRecords) {
    const name = record.command.replace(/^[.。．]/, '').split(/\s+/)[0] ?? '';
    rejectionCounts.set(name, (rejectionCounts.get(name) ?? 0) + 1);
  }

  const sequenceDistribution: Record<string, number> = {};
  for (const row of characters) {
    const key = String(row.sequence);
    sequenceDistribution[key] = (sequenceDistribution[key] ?? 0) + 1;
  }

  return {
    totalActions: records.length,
    totalPlayers: players,
    byPersona,
    replyOutcomes,
    // M2.6
    currencyCombo: collectCurrencyCombo(records),
    wanted: collectWantedStats(db, now),
    // M2.6.1
    assault: collectAssaultStats(db),
    promotion: {
      attempted,
      succeeded,
      rate: attempted === 0 ? 0 : succeeded / attempted,
      completions: promoted,
    },
    funnel: [
      { stage: '建号', count: created, rate: created === 0 ? 0 : 1 },
      { stage: '调制魔药', count: brewed, rate: created === 0 ? 0 : brewed / created },
      { stage: '服用魔药', count: drank, rate: created === 0 ? 0 : drank / created },
      { stage: 'DIG 达标', count: digReady, rate: created === 0 ? 0 : digReady / created },
      { stage: '晋升成功（序列 8）', count: promoted, rate: created === 0 ? 0 : promoted / created },
    ],
    finals: {
      sequenceDistribution,
      digAvg: average(digValues),
      madAvg: average(madValues),
      corAvg: average(corValues),
      hpAvg: average(characters.map((row) => Number(row.hp))),
    },
    percentiles: {
      dig: { p50: percentile(digValues, 0.5), p90: percentile(digValues, 0.9) },
      mad: { p50: percentile(madValues, 0.5), p90: percentile(madValues, 0.9) },
      cor: { p50: percentile(corValues, 0.5), p90: percentile(corValues, 0.9) },
    },
    rejectRate: records.length === 0 ? 0 : rejectedRecords.length / records.length,
    rejectSamples: rejectedRecords.slice(0, 10).map((record) => ({
      command: record.command,
      text: record.replyTexts[0]?.slice(0, 120) ?? '',
    })),
    rejectionByCommand: [...rejectionCounts.entries()]
      .map(([command, count]) => ({ command, count }))
      .sort((a, b) => b.count - a.count),
  };
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/*
 * M2.26 任务 0.6：**默认值改成引用 `OPEN_PATHWAYS`**（K16 的修法：引用，不是补齐）。
 *
 * 这里原来手抄了一份「已实现途径」的列表（先是三条、M2.26 任务 0 时补齐成五条）——
 * 与 `profiles.ts:130`、`cities.yaml` 的 `pathways` 是**同一个形状的漏**：
 * 抄一份会漂的副本，下一轮加途径必漏。
 *
 * 守卫：`test/m2-26-pathway-pool.test.ts` 里有用例断言
 * 「把 `OPEN_PATHWAYS` 改掉，这里的默认值跟着变」——
 * 那是**动态**的（读运行时的长度），不是「两边都写 5 条」那种会一起漂的断言。
 */
export function worldKnowledge(pathways: PathwayId[] = OPEN_PATHWAYS) {
  void pathways;
  return PATHWAY_TAGS;
}
