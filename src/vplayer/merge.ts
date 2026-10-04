/**
 * 分片结果合并（M2.3 任务四 §6.4）。
 *
 * 铁律：**合并必须走脚本，不许手动拼数字**。所以这里的每一个字段都只做两件事之一：
 *   累加（计数类）或按玩家数/动作数加权（比率类）。
 * 唯一需要「重算」的是百分位 —— 分片的 P50/P90 不能再平均一次，
 * 必须把各片的**原始值数组**拼起来重算（ShardJson.values 就是为它准备的）。
 *
 * 合并口径（任务书 §6.4 原表）：
 *   | 动作总数 | 累加 |  P0/P1 | 累加 |  覆盖率 | 累加 |
 *   | 长链路完成率 | 累加（分子分母都加） |  数值分布 | 按玩家数加权 |  失控率 | 按玩家数加权 |
 */
import { NUMERIC } from '../config/numeric.ts';
import { acceptanceOf, type ReportInput } from './report.ts';
import {
  COLUMN_TITLE,
  renderGateTable,
  renderVerdictLine,
} from './acceptance.ts';
import { coverageFailures, type CoverageItem, type CoverageReport } from './coverage.ts';
import { mergeLongChain, renderLongChainLines } from './longchain.ts';
import { SHARD_SCHEMA, type CharacterFinalValues, type ShardJson, type SocialMetrics } from './shard-json.ts';
import { codeVersionLineOf, type CodeVersion } from './code-version.ts';
import type { Analysis, AssaultStats, CurrencyComboStats, PersonaStats, WantedStats } from './analyzer.ts';
import type { AnomalyRecord } from './types.ts';
import { emptyGeoStats, renderGeoSection, type CityLabelLike, type GeoStats } from './geo-stats.ts';
import { loadCities } from '../data/loader.ts';

/**
 * 出生城市的中文名（报告里显示人话）。
 * 内容表是唯一的真相，这里只是读一次 —— 失败（内容损坏）时退回空表，
 * 报告里会显示城市 id，而不是让整份合并报告崩掉。
 */
const BIRTH_CITIES: readonly CityLabelLike[] = (() => {
  try {
    return loadCities()
      .cities.filter((city) => city.birth_weight > 0)
      .map((city) => ({ id: city.id, name: city.name }));
  } catch {
    return [];
  }
})();

export interface MergedShards {
  schema: string;
  shards: number;
  players: number;
  days: number;
  seeds: string[];
  /** M2.4：世界一致性（世界 seed 是否全局、4 片是否看到同一串事件） */
  world: WorldConsistency;
  costMsPerShard: number[];
  costMaxMs: number;
  wallClockMs: number;
  analysis: Analysis;
  coverage: CoverageReport;
  anomalies: AnomalyRecord[];
  /**
   * 逐片异常（M2.7.7 追加）。
   *
   * 为什么在"已经有一份累加好的 anomalies"之外还要留这个：
   * M2.7.6 的交付说明把 P1 写成了 0/0/1/0（实际 0/1/1/3 = 5 条）——
   * 因为写报告的人是从**四份分片进程的 stdout**里各抄了一个数字，而不是读合并报告。
   * 累加值本身没错（flatMap 而已），错的是"报告里没有一处能一眼看出这个值是怎么来的"。
   * 留下逐片明细之后，合并报告自己就能回答"5 条是哪来的"，
   * 引用数字的人不需要再去翻四个终端。
   */
  anomaliesPerShard: AnomalyRecord[][];
  profileSummary: Array<{ persona: string; players: number; loginAvg: number; actionsAvg: number; goalMix: string }>;
  cards: ShardJson['cards'];
  values: CharacterFinalValues;
  personaPlayers: Record<string, number>;
  lostControl: number;
  characters: number;
  rejectedActions: number;
  /** 不分片小轮的社交指标（分片模式下这些数字失真，单列在报告里） */
  social: { metrics: SocialMetrics; players: number; days: number; seed: string } | null;
  /** M2.7：世界地理与跨区域移动（各片累加） */
  geo: GeoStats;
  /** M2.32 任务 1（P0）：这批 8 片是不是同一份代码（见 codeConsistencyOf） */
  code: CodeConsistency;
}

/**
 * 地理统计的合并：全部是**计数**，直接累加即可。
 * 为什么不需要按人数加权（别的指标就要）：移动是「一个人的行程」——
 * 它不依赖同片里有谁，所以分片汇总与单轮跑没有口径差别。
 */
function mergeGeo(shards: readonly ShardJson[]): GeoStats {
  const out = emptyGeoStats();
  for (const shard of shards) {
    const geo = shard.geo;
    if (!geo) continue;
    for (const [key, value] of Object.entries(geo.birthCities)) {
      out.birthCities[key] = (out.birthCities[key] ?? 0) + value;
    }
    for (const [key, value] of Object.entries(geo.travelEvents)) {
      out.travelEvents[key] = (out.travelEvents[key] ?? 0) + value;
    }
    for (const [key, value] of Object.entries(geo.travelChoices)) {
      out.travelChoices[key] = (out.travelChoices[key] ?? 0) + value;
    }
    out.travelsStarted += geo.travelsStarted;
    out.travelsArrived += geo.travelsArrived;
    out.travelsOngoing += geo.travelsOngoing;
    out.travelPenny += geo.travelPenny;
  }
  return out;
}

/**
 * 世界一致性（M2.4 验收的核心证据）。
 *
 * 三件事分开判，因为它们对应三种不同的 bug：
 *   worldSeedAgreed —— 世界 seed 是不是全局的（分片派生了就会红）
 *   idsAgreed       —— 4 片是不是**同一串**事件（生成器读了玩家状态就会红）
 *   digestAgreed    —— 摘要是否相同（digestAgreed 与 idsAgreed 不一致 = 摘要函数本身有问题）
 */
export interface WorldConsistency {
  worldSeeds: string[];
  worldSeedAgreed: boolean;
  digests: string[];
  digestAgreed: boolean;
  idsAgreed: boolean;
  countPerShard: number[];
  /** 各片共同的事件 id 序列（只在完全一致时给出；不一致时是 null） */
  sharedIds: string[] | null;
  /** 只在不一致时才有的：第一片有、别的片没有的 id（最多 5 条，够定位问题） */
  diffSample: string[];
  identical: boolean;
}

export function worldConsistencyOf(shards: readonly ShardJson[]): WorldConsistency {
  const worldSeeds = shards.map((shard) => shard.worldSeed ?? '(缺失)');
  const digests = shards.map((shard) => shard.worldEvents?.digest ?? '(缺失)');
  const first = shards[0]?.worldEvents?.ids ?? [];
  const idsAgreed = shards.every(
    (shard) =>
      (shard.worldEvents?.ids ?? []).length === first.length &&
      (shard.worldEvents?.ids ?? []).every((id, index) => id === first[index]),
  );
  const worldSeedAgreed = worldSeeds.every((seed) => seed === worldSeeds[0]);
  const digestAgreed = digests.every((digest) => digest === digests[0]);

  const diffSample: string[] = [];
  if (!idsAgreed) {
    const others = new Set(shards.slice(1).flatMap((shard) => shard.worldEvents?.ids ?? []));
    for (const id of first) {
      if (!others.has(id) && diffSample.length < 5) diffSample.push(id);
    }
    for (const id of others) {
      if (!first.includes(id) && diffSample.length < 5) diffSample.push(id);
    }
  }

  return {
    worldSeeds,
    worldSeedAgreed,
    digests,
    digestAgreed,
    idsAgreed,
    countPerShard: shards.map((shard) => shard.worldEvents?.count ?? 0),
    sharedIds: idsAgreed ? first : null,
    diffSample,
    identical: worldSeedAgreed && idsAgreed,
  };
}

/**
 * M2.32 任务 1（P0）：**8 片跑的是不是同一份代码。**
 *
 * 为什么这不是锦上添花：**一个批次的定义就是「一份代码 + 一组参数跑出来的一堆数据」**。
 * 8 片各自在自己的进程里读 git ⇒ 如果跑批期间有人改了代码（或切了分支），
 * 8 片的 `codeRev` 就会不同 —— 那样这一批的每一个合并数字都是两份代码混出来的，
 * 而它**看起来完全正常**（K12 / K20 同族：症状都是「数据看起来没问题」）。
 *
 * 缺字段（M2.32 之前的产物）**不算不一致，但也不能算一致** —— 单列成「未记录」：
 * 那种批的一致性是**没有记录**，不是「验过了」。
 */
export interface CodeConsistency {
  /** 逐片的 rev（缺字段的记 '(未记录)'） */
  revs: string[];
  /** 逐片的 dirty 标记（缺字段的记 null） */
  dirtyFlags: Array<boolean | null>;
  /** 逐片的 builtAt（缺的记空串） */
  builtAts: string[];
  /** 有几片带了版本字段 */
  recorded: number;
  /** 带字段的那些片，rev 是否全部相同 */
  revAgreed: boolean;
  /** 标记了「工作区有未提交改动」的片数 */
  dirtyShards: number;
  /** 其中**判定输入**脏的片数 —— 非 0 ⇒ 这一批不可精确重生成 */
  judgementDirtyShards: number;
  /** 结论：true = 这一批可归因到同一个 commit 且可精确重生成 */
  attributed: boolean;
  /** 一句话结论（报告直接用） */
  note: string;
}

export function codeConsistencyOf(shards: readonly ShardJson[]): CodeConsistency {
  const revs = shards.map((shard) => shard.codeRev ?? '(未记录)');
  const dirtyFlags = shards.map((shard) => (shard.codeDirty === undefined ? null : shard.codeDirty));
  const builtAts = shards.map((shard) => shard.builtAt ?? '');
  const recordedShards = shards.filter((shard) => shard.codeRev !== undefined);
  const recorded = recordedShards.length;
  // ⚠️ 顺序很关键：先要求「每一片都记录了」，再谈「记录的值是否相同」——
  // 否则「全都缺字段」会被 every() 判成一致（空集的 every 是 true，这是最经典的假绿）。
  const revAgreed =
    shards.length > 0 &&
    recorded === shards.length &&
    recordedShards.every((shard) => shard.codeRev === recordedShards[0]!.codeRev);
  const dirtyShards = shards.filter((shard) => shard.codeDirty === true).length;
  const judgementDirtyShards = shards.filter((shard) => (shard.codeDirtyDetail?.judgement ?? 0) > 0).length;
  const attributed = revAgreed && judgementDirtyShards === 0;

  const note =
    recorded === 0
      ? '**未记录** —— 本产物生成于 M2.32 之前 ⇒ 这批**无法归因**到某个 commit'
      : !revAgreed
        ? '⚠️ **各片的 commit 不一致** —— 这一批是**两份代码混出来的**，「这批比上批多 N 人」不能这么读'
        : judgementDirtyShards > 0
          ? 'commit 一致（' + revs[0] + '），但有 ' + judgementDirtyShards + ' 片的工作区有未提交的**判定输入** ⇒ **不可精确重生成**'
          : 'commit 一致（' + revs[0] + '）、工作区干净 ⇒ **可精确重生成**';

  return { revs, dirtyFlags, builtAts, recorded, revAgreed, dirtyShards, judgementDirtyShards, attributed, note };
}

/**
 * 合并报告用的代码版本：把逐片的一致性结论压成报告首段那一行需要的形状。
 *
 * `codeRev` 在不一致时把各片的值都列出来（「哪个 commit」这个问题在不一致时没有单一答案，
 * 不能挑第一片的值冒充 —— 那正是 K12 / K20 的形状）。
 */
export function mergedCodeVersion(consistency: CodeConsistency): CodeVersion {
  const distinct = [...new Set(consistency.revs)];
  return {
    codeRev: consistency.revAgreed ? consistency.revs[0]! : distinct.join(' / '),
    codeDirty: consistency.dirtyShards > 0,
    builtAt: consistency.builtAts.find((value) => value.length > 0) ?? '',
    codeDirtyDetail: {
      judgement: consistency.judgementDirtyShards,
      artifacts: consistency.dirtyShards - consistency.judgementDirtyShards,
      sample: [],
    },
    // ⚠️ 合并层手上是**片数**不是处数 —— 量词必须说对（M2.32 实测踩过「1 片」被写成「1 处」）
    dirtyScope: 'merged',
  };
}

/**
 * M2.6：三层货币组合格式的分片合并。
 * 计数类一律累加；samples 只留前 12 条（报告里逐条列，不需要全量）。
 * ⚠️ mismatched 必须累加 —— 它是「金额对不上」的次数，任何一片对不上都是真 bug。
 */
function mergeCurrencyCombo(list: readonly CurrencyComboStats[]): CurrencyComboStats {
  const out: CurrencyComboStats = {
    attempts: 0,
    created: 0,
    mismatched: 0,
    byToken: {},
    samples: [],
    plainAttempts: 0,
  };
  for (const entry of list) {
    out.attempts += entry.attempts;
    out.created += entry.created;
    out.mismatched += entry.mismatched;
    out.plainAttempts += entry.plainAttempts;
    for (const [token, bucket] of Object.entries(entry.byToken)) {
      const target = (out.byToken[token] ??= { attempts: 0, created: 0, penny: bucket.penny });
      target.attempts += bucket.attempts;
      target.created += bucket.created;
    }
    for (const sample of entry.samples) {
      if (out.samples.length < 12) out.samples.push(sample);
    }
  }
  return out;
}

/**
 * M2.6：通缉统计的分片合并。
 *
 * characters 是「被判定过遭遇的角色数」——分片之间玩家不重叠，所以可以直接累加。
 * ⚠️ 但**绝对值不可信**（任务书 §五）：通缉是跨玩家行为（A 被通缉、B 举报 A），
 * 切片会改变"同一个通缉犯被几个人举报"这类相对关系的分母。
 * 分片只验机制跑通，绝对值一律用不分片小轮或真人验。
 */
function mergeWanted(list: readonly WantedStats[]): WantedStats {
  const out: WantedStats = {
    issued: 0,
    active: 0,
    byLevel: {},
    encounters: 0,
    claims: 0,
    claimedPenny: 0,
    characters: 0,
  };
  for (const entry of list) {
    out.issued += entry.issued;
    out.active += entry.active;
    out.encounters += entry.encounters;
    out.claims += entry.claims;
    out.claimedPenny += entry.claimedPenny;
    out.characters += entry.characters;
    for (const [level, count] of Object.entries(entry.byLevel)) {
      out.byLevel[level] = (out.byLevel[level] ?? 0) + count;
    }
  }
  return out;
}

/**
 * M2.6.1：袭击统计的分片合并。
 * 计数类累加；命中率**由累加后的分子分母重算**，不是对各片命中率取平均
 * （各片样本量不同，直接平均会偏向小样本那一片）。
 */
function mergeAssault(list: readonly AssaultStats[]): AssaultStats {
  const out: AssaultStats = {
    attempts: 0,
    blockedByGap: 0,
    resisted: 0,
    hit: 0,
    missed: 0,
    hitRate: 0,
    damage: 0,
    byDiff: {},
    sequenceMin: Number.POSITIVE_INFINITY,
    sequenceMax: Number.NEGATIVE_INFINITY,
  };
  for (const entry of list) {
    out.sequenceMin = Math.min(out.sequenceMin, entry.sequenceMin);
    out.sequenceMax = Math.max(out.sequenceMax, entry.sequenceMax);
    out.attempts += entry.attempts;
    out.blockedByGap += entry.blockedByGap;
    out.resisted += entry.resisted;
    out.hit += entry.hit;
    out.missed += entry.missed;
    out.damage += entry.damage;
    for (const [diff, count] of Object.entries(entry.byDiff)) {
      out.byDiff[diff] = (out.byDiff[diff] ?? 0) + count;
    }
  }
  // 与 analyzer.collectAssaultStats 同一口径（抗性挡下的算命中过）
  const decided = out.hit + out.missed + out.resisted;
  out.hitRate = decided === 0 ? 0 : (out.hit + out.resisted) / decided;
  if (!Number.isFinite(out.sequenceMin)) out.sequenceMin = 9;
  if (!Number.isFinite(out.sequenceMax)) out.sequenceMax = 9;
  return out;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function average(values: readonly number[]): number {
  return values.length === 0 ? 0 : sum(values) / values.length;
}

/** 与 analyzer.ts 同口径的百分位（左闭右开取整，保证合并结果与单轮可比） */
function percentile(values: readonly number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
}

/** 计数项合并：同 key 累加，pass 按合并后的总数重算（各片自己的 pass 不作数） */
function mergeItems(
  lists: ReadonlyArray<readonly CoverageItem[]>,
  passOf: (item: CoverageItem) => boolean,
): CoverageItem[] {
  const byKey = new Map<string, CoverageItem>();
  for (const list of lists) {
    for (const item of list) {
      const existing = byKey.get(item.key);
      if (!existing) {
        byKey.set(item.key, { ...item });
        continue;
      }
      existing.count += item.count;
      if (item.excluded) existing.excluded = true;
      if (!existing.note && item.note) existing.note = item.note;
    }
  }
  return [...byKey.values()].map((item) => ({ ...item, pass: passOf(item) }));
}

/** 「命令 → 次数」这一类的合并（回执分布、拒绝分布） */
function mergeCounts<T extends Record<string, unknown>>(
  lists: ReadonlyArray<readonly T[]>,
  keyOf: (entry: T) => string,
): T[] {
  const byKey = new Map<string, T>();
  for (const list of lists) {
    for (const entry of list) {
      const key = keyOf(entry);
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, { ...entry });
        continue;
      }
      const merged = { ...existing } as Record<string, unknown>;
      for (const [field, value] of Object.entries(entry)) {
        if (typeof value === 'number' && typeof merged[field] === 'number') {
          merged[field] = (merged[field] as number) + value;
        }
      }
      byKey.set(key, merged as T);
    }
  }
  return [...byKey.values()].sort(
    (a, b) => Number((b as { count?: number }).count ?? 0) - Number((a as { count?: number }).count ?? 0),
  );
}

function parseGoalMix(text: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const part of text.split(/\s+/)) {
    const [goal, count] = part.split(':');
    if (goal && count) out.set(goal, (out.get(goal) ?? 0) + Number(count));
  }
  return out;
}

function mergeProfiles(shards: readonly ShardJson[]): MergedShards['profileSummary'] {
  const byPersona = new Map<string, MergedShards['profileSummary'][number] & { goals: Map<string, number> }>();
  for (const shard of shards) {
    for (const entry of shard.profileSummary) {
      const current = byPersona.get(entry.persona) ?? {
        persona: entry.persona,
        players: 0,
        loginAvg: 0,
        actionsAvg: 0,
        goalMix: '',
        goals: new Map<string, number>(),
      };
      const total = current.players + entry.players;
      current.loginAvg = total === 0 ? 0 : (current.loginAvg * current.players + entry.loginAvg * entry.players) / total;
      current.actionsAvg = total === 0 ? 0 : (current.actionsAvg * current.players + entry.actionsAvg * entry.players) / total;
      current.players = total;
      for (const [goal, count] of parseGoalMix(entry.goalMix)) {
        current.goals.set(goal, (current.goals.get(goal) ?? 0) + count);
      }
      byPersona.set(entry.persona, current);
    }
  }
  return [...byPersona.values()].map((entry) => ({
    persona: entry.persona,
    players: entry.players,
    loginAvg: entry.loginAvg,
    actionsAvg: entry.actionsAvg,
    goalMix: [...entry.goals.entries()].map(([goal, count]) => `${goal}:${count}`).join(' '),
  }));
}

function mergeByPersona(shards: readonly ShardJson[]): PersonaStats[] {
  const personas = [...new Set(shards.flatMap((shard) => shard.analysis.byPersona.map((entry) => entry.persona)))];
  return personas.map((persona) => {
    const entries = shards
      .map((shard) => shard.analysis.byPersona.find((entry) => entry.persona === persona))
      .filter((entry): entry is PersonaStats => Boolean(entry));
    const players = sum(entries.map((entry) => entry.players));
    const actions = sum(entries.map((entry) => entry.actions));
    const weighted = (pick: (entry: PersonaStats) => number): number =>
      players === 0 ? 0 : sum(entries.map((entry) => pick(entry) * entry.players)) / players;
    return {
      persona,
      players,
      actions,
      promotionsAttempted: sum(entries.map((entry) => entry.promotionsAttempted)),
      promotionsSucceeded: sum(entries.map((entry) => entry.promotionsSucceeded)),
      lostControls: sum(entries.map((entry) => entry.lostControls)),
      reachedSequence8: sum(entries.map((entry) => entry.reachedSequence8)),
      avgDig: weighted((entry) => entry.avgDig),
      avgMad: weighted((entry) => entry.avgMad),
      avgCor: weighted((entry) => entry.avgCor),
      rejectRate: actions === 0 ? 0 : sum(entries.map((entry) => entry.rejectRate * entry.actions)) / actions,
    };
  });
}

/** 合并所有分片；社交指标只在 `social` 里出现（分片跑出来的社交数字不可信） */
export function mergeShards(
  shards: readonly ShardJson[],
  options: { social?: ShardJson; wallClockMs?: number } = {},
): MergedShards {
  if (shards.length === 0) throw new Error('没有分片结果可合并');
  for (const shard of shards) {
    if (shard.schema !== SHARD_SCHEMA) {
      throw new Error(`不认识的分片口径 ${shard.schema}（需要 ${SHARD_SCHEMA}）—— 别把不同版本的报告拼在一起`);
    }
  }
  const days = shards[0]!.days;
  for (const shard of shards) {
    if (shard.days !== days) {
      throw new Error(`分片天数不一致：${shard.shard} 是 ${shard.days} 天，${shards[0]!.shard} 是 ${days} 天`);
    }
  }

  const players = sum(shards.map((shard) => shard.players));
  const values: CharacterFinalValues = {
    dig: shards.flatMap((shard) => shard.values.dig),
    mad: shards.flatMap((shard) => shard.values.mad),
    cor: shards.flatMap((shard) => shard.values.cor),
    hp: shards.flatMap((shard) => shard.values.hp),
  };

  const totalActions = sum(shards.map((shard) => shard.analysis.totalActions));
  const rejectedActions = sum(shards.map((shard) => shard.rejectedActions));
  const sequenceDistribution: Record<string, number> = {};
  for (const shard of shards) {
    for (const [seq, count] of Object.entries(shard.analysis.finals.sequenceDistribution)) {
      sequenceDistribution[seq] = (sequenceDistribution[seq] ?? 0) + count;
    }
  }

  const created = sum(shards.map((shard) => shard.analysis.funnel[0]?.count ?? 0));
  const funnel = (shards[0]!.analysis.funnel ?? []).map((stage, index) => {
    const count = sum(shards.map((shard) => shard.analysis.funnel[index]?.count ?? 0));
    return { stage: stage.stage, count, rate: created === 0 ? 0 : count / created };
  });

  const attempted = sum(shards.map((shard) => shard.analysis.promotion.attempted));
  const succeeded = sum(shards.map((shard) => shard.analysis.promotion.succeeded));

  const analysis: Analysis = {
    totalActions,
    totalPlayers: players,
    byPersona: mergeByPersona(shards),
    promotion: {
      attempted,
      succeeded,
      rate: attempted === 0 ? 0 : succeeded / attempted,
      completions: sum(shards.map((shard) => shard.analysis.promotion.completions)),
    },
    funnel,
    finals: {
      sequenceDistribution,
      digAvg: average(values.dig),
      madAvg: average(values.mad),
      corAvg: average(values.cor),
      hpAvg: average(values.hp),
    },
    percentiles: {
      dig: { p50: percentile(values.dig, 0.5), p90: percentile(values.dig, 0.9) },
      mad: { p50: percentile(values.mad, 0.5), p90: percentile(values.mad, 0.9) },
      cor: { p50: percentile(values.cor, 0.5), p90: percentile(values.cor, 0.9) },
    },
    rejectRate: totalActions === 0 ? 0 : rejectedActions / totalActions,
    rejectSamples: shards.flatMap((shard) => shard.analysis.rejectSamples).slice(0, 10),
    rejectionByCommand: mergeCounts(
      shards.map((shard) => shard.analysis.rejectionByCommand as unknown as Array<Record<string, unknown>>),
      (entry) => String(entry.command),
    ) as unknown as Analysis['rejectionByCommand'],
    replyOutcomes: mergeCounts(
      shards.map((shard) => shard.analysis.replyOutcomes as unknown as Array<Record<string, unknown>>),
      (entry) => `${entry.command}|__|${entry.outcome}`,
    )
      .map((entry) => ({
        command: String(entry.command),
        outcome: String(entry.outcome),
        count: Number(entry.count ?? 0),
      }))
      .slice(0, 20),
    // M2.6：分片口径 —— **只验机制跑通，绝对值不作数**（任务书 §五）。
    // 通缉是跨玩家行为（A 被通缉、B 举报 A），被切成 4 片之后
    // 「同一个通缉犯被几个人举报」这类相对关系仍然成立，
    // 但「通缉率」「平均赏金」这类绝对值会随切片方式变化，只能用不分片小轮或真人验。
    currencyCombo: mergeCurrencyCombo(shards.map((shard) => shard.analysis.currencyCombo)),
    wanted: mergeWanted(shards.map((shard) => shard.analysis.wanted)),
    assault: mergeAssault(shards.map((shard) => shard.analysis.assault)),
  };

  const minCommandCount = shards[0]!.thresholds.minCommandCount;
  const minPromotions = shards[0]!.thresholds.minPromotions;
  /*
   * 长链路两段（M2.13 前置 1）：分子分母都累加，pass 按合并后的总数重算。
   *
   * 缺字段 = 这份 JSON 是 M2.13 之前的旧口径 —— **明确报错，不要静默补 0**：
   * 0 恰恰是「这一轮没人在序列 8」的正常取值，两者没法区分。
   */
  const longChain = mergeLongChain(
    shards.map((shard, index) => {
      const chain = shard.coverage.longChain;
      if (!chain) {
        throw new Error(
          `分片 ${index} 的 JSON 缺少 longChain（M2.13 之前的旧口径）：` +
            '请用 scripts/m2-13-1-merged-report.ts（它从分片库补算），或重跑这一批。',
        );
      }
      return chain;
    }),
  );
  const coverage: CoverageReport = {
    commands: mergeItems(
      shards.map((shard) => shard.coverage.commands),
      (item) => item.count >= minCommandCount,
    ),
    cards: mergeItems(
      shards.map((shard) => shard.coverage.cards),
      (item) => item.count >= 1 || item.excluded === true,
    ),
    locations: mergeItems(
      shards.map((shard) => shard.coverage.locations),
      (item) => item.count >= 1,
    ),
    recipes: mergeItems(
      shards.map((shard) => shard.coverage.recipes),
      (item) => item.count >= 1,
    ),
    lostControlTexts: mergeItems(
      shards.map((shard) => shard.coverage.lostControlTexts),
      (item) => item.count >= 1,
    ),
    contentGaps: [],
    longChain,
    pass: false,
    failures: [],
  };
  coverage.contentGaps = coverage.cards.filter((item) => item.excluded === true);
  coverage.failures = coverageFailures({
    commands: coverage.commands,
    cards: coverage.cards,
    locations: coverage.locations,
    recipes: coverage.recipes,
    lostControlTexts: coverage.lostControlTexts,
    longChain,
    minCommandCount,
  });
  coverage.pass = coverage.failures.length === 0;

  const personaPlayers: Record<string, number> = {};
  for (const shard of shards) {
    for (const [persona, count] of Object.entries(shard.personaPlayers)) {
      personaPlayers[persona] = (personaPlayers[persona] ?? 0) + count;
    }
  }

  return {
    schema: SHARD_SCHEMA,
    shards: shards.length,
    players,
    days,
    seeds: shards.map((shard) => shard.seed),
    world: worldConsistencyOf(shards),
    code: codeConsistencyOf(shards),
    geo: mergeGeo(shards),
    costMsPerShard: shards.map((shard) => shard.costMs),
    costMaxMs: Math.max(...shards.map((shard) => shard.costMs)),
    wallClockMs: options.wallClockMs ?? Math.max(...shards.map((shard) => shard.costMs)),
    analysis,
    coverage,
    anomalies: shards.flatMap((shard) => shard.anomalies),
    anomaliesPerShard: shards.map((shard) => shard.anomalies),
    profileSummary: mergeProfiles(shards),
    cards: shards[0]!.cards,
    values,
    personaPlayers,
    lostControl: sum(shards.map((shard) => shard.lostControl)),
    characters: sum(shards.map((shard) => shard.characters)),
    rejectedActions,
    social: options.social
      ? {
          metrics: options.social.social ?? {
            tradesCreated: 0,
            tradesConfirmed: 0,
            tradesExpired: 0,
            partyActions: 0,
            partyTasks: 0,
            partiesWithTwoPlus: 0,
          },
          players: options.social.players,
          days: options.social.days,
          seed: options.social.seed,
        }
      : null,
  };
}

/**
 * 指标来源对照表（任务书 §6.5 要求报告里必须标注哪些来自分片、哪些来自不分片小轮）。
 * 这张表是**写进报告的硬性内容**，不是注释。
 */
export const METRIC_PROVENANCE: ReadonlyArray<{
  metric: string;
  source: 'shard' | 'single';
  note: string;
}> = [
  { metric: '动作总数', source: 'shard', note: '累加' },
  { metric: 'P0 / P1 异常', source: 'shard', note: '累加' },
  { metric: '指令 / 卡 / 地点 / 配方覆盖率', source: 'shard', note: '按 key 累加' },
  { metric: '长链路完成率', source: 'shard', note: '分子分母都加' },
  { metric: '数值分布（MAD / COR / DIG）', source: 'shard', note: '按玩家数加权；百分位由全量值重算' },
  { metric: '失控率', source: 'shard', note: '按玩家数加权' },
  { metric: '交易成功率', source: 'single', note: '分片后跨片玩家不可见，交易只在本片内发生 —— 数字必然偏低' },
  { metric: '组队触发率', source: 'single', note: '同上：组队是跨玩家行为' },
  { metric: '跨玩家事件', source: 'single', note: '同上：私聊/群聊播报只在片内可见' },
  // M2.6 追加（任务书 §五 明确点名要求写进任务书，避免下一轮又问「为什么通缉率这么低」）
  {
    metric: '通缉 / 举报 / 逃逸（机制是否跑通）',
    source: 'shard',
    note: '累加即可判定「机制有没有被触发」',
  },
  {
    metric: '通缉率 / 举报成功率 / 赏金均值（绝对值）',
    source: 'single',
    note:
      '通缉是跨玩家行为（A 被通缉、B 举报 A）：切片会改变「同一个通缉犯被几个人举报」的分母。' +
      '分片只能验机制跑通，绝对值一律用不分片小轮或真人验',
  },
  {
    metric: '三层货币组合格式成功率',
    source: 'shard',
    note: '单玩家行为，切片不影响；金额按便士比对必须 0 笔不符',
  },
  {
    metric: '出生城市分布 / 移动次数 / 路途事件分布（M2.7）',
    source: 'shard',
    note:
      '出生分布由 userId 派生（纯函数，与分片无关）；移动是单个玩家的行程，' +
      '不依赖同片里有谁 —— 所以分片累加与单轮跑口径一致，' +
      '这与通缉那种跨玩家指标不同',
  },
];

function pct(value: number, digits = 1): string {
  return `${(value * 100).toFixed(digits)}%`;
}

function num(value: number, digits = 2): string {
  return value.toFixed(digits);
}

export interface RenderMergedOptions {
  /** 复现命令（写进报告首段） */
  commandLine: string;
  /** 阶段名（M2.3） */
  stage: string;
  /** 社交小轮的来源说明 */
  socialSource?: string;
}

/** 合并报告：首行必须写清口径（任务书 §6.6） */
export function renderMergedReport(merged: MergedShards, options: RenderMergedOptions): string {
  const { analysis, coverage, anomalies } = merged;
  const input: ReportInput = {
    players: merged.players,
    days: merged.days,
    seed: merged.seeds.join(' + '),
    baseUrl: '分片模式：每片独立进程 + 独立 SQLite + 独立端口',
    startedAt: new Date().toISOString(),
    costMs: merged.wallClockMs,
    analysis,
    coverage,
    anomalies,
    profileSummary: merged.profileSummary,
    cards: merged.cards as ReportInput['cards'],
    stage: options.stage,
    reportPrefix: `${options.stage}-回归`,
    // 合并报告不另出准入报告文件：三栏判定直接内嵌在本报告第一节（同一份 acceptance.ts 算出来的）
    acceptanceReportPath: `docs/${options.stage}-回归报告.md（第一节）`,
    acceptance: { pass: true, failures: [] },
    // M2.32 任务 1（P0）：合并报告也要说清「这批 8 片跑的是不是同一份代码」
    code: mergedCodeVersion(merged.code),
  };
  const { gates, verdict } = acceptanceOf(input);
  const p0 = anomalies.filter((anomaly) => anomaly.level === 'P0');
  const p1 = anomalies.filter((anomaly) => anomaly.level === 'P1');

  const lines: string[] = [];
  lines.push(`# ${options.stage} 回归报告（分片合并）`);
  lines.push('');
  lines.push(
    `> **口径（首行必读）**：本轮是 **${merged.shards} 分片并行**跑出来的 —— ` +
      `${merged.players} 玩家 × ${merged.days} 天，按玩家分片（每片 ${merged.players / merged.shards} 人），` +
      '每片独立进程、独立 SQLite、独立端口；**玩家行为 seed** 由 <seed>:shard:<i> 确定性派生，' +
      '**世界 seed 全局一个**（4 片相同，见第〇节）。' +
      '**分片模式与不分片模式不可直接比较**（玩家分组不同、跨玩家交互被切断）。',
  );
  lines.push('>');
  lines.push(
    '> 分片的代价（任务书 §6.5）：**社交失真** —— 交易、组队、跨玩家交互只在分片内发生，' +
      'A 片的玩家看不到 B 片的玩家。所以交易成功率 / 组队触发率 / 跨玩家事件**不用分片结果**，' +
      '单列在第九节的不分片小轮里。',
  );
  lines.push('');
  lines.push(`- 执行命令：\`${options.commandLine}\``);
  lines.push(
    `- 分片耗时：各片 ${merged.costMsPerShard.map((ms) => `${(ms / 1000).toFixed(0)}s`).join(' / ')}` +
      `；**墙钟 ${(merged.wallClockMs / 60000).toFixed(1)} 分钟**（并行跑，受最慢那片限制）`,
  );
  lines.push(`- 数据来源：${merged.seeds.join('、')}`);
  /*
   * M2.32 任务 1（P0）：合并报告也要能回答「这批跑的是哪份代码」。
   *
   * ⚠️ 合并报告的头部是**自己渲染**的（它只把 ReportInput 交给 acceptanceOf 算三栏判定），
   * 所以主报告里那一行**不会自动出现在这里** —— 必须在这里显式加。
   * （M2.32 实测踩到：先只改了 report.ts，合并报告里一个字都没有。）
   */
  lines.push(`- 代码版本：${codeVersionLineOf(mergedCodeVersion(merged.code), merged.code.recorded > 0)}`);
  if (merged.code.recorded > 0 && !merged.code.attributed) {
    lines.push('');
    lines.push('> ⚠️ **这一批不能归因到同一个 commit**：' + merged.code.note);
    lines.push('');
  }
  lines.push('');
  lines.push('## 〇、世界一致性（M2.4：4 片必须看到同一个世界）');
  lines.push('');
  lines.push(
    '世界 seed 是**全局一个**（WORLD_SEED，不随分片派生），分片只派生**玩家行为 seed**。' +
      '所以 4 片跑同一 seed 的世界，应该看到**同一串世界事件**；' +
      '不一样就说明世界 seed 没全局化，或者事件生成器读了玩家状态 —— 两种都是 bug。',
  );
  lines.push('');
  lines.push('| 分片 | 世界 seed | 事件条数 | 事件摘要 |');
  lines.push('|---|---|---|---|');
  for (let index = 0; index < merged.shards; index += 1) {
    lines.push(
      `| 片 ${index} | \`${merged.world.worldSeeds[index] ?? '-'}\` | ${merged.world.countPerShard[index] ?? 0} | \`${merged.world.digests[index] ?? '-'}\` |`,
    );
  }
  lines.push('');
  lines.push(
    `- 世界 seed 一致：${merged.world.worldSeedAgreed ? '**是**' : '**否（分片派生世界 seed = bug）**'}` +
      `（${merged.world.worldSeeds.join(' / ')}）`,
  );
  lines.push(
    `- 事件序列逐条一致：${merged.world.idsAgreed ? '**是**' : '**否**'}` +
      `（摘要 ${merged.world.digests.join(' / ')}）`,
  );
  if (!merged.world.idsAgreed && merged.world.diffSample.length > 0) {
    lines.push(`- 差异样例：\`${merged.world.diffSample.join('\`、\`')}\``);
  }
  lines.push(
    `- 结论：${merged.world.identical ? '**4 片世界状态一致**（M2.4 验收通过）' : '**世界状态分叉，必须查**'}`,
  );
  lines.push('');
  lines.push('## 一、准入判定（系统 / 内容 / 数值 三栏，来自分片）');
  lines.push('');
  lines.push(renderVerdictLine(verdict));
  lines.push('');
  lines.push(`### 1. ${COLUMN_TITLE.system}`);
  lines.push('');
  for (const line of renderGateTable(gates.system)) lines.push(line);
  lines.push('');
  lines.push(`### 2. ${COLUMN_TITLE.content}`);
  lines.push('');
  for (const line of renderGateTable(gates.content)) lines.push(line);
  lines.push('');
  lines.push(`### 3. ${COLUMN_TITLE.numeric}`);
  lines.push('');
  for (const line of renderGateTable(gates.numeric)) lines.push(line);
  lines.push('');
  lines.push('## 二、长链路漏斗（分片，分子分母都累加）');
  lines.push('');
  lines.push('| 阶段 | 人数 | 占建号比例 |');
  lines.push('|---|---|---|');
  for (const stage of analysis.funnel) lines.push(`| ${stage.stage} | ${stage.count} | ${pct(stage.rate)} |`);
  lines.push('');
  lines.push(
    `晋升判定：发起 ${analysis.promotion.attempted} 次、成功 ${analysis.promotion.succeeded} 次，成功率 ${pct(analysis.promotion.rate)}。`,
  );
  lines.push('');
  lines.push('## 三、期末数值分布（分片；百分位由全量值重算，不是分片百分位的平均）');
  lines.push('');
  lines.push('| 指标 | 均值 | P50 | P90 |');
  lines.push('|---|---|---|---|');
  lines.push(`| DIG | ${num(analysis.finals.digAvg)} | ${num(analysis.percentiles.dig.p50)} | ${num(analysis.percentiles.dig.p90)} |`);
  lines.push(`| MAD | ${num(analysis.finals.madAvg)} | ${num(analysis.percentiles.mad.p50)} | ${num(analysis.percentiles.mad.p90)} |`);
  lines.push(`| COR | ${num(analysis.finals.corAvg)} | ${num(analysis.percentiles.cor.p50)} | ${num(analysis.percentiles.cor.p90)} |`);
  lines.push('');
  lines.push(
    `期末均值：HP ${num(analysis.finals.hpAvg, 1)}；` +
      `期末仍处失控 ${merged.lostControl}/${merged.characters}（${pct(merged.characters === 0 ? 0 : merged.lostControl / merged.characters)}）—— ` +
      '失控只持续 1 天且玩家会当天解除，所以期末为 0 是常态；失控是否真的发生要看「失控文本触发了多少条」。',
  );
  lines.push('');
  lines.push('| 画像 | 人数 | 动作数 | 晋升成功 | 到达序列 8 | 期末 DIG | 期末 MAD | 期末 COR | 拒绝率 |');
  lines.push('|---|---|---|---|---|---|---|---|---|');
  for (const stats of analysis.byPersona) {
    lines.push(
      `| ${stats.persona} | ${stats.players} | ${stats.actions} | ${stats.promotionsSucceeded} | ${stats.reachedSequence8} | ` +
        `${num(stats.avgDig)} | ${num(stats.avgMad)} | ${num(stats.avgCor)} | ${pct(stats.rejectRate)} |`,
    );
  }
  lines.push('');
  lines.push(
    `动作总数 ${analysis.totalActions} 条（累加），拒绝 ${merged.rejectedActions} 条，整体拒绝率 ${pct(analysis.rejectRate)}。`,
  );
  lines.push('');
  lines.push('## 四、异常摘要（分片，累加）');
  lines.push('');
  lines.push(
    `P0 ${p0.length} 条、P1 ${p1.length} 条。` +
      '**这一节的数字是引用口径的唯一来源** —— 交付说明、验收报告里写 P0/P1 时，' +
      '一律以本节为准（历史教训：M2.7.6 的交付说明从四份分片 stdout 里各抄了一个数字，把 P1 写成 1 条，实际是 5 条）。',
  );
  /*
   * 逐片分布：让"合并值是怎么来的"在这张表里自证。
   * 合计行必须等于各片之和 —— test/m2-3-shard.test.ts 守着这条。
   */
  lines.push('');
  lines.push('| 分片 | P0 | P1 | 合计 |');
  lines.push('|---|---|---|---|');
  let p0Sum = 0;
  let p1Sum = 0;
  for (let index = 0; index < merged.anomaliesPerShard.length; index += 1) {
    const ofShard = merged.anomaliesPerShard[index] ?? [];
    const shardP0 = ofShard.filter((anomaly) => anomaly.level === 'P0').length;
    const shardP1 = ofShard.filter((anomaly) => anomaly.level === 'P1').length;
    p0Sum += shardP0;
    p1Sum += shardP1;
    lines.push(`| 片 ${index} | ${shardP0} | ${shardP1} | ${shardP0 + shardP1} |`);
  }
  lines.push(`| **合计** | **${p0Sum}** | **${p1Sum}** | **${p0Sum + p1Sum}** |`);
  if (anomalies.length > 0) {
    lines.push('');
    lines.push('| 代码 | 级别 | 次数 |');
    lines.push('|---|---|---|');
    const byCode = new Map<string, { level: string; count: number }>();
    for (const anomaly of anomalies) {
      const entry = byCode.get(anomaly.code) ?? { level: anomaly.level, count: 0 };
      entry.count += 1;
      byCode.set(anomaly.code, entry);
    }
    for (const [code, entry] of byCode) lines.push(`| ${code} | ${entry.level} | ${entry.count} |`);
  }
  lines.push('');
  // M2.7：世界地理与移动（各片累加，口径与单轮一致 —— 移动是「一个人的行程」）
  lines.push(...renderGeoSection(merged.geo, BIRTH_CITIES, { sharded: true }));
  lines.push('');
  lines.push('## 五、覆盖率摘要（分片，按 key 累加）');
  lines.push('');
  lines.push(
    `指令：${coverage.commands.filter((item) => item.pass).length}/${coverage.commands.length} 条达标；` +
      `事件卡：${coverage.cards.filter((item) => item.pass).length}/${coverage.cards.length}；` +
      `地点：${coverage.locations.filter((item) => item.pass).length}/${coverage.locations.length}；` +
      `配方：${coverage.recipes.filter((item) => item.pass).length}/${coverage.recipes.length}；` +
      `失控文本：${coverage.lostControlTexts.length} 条被触发。`,
  );
  lines.push('');
  lines.push('### 晋升链路：两段各自判定（M2.13 前置 1）');
  lines.push('');
  for (const line of renderLongChainLines(coverage.longChain)) lines.push(line);
  lines.push('');
  lines.push('| 指令 | 次数（合并） | 结论 |');
  lines.push('|---|---|---|');
  for (const item of [...coverage.commands].sort((a, b) => b.count - a.count)) {
    lines.push(`| .${item.key} | ${item.count} | ${item.pass ? '达标' : '未达标'} |`);
  }
  lines.push('');
  const missedCards = coverage.cards.filter((item) => !item.pass);
  if (missedCards.length > 0) {
    lines.push('### 未触发的卡（按原因分类 —— 分片轮里组队类卡的可见性天然偏低）');
    lines.push('');
    lines.push('| 卡 id | 触发次数 | 未触发原因 |');
    lines.push('|---|---|---|');
    for (const item of missedCards) {
      const conds = merged.cards.find((card) => card.id === item.key)?.conds ?? [];
      const reason = conds.some((cond) => /^party\s*:/.test(cond.trim()))
        ? '需要队友（party:*）：**分片切断了跨玩家交互**，这类卡的可达性以不分片小轮 / 单轮 200×14 为准'
        : conds.some((cond) => /^flag\s*:/.test(cond.trim()))
          ? '依赖 flag 链（flag:*）：本轮没有走到该分支'
          : '窗口内没有抽到（随机性，不是内容配置问题）';
      lines.push(`| ${item.key} | ${item.count} | ${reason} |`);
    }
    lines.push('');
  }
  if (coverage.failures.length > 0) {
    lines.push('### 未达标项');
    lines.push('');
    for (const failure of coverage.failures) lines.push(`- ${failure}`);
    lines.push('');
  }
  // M2.6：通缉与三层货币。分片口径只报"机制有没有跑通"，绝对值一律交给不分片小轮。
  {
    const combo = merged.analysis.currencyCombo;
    const wanted = merged.analysis.wanted;
    lines.push('## 五·补、M2.6 通缉系统与三层货币（分片合并）');
    lines.push('');
    lines.push('| 指标 | 合并实测 | 口径 |');
    lines.push('|---|---|---|');
    lines.push(`| 通缉令签发 | ${wanted.issued} 条（期末有效 ${wanted.active}） | 累加；只验机制跑通 |`);
    lines.push(
      `| 通缉等级分布 | ${Object.entries(wanted.byLevel).map(([level, count]) => level + ' 级:' + count).join(' ') || '无'} | 本版应只有 1 级 |`,
    );
    lines.push(`| 遭遇判定 | ${wanted.encounters} 次（${wanted.characters} 人） | 累加 |`);
    lines.push(`| 赏金领取 | ${wanted.claims} 笔 / ${wanted.claimedPenny} 便士 | 累加 |`);
    const assault = merged.analysis.assault;
    lines.push(
      `| 袭击判定（M2.6.1） | 判定 ${assault.attempts} 次：被拦 ${assault.blockedByGap} / 抗性 ${assault.resisted} / 命中 ${assault.hit} / 扑空 ${assault.missed} | 累加 |`,
    );
    lines.push(
      `| 实测命中率 | ${(assault.hitRate * 100).toFixed(1)}%（命中 ${assault.hit} / 决出 ${assault.hit + assault.missed}） | 由累加后的分子分母重算 |`,
    );
    lines.push(`| 袭击造成的伤害合计 | ${assault.damage} | 累加 |`);
    lines.push(
      `| 序列差分布 | ${Object.entries(assault.byDiff).map(([diff, count]) => (Number(diff) > 0 ? '弱' : Number(diff) < 0 ? '强' : '同') + Math.abs(Number(diff)) + ':' + count).join(' ') || '无'} | 正数 = 攻击者序列更低 |`,
    );
    lines.push(
      `| 序列跨度 | ${assault.sequenceMin}—${assault.sequenceMax} | 跨度 < ${NUMERIC.assault.sequenceGating.blockThreshold} 时「被拦」必然为 0 |`,
    );
    lines.push(
      `| 组合格式报价 | ${combo.created} / ${combo.attempts} 笔成功（纯数字 ${combo.plainAttempts} 笔） | 单玩家行为，切片不影响 |`,
    );
    lines.push(`| 金额按便士比对不符 | ${combo.mismatched} 笔 | **必须为 0** |`);
    lines.push('');
    lines.push(
      '> ⚠️ **绝对值不可信**（任务书 §五 与上面的「指标来源对照」表）：' +
        '通缉是跨玩家行为，切片改变了「同一个通缉犯被几个人举报」的分母。' +
        '本节的数字只能回答「机制跑通了没有」，通缉率 / 举报成功率这类绝对值' +
        '以不分片小轮（20×3）或真人封测为准。',
    );
    lines.push('');
  }
  lines.push('## 六、社交指标（**来自不分片小轮，不是分片**）');
  lines.push('');
  if (merged.social) {
    const social = merged.social;
    lines.push(
      `- 小轮配置：${social.players} 玩家 × ${social.days} 天，seed=\`${social.seed}\`（不分片：所有玩家互相可见）`,
    );
    lines.push(`- 交易：发起 ${social.metrics.tradesCreated} 笔、成交 ${social.metrics.tradesConfirmed} 笔、超时 ${social.metrics.tradesExpired} 笔`);
    lines.push(
      `- 交易成交率：${pct(social.metrics.tradesCreated === 0 ? 0 : social.metrics.tradesConfirmed / social.metrics.tradesCreated)}`,
    );
    lines.push(`- 组队：.队伍 类指令 ${social.metrics.partyActions} 次，队伍任务 ${social.metrics.partyTasks} 次，2 人以上队伍 ${social.metrics.partiesWithTwoPlus} 个`);
    lines.push(
      '> 读法：小轮（20 人 × 3 天）的价值是**对照**而不是绝对值 —— ' +
        '交易要成交，对手得在同一天上线并且选择确认；窗口一短，成交率自然接近 0（M2.2 时代的 W8-CI 20×3 同样是「发起 24 笔、无成交记录」）。' +
        '真正能说明交易链路是否健康的是不分片的 200×14（M2.2-终验：426 笔成交）。',
    );
    if (options.socialSource) lines.push(`- 来源：\`${options.socialSource}\``);
  } else {
    lines.push('本轮没有提供不分片小轮的结果，社交指标缺失 —— **报告口径不完整**，请补跑 20×3。');
  }
  lines.push('');
  lines.push('## 七、指标来源对照（任务书 §6.5 强制标注）');
  lines.push('');
  lines.push('| 指标 | 来源 | 说明 |');
  lines.push('|---|---|---|');
  for (const entry of METRIC_PROVENANCE) {
    lines.push(`| ${entry.metric} | ${entry.source === 'shard' ? '分片' : '不分片小轮'} | ${entry.note} |`);
  }
  lines.push('');
  lines.push('## 八、可复现性说明（任务书 §6.6）');
  lines.push('');
  lines.push(
    '- 分片模式下：**同 seed + 同分片数 → 同结果**（每片的 seed 由 vplayer-m23:shard:<i> 确定性派生，' +
      '分片内玩家由该 seed 生成，服务端时钟由测试固定）。',
  );
  lines.push('- **与不分片模式不可直接比较**：玩家被分到了不同的片里，跨玩家交互的可见性不同，分组本身就变了。');
  lines.push(
    `- 每片玩家数：${merged.seeds.map((seed, index) => '片' + index + '=' + Math.round(merged.players / merged.shards)).join('、')}（余数分给前几片）。`,
  );
  lines.push('');
  lines.push('## 九、结论');
  lines.push('');
  lines.push(
    verdict.level === 'red'
      ? '- 本轮有红项，**先修红项再谈下一阶段**。'
      : verdict.level === 'yellow'
        ? '- 本轮无红项，黄项作为下一阶段第一优先。'
        : '- 三栏全绿，可进入下一阶段。',
  );
  lines.push(
    `- 分片把单轮从「单进程串行」压到 ${(merged.wallClockMs / 60000).toFixed(1)} 分钟（${merged.shards} 片）；` +
      '分片数越高越快，但社交失真越大 —— 默认 4 片是速度与失真的折中。',
  );
  lines.push('');
  return lines.join('\n');
}


