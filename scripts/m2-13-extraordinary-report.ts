/**
 * M2.13 主任务的覆盖报告：**封印物**。
 *
 * 用法：node scripts/m2-13-extraordinary-report.ts [片数] [输出路径] [库前缀]
 *   例：node scripts/m2-13-extraordinary-report.ts 8 docs/M2.13-封印物覆盖.md m213
 *
 * ## 这一份要回答的四件事（任务书 §5.10）
 *
 *   1. 封印物**获取**次数（按类型：神奇物品 / 封印物 / 符咒）；
 *   2. 封印物**使用**次数（按物品）；
 *   3. **「序列 9 玩家用封印物打赢序列 8 生物」≥ 3 次** —— 这是这一轮的**核心验收**；
 *   4. 三类在各序列玩家手里的分布（回答「封印物到底有没有落到低序列玩家手上」）。
 *
 * ## 第 3 条为什么能数得出来
 *
 * 它需要三个数，缺一不可：
 *   - **玩家当时的序列** —— 来自 `battle_start` 事件的 `playerSequence`
 *     （M2.13 补上的字段；用 `characters.sequence` 会漂，见那边的注释）；
 *   - **生物当时的序列** —— `battle_start` 的 `creatureSequence`（M2.9 起就有）；
 *   - **这一场有没有用过封印物** —— `battle_rounds.result_json` 的 `playerAction.kind`。
 *
 * 三者用 `battleId` 串起来，再与 `battles.status` 的胜负对一次 ——
 * 「打赢」是**这一场战斗的结局**，不是某一回合的命中。
 */
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase } from '../src/infra/db/sqlite.ts';

const SHARDS = Number(process.argv[2] ?? 8);
const OUT = process.argv[3] ?? join('docs', 'M2.13-封印物覆盖.md');
const PREFIX = process.argv[4] ?? 'm213';

/** 核心验收的门槛（任务书 §5.10） */
const CORE_GATE = 3;

interface Totals {
  /** 掉落的封印物：id → 次数 */
  drops: Map<string, number>;
  /** 掉落的封印物：类型 → 次数 */
  dropKinds: Map<string, number>;
  /** 使用：id → 次数 */
  uses: Map<string, number>;
  /** 谁用的：玩家序列 → 次数 */
  useBySequence: Map<string, number>;
  /** 探索总次数（算掉落率的分子分母） */
  explores: number;
  /** 按地点门槛分的掉落（seq9 / seq8 / seq7） */
  dropsByTier: Map<string, number>;
  /** 核心验收：序列 9 用封印物打赢序列 8 生物 */
  lowSeqWinsWithArtifact: Array<{ battleId: string; playerSeq: number; creatureSeq: number; speciesId: string; itemId: string }>;
  /** 对照：序列 9 打序列 8 且**没用**封印物的胜场 */
  lowSeqWinsPlain: number;
  /** 序列 9 打序列 8 的总场次 */
  lowSeqVsHighTotal: number;
  /** 用过封印物的战斗场次 */
  battlesWithArtifact: number;
  /** 封印物交易的成交笔数 */
  artifactTrades: number;
}

function empty(): Totals {
  return {
    drops: new Map(),
    dropKinds: new Map(),
    uses: new Map(),
    useBySequence: new Map(),
    explores: 0,
    dropsByTier: new Map(),
    lowSeqWinsWithArtifact: [],
    lowSeqWinsPlain: 0,
    lowSeqVsHighTotal: 0,
    battlesWithArtifact: 0,
    artifactTrades: 0,
  };
}

function bump(map: Map<string, number>, key: string, by = 1): void {
  map.set(key, (map.get(key) ?? 0) + by);
}

function kindOfItemId(itemId: string): string {
  if (itemId.startsWith('wonder_')) return 'wonder';
  if (itemId.startsWith('sealed_')) return 'sealed';
  if (itemId.startsWith('charm_')) return 'charm';
  return 'other';
}

const t = empty();

for (let index = 0; index < SHARDS; index += 1) {
  const path = join('data', PREFIX + '-shard-' + index + '.db');
  if (!existsSync(path)) {
    console.log('跳过不存在的库：' + path);
    continue;
  }
  const db = openDatabase(path);

  // 1) 探索总次数（掉落率的分母）
  try {
    const row = db.prepare('SELECT COALESCE(SUM(count), 0) AS n FROM explore_daily').get() as { n: number };
    t.explores += Number(row.n);
  } catch {
    /* 旧库没有这张表时忽略 */
  }

  /*
   * 2) 掉落。**M2.14 起有两个来源**，reason 都写死在命令层：
   *      '探索·封印物掉落'  —— M2.13 的旧来源（按地点序列门槛分三档）
   *      '探索·灾厄掉落'    —— M2.14 方案 A 的主路径（灾厄期每次探索）
   *      '战斗·灾厄掉落'    —— M2.14 的次路径（灾厄期战斗胜利，观察项）
   *    灾厄产出的 payload 没有 tier（它按触发点分档，不按地点门槛），
   *    所以下面用 payload.tier ?? 'unknown' 兜底 —— 不会漏数，只是归不进三档。
   */
  for (const row of db
    .prepare(
      "SELECT payload FROM domain_events WHERE type = 'item_gain' " +
        "AND reason IN ('探索·封印物掉落', '探索·灾厄掉落', '战斗·灾厄掉落')",
    )
    .all() as Array<Record<string, unknown>>) {
    try {
      const payload = JSON.parse(String(row.payload)) as Record<string, unknown>;
      const itemId = String(payload.itemId ?? '');
      if (!itemId) continue;
      bump(t.drops, itemId);
      bump(t.dropKinds, String(payload.extraordinaryKind ?? kindOfItemId(itemId)));
      bump(t.dropsByTier, String(payload.tier ?? 'unknown'));
    } catch {
      /* 忽略坏行 */
    }
  }

  // 3) 使用
  for (const row of db
    .prepare("SELECT payload, character_id FROM domain_events WHERE type = 'extraordinary_used'")
    .all() as Array<Record<string, unknown>>) {
    try {
      const payload = JSON.parse(String(row.payload)) as Record<string, unknown>;
      const itemId = String(payload.itemId ?? '');
      if (itemId) bump(t.uses, itemId);
    } catch {
      /* 忽略坏行 */
    }
  }

  // 4) 核心验收：序列 9 用封印物打赢序列 8 生物
  try {
    const starts = db
      .prepare(
        "SELECT payload FROM domain_events WHERE type = 'battle_start' ORDER BY created_at ASC",
      )
      .all() as Array<Record<string, unknown>>;
    /** battleId → { playerSeq, creatureSeq, speciesId } */
    const meta = new Map<string, { playerSeq: number; creatureSeq: number; speciesId: string }>();
    for (const row of starts) {
      try {
        const payload = JSON.parse(String(row.payload)) as Record<string, unknown>;
        const battleId = String(payload.battleId ?? '');
        const playerSeq = Number(payload.playerSequence);
        const creatureSeq = Number(payload.creatureSequence);
        if (!battleId || !Number.isFinite(playerSeq) || !Number.isFinite(creatureSeq)) continue;
        meta.set(battleId, { playerSeq, creatureSeq, speciesId: String(payload.speciesId ?? '') });
      } catch {
        /* 忽略坏行 */
      }
    }

    /** battleId → 用过的封印物（第一件） */
    const used = new Map<string, string>();
    for (const row of db
      .prepare('SELECT battle_id, result_json FROM battle_rounds')
      .all() as Array<Record<string, unknown>>) {
      try {
        const parsed = JSON.parse(String(row.result_json)) as {
          playerAction?: { kind?: string; extraordinaryId?: string };
        };
        if (parsed.playerAction?.kind !== 'extraordinary') continue;
        const battleId = String(row.battle_id);
        if (!used.has(battleId)) used.set(battleId, String(parsed.playerAction.extraordinaryId ?? '?'));
      } catch {
        /* 忽略坏行 */
      }
    }
    t.battlesWithArtifact += used.size;

    for (const row of db
      .prepare("SELECT id, status, species_id FROM battles WHERE is_pvp = 0")
      .all() as Array<Record<string, unknown>>) {
      const battleId = String(row.id);
      const info = meta.get(battleId);
      if (!info) continue;
      if (info.playerSeq !== 9 || info.creatureSeq !== 8) continue;
      t.lowSeqVsHighTotal += 1;
      if (String(row.status) !== 'player_win') continue;
      const artifact = used.get(battleId);
      if (artifact) {
        t.lowSeqWinsWithArtifact.push({
          battleId,
          playerSeq: info.playerSeq,
          creatureSeq: info.creatureSeq,
          speciesId: String(row.species_id ?? info.speciesId),
          itemId: artifact,
        });
      } else {
        t.lowSeqWinsPlain += 1;
      }
    }
  } catch {
    /* 旧库缺表时忽略 */
  }

  // 5) 玩家序列分布（使用侧的对照）
  try {
    for (const row of db
      .prepare(
        'SELECT c.sequence AS seq, COUNT(*) AS n FROM domain_events e ' +
          'JOIN characters c ON c.id = e.character_id ' +
          "WHERE e.type = 'extraordinary_used' GROUP BY c.sequence",
      )
      .all() as Array<Record<string, unknown>>) {
      bump(t.useBySequence, '序列 ' + String(row.seq), Number(row.n));
    }
  } catch {
    /* 忽略 */
  }

  // 6) 封印物的交易成交（非绑定 → 可交易，这是「序列 9 找序列 7 买」那条经济流）
  try {
    for (const row of db
      .prepare(
        "SELECT item_id FROM trades WHERE status = 'completed' AND (" +
          "item_id LIKE 'wonder\_%' ESCAPE '\\' OR item_id LIKE 'sealed\_%' ESCAPE '\\' OR item_id LIKE 'charm\_%' ESCAPE '\\')",
      )
      .all() as Array<Record<string, unknown>>) {
      if (String(row.item_id ?? '')) t.artifactTrades += 1;
    }
  } catch {
    /* 忽略 */
  }

  db.close();
}

const rowsOf = (map: Map<string, number>): string =>
  [...map.entries()]
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .map(([key, value]) => '| ' + key + ' | ' + value + ' |')
    .join('\n') || '| （无） | 0 |';

const totalDrops = [...t.drops.values()].reduce((sum, n) => sum + n, 0);
const totalUses = [...t.uses.values()].reduce((sum, n) => sum + n, 0);
const core = t.lowSeqWinsWithArtifact.length;
const corePass = core >= CORE_GATE;

const lines: string[] = [];
lines.push('# M2.13 封印物覆盖（' + SHARDS + ' 分片）');
lines.push('');
lines.push('> 数据来源：' + SHARDS + ' 个分片库（`data/' + PREFIX + '-shard-N.db`），从库里数出来，不靠人抄 stdout。');
lines.push('');
lines.push('## 〇、核心验收');
lines.push('');
lines.push('| 项 | 结果 | 门槛 | 判定 |');
lines.push('| --- | --- | --- | --- |');
lines.push(
  '| **序列 9 玩家用封印物打赢序列 8 生物** | **' +
    core +
    '** | ≥ ' +
    CORE_GATE +
    ' | ' +
    (corePass ? '**通过**' : '**不通过**') +
    ' |',
);
lines.push('');
lines.push('逐条记录：');
lines.push('');
lines.push('| 战斗 | 玩家序列 | 生物序列 | 物种 | 用的东西 |');
lines.push('| --- | --- | --- | --- | --- |');
for (const entry of t.lowSeqWinsWithArtifact) {
  lines.push(
    '| ' + entry.battleId + ' | ' + entry.playerSeq + ' | ' + entry.creatureSeq + ' | ' + entry.speciesId + ' | ' + entry.itemId + ' |',
  );
}
if (core === 0) lines.push('| （无） | — | — | — | — |');
lines.push('');
lines.push('**对照（同一批里「序列 9 打序列 8」的其它结局）**：');
lines.push('');
lines.push('| 项 | 场次 |');
lines.push('| --- | --- |');
lines.push('| 序列 9 对序列 8 的总场次 | ' + t.lowSeqVsHighTotal + ' |');
lines.push('| 其中**没用**封印物就赢的 | ' + t.lowSeqWinsPlain + ' |');
lines.push('| 其中**用了**封印物才赢的 | ' + core + ' |');
lines.push('');
lines.push('> 这一栏是**这一轮为什么要做封印物**的直接证据：');
lines.push('> 「没用封印物就赢」的场次说明序列差不是绝对墙，');
lines.push('> 而「用了封印物才赢」的场次说明封印物真的在起作用。');
lines.push('');
lines.push('## 一、获取（探索掉落 —— 这一轮唯一的来源）');
lines.push('');
lines.push('| 项 | 次数 |');
lines.push('| --- | --- |');
lines.push('| 探索总次数 | ' + t.explores + ' |');
lines.push('| **掉出封印物** | **' + totalDrops + '** |');
lines.push('| 掉落率（总） | ' + (t.explores > 0 ? ((totalDrops / t.explores) * 100).toFixed(3) + '%' : '—') + ' |');
lines.push('');
lines.push('| 类型 | 次数 |');
lines.push('| --- | --- |');
lines.push(rowsOf(t.dropKinds));
lines.push('');
lines.push('| 地点档位 | 次数 |');
lines.push('| --- | --- |');
lines.push(rowsOf(t.dropsByTier));
lines.push('');
lines.push('| 物品 | 次数 |');
lines.push('| --- | --- |');
lines.push(rowsOf(t.drops));
lines.push('');
lines.push('## 二、使用');
lines.push('');
lines.push('| 项 | 次数 |');
lines.push('| --- | --- |');
lines.push('| **使用封印物** | **' + totalUses + '** |');
lines.push('| 用过封印物的战斗场次 | ' + t.battlesWithArtifact + ' |');
lines.push('');
lines.push('| 物品 | 使用次数 |');
lines.push('| --- | --- |');
lines.push(rowsOf(t.uses));
lines.push('');
lines.push('| 使用者的序列 | 次数 |');
lines.push('| --- | --- |');
lines.push(rowsOf(t.useBySequence));
lines.push('');
lines.push('## 三、交易（封印物是非绑定物品 → 「序列 9 找序列 7 买」这条经济流）');
lines.push('');
lines.push('| 项 | 笔数 |');
lines.push('| --- | --- |');
lines.push('| 封印物的成交笔数 | ' + t.artifactTrades + ' |');
lines.push('');

writeFileSync(OUT, lines.join('\n'), 'utf8');
console.log('已写出 ' + OUT);
console.log(
  '核心验收：序列 9 用封印物打赢序列 8 生物 = ' +
    core +
    '（门槛 ' +
    CORE_GATE +
    '，' +
    (corePass ? '通过' : '不通过') +
    '）',
);
console.log('掉落 ' + totalDrops + ' 次 / 使用 ' + totalUses + ' 次；探索 ' + t.explores + ' 次');
console.log('按类型：' + JSON.stringify([...t.dropKinds.entries()]));
console.log('按物品（使用）：' + JSON.stringify([...t.uses.entries()]));
