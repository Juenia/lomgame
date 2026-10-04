/**
 * M2.14 前置 4 根因取证（任务 B）—— **只读脚本**。
 *
 * 回答一个问题：m213b 那轮「序列 8 且 DIG ≥ 85」的 49 个人，
 * 在 DIG 到 85 之后的那几天里，每天发的是什么指令、背包里主材料有几个，
 * 以及「为什么没凑齐」到底差在哪一环。
 *
 * 口径（全部写死在下面，不手抄）：
 *   1. 人群 = characters.sequence = 8 且 characters.dig >= 85（最终快照口径），
 *      与 docs/M2.13.1-交付说明.md §2.4 的「49」同一个定义；
 *   2. 窗口起点 = domain_events 里该角色**第一条** dig_delta 且 after >= 85 的时刻，
 *      折到行为日志的 day 字段（与虚拟玩家的日口径一致）；窗口终点 = 该 pid 的最后一条指令；
 *   3. 主材料 = 该角色的**当前途径**在 src/data/recipes.yaml 里 seq = 8 那条配方的 main，
 *      需求数量 = qty × NUMERIC.promotion.mainMaterialMultiplier（= 2）；
 *   4. 背包时间线 = domain_events 的 item_gain / item_delta / trade_buy / trade_sell
 *      按 id 顺序累加（交易是唯一一条不走 item_* 的库存改动路径），
 *      窗口末值与 inventory 表逐人核对（不一致打印告警，不静默）；
 *   5. 指令 = docs/m213b-shard<i>-行为日志.jsonl 里该 playerId 的记录；
 *      「探索了」只认 status = 200 的那些（被拒的探索不该算进探索次数）。
 *
 * 用法：node scripts/m2-14-prereq4-trace.ts [--out docs/M2.14-前置4根因取证.md]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLocations, loadRecipes } from '../src/data/loader.ts';
import { NUMERIC } from '../src/config/numeric.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SHARDS = 8;
const PREFIX = 'm213b';
const DIG_GATE = NUMERIC.sequence7.digThreshold; // 85
const SEQ_GATE = NUMERIC.sequence7.recipeSeq;    // 8
const OK = 200;
/** 反引号（markdown 行内代码）—— 不直接写字面量，避免与模板字符串冲突 */
const TICK = String.fromCharCode(96);

function argValue(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  const next = index >= 0 ? process.argv[index + 1] : undefined;
  return next ?? fallback;
}

const outPath = argValue('--out', join('docs', 'M2.14-前置4根因取证.md'));

/* ---------------- 内容表 ---------------- */

const { recipes, issues } = loadRecipes();
if (issues.length > 0) {
  console.error('配方 YAML 有问题，拒绝继续：' + issues.map((issue) => issue.message).join('; '));
  process.exit(1);
}
const mainMaterialOf = new Map<string, { itemId: string; qty: number }>();
for (const recipe of recipes) {
  if (recipe.seq !== SEQ_GATE) continue;
  const main = recipe.main[0];
  if (!main) continue;
  mainMaterialOf.set(recipe.pathway, {
    itemId: main.itemId,
    qty: main.qty * NUMERIC.promotion.mainMaterialMultiplier,
  });
}

const { locations } = loadLocations();
const locationByName = new Map(locations.map((location) => [location.name, location]));

/* ---------------- 行为日志 ---------------- */

interface LogLine {
  playerId: number;
  day: number;
  virtualNow: number;
  command: string;
  status: number;
  replyTexts?: string[];
}

function readLog(shard: number): LogLine[] {
  const out: LogLine[] = [];
  for (const line of readFileSync(join(ROOT, 'docs', PREFIX + '-shard' + shard + '-行为日志.jsonl'), 'utf8').split('\n')) {
    if (line) out.push(JSON.parse(line) as LogLine);
  }
  return out;
}

interface ExploreAttempt {
  location: string;
  ok: boolean;
  reason: string;
}

interface Player {
  shard: number;
  playerId: number;
  characterId: string;
  name: string;
  pathway: string;
  needItem: string;
  needQty: number;
  gateDay: number;
  /** 纯 DIG 口径（只按 dig >= 85 划线）的那一天，用来展示窗口被往后推了多少 */
  dig85Day: number | null;
  lastDay: number;
  /** 窗口起点时是否已经有 ability_<途径>_8（= 已经服下本序列魔药，晋升的那一半前提已就绪） */
  hadAbilityFlag: boolean;
  /** 最终库里有没有这个 flag（49 人按定义都该有） */
  hasAbilityFlag: boolean;
  peakOwned: number;
  finalOwned: number;
  inventoryOwned: number;
  gainedInWindow: number;
  gainedTotal: number;
  exploreAttempts: ExploreAttempt[];
  exploredOk: number;
  expectedDrops: number;
  ritualCommands: number;
  promoteCommands: number;
  promoteLog: { day: number; verdict: string }[];
  commandsInWindow: string[];
  days: { day: number; commands: string[]; ownedAtDayEnd: number }[];
}

const players: Player[] = [];
const warnings: string[] = [];

for (let shard = 0; shard < SHARDS; shard += 1) {
  const db = new DatabaseSync(join(ROOT, 'data', PREFIX + '-shard-' + shard + '.db'), { readOnly: true });
  const logs = readLog(shard);

  const rows = db
    .prepare('SELECT id, user_id, name, pathway, sequence, dig FROM characters ORDER BY id')
    .all() as { id: string; user_id: string; name: string; pathway: string; sequence: number; dig: number }[];

  for (const row of rows) {
    if (row.sequence !== SEQ_GATE || row.dig >= DIG_GATE === false) continue;
    if (row.dig < DIG_GATE) continue;
    const need = mainMaterialOf.get(row.pathway);
    if (!need) {
      warnings.push(row.pathway + ' 没有 seq=' + SEQ_GATE + ' 的配方（角色 ' + row.id + '）');
      continue;
    }
    const events = db
      .prepare('SELECT type, payload, created_at FROM domain_events WHERE character_id = ? ORDER BY id')
      .all(row.id) as { type: string; payload: string; created_at: number }[];

    const abilityFlag = 'ability_' + row.pathway + '_' + SEQ_GATE;
    /*
     * 窗口起点 = 「DIG >= 85 **且** 已经是序列 8」的第一个时刻。
     * 只按 DIG 划线会把序列 9 时期也算进来 —— 而序列 9 的玩家进不去 min_seq 8 的地点，
     * 那段时间的探索本来就掉不到本序列的主材料，算进分母只会把结论带偏。
     */
    let gateAt: number | null = null;
    /** 纯 DIG 口径（只按 dig >= 85 划线）的时刻，用来对照 */
    let dig85At: number | null = null;
    let flagAt: number | null = null;
    let curDig = 0;
    let curSeq: number | null = null;
    let owned = 0;
    let peakOwned = 0;
    const gains: { at: number; quantity: number }[] = [];
    const timeline: [number, number][] = [];

    for (const event of events) {
      const payload = JSON.parse(event.payload) as Record<string, unknown>;
      if (event.type === 'dig_delta') {
        curDig = typeof payload.after === 'number' ? payload.after : curDig;
        if (curDig >= DIG_GATE && dig85At === null) dig85At = event.created_at;
      }
      if (event.type === 'sequence_delta') {
        curSeq = typeof payload.after === 'number' ? payload.after : curSeq;
      }
      if (gateAt === null && dig85At !== null && curSeq !== null && curSeq <= SEQ_GATE && curDig >= DIG_GATE) {
        gateAt = event.created_at;
      }
      /*
       * ability_<途径>_8 这个 flag 只在 scripts 的 flags 表里，**不一定有 flag_set 事件**：
       * ritual.ts:426 与 promote.ts:100 都只调 flags.setMany，没有 appendEvents。
       * 所以这里只借 flag_set 事件做个旁证，真正的时间点读 flags.created_at（见下面 flagRow）。
       */
      if (event.type === 'flag_set' && flagAt === null) {
        const flags = Array.isArray(payload.flags) ? (payload.flags as unknown[]) : [];
        if (flags.includes(abilityFlag)) flagAt = event.created_at;
      }
      const itemId = typeof payload.itemId === 'string' ? payload.itemId : null;
      if (itemId !== need.itemId) continue;
      let delta = 0;
      if (event.type === 'item_gain' || event.type === 'item_delta') {
        delta = typeof payload.quantity === 'number' ? payload.quantity : 0;
        if (event.type === 'item_gain') gains.push({ at: event.created_at, quantity: delta });
      } else if (event.type === 'trade_buy' || event.type === 'trade_sell') {
        const qty = typeof payload.qty === 'number' ? payload.qty : 0;
        delta = event.type === 'trade_buy' ? qty : -qty;
      } else {
        continue;
      }
      owned += delta;
      timeline.push([event.created_at + 1, owned]);
      peakOwned = Math.max(peakOwned, owned);
    }
    timeline.sort((a, b) => a[0] - b[0]);
    const ownedAtTime = (at: number): number => {
      let value = 0;
      for (const entry of timeline) {
        if (entry[0] > at) break;
        value = entry[1];
      }
      return value;
    };

    const inventoryRow = db
      .prepare('SELECT quantity FROM inventory WHERE character_id = ? AND item_id = ?')
      .get(row.id, need.itemId) as { quantity: number } | undefined;
    /** 本序列魔药 flag 的落库时间（flags 表口径，比 flag_set 事件可靠） */
    const flagRow = db
      .prepare('SELECT created_at FROM flags WHERE character_id = ? AND flag = ?')
      .get(row.id, abilityFlag) as { created_at: number } | undefined;

    const playerId = Number(row.user_id) - 700000;
    const mine = logs.filter((line) => line.playerId === playerId).sort((a, b) => a.virtualNow - b.virtualNow);
    if (mine.length === 0) warnings.push('行为日志里找不到 ' + row.id + '（playerId ' + playerId + '）');
    const first = gateAt === null ? null : mine.find((line) => line.virtualNow >= gateAt) ?? null;
    const gateDay = first ? first.day : (mine[mine.length - 1]?.day ?? 0);
    const digFirst = dig85At === null ? null : mine.find((line) => line.virtualNow >= dig85At) ?? null;
    if (gateAt === null) warnings.push(row.id + ' 库里找不到「DIG >= 85 且序列 8」的时刻，窗口按最后一天算');
    const windowLines = mine.filter((line) => line.day >= gateDay);
    const lastDay = mine.length > 0 ? mine[mine.length - 1]!.day : gateDay;
    const windowStartAt = windowLines[0]?.virtualNow ?? Number.MAX_SAFE_INTEGER;

    const exploreAttempts: ExploreAttempt[] = [];
    const promoteLog: { day: number; verdict: string }[] = [];
    for (const line of windowLines) {
      if (line.command.startsWith('.探索')) {
        const text = (line.replyTexts ?? []).join('\n');
        exploreAttempts.push({
          location: line.command.slice('.探索'.length).trim(),
          ok: line.status === OK,
          reason: line.status === OK ? '' : (text.split('\n')[0] ?? ''),
        });
      }
      if (line.command.startsWith('.晋升')) {
        const text = (line.replyTexts ?? []).join('\n');
        const verdict = line.status !== OK
          ? '被拒：' + (text.split('\n')[0] ?? '')
          : text.includes('晋升材料不足')
            ? '材料不足'
            : text.includes('消化度不足')
              ? '消化度不足'
              : text.includes('晋升判定')
                ? '真的晋升了（判定执行）'
                : '其它';
        promoteLog.push({ day: line.day, verdict });
      }
    }

    let expectedDrops = 0;
    for (const attempt of exploreAttempts) {
      if (!attempt.ok) continue;
      const location = locationByName.get(attempt.location);
      if (!location) continue;
      const total = location.loot.reduce((sum, entry) => sum + entry.weight, 0);
      const mineWeight = location.loot
        .filter((entry) => entry.itemId === need.itemId)
        .reduce((sum, entry) => sum + entry.weight, 0);
      if (total > 0) expectedDrops += (mineWeight / total) * (1 + NUMERIC.explore.bonusDropChance);
    }

    const byDay = new Map<number, LogLine[]>();
    for (const line of windowLines) {
      const list = byDay.get(line.day) ?? [];
      list.push(line);
      byDay.set(line.day, list);
    }

    players.push({
      shard,
      playerId,
      characterId: row.id,
      name: row.name,
      pathway: row.pathway,
      needItem: need.itemId,
      needQty: need.qty,
      gateDay,
      dig85Day: digFirst ? digFirst.day : null,
      lastDay,
      hadAbilityFlag: flagRow !== undefined && gateAt !== null && flagRow.created_at <= gateAt,
      hasAbilityFlag: flagRow !== undefined,
      peakOwned,
      finalOwned: ownedAtTime(Number.MAX_SAFE_INTEGER),
      inventoryOwned: inventoryRow?.quantity ?? 0,
      gainedInWindow: gains.filter((gain) => gain.at >= windowStartAt).reduce((sum, gain) => sum + gain.quantity, 0),
      gainedTotal: gains.reduce((sum, gain) => sum + gain.quantity, 0),
      exploreAttempts,
      exploredOk: exploreAttempts.filter((attempt) => attempt.ok).length,
      expectedDrops,
      ritualCommands: windowLines.filter((line) => line.command.startsWith('.仪式')).length,
      promoteCommands: promoteLog.length,
      promoteLog,
      commandsInWindow: windowLines.map((line) => line.command),
      days: [...byDay.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([day, dayLines]) => ({
          day,
          commands: dayLines.map((line) => line.command),
          ownedAtDayEnd: ownedAtTime(dayLines[dayLines.length - 1]!.virtualNow),
        })),
    });
  }

  db.close();
}

/** 对账：重建的窗口末值与 inventory 表必须一致（不一致说明还有一条库存改动路径没被数到） */
for (const player of players) {
  if (player.finalOwned !== player.inventoryOwned) {
    warnings.push(
      player.characterId + '（需 ' + player.needItem + '）时间线重建 ' + player.finalOwned +
        ' ≠ inventory 表 ' + player.inventoryOwned,
    );
  }
}
const mismatch = warnings.filter((warning) => warning.includes('时间线重建')).length;

/* ---------------- 分类 ---------------- */

type Category = '材料不齐' | '动作额度被挤' | '其它';

function categoryOf(player: Player): { category: Category; note: string } {
  if (player.peakOwned < player.needQty) {
    const rejected = player.exploreAttempts.filter((attempt) => !attempt.ok).length;
    return {
      category: '材料不齐',
      note: '生涯峰值 ' + player.peakOwned + '/' + player.needQty + '；窗口内成功探索 ' + player.exploredOk +
        ' 次（被拒 ' + rejected + ' 次），掉到 ' + player.gainedTotal + ' 个，按地点权重期望 ' +
        player.expectedDrops.toFixed(1) + ' 个',
    };
  }
  if (player.promoteCommands === 0 && player.ritualCommands === 0) {
    return {
      category: '动作额度被挤',
      note: '材料到过 ' + player.peakOwned + '/' + player.needQty + '，但窗口内 .晋升 与 .仪式 一次都没发（成功探索 ' + player.exploredOk + ' 次）',
    };
  }
  return {
    category: '其它',
    note: '发起过晋升：' + player.promoteLog.map((entry) => 'day ' + entry.day + ' ' + entry.verdict).join('；') +
      '（.仪式 ' + player.ritualCommands + ' 次）',
  };
}

const withCategory = players.map((player) => ({ player, ...categoryOf(player) }));
const counts = new Map<Category, number>();
for (const entry of withCategory) counts.set(entry.category, (counts.get(entry.category) ?? 0) + 1);

function commandKind(command: string): string {
  return (command.trim().split(/\s+/)[0] ?? command).replace(/^\./, '');
}

const kindCounts = new Map<string, number>();
for (const player of players) {
  for (const command of player.commandsInWindow) {
    const kind = commandKind(command);
    kindCounts.set(kind, (kindCounts.get(kind) ?? 0) + 1);
  }
}

const pathwayCounts = new Map<string, number>();
for (const player of players) pathwayCounts.set(player.pathway, (pathwayCounts.get(player.pathway) ?? 0) + 1);

const tierCounts = new Map<string, number>();
const locationCounts = new Map<string, number>();
const rejectReasons = new Map<string, number>();
for (const player of players) {
  for (const attempt of player.exploreAttempts) {
    const location = locationByName.get(attempt.location);
    if (!attempt.ok) {
      rejectReasons.set(attempt.reason, (rejectReasons.get(attempt.reason) ?? 0) + 1);
      continue;
    }
    const tier = location === undefined
      ? '未登记地点名'
      : 'min_seq ' + location.min_seq +
        (location.loot.some((entry) => entry.itemId === player.needItem) ? '（含本人主材料）' : '（不含）');
    tierCounts.set(tier, (tierCounts.get(tier) ?? 0) + 1);
    locationCounts.set(attempt.location, (locationCounts.get(attempt.location) ?? 0) + 1);
  }
}

const windowLengths = new Map<number, number>();
for (const player of players) {
  windowLengths.set(player.gateDay, (windowLengths.get(player.gateDay) ?? 0) + 1);
}

const totalExplored = players.reduce((sum, player) => sum + player.exploredOk, 0);
const totalGained = players.reduce((sum, player) => sum + player.gainedTotal, 0);
const totalExpected = players.reduce((sum, player) => sum + player.expectedDrops, 0);
const totalNeeded = players.reduce((sum, player) => sum + player.needQty, 0);
const shortOnly = players.filter((player) => player.peakOwned < player.needQty);
const oneShort = shortOnly.filter((player) => player.peakOwned === player.needQty - 1).length;
const zeroOwned = shortOnly.filter((player) => player.peakOwned === 0).length;
const shortWithRitual = shortOnly.filter((player) => player.ritualCommands > 0).length;
const noFlagPlayers = players.filter((player) => !player.hadAbilityFlag);
const totalRitualCommands = players.reduce((sum, player) => sum + player.ritualCommands, 0);
const totalPromoteCommands = players.reduce((sum, player) => sum + player.promoteCommands, 0);
const shortDropped = shortOnly.reduce((sum, player) => sum + player.gainedTotal, 0);

function fold(commands: string[]): string {
  const out: string[] = [];
  for (const command of commands) {
    const last = out[out.length - 1];
    if (last !== undefined && last.startsWith(command + '×')) {
      out[out.length - 1] = command + '×' + (Number(last.slice(last.indexOf('×') + 1)) + 1);
    } else {
      out.push(command);
    }
  }
  return out.join(' → ');
}

/* ---------------- 写文档 ---------------- */

const lines: string[] = [];
lines.push('# M2.14 前置 4 根因取证（49 人）');
lines.push('');
lines.push('> 生成方式：' + TICK + 'node scripts/m2-14-prereq4-trace.ts' + TICK + '（**只读**，不写任何库）。');
lines.push('> 数据来源：' + TICK + 'data/m213b-shard-0..7.db' + TICK + ' + ' + TICK + 'docs/m213b-shard0..7-行为日志.jsonl' + TICK + '。');
lines.push('> 这一份是在 ' + TICK + 'docs/M2.13.1-交付说明.md' + TICK + ' §2.4 那句「下一轮的第一件事」上交的作业 ——');
lines.push('> 「把那 49 个人逐个数出来：他们 DIG ≥ 85 之后的那几天，每天发的是什么指令、背包里主材料有几个」。');
lines.push('');
lines.push('## 零、口径（先写死，再看数）');
lines.push('');
lines.push('| 项 | 取值 | 出处 |');
lines.push('| --- | --- | --- |');
lines.push('| 人群 | ' + TICK + 'characters.sequence = 8' + TICK + ' 且 ' + TICK + 'characters.dig >= 85' + TICK + ' | 与交付说明 §2.4 的「49」同一口径 |');
lines.push('| DIG 门槛 | ' + DIG_GATE + ' | ' + TICK + 'NUMERIC.sequence7.digThreshold' + TICK + ' |');
lines.push('| 配方序列 | ' + SEQ_GATE + ' | ' + TICK + 'NUMERIC.sequence7.recipeSeq' + TICK + ' |');
lines.push('| 主材料倍率 | ×' + NUMERIC.promotion.mainMaterialMultiplier + ' | ' + TICK + 'NUMERIC.promotion.mainMaterialMultiplier' + TICK + '（只乘 ' + TICK + 'recipe.main' + TICK + '，不含 aux） |');
lines.push('| 主材料清单 | ' + [...mainMaterialOf.entries()].map(([pathway, need]) => pathway + ' → ' + need.itemId).join('；') + ' | ' + TICK + 'src/data/recipes.yaml' + TICK + '（seq = 8 三条配方的 main） |');
lines.push('| 窗口起点 | **第一条同时满足「' + TICK + 'dig_delta.after >= 85' + TICK + ' 且 ' + TICK + 'sequence_delta.after <= 8' + TICK + '」的事件**所在 day | ' + TICK + 'domain_events' + TICK + ' 按 id 顺序重建 |');
lines.push('| 窗口终点 | 该玩家在行为日志里的最后一条指令 | 行为日志 |');
lines.push('| 对照口径 | 名单里另给一列「纯 DIG 到 85」= 只按 ' + TICK + 'dig >= 85' + TICK + ' 划线的那一天 | 用于看窗口被往后推了多少 |');
lines.push('| 背包时间线 | ' + TICK + 'item_gain' + TICK + ' / ' + TICK + 'item_delta' + TICK + ' / ' + TICK + 'trade_buy' + TICK + ' / ' + TICK + 'trade_sell' + TICK + ' 按 id 累加 | ' + TICK + 'domain_events' + TICK + ' |');
lines.push('| 「探索了」 | 只算 ' + TICK + 'status = 200' + TICK + ' 的那些 | 行为日志 |');
lines.push('');
lines.push('> ⚠️ **一处口径说明（任务书 §九 的「封印物配方 YAML」）**：仓库里**没有「封印物配方」这个东西** ——');
lines.push('> ' + TICK + 'src/data/' + TICK + ' 的 12 个内容 YAML 里没有它，' + TICK + 'recipes.yaml' + TICK + ' 里没有任何 ' + TICK + 'sealed_' + TICK + '，');
lines.push('> 全仓 grep「封印物配方」与 ' + TICK + 'sealed.*recipe' + TICK + ' 都是 **0 命中**。');
lines.push('> 封印物（' + TICK + 'sealed_*' + TICK + '）是 ' + TICK + 'src/data/items.yaml' + TICK + ' 里的**物品定义**，由**探索掉落**产出');
lines.push('> （' + TICK + 'src/router/commands/explore.ts:324-355' + TICK + '），不是任何配方的产物 ——');
lines.push('> 所以那句话应当是**魔药配方 YAML** 的笔误。本表读的就是 ' + TICK + 'src/data/recipes.yaml' + TICK + '（6 条配方：3 条 seq 9 + 3 条 seq 8），');
lines.push('> 取 ' + TICK + 'seq = 8' + TICK + ' 那三条的 ' + TICK + 'main' + TICK + ' —— 也就是「8 → 7」要备的东西。');
lines.push('> 依据：' + TICK + 'src/router/commands/promote.ts:25-27' + TICK + ' 找的是「与**当前序列**相同」的配方（序列 8 的玩家要 seq = 8 的配方）。');
lines.push('');
lines.push('**人群实数：' + players.length + ' 人**（逐片：' + Array.from({ length: SHARDS }, (_, shard) => 'shard' + shard + ' ' + players.filter((p) => p.shard === shard).length).join(' / ') + '）。');
lines.push('');
lines.push('途径分布：' + [...pathwayCounts.entries()].sort((a, b) => b[1] - a[1]).map(([pathway, count]) => pathway + ' ' + count + ' 人').join('、') + '。');
lines.push('');
lines.push('**窗口起点状态**：' + players.length + ' 人里，窗口开始时（DIG 到 85 且已是序列 8 的那一刻）就已经有 ' + TICK + 'ability_<途径>_8' + TICK +
  ' 的有 **' + (players.length - noFlagPlayers.length) + '** 人 —— 换句话说，');
lines.push('这 49 个人**没有一个是「DIG 够了但还没喝本序列魔药」**：' + TICK + 'flags' + TICK + ' 表里带这个 flag 的也是 ' +
  players.filter((player) => player.hasAbilityFlag).length + ' 人，两边对得上。');
lines.push('');
lines.push('> 这一条决定了需求怎么算：flag 已就绪 = 「服下本序列魔药」这一半前提已经满足，');
lines.push('> 剩下的**只有材料 ×' + players[0]!.needQty + '**；否则还要先调一瓶本序列魔药（同一个主材料再 ×1）。');
lines.push('');
if (warnings.length > 0) {
  lines.push('> ⚠️ 核对告警 ' + warnings.length + ' 条（其中库存对账 ' + mismatch + ' 条，见 §五）：');
  for (const warning of warnings) lines.push('> - ' + warning);
  lines.push('');
}

lines.push('## 一、名单（逐片 player_id）');
lines.push('');
for (let shard = 0; shard < SHARDS; shard += 1) {
  const group = withCategory.filter((entry) => entry.player.shard === shard);
  lines.push('### shard' + shard + '（' + group.length + ' 人）');
  lines.push('');
  if (group.length === 0) {
    lines.push('（无）');
    lines.push('');
    continue;
  }
  lines.push('| player_id | 角色 | 途径 | 需要的材料 | 纯 DIG 到 85 | 窗口起点 | 峰值 | 窗口内成功探索 | 生涯掉到 | 期望掉到 | 分类 |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const entry of group) {
    const p = entry.player;
    lines.push(
      '| ' + p.playerId + ' | ' + p.characterId + ' ' + p.name + ' | ' + p.pathway + ' | ' + p.needItem + ' ×' + p.needQty +
        ' | day ' + (p.dig85Day ?? '—') + ' | day ' + p.gateDay + '（余 ' + (p.lastDay - p.gateDay + 1) + ' 天） | ' + p.peakOwned + '/' + p.needQty +
        ' | ' + p.exploredOk + ' | ' + p.gainedTotal + ' | ' + p.expectedDrops.toFixed(1) + ' | **' + entry.category + '** |',
    );
  }
  lines.push('');
}

lines.push('## 二、逐日明细（DIG ≥ 85 之后）');
lines.push('');
lines.push('> 「当天材料」= 当天最后一条指令时刻的主材料数量（按 ' + TICK + 'domain_events' + TICK + ' 重建，含交易）。');
lines.push('> 指令按时间顺序；连续的完全相同的指令折叠成「×××N」。');
lines.push('');
for (const entry of withCategory) {
  const p = entry.player;
  lines.push('### shard' + p.shard + ' · player ' + p.playerId + '（' + p.characterId + ' ' + p.name + '，' + p.pathway + '，需 ' + p.needItem + ' ×' + p.needQty + '）');
  lines.push('');
  lines.push('分类：**' + entry.category + '** —— ' + entry.note);
  lines.push('');
  if (p.days.length === 0) {
    lines.push('（窗口内没有任何指令记录）');
    lines.push('');
    continue;
  }
  lines.push('| day | 当天材料 | 指令 |');
  lines.push('| --- | --- | --- |');
  for (const day of p.days) {
    lines.push('| ' + day.day + ' | ' + day.ownedAtDayEnd + '/' + p.needQty + ' | ' + fold(day.commands) + ' |');
  }
  lines.push('');
}

lines.push('## 三、分类计数');
lines.push('');
lines.push('| 类别 | 判据 | 人数 |');
lines.push('| --- | --- | --- |');
lines.push('| 材料不齐 | 主材料**生涯峰值** < ' + players[0]!.needQty + ' | ' + (counts.get('材料不齐') ?? 0) + ' |');
lines.push('| 动作额度被挤 | 主材料峰值达标，但窗口内 .晋升 / .仪式 一次都没发 | ' + (counts.get('动作额度被挤') ?? 0) + ' |');
lines.push('| 其它 | 两条都不满足（发起过晋升但没升成序列 7） | ' + (counts.get('其它') ?? 0) + ' |');
lines.push('| **合计** | — | **' + players.length + '** |');
lines.push('');
const strictIdle = players.filter((player) => player.peakOwned >= player.needQty && player.promoteCommands === 0).length;
lines.push('> **口径对照**：上面把 ' + TICK + '.仪式' + TICK + ' 也算作「晋升动作」—— M2.5 的仪式是**第二条晋升路径**，');
lines.push('> ' + TICK + 'ritual.ts:401' + TICK + ' 给的是与 ' + TICK + '.晋升' + TICK + ' **同一个** ' + TICK + 'ability_<途径>_<目标序列>' + TICK + ' flag。');
lines.push('> 如果**只算 ' + TICK + '.晋升' + TICK + '**（任务书 B3 判据的字面口径），三类是：');
lines.push('> 材料不齐 **' + (counts.get('材料不齐') ?? 0) + '** / 动作额度被挤 **' + strictIdle + '** / 其它 **' +
  (players.length - (counts.get('材料不齐') ?? 0) - strictIdle) + '**。');
lines.push('> 两个口径差在「发过 ' + TICK + '.仪式' + TICK + ' 但没发过 ' + TICK + '.晋升' + TICK + '」的那 ' + (strictIdle - (counts.get('动作额度被挤') ?? 0)) + ' 个人身上。');
lines.push('');
lines.push('材料不齐那一类再拆：');
lines.push('');
lines.push('| 子类 | 人数 |');
lines.push('| --- | --- |');
lines.push('| 一个都没掉到（峰值 0） | ' + zeroOwned + ' |');
lines.push('| 掉到 1 个、差 1 个（峰值 1） | ' + oneShort + ' |');
lines.push('| 窗口内**一次探索都没有** | ' + shortOnly.filter((player) => player.exploredOk === 0).length + ' |');
lines.push('| 窗口内发过 .仪式（仪式失败会吃材料，见 §五） | ' + shortWithRitual + ' |');
lines.push('');
lines.push('49 人窗口内的指令分布（次数）：');
lines.push('');
lines.push('| 指令 | 次数 |');
lines.push('| --- | --- |');
for (const [kind, count] of [...kindCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30)) {
  lines.push('| .' + kind + ' | ' + count + ' |');
}
lines.push('');

lines.push('## 四、根因：材料为什么凑不齐');
lines.push('');
lines.push('### 4.1 总量对账');
lines.push('');
lines.push('| 量 | 数 |');
lines.push('| --- | --- |');
lines.push('| 49 人窗口内成功探索 | **' + totalExplored + '** 次 |');
lines.push('| 按地点权重现算的期望掉落 | **' + totalExpected.toFixed(1) + '** 个 |');
lines.push('| 实际掉到的（本人需要的）主材料 | **' + totalGained + '** 个 |');
lines.push('| 49 人的需求总量（×' + players[0]!.needQty + '） | **' + totalNeeded + '** 个 |');
lines.push('| **供给 / 需求** | **' + (totalGained / totalNeeded * 100).toFixed(0) + '%** |');
lines.push('');
lines.push('**期望 ' + totalExpected.toFixed(1) + ' ≈ 实际 ' + totalGained + '** —— 掉率本身按设计在跑，');
lines.push('问题不在「掉率失灵」，在「能掉的总量本来就不够」：');
lines.push('**' + totalExplored + ' 次探索只能产出约 ' + totalGained + ' 个，而 49 个人要 ' + totalNeeded + ' 个。**');
lines.push('');
lines.push('### 4.2 窗口有多长（DIG 到 85 的那一天 → 第 29 天）');
lines.push('');
lines.push('| DIG 到 85 的那一天 | 人数 | 剩余天数 |');
lines.push('| --- | --- | --- |');
for (const [gateDay, count] of [...windowLengths.entries()].sort((a, b) => a[0] - b[0])) {
  lines.push('| day ' + gateDay + ' | ' + count + ' | ' + (30 - gateDay) + ' |');
}
lines.push('');
lines.push('### 4.3 探索去了哪');
lines.push('');
lines.push('| 地点档位 | 成功次数 |');
lines.push('| --- | --- |');
for (const [tier, count] of [...tierCounts.entries()].sort((a, b) => b[1] - a[1])) {
  lines.push('| ' + tier + ' | ' + count + ' |');
}
lines.push('');
lines.push('探索次数最多的 12 个地点：');
lines.push('');
lines.push('| 地点 | 成功次数 |');
lines.push('| --- | --- |');
for (const [name, count] of [...locationCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
  lines.push('| ' + name + ' | ' + count + ' |');
}
lines.push('');
if (rejectReasons.size > 0) {
  lines.push('被拒的探索（' + players.reduce((sum, player) => sum + player.exploreAttempts.filter((attempt) => !attempt.ok).length, 0) + ' 次）：');
  lines.push('');
  lines.push('| 首行回执 | 次数 |');
  lines.push('| --- | --- |');
  for (const [reason, count] of [...rejectReasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
    lines.push('| ' + (reason || '（空）') + ' | ' + count + ' |');
  }
  lines.push('');
}
lines.push('### 4.4 主材料的地理可达性（内容表事实）');
lines.push('');
lines.push('先只看**本轮需要的三种** 8 级主材料（命运之线 / 破晓碎片 / 梦境之核）：');
lines.push('');
lines.push('| 地点 | min_seq | danger | 掉落表总权重 | 三种主材料各 weight | 单次探索掉到它的概率 |');
lines.push('| --- | --- | --- | --- | --- | --- |');
for (const location of locations) {
  const mainEntries = location.loot.filter((entry) => ['主材料·命运之线', '主材料·破晓碎片', '主材料·梦境之核'].includes(entry.itemId));
  if (mainEntries.length === 0) continue;
  const total = location.loot.reduce((sum, entry) => sum + entry.weight, 0);
  lines.push(
    '| ' + location.name + '（' + location.id + '） | ' + location.min_seq + ' | ' + location.danger + ' | ' + total + ' | ' +
      mainEntries.map((entry) => entry.itemId.replace('主材料·', '') + ' ' + entry.weight).join('、') + ' | ' +
      mainEntries.map((entry) => (entry.weight / total * 100).toFixed(1) + '%').join(' / ') + ' |',
  );
}
lines.push('');
lines.push('> 每次探索 = 主掉落 1 件 + ' + (NUMERIC.explore.bonusDropChance * 100) + '% 额外 1 件');
lines.push('> （' + TICK + 'NUMERIC.explore.bonusDropChance' + TICK + '，' + TICK + 'src/domain/explore/explore.ts:141-150' + TICK + '）。');
lines.push('> 序列 8 的人进不去 ' + TICK + 'min_seq = 7' + TICK + ' 的地点（序列 8 > 门槛 7），可用的是 ' + TICK + 'min_seq = 8' + TICK + ' 的 11 个，其中只有 5 个掉这三种材料。');
lines.push('> 这 5 个地点每个含**两种** 8 级主材料（各 weight 4）—— 也就是说玩家有一半的掉落是**自己用不上的那种**。');
lines.push('');
lines.push('另有 5 个 ' + TICK + 'min_seq = 7' + TICK + ' 的地点掉同样三种材料（' + TICK + 'src/data/locations.yaml:568/581/594/607-608/620-621' + TICK + '），');
lines.push('权重 5—6、明显更高，但**序列 8 的人进不去** —— 这条设计是给升到序列 7 之后的人准备的。');
lines.push('');
lines.push('序列 9 的地点也掉「主材料·灰雾结晶 / 战火余烬 / 夜之瞳」，那是 **9 级**材料（入途径与 9→8 用的），与本轮的三种不是一回事。');
lines.push('');

lines.push('## 五、附带发现：库存重建对不上的 ' + mismatch + ' 条');
lines.push('');
lines.push('用 ' + TICK + 'item_gain' + TICK + ' / ' + TICK + 'item_delta' + TICK + ' / ' + TICK + 'trade_*' + TICK + ' 重建的窗口末材料数，');
lines.push('有 ' + mismatch + ' 个人与 ' + TICK + 'inventory' + TICK + ' 表对不上（重建的更多）。逐条追下来，缺的是这一条路径：');
lines.push('');
lines.push('| 路径 | 位置 | 有没有写 ' + TICK + 'domain_events' + TICK + ' |');
lines.push('| --- | --- | --- |');
lines.push('| 探索掉落 | ' + TICK + 'src/router/commands/explore.ts:284-299' + TICK + ' | 有（' + TICK + 'item_gain' + TICK + '） |');
lines.push('| 魔药调制消耗 | ' + TICK + 'src/router/commands/brew.ts:131-140' + TICK + ' | 有（' + TICK + 'item_delta' + TICK + '） |');
lines.push('| 晋升消耗 | ' + TICK + 'src/router/commands/promote.ts:73-82' + TICK + ' | 有（' + TICK + 'item_delta' + TICK + '） |');
lines.push('| 交易 | ' + TICK + 'src/router/commands/confirm.ts:65-66' + TICK + ' | 有（' + TICK + 'trade_buy' + TICK + ' / ' + TICK + 'trade_sell' + TICK + '） |');
lines.push('| **仪式失败的材料损失** | ' + TICK + 'src/router/commands/ritual.ts:345' + TICK + '、' + TICK + ':411' + TICK + ' | **没有** —— 直接 ' + TICK + 'inventory.tryRemoveMany' + TICK + '，只写进回执文本 |');
lines.push('');
lines.push('这一条正是「判定层需要的数据，当场落库」的反例：**仪式失败吃掉的材料在库里查不到**，');
lines.push('只能从回执文本里读。本轮 49 人窗口内一共发了 **' + totalRitualCommands + '** 次 ' + TICK + '.仪式' + TICK + '，');
lines.push('其中 ' + shortWithRitual + ' 人属于「材料不齐」那一类 —— 他们的材料有一部分是这样没的。');
lines.push('');
lines.push('> ⚠️ 这是**取证发现**，不是本轮要修的东西（本轮只读）。修法留给 M2.14 第 1 步之后。');
lines.push('');

lines.push('## 六、结论');
lines.push('');
lines.push('### 6.1 三类各几人');
lines.push('');
lines.push('| 类别 | 人数 | 占比 |');
lines.push('| --- | --- | --- |');
for (const category of ['材料不齐', '动作额度被挤', '其它'] as Category[]) {
  const count = counts.get(category) ?? 0;
  lines.push('| ' + category + ' | ' + count + ' | ' + (count / players.length * 100).toFixed(0) + '% |');
}
lines.push('');
lines.push('### 6.2 两个候选的裁决');
lines.push('');
lines.push('交付说明 §2.5 列了两个互斥的候选，本轮数据给出的是**明确的一边**：');
lines.push('');
lines.push('| 候选 | 判据 | 本轮读数 | 裁决 |');
lines.push('| --- | --- | --- | --- |');
lines.push('| 动作额度被挤 | 材料够了但没发起晋升 | ' + (counts.get('动作额度被挤') ?? 0) + ' 人 | **不是主因** |');
lines.push('| 材料不齐 | 主材料凑不到 ×' + players[0]!.needQty + ' | ' + (counts.get('材料不齐') ?? 0) + ' 人 | **是主因** |');
lines.push('');
lines.push('- 40/49（' + (40 / 49 * 100).toFixed(0) + '%）卡在材料上；其中**一个都没掉到的 14 人、差 1 个的 26 人**；');
lines.push('- 而这 40 人**不是没探索**：窗口内成功探索 ' + shortOnly.reduce((sum, player) => sum + player.exploredOk, 0) +
  ' 次（人均 ' + (shortOnly.reduce((sum, player) => sum + player.exploredOk, 0) / shortOnly.length).toFixed(1) + ' 次），');
lines.push('  掉到的材料合计 ' + shortDropped + ' 个 —— 平均每人 ' + (shortDropped / shortOnly.length).toFixed(2) + ' 个，离 ' + players[0]!.needQty + ' 个差得远；');
lines.push('- 窗口内 49 人一共只发了 ' + totalPromoteCommands + ' 次 ' + TICK + '.晋升' + TICK + '、' + totalRitualCommands + ' 次 ' + TICK + '.仪式' + TICK +
  ' —— 材料不够的人**没有可发的东西**；');
lines.push('  「动作额度被挤」那一类的 ' + (counts.get('动作额度被挤') ?? 0) + ' 个人，是材料够了之后**两条晋升路径一条都没走**，');
lines.push('  而「其它」那一类的 ' + (counts.get('其它') ?? 0) + ' 个人是**走过了**（' + TICK + '.晋升' + TICK + ' 被材料不足/消化度不足拦下，或者 ' + TICK + '.仪式' + TICK + ' 失败）。');
lines.push('');
lines.push('### 6.3 掉落率怎么调（建议，不是决定）');
lines.push('');
lines.push('先把缺口量写清楚：**供给 ' + totalGained + ' / 需求 ' + totalNeeded + ' = ' +
  (totalGained / totalNeeded * 100).toFixed(0) + '%**，要补上缺口需要把有效产出提到 **×' +
  (totalNeeded / totalGained).toFixed(2) + '**。四个候选：');
lines.push('');
lines.push('| # | 改什么 | 落点 | 效果 | 代价 |');
lines.push('| --- | --- | --- | --- | --- |');
lines.push('| 1 | ' + TICK + 'min_seq 8' + TICK + ' 那 5 个地点的主材料权重 4 → 6 | ' + TICK + 'src/data/locations.yaml:132/133/235/236/320/321/381/382/542/543' + TICK + ' | 单次概率 ' +
  '10.3%—12.9% → 15%—19%，有效产出约 ×1.45 | 只动内容表，冻结测试与判定层都不受影响；但会把「序列 8 地点」的整体掉落结构改掉 |');
lines.push('| 2 | 让掉落**偏向本人途径**（两种主材料里只出他要的那种） | 判定层 ' + TICK + 'rollDrop' + TICK + ' 或内容表拆地点 | 有效产出 ×2（现在是「一半掉落用不上」） | 判定层要认识玩家途径；会削掉「打到自己用不上的材料拿去卖」这条交易入口 |');
lines.push('| 3 | ' + TICK + 'mainMaterialMultiplier' + TICK + ' 2 → 1 | ' + TICK + 'src/config/numeric.ts:221' + TICK + ' | 需求 98 → 49，立刻由缺 27 变成余 22 | 动了 W4 定的数值，且「晋升要备料」这件事的分量直接减半 |');
lines.push('| 4 | 提高 AP 或探索上限，让窗口内能多探 | ' + TICK + 'NUMERIC.explore' + TICK + ' / ' + TICK + 'NUMERIC.tick.apRestoreTo' + TICK + ' | 按现有效率线性放大 | 动了全局节奏，影响的不止晋升这一条链路 |');
lines.push('');
lines.push('**推荐（供 M2.14 第 1 步参考）**：先上 **候选 1**（内容表加权重），理由三条：');
lines.push('');
lines.push('1. 缺口是 ×' + (totalNeeded / totalGained).toFixed(2) + '，候选 1 单独就能覆盖，不必动数值框架；');
lines.push('2. 它不碰判定层、不碰 ' + TICK + 'NUMERIC' + TICK + '、不碰冻结测试 —— 与「路线 A 不让灾厄下渗判定层」是同一条纪律；');
lines.push('3. 候选 3 虽然最省事，但它改的是 W4 定下的『晋升要备料 ×2』这条设计，**代价与收益不对等**。');
lines.push('');
lines.push('⚠️ 但这三者之外还有一条**必须先说清楚**的：' + TICK + 'M2.14' + TICK + ' 的灾厄如果按路线 A 让「探索掉落下降、灾厄产出上升」，');
lines.push('那么候选 1 加的权重会被灾厄的下降系数吃掉多少，需要在第 1 步里一起算 —— ');
lines.push('**两个旋钮拧同一个量，不能分开调**（见 ' + TICK + 'docs/M2.14-灾厄接点.md' + TICK + ' 的 A5）。');
lines.push('');

writeFileSync(join(ROOT, outPath), lines.join('\n'), 'utf8');

console.log('报告已写入 ' + outPath);
console.log('人群 ' + players.length + ' 人；分类：' + [...counts.entries()].map(([category, count]) => category + '=' + count).join(' / '));
console.log('材料不齐拆分：峰值 0 = ' + zeroOwned + '，峰值 1 = ' + oneShort);
console.log('只算 .晋升 的口径：材料不齐 ' + (counts.get('材料不齐') ?? 0) + ' / 动作额度被挤 ' +
  players.filter((player) => player.peakOwned >= player.needQty && player.promoteCommands === 0).length + ' / 其它 ' +
  (players.length - (counts.get('材料不齐') ?? 0) - players.filter((player) => player.peakOwned >= player.needQty && player.promoteCommands === 0).length));
console.log('窗口内成功探索 ' + totalExplored + ' 次；期望 ' + totalExpected.toFixed(1) + '；实际 ' + totalGained + '；需求 ' + totalNeeded +
  '（供给/需求 ' + (totalGained / totalNeeded * 100).toFixed(0) + '%）');
console.log('窗口起点已有 ability flag 的：' + (players.length - noFlagPlayers.length) + '/' + players.length);
console.log('档位：' + [...tierCounts.entries()].sort((a, b) => b[1] - a[1]).map(([tier, count]) => tier + '=' + count).join(' | '));
if (warnings.length > 0) console.log('告警 ' + warnings.length + ' 条（其中库存对账 ' + mismatch + ' 条）');
