#! /usr/bin/env node
/**
 * M2.26 任务 0.5：**小批读数**（新途径的四个数）。
 *
 * 每落地一条途径，就用它读一次 —— 三批共用同一个脚本，口径不重写。
 *
 * | # | 量 | 判据 |
 * | --- | --- | --- |
 * | 1 | 该途径人数 | 与**途径池等权**（1/`OPEN_PATHWAYS.length`）的偏离可解释；**不能是 0** |
 * | 2 | 该途径玩家入途径率 | 与现有途径同量级（这里报「该途径人数 / 全批人数」与「已入途径人数 / 全批人数」两个口径） |
 * | 3 | 该途径的 PVP 参与 | `battles` 里有该途径玩家的行数（攻守任一侧） |
 * | 4 | 该途径的战斗技能被选 | `battles.pending_action_json` 与 `battle_rounds` 里出现该途径的 skillId |
 *
 * ⚠️ **等权分母从 `OPEN_PATHWAYS` 取，不手抄**（K16：见到「手抄一份列表」，先问权威清单在哪）。
 *
 * 用法：
 *   node scripts/m226-small-read.ts --batch m226-steam-small --pathway perfect --skills precise_strike,chain_calibration,overload
 */
import { DatabaseSync } from 'node:sqlite';
import { OPEN_PATHWAYS } from '../src/domain/character/rules.ts';
import { loadCities, loadChurches, loadFactions } from '../src/data/loader.ts';
import { NUMERIC } from '../src/config/numeric.ts';
import { birthShares } from './birth-share-lib.ts';

const argv = process.argv.slice(2);
const argOf = (name: string, fallback: string): string => {
  const i = argv.indexOf('--' + name);
  return i >= 0 ? (argv[i + 1] ?? fallback) : fallback;
};
const BATCH = argOf('batch', 'm226-steam-small');
const PATHWAY = argOf('pathway', 'perfect');
const SKILLS = argOf('skills', '').split(',').map((s) => s.trim()).filter((s) => s.length > 0);

const db = new DatabaseSync('data/' + BATCH + '-shard-0.db', { readOnly: true });
const chars = db.prepare('SELECT id, pathway, sequence FROM characters').all() as unknown as Array<{
  id: string; pathway: string | null; sequence: number | null;
}>;
const isMine = (id: string | null | undefined): boolean => {
  if (!id) return false;
  const row = chars.find((c) => String(c.id) === String(id));
  return row?.pathway === PATHWAY;
};
const ids = new Set(chars.map((c) => String(c.id)));

console.log('=== M2.26 任务 0.5 · 小批读数（' + BATCH + '，途径 ' + PATHWAY + '）===');
console.log('  权威清单 OPEN_PATHWAYS：' + OPEN_PATHWAYS.join(', ') + '（' + OPEN_PATHWAYS.length + ' 条）');
console.log('');

/* ---- 1. 该途径人数 ---- */
const tally = new Map<string, number>();
for (const c of chars) tally.set(c.pathway ?? '（未入途径）', (tally.get(c.pathway ?? '（未入途径）') ?? 0) + 1);
const mine = tally.get(PATHWAY) ?? 0;
/*
 * 期望人数的口径**只有一份**（scripts/birth-share-lib.ts）。
 *
 * 这里原来写的是 `chars.length / OPEN_PATHWAYS.length` —— **只用途径池等权，漏了「出生城市必须开放这条途径」**。
 * 于是它打印「等权期望 8.3 人」而真实期望是 1.3 人（差 6 倍），
 * 直接把「0 人是期望」读成了「0 人是断链」（M2.26 第二批的 reader 就是 0 人）。
 * 这正是 K16 的形状：同一份口径在两个脚本里各抄了一遍。
 */
const churches = loadChurches().churches;
const mineShare = birthShares({
  cities: loadCities().cities,
  pathways: OPEN_PATHWAYS,
  factions: loadFactions().factions,
  priorityWeight: NUMERIC.initiation.factionPriority,
  // 本批实际人数一档 + 大规模一档（去重：批次本来就有 200 人时只留一档）
  expectAt: Array.from(new Set([chars.length, 200])),
  churchOf: (pathway) => churches.find((church) => church.pathway === pathway)?.id ?? null,
}).find((row) => row.pathway === PATHWAY)!;

/** 本批人数那一档（判读只看它） */
const mineAt = mineShare.expectedBy.find((e) => e.players === chars.length) ?? mineShare.expectedBy[0]!;
const mineNumbers = mineShare.expectedBy
  .map((e) => e.players + ' 人档 ' + e.expected.toFixed(1) + ' 人（P(0)=' + e.zeroProbability.toFixed(3) + '）')
  .join('　｜　');
console.log('=== §1 途径分布（' + chars.length + ' 人）===');
for (const [key, n] of [...tally.entries()].sort((a, b) => b[1] - a[1])) {
  const pct = ((100 * n) / chars.length).toFixed(1);
  const mark = key === PATHWAY ? '　← 本批新途径' : '';
  console.log('  ' + key.padEnd(14) + String(n).padStart(4) + ' 人（' + pct.padStart(5) + '%）' + mark);
}
console.log('');
console.log('  · **' + PATHWAY + ' = ' + mine + ' 人**（期望：' + mineNumbers + '）');
console.log('  · 算式 ' + mineShare.formula);
if (mineShare.sources.length === 0) {
  console.log('  · ⚠️ **没有任何引导势力传承它 ⇒ 期望是 0（不是「低」）** —— 这是结构性断链，不是抽样运气');
  console.log('      修法：cities.yaml 开了这条途径，就得在本城 factions.yaml 里加一家传承它的势力（M2.19 给 pritz 加引水人协会就是这件事）');
} else {
  const detail = mineShare.sources
    .map((s) => s.cityId + '/' + s.factionId + '(' + s.priority + ' ' + (100 * s.contribution).toFixed(1) + '%)')
    .join('、');
  console.log('  · 传承它的引导势力：' + detail);
}
console.log('  · 口径 = Σ_城市 [城市权重占比 x 本城传承它的势力权重和 / 本城全部势力权重和]（scripts/birth-share-lib.ts）');
console.log('  · 判据：**先和期望比再看 0** —— 用显著性水平 **alpha = 0.05**：P(0) >= 0.05 就不能判断链');

/* ---- 2. 入途径率 ---- */
const initiated = chars.filter((c) => c.pathway !== null).length;
console.log('');
console.log('=== §2 入途径率 ===');
console.log('  · 已入途径 ' + initiated + ' / ' + chars.length + ' = **' + ((100 * initiated) / chars.length).toFixed(1) + '%**');
console.log('  · 其中 ' + PATHWAY + ' 占 ' + ((100 * mine) / Math.max(1, initiated)).toFixed(1) + '%');
console.log('  · （vplayer 的入途径率历史量级：m224 93%、m223a 91% —— 与途径无关）');

/* ---- 3. PVP 参与 ---- */
const battles = db.prepare(
  'SELECT id, character_id, opponent_character_id, pending_action_json, status FROM battles WHERE is_pvp = 1',
).all() as unknown as Array<{
  id: number; character_id: string; opponent_character_id: string | null; pending_action_json: string | null; status: string;
}>;
let involved = 0;
let mineAsChallenger = 0;
let mineAsOpponent = 0;
for (const b of battles) {
  const a = isMine(b.character_id);
  const o = isMine(b.opponent_character_id);
  if (a || o) involved += 1;
  if (a) mineAsChallenger += 1;
  if (o) mineAsOpponent += 1;
}
console.log('');
console.log('=== §3 PVP 参与 ===');
console.log('  · PVP 总场次：' + battles.length);
console.log('  · **有 ' + PATHWAY + ' 玩家参与的：' + involved + '**（发起 ' + mineAsChallenger + ' / 应战 ' + mineAsOpponent + '）');

/* ---- 4. 战斗技能被选 ---- */
console.log('');
console.log('=== §4 战斗技能被选 ===');
let picked = 0;
const pickedDetail = new Map<string, number>();
for (const b of battles) {
  const raw = b.pending_action_json;
  if (!raw) continue;
  for (const skill of SKILLS) {
    if (raw.includes(skill)) {
      picked += 1;
      pickedDetail.set(skill, (pickedDetail.get(skill) ?? 0) + 1);
    }
  }
}
console.log('  · 待查 skillId：' + (SKILLS.join(', ') || '（没给 --skills）'));
console.log('  · **在 battles.pending_action_json 里出现过 ' + picked + ' 次**');
for (const [skill, n] of pickedDetail) console.log('      ' + skill + '：' + n + ' 次');
let rounds = 0;
try {
  const rows = db.prepare('SELECT player_action FROM battle_rounds').all() as unknown as Array<{ player_action: string }>;
  for (const r of rows) for (const skill of SKILLS) if (String(r.player_action).includes(skill)) rounds += 1;
  console.log('  · 在 battle_rounds.player_action 里出现过 ' + rounds + ' 次（结算过的回合）');
} catch {
  console.log('  · （没有 battle_rounds 表）');
}

console.log('');
console.log('=== 判读（任务书 §任务 0.5 的四种结果）===');
const c1 = mine > 0;
const c2 = initiated > 0;
const c3 = involved > 0;
const c4 = picked + rounds > 0;
const verdict1 = c1
  ? '✅ ' + mine + ' 人'
  : mineShare.sources.length === 0
    ? '❌ 0 人 —— 而且**没有任何引导势力传承它 ⇒ 期望恒为 0**，这是结构性断链（改内容表，不是加大样本）'
    : mineAt.zeroProbability >= 0.05
      ? '⚠️ 0 人 —— 但期望只有 ' + mineAt.expected.toFixed(1) + ' 人、抽到 0 人的概率 ' + mineAt.zeroProbability.toFixed(3) + ' ≥ 0.05 ⇒ **不能排除是抽样波动，不是断链**'
      : '❌ 0 人 —— 期望 ' + mineAt.expected.toFixed(1) + ' 人、抽到 0 人的概率只有 ' + mineAt.zeroProbability.toFixed(3) + ' < 0.05 ⇒ **这才可能是断链**（先看生产链路用例是不是绿的）';
console.log('  ① 途径人数非 0：' + verdict1);
console.log('  ② 入途径率正常：' + (c2 ? '✅ ' + ((100 * initiated) / chars.length).toFixed(1) + '%' : '❌'));
console.log('  ③ 有 PVP 参与：' + (c3 ? '✅ ' + involved + ' 场' : '⚠️ 0 场（PVP 本来就少，单独为 0 不一定是断链）'));
console.log('  ④ 技能被选：' + (c4 ? '✅ ' + (picked + rounds) + ' 次' : '⚠️ 0 次（同上）'));
console.log('');
console.log('  · ② 是硬判据（为 0 就是断链）；① 要先扣掉期望（口径见 scripts/birth-share-lib.ts）；③④ 受 PVP 总量影响');
db.close();
