/**
 * 实测 MAD / COR 分布（M2.1）
 *
 * 为什么要这份东西：W5 模拟器给出「激进型 30 天失控率 27.2%」，前提假设是
 * 「玩家会把 MAD 顶到 90+」；W7/W8 实测激进型 14 天 MAD 均值只有 40 出头、P90 只有 71。
 * 假设与实测对不上，阈值就没法定。M2.1 的第一步就是**把实测分布取出来**。
 *
 * 两个数据源，产出同一份结构：
 *   1) domain_events（服务端权威账本）：mad_delta / cor_delta / dig_delta 的 payload.after
 *      —— 有库时用这条，最准。
 *   2) 行为日志 JSONL（W7/W8 归档）：回执里带「疯狂 0 → 1」与「当前：… 疯狂 3 / 污染 2」
 *      —— 虚拟玩家 CLI 跑完会删临时库（cleanupDb），W7/W8 的库没留下，只有日志留下来了。
 *      日志里每次变化都打印 before → after，逐条重放即可还原轨迹；
 *      before 与本地跟踪值不一致时以回执为准（resync），把 tick 等无回执的变化纠正回来。
 */
import { createReadStream, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { timeOfDay } from '../domain/world/clock.ts';

/** 时段桶的取法：与世界时钟同一份实现（东八区），不另写一套边界 */
const timeOfDayOf = (at: number): string => timeOfDay(at);

export const DEFAULT_BASE_EPOCH = Date.parse('2026-01-01T00:00:00+08:00');
const DAY_MS = 24 * 60 * 60 * 1000;

/** 角色名前缀 → 画像（虚拟玩家的名字就是「激进者12」这种，库里可从名字反查画像） */
export const PERSONA_PREFIX: Readonly<Record<string, string>> = {
  稳健者: 'steady',
  激进者: 'aggressive',
  混乱者: 'chaotic',
  轻量者: 'light',
  完美者: 'perfectionist',
};

export function personaOfName(name: string): string {
  for (const [prefix, persona] of Object.entries(PERSONA_PREFIX)) {
    if (name.startsWith(prefix)) return persona;
  }
  return 'unknown';
}

export interface DailySample {
  characterId: string;
  persona: string;
  day: number;
  mad: number;
  cor: number;
  dig: number;
  sequence: number;
}

export interface PersonaDayStats {
  persona: string;
  day: number;
  count: number;
  madMean: number;
  madP50: number;
  madP90: number;
  corMean: number;
  corP90: number;
  digMean: number;
  dangerShare: number;
}

export interface PersonaStats {
  persona: string;
  characters: number;
  days: number;
  madMean: number;
  madP50: number;
  madP90: number;
  madMax: number;
  corMean: number;
  corP90: number;
  /** 期末仍卡在序列 9 且 DIG 达标 且 MAD ≥ 80 且 COR ≥ 70 的比例（死循环，固定尺子 80/70） */
  deadlockShare: number;
}

/** 画像级行为频率（可见性预算要用：失控日能抽几次卡） */
export interface PersonaActionRate {
  persona: string;
  playerDays: number;
  plays: number;
  /** 每个「玩家日」平均发出几次 .扮演 */
  playsPerPlayerDay: number;
  /** 每个「玩家日」平均发出几次 .事件 */
  eventsPerPlayerDay: number;
  /** 每个「玩家日」平均总动作数 */
  actionsPerPlayerDay: number;
  /**
   * M2.2：每角色每日 .扮演 次数的直方图（下标 = 次数，值 = 出现该次数的玩家日数量）。
   * 「激进行为 MAD 涨得更猛」这一刀要按它抽样 —— 只加在**当天扮演很多**的玩家日上，
   * 稳健型天然落在阈值以下（依据见 docs/M2.2-失控复算报告.md）。
   */
  playsPerDayHistogram: number[];
}

export interface MeasuredDistribution {
  source: string;
  generatedAt: string;
  window: { characters: number; days: number };
  /** 逐角色逐天的期末样本（投影引擎的输入） */
  samples: DailySample[];
  byPersona: PersonaStats[];
  byDay: PersonaDayStats[];
  actionRates?: PersonaActionRate[];
  diagnostics: { records: number; resync: number; daysObserved: number };
}

/** 由「画像 × 玩家日」的动作计数汇总出行为频率 */
export function summarizeActionRates(
  counts: Map<string, { persona: string; plays: number; events: number; actions: number }>,
): PersonaActionRate[] {
  const byPersona = new Map<
    string,
    { play: number; event: number; action: number; days: number; histogram: number[] }
  >();
  for (const entry of counts.values()) {
    const bucket =
      byPersona.get(entry.persona) ?? { play: 0, event: 0, action: 0, days: 0, histogram: [] };
    bucket.play += entry.plays;
    bucket.event += entry.events;
    bucket.action += entry.actions;
    bucket.days += 1;
    bucket.histogram[entry.plays] = (bucket.histogram[entry.plays] ?? 0) + 1;
    byPersona.set(entry.persona, bucket);
  }
  return [...byPersona.entries()]
    .map(([persona, bucket]) => ({
      persona,
      playerDays: bucket.days,
      plays: bucket.play,
      playsPerPlayerDay: round(bucket.days === 0 ? 0 : bucket.play / bucket.days, 3),
      eventsPerPlayerDay: round(bucket.days === 0 ? 0 : bucket.event / bucket.days, 3),
      actionsPerPlayerDay: round(bucket.days === 0 ? 0 : bucket.action / bucket.days, 3),
      playsPerDayHistogram: padHistogram(bucket.histogram),
    }))
    .sort((a, b) => (a.persona < b.persona ? -1 : 1));
}

/** 直方图补齐（把空洞填 0，并保证至少有 2 个槽） */
export function padHistogram(histogram: readonly number[]): number[] {
  const out: number[] = [];
  const length = Math.max(2, histogram.length);
  for (let index = 0; index < length; index += 1) out.push(histogram[index] ?? 0);
  return out;
}

/* ---------------- 统计工具 ---------------- */

export function percentile(values: readonly number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;

}
export function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

const round = (value: number, digits = 2): number => Number(value.toFixed(digits));

/** 由逐天样本汇总出「按画像」「按画像 × 天」两张表（报告与投影都读它） */
export function summarize(samples: readonly DailySample[]): {
  byPersona: PersonaStats[];
  byDay: PersonaDayStats[];
} {
  const personas = [...new Set(samples.map((sample) => sample.persona))].sort();
  const byPersona: PersonaStats[] = personas.map((persona) => {
    const rows = samples.filter((sample) => sample.persona === persona);
    const maxDay = Math.max(...rows.map((row) => row.day));
    const finals = rows.filter((row) => row.day === maxDay);
    const deadlock = finals.filter(
      (row) => row.sequence === 9 && row.dig >= 60 && row.mad >= 80 && row.cor >= 70,
    ).length;
    return {
      persona,
      characters: new Set(rows.map((row) => row.characterId)).size,
      days: maxDay + 1,
      madMean: round(mean(rows.map((row) => row.mad))),
      madP50: round(percentile(rows.map((row) => row.mad), 0.5)),
      madP90: round(percentile(rows.map((row) => row.mad), 0.9)),
      madMax: Math.max(0, ...rows.map((row) => row.mad)),
      corMean: round(mean(rows.map((row) => row.cor))),
      corP90: round(percentile(rows.map((row) => row.cor), 0.9)),
      deadlockShare: round(finals.length === 0 ? 0 : deadlock / finals.length, 4),
    };
  });

  const byDay: PersonaDayStats[] = [];
  const days = [...new Set(samples.map((sample) => sample.day))].sort((a, b) => a - b);
  for (const persona of personas) {
    for (const day of days) {
      const rows = samples.filter((sample) => sample.persona === persona && sample.day === day);
      if (rows.length === 0) continue;
      byDay.push({
        persona,
        day,
        count: rows.length,
        madMean: round(mean(rows.map((row) => row.mad))),
        madP50: round(percentile(rows.map((row) => row.mad), 0.5)),
        madP90: round(percentile(rows.map((row) => row.mad), 0.9)),
        corMean: round(mean(rows.map((row) => row.cor))),
        corP90: round(percentile(rows.map((row) => row.cor), 0.9)),
        digMean: round(mean(rows.map((row) => row.dig))),
        dangerShare: round(rows.filter((row) => row.mad >= 80 || row.cor >= 70).length / rows.length, 4),
      });
    }
  }
  return { byPersona, byDay };
}
/* ---------------- 回执解析（日志路径） ---------------- */

export interface TrackState {
  mad: number;
  cor: number;
  dig: number;
  sequence: number;
}

export interface TrackStats {
  /** 回执里的 before 与本地跟踪值不一致的次数（tick 等无回执变化被纠正） */
  resync: number;
}

const RE_STATUS = /疯狂\s+(\d+)\s+污染\s+(\d+)\s+消化\s+([\d.]+)/;
const RE_CREATE = /疯狂\/污染：(\d+)\/(\d+)/;
const RE_CREATE_SEQ = /序列：(\d+)/;
const RE_CREATE_DIG = /消化：([\d.]+)/;
const RE_CUR = /当前：[^\n]*/;
const RE_CUR_MAD = /(?:疯狂|MAD)\s+([\d.]+)/;
const RE_CUR_COR = /(?:污染|COR)\s+([\d.]+)/;
const RE_CUR_DIG = /消化\s+([\d.]+)/;
const RE_MAD_DELTA = /疯狂\s+(\d+)\s*→\s*(\d+)/g;
const RE_COR_DELTA = /污染\s+(\d+)\s*→\s*(\d+)/g;
const RE_DIG_DELTA = /消化\s+([\d.]+)\s*→\s*([\d.]+)/g;
const RE_SEQ_DELTA = /序列\s+(\d+)\s*→\s*(\d+)/g;

export function emptyTrack(): TrackState {
  return { mad: 0, cor: 0, dig: 0, sequence: 9 };
}

function sync(
  track: TrackState,
  field: keyof TrackState,
  before: number,
  after: number,
  stats: TrackStats,
): void {
  if (Math.abs(track[field] - before) > 1e-6) stats.resync += 1;
  track[field] = after;
}

/**
 * 一条回执 → 更新本地轨迹。
 * 处理顺序：绝对状态（.状态）→ 建号快照 → 增减行（可有可无、可多条）→ 「当前：」绝对值兜底。
 */
export function applyReplyText(text: string, track: TrackState, stats: TrackStats): void {
  if (!text) return;

  const status = RE_STATUS.exec(text);
  if (status) {
    track.mad = Number(status[1]);
    track.cor = Number(status[2]);
    track.dig = Number(status[3]);
    const seq = /序列\s+(\d+)/.exec(text);
    if (seq) track.sequence = Number(seq[1]);
  }

  const created = RE_CREATE.exec(text);
  if (created) {
    track.mad = Number(created[1]);
    track.cor = Number(created[2]);
    const seq = RE_CREATE_SEQ.exec(text);
    if (seq) track.sequence = Number(seq[1]);
    const dig = RE_CREATE_DIG.exec(text);
    if (dig) track.dig = Number(dig[1]);
  }

  for (const match of text.matchAll(RE_MAD_DELTA)) sync(track, 'mad', Number(match[1]), Number(match[2]), stats);
  for (const match of text.matchAll(RE_COR_DELTA)) sync(track, 'cor', Number(match[1]), Number(match[2]), stats);
  for (const match of text.matchAll(RE_DIG_DELTA)) sync(track, 'dig', Number(match[1]), Number(match[2]), stats);
  for (const match of text.matchAll(RE_SEQ_DELTA)) sync(track, 'sequence', Number(match[1]), Number(match[2]), stats);

  const current = RE_CUR.exec(text);
  if (current) {
    const line = current[0];
    const mad = RE_CUR_MAD.exec(line);
    const cor = RE_CUR_COR.exec(line);
    const dig = RE_CUR_DIG.exec(line);
    if (mad) track.mad = Number(mad[1]);
    if (cor) track.cor = Number(cor[1]);
    if (dig) track.dig = Number(dig[1]);
  }
}

/* ---------------- 数据源一：行为日志 JSONL ---------------- */

export interface LogLine {
  playerId: number;
  persona: string;
  day: number;
  command: string;
  replyTexts: string[];
}

/** 解析日志（流式，13MB 级别也不会把内存打满） */
export async function fromBehaviorLogs(files: readonly string[]): Promise<MeasuredDistribution> {
  // 键带上数据源前缀：主轮与边界轮的 playerId 都从 0 开始，不加前缀会串号（同一 playerId 被当成同一个角色）
  const pending = new Map<string, { persona: string; day: number; track: TrackState }>();
  const samples: DailySample[] = [];
  const stats: TrackStats = { resync: 0 };
  const actionCounts = new Map<string, { persona: string; plays: number; events: number; actions: number }>();
  let records = 0;
  let observedDays = 0;

  const flush = (key: string): void => {
    const entry = pending.get(key);
    if (!entry) return;
    samples.push({
      characterId: key,
      persona: entry.persona,
      day: entry.day,
      mad: entry.track.mad,
      cor: entry.track.cor,
      dig: Number(entry.track.dig.toFixed(2)),
      sequence: entry.track.sequence,
    });
    observedDays += 1;
  };

  for (const file of files) {
    const namespace = file.replace(/^.*[\\/]/, '').replace(/\.jsonl$/, '');
    const stream = createReadStream(file, { encoding: 'utf8' });
    const reader = createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of reader) {
      if (!line.trim()) continue;
      let record: LogLine;
      try {
        record = JSON.parse(line) as LogLine;
      } catch {
        continue;
      }
      records += 1;
      const key = namespace + '#' + record.playerId;
      const existing = pending.get(key);
      let entry = existing;
      if (!entry) {
        entry = { persona: record.persona, day: Number(record.day), track: emptyTrack() };
        pending.set(key, entry);
      } else if (Number(record.day) > entry.day) {
        flush(key);
        entry = { persona: record.persona, day: Number(record.day), track: entry.track };
        pending.set(key, entry);
      }
      for (const reply of record.replyTexts ?? []) applyReplyText(reply, entry.track, stats);

      const dayKey = key + '#' + record.day;
      const bucket = actionCounts.get(dayKey) ?? { persona: record.persona, plays: 0, events: 0, actions: 0 };
      const name = String(record.command).replace(/^[.。．]/, '').split(/\s+/)[0] ?? '';
      bucket.actions += 1;
      if (name === '扮演') bucket.plays += 1;
      if (name === '事件') bucket.events += 1;
      actionCounts.set(dayKey, bucket);
    }
  }
  for (const key of pending.keys()) flush(key);

  const summary = summarize(samples);
  return {
    source: files.join(' + '),
    generatedAt: new Date().toISOString(),
    window: {
      characters: new Set(samples.map((sample) => sample.characterId)).size,
      days: samples.reduce((max, sample) => Math.max(max, sample.day), 0) + 1,
    },
    samples,
    byPersona: summary.byPersona,
    byDay: summary.byDay,
    actionRates: summarizeActionRates(actionCounts),
    diagnostics: { records, resync: stats.resync, daysObserved: observedDays },
  };
}

/* ---------------- 数据源二：domain_events（权威账本） ---------------- */

export function fromDomainEvents(dbPath: string, baseEpoch: number = DEFAULT_BASE_EPOCH): MeasuredDistribution {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const characters = db.prepare('SELECT id, name FROM characters').all() as Array<{ id: string; name: string }>;
    const personaById = new Map(characters.map((row) => [row.id, personaOfName(row.name)]));
    const rows = db
      .prepare(
        "SELECT character_id, type, payload, reason, created_at FROM domain_events " +
          "WHERE type IN ('mad_delta','cor_delta','dig_delta','sequence_delta') ORDER BY id ASC",
      )
      .all() as Array<{
        character_id: string;
        type: string;
        payload: string;
        reason: string;
        created_at: number;
      }>;

    const latest = new Map<string, DailySample>();
    // M2.2：domain_events 也能数出「每角色每日扮演几次」（reason = 扮演消化 的 dig_delta）
    const playCounts = new Map<string, { persona: string; plays: number; events: number; actions: number }>();
    let resync = 0;
    for (const row of rows) {
      const day = Math.floor((Number(row.created_at) - baseEpoch) / DAY_MS);
      const payload = JSON.parse(row.payload) as { after?: number };
      const after = Number(payload.after ?? 0);
      const key = row.character_id + '#' + day;
      const sample =
        latest.get(key) ??
        ({
          characterId: row.character_id,
          persona: personaById.get(row.character_id) ?? 'unknown',
          day,
          mad: 0,
          cor: 0,
          dig: 0,
          sequence: 9,
        } satisfies DailySample);
      if (row.type === 'mad_delta') sample.mad = after;
      else if (row.type === 'cor_delta') sample.cor = after;
      else if (row.type === 'dig_delta') sample.dig = after;
      else sample.sequence = after;
      latest.set(key, sample);

      const bucket =
        playCounts.get(key) ??
        { persona: personaById.get(row.character_id) ?? 'unknown', plays: 0, events: 0, actions: 0 };
      bucket.actions += 1;
      if (row.reason === '扮演消化' && row.type === 'dig_delta') bucket.plays += 1;
      if (row.type === 'dig_delta' && row.reason !== '扮演消化' && row.reason !== '每日tick' && !String(row.reason).startsWith('每日tick')) {
        bucket.events += 1;
      }
      playCounts.set(key, bucket);
    }
    void resync;

    const samples = [...latest.values()].sort((a, b) => (a.characterId < b.characterId ? -1 : a.characterId > b.characterId ? 1 : a.day - b.day));
    const summary = summarize(samples);
    return {
      source: dbPath,
      generatedAt: new Date().toISOString(),
      window: {
        characters: new Set(samples.map((sample) => sample.characterId)).size,
        days: samples.reduce((max, sample) => Math.max(max, sample.day), 0) + 1,
      },
      samples,
      byPersona: summary.byPersona,
      byDay: summary.byDay,
      actionRates: summarizeActionRates(playCounts),
      diagnostics: { records: rows.length, resync, daysObserved: samples.length },
    };
  } finally {
    db.close();
  }
}

export function readDistribution(file: string): MeasuredDistribution {
  return JSON.parse(readFileSync(file, 'utf8')) as MeasuredDistribution;
}

/* ---------------- 按时段的分布（M2.2） ---------------- */

/**
 * 按时段（黎明/白天/黄昏/夜晚）拆开的行为与 MAD 分布（M2.2 §5.6 复算用）。
 *
 * 为什么需要它：M2.2 让夜晚变得危险（其他途径每次扮演 MAD +1、探索危险 +10%），
 * 「新的 MAD 分布」不只是一个数变了，而是**分布的形状按时段分叉** ——
 * 报告要能指出「夜晚的扮演增量整体右移了多少」，否则复算只是换个总数。
 *
 * 数据源只有 domain_events（行为日志里没有每次判定的准确时刻与 reason）。
 */
export interface TimeOfDayStats {
  timeOfDay: string;
  /** 该时段的数值变动事件数（mad/cor/dig/… _delta 全算） */
  events: number;
  /** 其中 .扮演 的次数（reason = 扮演消化） */
  plays: number;
  /** 每次 MAD 事件的平均增量（只统计正增量，负增量是净化/休息，会把口径搅浑） */
  madGainMean: number;
  madGainP90: number;
  /** 事件发生后的 MAD 水平（分布的位置，不是增量） */
  madLevelMean: number;
  madLevelP90: number;
}

export interface PersonaTimeOfDayStats {
  persona: string;
  timeOfDay: string;
  events: number;
  plays: number;
  madGainMean: number;
  madLevelMean: number;
}

export interface TimeOfDayBreakdown {
  source: string;
  byTimeOfDay: TimeOfDayStats[];
  byPersona: PersonaTimeOfDayStats[];
  byReason: Array<{ reason: string; timeOfDay: string; events: number; madGainMean: number }>;
}

export function timeOfDayBreakdown(
  dbPath: string,
  baseEpoch: number = DEFAULT_BASE_EPOCH,
): TimeOfDayBreakdown {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const characters = db.prepare('SELECT id, name FROM characters').all() as Array<{ id: string; name: string }>;
    const personaById = new Map(characters.map((row) => [row.id, personaOfName(row.name)]));
    const rows = db
      .prepare(
        "SELECT character_id, type, payload, reason, created_at FROM domain_events " +
          "WHERE type IN ('mad_delta','cor_delta','dig_delta') ORDER BY id ASC",
      )
      .all() as Array<{ character_id: string; type: string; payload: string; reason: string; created_at: number }>;

    const overall = new Map<string, { events: number; plays: number; gains: number[]; levels: number[] }>();
    const personaBucket = new Map<string, { events: number; plays: number; gains: number[]; levels: number[] }>();
    const reasonBucket = new Map<string, { events: number; gains: number[] }>();
    const bucketOf = <T>(
      map: Map<string, T>,
      key: string,
      init: () => T,
    ): T => {
      const existing = map.get(key);
      if (existing) return existing;
      const created = init();
      map.set(key, created);
      return created;
    };

    let dayIndex = -1;
    void dayIndex;
    for (const row of rows) {
      const slot = timeOfDayOf(row.created_at);
      const payload = JSON.parse(row.payload) as { before?: number; after?: number; delta?: number };
      const gain = Number(payload.delta ?? (Number(payload.after ?? 0) - Number(payload.before ?? 0)));
      const persona = personaById.get(row.character_id) ?? 'unknown';
      const isPlay = row.reason === '扮演消化';

      const target = bucketOf(overall, slot, () => ({ events: 0, plays: 0, gains: [], levels: [] }));
      target.events += 1;
      if (isPlay) target.plays += 1;
      if (row.type === 'mad_delta') {
        if (gain > 0) target.gains.push(gain);
        target.levels.push(Number(payload.after ?? 0));
      }

      const perPersona = bucketOf(
        personaBucket,
        persona + '|' + slot,
        () => ({ events: 0, plays: 0, gains: [], levels: [] }),
      );
      perPersona.events += 1;
      if (isPlay) perPersona.plays += 1;
      if (row.type === 'mad_delta') {
        if (gain > 0) perPersona.gains.push(gain);
        perPersona.levels.push(Number(payload.after ?? 0));
      }

      if (row.type === 'mad_delta') {
        const perReason = bucketOf(reasonBucket, row.reason + '|' + slot, () => ({ events: 0, gains: [] }));
        perReason.events += 1;
        if (gain > 0) perReason.gains.push(gain);
      }
    }

    const order = ['dawn', 'day', 'dusk', 'night'];
    const byTimeOfDay: TimeOfDayStats[] = order
      .filter((slot) => overall.has(slot))
      .map((slot) => {
        const bucket = overall.get(slot)!;
        return {
          timeOfDay: slot,
          events: bucket.events,
          plays: bucket.plays,
          madGainMean: round(mean(bucket.gains)),
          madGainP90: round(percentile(bucket.gains, 0.9)),
          madLevelMean: round(mean(bucket.levels)),
          madLevelP90: round(percentile(bucket.levels, 0.9)),
        };
      });

    const byPersona: PersonaTimeOfDayStats[] = [...personaBucket.entries()]
      .map(([key, bucket]) => {
        const [persona, slot] = key.split('|');
        return {
          persona: persona ?? 'unknown',
          timeOfDay: slot ?? 'unknown',
          events: bucket.events,
          plays: bucket.plays,
          madGainMean: round(mean(bucket.gains)),
          madLevelMean: round(mean(bucket.levels)),
        };
      })
      .sort((a, b) => (a.persona === b.persona ? order.indexOf(a.timeOfDay) - order.indexOf(b.timeOfDay) : a.persona < b.persona ? -1 : 1));

    const byReason = [...reasonBucket.entries()]
      .map(([key, bucket]) => {
        const [reason, slot] = key.split('|');
        return { reason: reason ?? '', timeOfDay: slot ?? 'unknown', events: bucket.events, madGainMean: round(mean(bucket.gains)) };
      })
      .sort((a, b) => b.events - a.events)
      .slice(0, 40);

    return { source: dbPath, byTimeOfDay, byPersona, byReason };
  } finally {
    db.close();
  }
}