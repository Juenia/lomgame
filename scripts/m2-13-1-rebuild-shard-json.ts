/**
 * 从「库 + 行为日志 + 异常清单」**重建一片的分片 JSON**。
 *
 * 用法：
 *   node scripts/m2-13-1-rebuild-shard-json.ts --prefix m213boff --shard 0 \
 *     --players 25 --days 30 --seed m213b:shard:0 --shards 8 --out data/vplayer-shards-off/shard-0.json
 *
 * ## 为什么需要它
 *
 * 分片 JSON 是**跑批产物**，一旦被同名的另一轮覆盖就只能重建。已经发生过两次：
 *
 *   - m213 那一轮：JSON 文件名叫 shard-N.json（不含前缀），被 m213b 覆盖 →
 *     那一轮只能从行为日志 + 库重建（见 docs/M2.13.1-交付说明.md §8.3）；
 *   - m213boff 的片 0：M2.13.1 任务 D 的验证过程中踩到，也正是这个任务的动机。
 *
 * 好消息是**重建要的东西都还在**：库（权威账本）、行为日志（指令流）、异常清单（P0/P1）。
 * 重建**不跑批、不写库**：所有数字都从这三样里读出来。
 *
 * 注意：**m213boff 不能靠重跑恢复** —— 它跑的是「关闭前置 4」的行为，
 * 而那个开关（M213_PREREQ4）在 M2.13.1 已经删了，重跑出来的是另一件事。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadCards } from '../src/cards/loader.ts';
import { WorldEventRepo } from '../src/infra/db/world-events.ts';
import { analyze, isRejected } from '../src/vplayer/analyzer.ts';
import { buildWorld } from '../src/vplayer/cli.ts';
import { analyzeCardReachability, computeCoverage } from '../src/vplayer/coverage.ts';
import { collectGeoStats } from '../src/vplayer/geo-stats.ts';
import { buildProfiles } from '../src/vplayer/profiles.ts';
import { summarizeProfiles } from '../src/vplayer/report.ts';
import {
  SHARD_SCHEMA,
  worldEventEvidenceOf,
  type CharacterFinalValues,
  type ShardJson,
} from '../src/vplayer/shard-json.ts';
import type { ActionRecord, AnomalyRecord } from '../src/vplayer/types.ts';
import { readAnomalyReport } from './m2-13-1-anomaly-lib.ts';

function argOf(argv: readonly string[], name: string, fallback: string): string {
  const index = argv.indexOf('--' + name);
  return index >= 0 ? (argv[index + 1] ?? fallback) : fallback;
}

const argv = process.argv.slice(2);
const PREFIX = argOf(argv, 'prefix', 'm213boff');
const SHARD = Number(argOf(argv, 'shard', '0'));
const PLAYERS = Number(argOf(argv, 'players', '25'));
const DAYS = Number(argOf(argv, 'days', '30'));
const SHARDS = Number(argOf(argv, 'shards', '8'));
const SEED = argOf(argv, 'seed', 'm213b:shard:' + SHARD);
const BASE_EPOCH = Number(argOf(argv, 'base-epoch', String(Date.parse('2026-01-01T00:00:00+08:00'))));
const WORLD_SEED = argOf(argv, 'world-seed', 'world');
const STAGE = argOf(argv, 'stage', PREFIX + '-shard' + SHARD);
const OUT = argOf(argv, 'out', join('data', 'vplayer-shards-off', 'shard-' + SHARD + '.json'));
/** 指令清单从哪读：同一份代码的另一个分片 JSON（指令集与分片无关） */
const COMMANDS_FROM = argOf(argv, 'commands-from', join('data', 'vplayer-shards-off', 'shard-1.json'));

const dbPath = join('data', PREFIX + '-shard-' + SHARD + '.db');
const logPath = join('docs', PREFIX + '-shard' + SHARD + '-行为日志.jsonl');
for (const path of [dbPath, logPath]) {
  if (!existsSync(path)) throw new Error('缺文件：' + path);
}

/* 1) 指令流 ← 行为日志 */
const records: ActionRecord[] = [];
for (const line of readFileSync(logPath, 'utf8').split('\n')) {
  if (line.trim().length === 0) continue;
  records.push(JSON.parse(line) as ActionRecord);
}

/* 2) 指令清单 ← 另一个分片 JSON（分片之间指令集相同） */
const commands = (JSON.parse(readFileSync(COMMANDS_FROM, 'utf8')) as ShardJson).coverage.commands
  .map((item) => item.key)
  .sort();

const world = buildWorld();
const cardDefs = loadCards().cards;
const db = new DatabaseSync(dbPath, { readOnly: true });

const analysis = analyze(records, db, PLAYERS, BASE_EPOCH + DAYS * 24 * 60 * 60 * 1000);

const reachability = analyzeCardReachability(
  cardDefs.map((card) => ({
    id: card.id,
    locations: card.trigger.location ?? [],
    type: card.trigger.type,
  })),
  world.locations,
);
const unreachableCards = reachability.filter((entry) => !entry.reachable).map((entry) => entry.cardId);
const unreachableReasons: Record<string, string> = {};
for (const entry of reachability) {
  if (entry.reachable) continue;
  unreachableReasons[entry.cardId] =
    entry.locations.length > 0
      ? '限定了地点「' + entry.locations.join('、') + '」，但该地点的 events 名单里没有它'
      : '没有任何一条抽取路径会带上它';
}

const coverage = computeCoverage(
  records,
  db,
  {
    commands,
    cards: cardDefs.map((card) => card.id),
    locations: world.locations.map((location) => ({ id: location.id, name: location.name })),
    recipes: world.recipes.map((recipe) => recipe.id),
    lostControlTexts: [],
  },
  { minCommandCount: 10, unreachableCards, unreachableReasons },
);

/* 3) 异常 ← 异常清单 md（P0/P1 的权威载体） */
const anomalyReport = readAnomalyReport(PREFIX, SHARD);
const virtualNowOf = new Map<string, number>();
for (const record of records) {
  const key = record.playerId + '-' + record.day;
  if (!virtualNowOf.has(key)) virtualNowOf.set(key, record.virtualNow);
}
const anomalies: AnomalyRecord[] = anomalyReport.items.map((item) => ({
  level: item.code === 'HTTP_STATUS' || item.code === 'STAT_OUT_OF_RANGE' || item.code === 'RESOURCE_INCONSISTENT' ? 'P0' : 'P1',
  // 清单里是文本，类型上要收窄到 AnomalyRecord 的联合类型
  code: item.code as AnomalyRecord['code'],
  playerId: item.playerId,
  day: item.day,
  virtualNow: virtualNowOf.get(item.playerId + '-' + item.day) ?? 0,
  command: item.command,
  detail: item.detail,
}));

/* 4) 期末数值 / 角色状态 */
const charRows = db.prepare('SELECT dig, mad, cor, hp, status, created_at, updated_at FROM characters').all() as Array<Record<string, unknown>>;
const column = (key: string): number[] => charRows.map((row) => Number(row[key] ?? 0));
const values: CharacterFinalValues = {
  dig: column('dig'), mad: column('mad'), cor: column('cor'), hp: column('hp'),
};
const createdAts = charRows.map((row) => Number(row.created_at ?? 0)).filter((n) => n > 0);
const updatedAts = charRows.map((row) => Number(row.updated_at ?? 0)).filter((n) => n > 0);
const startedAtMs = createdAts.length > 0 ? Math.min(...createdAts) : BASE_EPOCH;
const costMs = updatedAts.length > 0 ? Math.max(...updatedAts) - startedAtMs : 0;

const profiles = buildProfiles({ players: PLAYERS, seed: SEED });
const personaPlayers: Record<string, number> = {};
for (const profile of profiles) {
  personaPlayers[profile.persona] = (personaPlayers[profile.persona] ?? 0) + 1;
}

const shard: ShardJson = {
  schema: SHARD_SCHEMA,
  shard: SHARD,
  shards: SHARDS,
  seed: SEED,
  worldSeed: WORLD_SEED,
  worldEvents: worldEventEvidenceOf(new WorldEventRepo(db).all()),
  players: PLAYERS,
  days: DAYS,
  baseEpoch: BASE_EPOCH,
  startedAt: new Date(startedAtMs).toISOString(),
  costMs,
  stage: STAGE,
  analysis,
  coverage,
  anomalies,
  profileSummary: summarizeProfiles(profiles),
  cards: cardDefs.map((card) => ({
    id: card.id,
    conds: card.trigger.cond ?? [],
    minSeq: card.trigger.min_seq,
    maxSeq: card.trigger.max_seq,
  })),
  values,
  personaPlayers,
  lostControl: charRows.filter((row) => row.status === 'lost_control').length,
  characters: charRows.length,
  rejectedActions: records.filter((record) => isRejected(record.replyTexts)).length,
  thresholds: { minCommandCount: 10, minPromotions: 50 },
  geo: collectGeoStats(db, profiles.map((profile) => profile.userId), world.birthCities),
};
db.close();

writeFileSync(OUT, JSON.stringify(shard, null, 2), 'utf8');
console.log('已重建 ' + OUT);
console.log('  指令 ' + records.length + ' 条；P0 ' + anomalies.filter((a) => a.level === 'P0').length + '、P1 ' + anomalies.filter((a) => a.level === 'P1').length);
console.log('  覆盖率：指令 ' + coverage.commands.filter((i) => i.pass).length + '/' + coverage.commands.length + '，长链路 入途径→8 ' + coverage.longChain.toSeq8.count + ' / 8→7 ' + coverage.longChain.toSeq7.count);
