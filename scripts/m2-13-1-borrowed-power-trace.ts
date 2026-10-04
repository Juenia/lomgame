/**
 * M2.13.1 任务 1：**`borrowedPower` 分支为什么一次都没触发** —— 取证脚本。
 *
 * 用法：node scripts/m2-13-1-borrowed-power-trace.ts [片数] [库前缀] [日志前缀] [输出]
 *   例：node scripts/m2-13-1-borrowed-power-trace.ts 8 m213 m213-shard docs/M2.13.1-封印物使用取证.md
 *
 * ## 这是一张**漏斗表**，不是一段解释
 *
 * 从「有战斗」一路数到「真的用了封印物」，每一层少掉的部分就是 bug 在哪一层：
 *
 *   L0  有战斗回合（`battle_rounds`）
 *   L1  其中**那一刻手里有封印之刃 / 命运骰子**（用 `item_gain` 的时间戳还原）
 *   L2  其中**对方比我强**（正确的序列差口径：`玩家序列 − 生物序列 ≥ 1`）
 *   L2' 其中**对方比我弱**（**M2.13 实现里写的那一条**：`生物序列 − 玩家序列 ≥ 1`）
 *   L3  `borrowedPowerChoice` 返回非 null（L2 ∩ 代价未越线）
 *   L4  真的发出了 `.战斗 物品 <封印物>`（从行为日志数）
 *
 * **L2 与 L2' 是这张表的关键**：它们用同一个数据集、只差一个减法的方向。
 * 如果 L2' 是 0 而 L2 不是 0，那结论只有一个 —— **判据写反了**。
 *
 * ## 为什么不用「背包里现在有没有」来判断 L1
 *
 * 那一问问的是**今天**，而战斗发生在 30 天里的某一刻。
 * 所以 L1 用 `item_gain` 事件（`reason = '探索·封印物掉落'`）的
 * `created_at` 与 `battle_start` 的 `created_at` 比时间：
 * 「这一场开始之前，他掉到过封印之刃 / 命运骰子没有」。
 * 不考虑交易流转（封印物不消耗，掉到就是持有）—— 这条简化写在报告的口径里。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase } from '../src/infra/db/sqlite.ts';

const SHARDS = Number(process.argv[2] ?? 8);
const PREFIX = process.argv[3] ?? 'm213';
const LOG_PREFIX = process.argv[4] ?? 'm213-shard';
const OUT = process.argv[5] ?? join('docs', 'M2.13.1-封印物使用取证.md');

/** 能改变胜负的那两件（与 decide.ts 的 hasBorrowedPower 同一份名单） */
const BORROWED = ['sealed_blade', 'sealed_fate_dice'];

interface Row {
  shard: number;
  battleId: string;
  characterId: string;
  round: number;
  playerSeq: number;
  creatureSeq: number;
  /** 那一刻手里有没有那两件 */
  armed: boolean;
}

function parseJson<T>(raw: unknown, fallback: T): T {
  try {
    return (JSON.parse(String(raw ?? '')) as T) ?? fallback;
  } catch {
    return fallback;
  }
}

const rows: Row[] = [];
const perShard: Array<{ shard: number; battles: number; rounds: number; armed: number; l2: number; l2bad: number; used: number }> = [];
let logUsed = 0;
const usedItems = new Map<string, number>();
/** 实际使用的逐条记录（含虚拟玩家自己写下的序列差） */
const usedDetail: Array<{ shard: number; playerId: number; day: number; itemId: string; foeSeq: number; mySeq: number; gap: number }> = [];

for (let index = 0; index < SHARDS; index += 1) {
  const path = join('data', PREFIX + '-shard-' + index + '.db');
  if (!existsSync(path)) {
    console.log('跳过不存在的库：' + path);
    continue;
  }
  const db = openDatabase(path);

  /* ---- 1) 每一场战斗的「玩家序列 / 生物序列」（战斗开始那一刻的快照） ---- */
  const meta = new Map<string, { characterId: string; playerSeq: number; creatureSeq: number; startedAt: number }>();
  for (const row of db
    .prepare("SELECT character_id, payload, created_at FROM domain_events WHERE type = 'battle_start'")
    .all() as Array<Record<string, unknown>>) {
    const payload = parseJson<Record<string, unknown>>(row.payload, {});
    const battleId = String(payload.battleId ?? '');
    const playerSeq = Number(payload.playerSequence);
    const creatureSeq = Number(payload.creatureSequence);
    if (!battleId || !Number.isFinite(playerSeq) || !Number.isFinite(creatureSeq)) continue;
    meta.set(battleId, {
      characterId: String(row.character_id),
      playerSeq,
      creatureSeq,
      startedAt: Number(row.created_at),
    });
  }

  /* ---- 2) 谁在什么时候掉到过那两件 ---- */
  const gainsByChar = new Map<string, Array<{ itemId: string; at: number }>>();
  for (const row of db
    .prepare("SELECT character_id, payload, created_at FROM domain_events WHERE type = 'item_gain'")
    .all() as Array<Record<string, unknown>>) {
    const payload = parseJson<Record<string, unknown>>(row.payload, {});
    const itemId = String(payload.itemId ?? '');
    if (!BORROWED.includes(itemId)) continue;
    const list = gainsByChar.get(String(row.character_id)) ?? [];
    list.push({ itemId, at: Number(row.created_at) });
    gainsByChar.set(String(row.character_id), list);
  }

  /* ---- 3) 逐回合算 ---- */
  const rounds = db
    .prepare('SELECT battle_id, round FROM battle_rounds ORDER BY battle_id, round')
    .all() as Array<Record<string, unknown>>;
  let battles = 0;
  let armed = 0;
  let l2 = 0;
  let l2bad = 0;
  for (const row of rounds) {
    const battleId = String(row.battle_id);
    const info = meta.get(battleId);
    if (!info) continue;
    battles += 1;
    const gains = gainsByChar.get(info.characterId) ?? [];
    // 「那一刻」= 这一场开始之前
    const armedNow = gains.some((entry) => entry.at <= info.startedAt);
    const gapCorrect = info.playerSeq - info.creatureSeq; // 正数 = 对方比我强
    const gapAsWritten = info.creatureSeq - info.playerSeq; // M2.13 实现里写的那一条
    if (armedNow) armed += 1;
    if (armedNow && gapCorrect >= 1) l2 += 1;
    if (armedNow && gapAsWritten >= 1) l2bad += 1;
    rows.push({
      shard: index,
      battleId,
      characterId: info.characterId,
      round: Number(row.round),
      playerSeq: info.playerSeq,
      creatureSeq: info.creatureSeq,
      armed: armedNow,
    });
  }
  db.close();

  /* ---- 4) 行为日志里真的发出了几条 ---- */
  const logPath = join('docs', LOG_PREFIX + index + '-行为日志.jsonl');
  let used = 0;
  if (existsSync(logPath)) {
    for (const line of readFileSync(logPath, 'utf8').trim().split('\n')) {
      let record: Record<string, unknown>;
      try {
        record = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const command = String(record.command ?? '');
      const match = /\.战斗 物品 (sealed_[a-z_]+)/.exec(command);
      if (!match) continue;
      used += 1;
      logUsed += 1;
      usedItems.set(match[1]!, (usedItems.get(match[1]!) ?? 0) + 1);
      /*
       * ⚠️ **L4 是从行为日志数出来的，不是从库里数出来的** —— 这一条很关键：
       * M2.13 的 14 次「使用」**全部发生在 PVP**（.挑战 打另一个玩家），
       * 而 PVP 走的是 pvp-hooks 那条路，**当时既没喂封印物效果、也没写留档事件**
       * （两处都在 M2.13.1 补上了）。所以只看库里的 extraordinary_used 会漏掉整个 PVP 半边。
       *
       * 顺手把 reason 里那句「序列 X、我序列 Y（差 N）」解析出来 ——
       * 它是虚拟玩家自己写下的**当时**的序列差，比事后查 characters.sequence 准。
       */
      const gapMatch = /序列 (\d+)、我序列 (\d+)（差 (-?\d+)）/.exec(String(record.reason ?? ''));
      if (gapMatch) {
        usedDetail.push({
          shard: index,
          playerId: Number(record.playerId ?? 0),
          day: Number(record.day ?? 0),
          itemId: match[1]!,
          foeSeq: Number(gapMatch[1]),
          mySeq: Number(gapMatch[2]),
          gap: Number(gapMatch[3]),
        });
      }
    }
  }
  perShard.push({ shard: index, battles, rounds: rounds.length, armed, l2, l2bad, used });
}

/* ------------------------------------------------------------------ *
 * 报告
 * ------------------------------------------------------------------ */

const total = perShard.reduce(
  (acc, s) => ({
    battles: acc.battles + s.battles,
    rounds: acc.rounds + s.rounds,
    armed: acc.armed + s.armed,
    l2: acc.l2 + s.l2,
    l2bad: acc.l2bad + s.l2bad,
    used: acc.used + s.used,
  }),
  { battles: 0, rounds: 0, armed: 0, l2: 0, l2bad: 0, used: 0 },
);

/** 序列差分布（只看「手里有」的那些回合，两种口径并排） */
const gapHist = new Map<string, { correct: number; asWritten: number }>();
for (const row of rows) {
  if (!row.armed) continue;
  const key = row.playerSeq + ' → ' + row.creatureSeq;
  const entry = gapHist.get(key) ?? { correct: 0, asWritten: 0 };
  entry.correct += 1;
  if (row.creatureSeq - row.playerSeq >= 1) entry.asWritten += 1;
  gapHist.set(key, entry);
}

const lines: string[] = [];
lines.push('# M2.13.1 封印物使用取证：`borrowedPower` 的漏斗');
lines.push('');
lines.push('> 数据来源：' + SHARDS + ' 个分片库（`data/' + PREFIX + '-shard-N.db`）与它们的行为日志。');
lines.push('> 口径：「那一刻手里有」用 `item_gain` 的时间戳与 `battle_start` 的时间戳比出来（不考虑交易流转 —— 封印物不消耗）。');
lines.push('');
lines.push('## 一、漏斗表');
lines.push('');
lines.push('| 层 | 定义 | 回合数 |');
lines.push('| --- | --- | --- |');
lines.push('| **L0** | 有战斗回合（`battle_rounds`，' + total.battles + ' 场） | ' + total.rounds + ' |');
lines.push('| **L1** | 其中**那一刻手里有**封印之刃 / 命运骰子 | ' + total.armed + ' |');
lines.push('| **L2' + "'" + '** | 其中按 **M2.13 实现写的那条**（生物序列 − 玩家序列 ≥ 1） | **' + total.l2bad + '** |');
lines.push('| **L2** | 其中按**正确口径**（玩家序列 − 生物序列 ≥ 1，即「对方比我强」） | **' + total.l2 + '** |');
lines.push('| **L3** | `borrowedPowerChoice` 返回非 null（L2 ∩ 代价未越线） | ' + total.l2 + ' |');
lines.push('| **L4** | 真的发出了 `.战斗 物品 <封印物>` | **' + logUsed + '** |');
lines.push('');
lines.push('**每一层少掉的部分，就是 bug 在哪一层。**');
lines.push('');
lines.push('## 二、序列差分布（只看「手里有」的那些回合）');
lines.push('');
lines.push('| 玩家序列 → 生物序列 | 回合数 | 其中「对方比我强」 | 其中「M2.13 实现认的」 |');
lines.push('| --- | --- | --- | --- |');
for (const [key, entry] of [...gapHist.entries()].sort((a, b) => b[1].correct - a[1].correct)) {
  lines.push('| ' + key + ' | ' + entry.correct + ' | ' + entry.correct + ' | ' + entry.asWritten + ' |');
}
if (gapHist.size === 0) lines.push('| （无） | 0 | 0 | 0 |');
lines.push('');
lines.push('## 三、逐片');
lines.push('');
lines.push('| 分片 | 战斗回合 | 手里有 | L2（正确） | L2' + "'" + '（实现） | 实际使用 |');
lines.push('| --- | --- | --- | --- | --- | --- |');
for (const s of perShard) {
  lines.push('| ' + s.shard + ' | ' + s.rounds + ' | ' + s.armed + ' | ' + s.l2 + ' | ' + s.l2bad + ' | ' + s.used + ' |');
}
lines.push('');
lines.push('## 四、实际用掉的物品');
lines.push('');
lines.push('> ⚠️ **这一节是从行为日志数出来的，不是从库里数出来的。** M2.13 的 14 次「使用」');
lines.push('> **全部发生在 PVP**（`.挑战` 打另一个玩家），而 PVP 走的是 `pvp-hooks` 那条路 ——');
lines.push('> 它当时**既没把封印物的效果喂进判定层、也没写留档事件**。两处都在 M2.13.1 补齐。');
lines.push('> 只看库里的 `extraordinary_used` 会把整个 PVP 半边漏掉。');
lines.push('');
lines.push('| 物品 | 次数 |');
lines.push('| --- | --- |');
for (const [id, n] of [...usedItems.entries()].sort((a, b) => b[1] - a[1])) lines.push('| ' + id + ' | ' + n + ' |');
if (usedItems.size === 0) lines.push('| （无） | 0 |');
lines.push('');
lines.push('### 逐条（虚拟玩家自己写下的序列差）');
lines.push('');
lines.push('| 分片 | 玩家 | 天 | 物品 | 对手序列 | 我序列 | 差（正 = 对方更强） |');
lines.push('| --- | --- | --- | --- | --- | --- | --- |');
for (const row of usedDetail) {
  lines.push(
    '| ' + row.shard + ' | #' + row.playerId + ' | ' + row.day + ' | ' + row.itemId + ' | ' +
      row.foeSeq + ' | ' + row.mySeq + ' | **' + row.gap + '** |',
  );
}
if (usedDetail.length === 0) lines.push('| （无） | — | — | — | — | — | — |');
lines.push('');

writeFileSync(OUT, lines.join('\n'), 'utf8');
console.log('已写出 ' + OUT);
console.log(
  '漏斗：L0=' + total.rounds + ' → L1(手里有)=' + total.armed + ' → L2(正确口径)=' + total.l2 +
    ' / L2\'(实现口径)=' + total.l2bad + ' → L4(实际使用)=' + logUsed,
);
