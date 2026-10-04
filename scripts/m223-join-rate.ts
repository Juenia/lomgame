#! /usr/bin/env node
/**
 * M2.23 任务 1：**入教率三层拆解**（只读）。
 *
 * 要回答的三个问题（任务书 §任务 1）：
 *   1. vplayer **发不发**入教指令 —— 代码（`src/vplayer/decide.ts` 的 `churchDecision`）+ 行为日志（实测）；
 *   2. **发了但没成**，还是**根本没发** —— 行为日志里 `.加入教会` 的发起数与成功数；
 *   3. 入教门槛在 vplayer 行为下**可达吗** —— 贡献门槛与序列门槛的达成分布。
 *
 * ## 三层（数据来源分开写，不要混）
 *
 * | 层 | 问的是 | 数据 |
 * | --- | --- | --- |
 * | **结构层** | 「按内容表，这个人**理论上**能入哪家教会」 | 状态表（pathway / city）+ churches.yaml |
 * | **行为层** | 「vplayer **有没有去试**」 | 行为日志 `docs/<前缀>-行为日志.jsonl` |
 * | **机制层** | 「试了之后**门槛挡不挡**」 | `domain_events` 的 church_* 事件 + 状态表 |
 *
 * ⚠️ **为什么必须分开**：「入教率低」有两种完全不同的解释 ——
 * 「vplayer 不发指令」（行为特征，与 M2.19 的「不打敌对教会」同类，**改它要过校准门槛**）
 * 与「入教本身难」（设计问题，**可以改内容/门槛**）。混在一起就分不出该动哪一层。
 *
 * 用法：
 *   node scripts/m223-join-rate.ts --batch m224 --shards 1 --log docs/m224-shard0-行为日志.jsonl
 *   node scripts/m223-join-rate.ts --batch m223a --shards 8        # 不给 --log 就跳过行为层
 */
import { DatabaseSync } from 'node:sqlite';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { NUMERIC } from '../src/config/numeric.ts';
import { loadChurches } from '../src/data/loader.ts';
import { shardKey } from '../src/infra/shard-key.ts';

const argv = process.argv.slice(2);
const argOf = (name: string, fallback: string): string => {
  const i = argv.indexOf('--' + name);
  return i >= 0 ? (argv[i + 1] ?? fallback) : fallback;
};
const BATCH = argOf('batch', 'm224');
const SHARDS = Number(argOf('shards', '1'));
const LOG = argOf('log', '');
const JSON_PATH = argOf('json', 'data/vplayer-shards-' + BATCH + '/' + BATCH + '-shard-0.json');

const THRESHOLDS = NUMERIC.church.ranks.contributionThreshold;
const SEQ_GATE = NUMERIC.church.ranks.sequenceGate;
const churches = loadChurches().churches;
const byChurchId = new Map(churches.map((c) => [c.id, c]));

/** 内容表：哪些途径**有**教会（pathway 非 null 且 seats 非空） */
const pathwayToChurch = new Map<string, Array<{ id: string; seats: readonly string[] }>>();
for (const church of churches) {
  if (!church.pathway) continue;
  const list = pathwayToChurch.get(church.pathway) ?? [];
  list.push({ id: church.id, seats: church.seats });
  pathwayToChurch.set(church.pathway, list);
}

interface CharRow {
  id: string; user_id: string; pathway: string | null; sequence: number | null;
  church_id: string | null; church_contribution: number; current_city_id: string | null;
}

const rows: Array<CharRow & { key: string }> = [];
for (let s = 0; s < SHARDS; s += 1) {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync('data/' + BATCH + '-shard-' + s + '.db', { readOnly: true });
  } catch {
    continue;
  }
  for (const row of db.prepare(
    'SELECT id, user_id, pathway, sequence, church_id, church_contribution, current_city_id FROM characters',
  ).all() as unknown as CharRow[]) {
    rows.push({ ...row, key: shardKey(s, String(row.id)) });
  }
  db.close();
}

console.log('=== M2.23 任务 1 · 入教率三层拆解 ===');
console.log('  批：' + BATCH + '　片数：' + SHARDS + '　角色：' + rows.length);
console.log('');

/* ==================== 结构层 ==================== */
console.log('=== §1 结构层：按内容表，谁**理论上**能入教 ===');
console.log('  1.1 教会 ↔ 途径（churches.yaml）');
const withPathway = churches.filter((c) => c.pathway);
const withoutPathway = churches.filter((c) => !c.pathway);
for (const church of churches) {
  console.log(
    '    ' + church.id.padEnd(22) + ' pathway=' + String(church.pathway ?? 'null').padEnd(10) +
      ' seats=[' + church.seats.join(', ') + ']',
  );
}
console.log('    ⇒ 绑了**已实现途径**的：' + withPathway.length + ' 家（' + withPathway.map((c) => c.id).join('、') + '）');
console.log('    ⇒ 途径待定的：' + withoutPathway.length + ' 家（' + withoutPathway.map((c) => c.id).join('、') + '）');

console.log('');
console.log('  1.2 逐人判定（pathway 有教会 **且** 当前城市在它的 seats 里）');
const pathwayTally = new Map<string, { total: number; hasChurch: number; cityOk: number; joined: number }>();
let structuralOk = 0;
let noChurchForPathway = 0;
let churchExistsButOtherCity = 0;
let noPathway = 0;
for (const row of rows) {
  const pathway = row.pathway ?? '（未入途径）';
  const bucket = pathwayTally.get(pathway) ?? { total: 0, hasChurch: 0, cityOk: 0, joined: 0 };
  bucket.total += 1;
  if (row.church_id) bucket.joined += 1;
  const options = row.pathway ? (pathwayToChurch.get(row.pathway) ?? []) : [];
  if (!row.pathway) noPathway += 1;
  else if (options.length === 0) noChurchForPathway += 1;
  else {
    bucket.hasChurch += 1;
    const city = row.current_city_id ?? '';
    if (options.some((o) => o.seats.includes(city))) {
      bucket.cityOk += 1;
      structuralOk += 1;
    } else churchExistsButOtherCity += 1;
  }
  pathwayTally.set(pathway, bucket);
}
console.log('    | 途径 | 人数 | 有对应教会 | 当前城市在 seats 里 | 已入教 |');
console.log('    | --- | --- | --- | --- | --- |');
for (const [pathway, b] of [...pathwayTally.entries()].sort((a, b2) => b2[1].total - a[1].total)) {
  console.log('    | ' + pathway + ' | ' + b.total + ' | ' + b.hasChurch + ' | ' + b.cityOk + ' | ' + b.joined + ' |');
}
console.log('');
console.log('    · 未入途径（谈不上入教）：' + noPathway + ' 人');
console.log('    · **途径没有对应教会**（seer 这一类）：**' + noChurchForPathway + ' 人**');
console.log('    · 有教会但**当前城市不在 seats 里**：' + churchExistsButOtherCity + ' 人');
console.log('    · **结构上可入教**（两条都满足）：**' + structuralOk + ' 人**');
console.log('');
console.log('  ⚠️ 城市口径是**终态**（`current_city_id`）—— vplayer 会移动，');
console.log('     「曾经在某座有堂口的城市停留过」的人只会更多，所以这一格是**下界**。');

/* ==================== 行为层 ==================== */
console.log('');
console.log('=== §2 行为层：vplayer **有没有去试** ===');
if (!LOG || !existsSync(LOG)) {
  console.log('  （没有给 --log，跳过。用法见文件头）');
} else {
  const byPlayer = new Map<string, { persona: string; tries: number; ok: number; rejected: number }>();
  let lines = 0;
  let tries = 0;
  let ok = 0;
  const examples: string[] = [];
  const rl = createInterface({ input: createReadStream(LOG, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    lines += 1;
    if (!line.includes('加入教会')) continue;
    let rec: { playerId?: number; persona?: string; command?: string; replyTexts?: string[] };
    try {
      rec = JSON.parse(line) as typeof rec;
    } catch {
      continue;
    }
    const command = String(rec.command ?? '');
    if (!command.startsWith('.加入教会')) continue;
    tries += 1;
    const text = (rec.replyTexts ?? []).join('\n');
    const joined = text.includes('【入教 ·');
    if (joined) ok += 1;
    const key = String(rec.playerId ?? '?');
    const bucket = byPlayer.get(key) ?? { persona: String(rec.persona ?? '?'), tries: 0, ok: 0, rejected: 0 };
    bucket.tries += 1;
    if (joined) bucket.ok += 1; else bucket.rejected += 1;
    byPlayer.set(key, bucket);
    if (examples.length < 3 && !joined) examples.push('    被拒样本：' + command + ' → ' + text.replace(/\s+/g, ' ').slice(0, 110));
  }
  console.log('  行为日志：' + LOG + '（' + lines + ' 条记录）');
  console.log('  · **发起 `.加入教会` 的次数：' + tries + '**（涉及 ' + byPlayer.size + ' 个玩家）');
  console.log('  · 其中**成功**：' + ok + '　**被拒**：' + (tries - ok));
  if (examples.length) for (const e of examples) console.log(e);
  const byPersona = new Map<string, { players: number; tries: number; ok: number }>();
  for (const b of byPlayer.values()) {
    const p = byPersona.get(b.persona) ?? { players: 0, tries: 0, ok: 0 };
    p.players += 1; p.tries += b.tries; p.ok += b.ok;
    byPersona.set(b.persona, p);
  }
  console.log('  · 按画像：');
  for (const [persona, p] of byPersona) {
    console.log('      ' + persona.padEnd(14) + ' 尝试过的玩家 ' + p.players + ' 人，发起 ' + p.tries + ' 次，成功 ' + p.ok);
  }
}

/* ==================== 机制层 ==================== */
console.log('');
console.log('=== §3 机制层：门槛挡不挡 ===');
let joinEvents = 0;
let contributeEvents = 0;
let rankUpEvents = 0;
const joinDays: number[] = [];
for (let s = 0; s < SHARDS; s += 1) {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync('data/' + BATCH + '-shard-' + s + '.db', { readOnly: true });
  } catch {
    continue;
  }
  const tally = db.prepare(
    "SELECT type, COUNT(*) n FROM domain_events WHERE type IN ('church_join','church_contribute','church_rank_up') GROUP BY type",
  ).all() as unknown as Array<{ type: string; n: number }>;
  for (const row of tally) {
    if (row.type === 'church_join') joinEvents += Number(row.n);
    if (row.type === 'church_contribute') contributeEvents += Number(row.n);
    if (row.type === 'church_rank_up') rankUpEvents += Number(row.n);
  }
  const born = db.prepare("SELECT character_id, MIN(created_at) t FROM domain_events WHERE type='character_created' GROUP BY character_id").all() as unknown as Array<{ character_id: string; t: number }>;
  const first = new Map(born.map((b) => [String(b.character_id), Number(b.t)]));
  for (const row of db.prepare("SELECT character_id, MIN(created_at) t FROM domain_events WHERE type='church_join' GROUP BY character_id").all() as unknown as Array<{ character_id: string; t: number }>) {
    const b = first.get(String(row.character_id));
    if (b !== undefined) joinDays.push((Number(row.t) - b) / 86400000);
  }
  db.close();
}
console.log('  · `church_join` 事件：**' + joinEvents + '**　`church_contribute`：' + contributeEvents + '　`church_rank_up`：' + rankUpEvents);
if (joinDays.length) {
  joinDays.sort((a, b) => a - b);
  const median = joinDays[Math.floor(joinDays.length / 2)]!;
  console.log('  · 入教耗时（建号 → church_join）：中位 **' + median.toFixed(2) + ' 天**，最早 ' + joinDays[0]!.toFixed(2) + ' 天，最晚 ' + joinDays[joinDays.length - 1]!.toFixed(2) + ' 天');
}
console.log('');
console.log('  · 贡献门槛 ' + JSON.stringify(THRESHOLDS) + ' 的达成分布（已入教者）：');
const joined = rows.filter((r) => r.church_id);
for (let i = 1; i < THRESHOLDS.length; i += 1) {
  const need = THRESHOLDS[i]!;
  const hit = joined.filter((r) => Number(r.church_contribution) >= need).length;
  const seqNeed = SEQ_GATE[i]!;
  const both = joined.filter((r) => Number(r.church_contribution) >= need && (r.sequence ?? 9) <= seqNeed).length;
  console.log('      档 ' + (i + 1) + '（贡献 ≥ ' + String(need).padStart(4) + '，序列 ≤ ' + seqNeed + '）：贡献够 ' + String(hit).padStart(3) + ' 人，**两条都够 ' + String(both).padStart(3) + ' 人**');
}
const contributions = joined.map((r) => Number(r.church_contribution)).sort((a, b) => a - b);
console.log('  · 贡献点：中位 ' + (contributions.length ? contributions[Math.floor(contributions.length / 2)] : 0) + '，最大 ' + (contributions[contributions.length - 1] ?? 0));
console.log('  · 序列分布（全体）：');
const seqTally = new Map<string, number>();
for (const row of rows) {
  const k = row.sequence === null ? '（普通人）' : String(row.sequence);
  seqTally.set(k, (seqTally.get(k) ?? 0) + 1);
}
console.log('      ' + [...seqTally.entries()].sort((a, b) => Number(a[0]) - Number(b[0]) || a[0].localeCompare(b[0])).map(([k, n]) => k + '：' + n).join('　'));

/* ==================== 画像 ==================== */
if (existsSync(JSON_PATH)) {
  try {
    const json = JSON.parse(readFileSync(JSON_PATH, 'utf8')) as { personaPlayers?: Record<string, number> };
    console.log('');
    console.log('=== §4 画像（决定谁**会**走教会分支）===');
    const personas = json.personaPlayers ?? {};
    const total = Object.values(personas).reduce((a, b) => a + b, 0);
    for (const [persona, n] of Object.entries(personas)) {
      console.log('    ' + persona.padEnd(14) + ' ' + n + ' 人' + (persona === 'secular' ? '　← **decide.ts 整段跳过教会分支**' : ''));
    }
    console.log('    ⇒ secular 占比 ' + (100 * (personas.secular ?? 0) / Math.max(1, total)).toFixed(1) + '%（这一批结构上就少了这么多人）');
  } catch {
    /* 读不到就跳过 */
  }
}
