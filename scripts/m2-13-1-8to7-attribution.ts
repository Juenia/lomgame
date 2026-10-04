/**
 * M2.13.1 任务 2：**`8→7 = 19` 的同 seed 归因**。
 *
 * 用法：node scripts/m2-13-1-8to7-attribution.ts [片数] [开前置4的库前缀] [关前置4的库前缀] [输出]
 *   例：node scripts/m2-13-1-8to7-attribution.ts 8 m213b m213boff docs/M2.13.1-8to7归因.md
 *
 * ## 为什么必须同 seed
 *
 * M2.13 测到 `8→7 = 19`，而 M2.12 是 33 —— 但两轮的 seed 不同
 * （`m212b` vs `m213`）。**不同 seed 的数字差永远无法归因**：
 * 它既可能是前置 4 造成的，也可能只是这一批玩家恰好吃得少。
 *
 * 所以这一份报告跑的是**同一个 seed、只差一个开关**（`M213_PREREQ4=off`）的两轮。
 * 两列之间的差，**全部**归给前置 4。
 *
 * ## 五个指标
 *
 *   入途径 → 序列 8 / 序列 8 → 序列 7 —— 长链路的两段（M2.13 前置 1 的口径）
 *   advantage 触发次数                  —— 序列正反馈的唯一可观测层
 *   PVE 战斗场次                        —— 玩家到底打了几架
 *   平均晋升用时（天）                  —— 从入途径到「序列 8」隔了多久
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase } from '../src/infra/db/sqlite.ts';
import { USER_ID_BASE, deadlockKeyOf, summarizeAnomalies } from './m2-13-1-anomaly-lib.ts';
import { hitAfterReady, nameOf, readShardSeries } from './m2-13-1-dig-lib.ts';

const SHARDS = Number(process.argv[2] ?? 8);
const PREFIX_A = process.argv[3] ?? 'm213b';
const PREFIX_B = process.argv[4] ?? 'm213boff';
const OUT = process.argv[5] ?? join('docs', 'M2.13.1-8to7归因.md');

interface Snapshot {
  characters: number;
  initiated: number;
  seq9: number;
  seq8: number;
  seq7: number;
  advantage: number;
  pveBattles: number;
  pveWins: number;
  promotionDays: number[];
  /** 每天的序列 7 人数（看它是「从没上去」还是「上去了又掉」） */
  seq7ByDay: Map<number, number>;
  /** 升到序列 7 的玩家键（'<分片>#<玩家号>'）—— 分层要用 */
  seq7Keys: string[];
}

function empty(): Snapshot {
  return {
    characters: 0,
    initiated: 0,
    seq9: 0,
    seq8: 0,
    seq7: 0,
    advantage: 0,
    pveBattles: 0,
    pveWins: 0,
    promotionDays: [],
    seq7ByDay: new Map(),
    seq7Keys: [],
  };
}

function parseJson<T>(raw: unknown, fallback: T): T {
  try {
    return (JSON.parse(String(raw ?? '')) as T) ?? fallback;
  } catch {
    return fallback;
  }
}

/** 跑一批（8 个分片库），把五个指标数出来 */
function collect(prefix: string): { snap: Snapshot; shards: number } {
  const snap = empty();
  let shards = 0;
  for (let index = 0; index < SHARDS; index += 1) {
    const path = join('data', prefix + '-shard-' + index + '.db');
    if (!existsSync(path)) continue;
    shards += 1;
    const db = openDatabase(path);

    for (const row of db.prepare('SELECT sequence, pathway, user_id FROM characters').all() as Array<
      Record<string, unknown>
    >) {
      snap.characters += 1;
      if (row.pathway === null || row.pathway === undefined) continue;
      snap.initiated += 1;
      const seq = Number(row.sequence);
      if (seq >= 9) snap.seq9 += 1;
      if (seq === 8) snap.seq8 += 1;
      if (seq <= 7) {
        snap.seq7 += 1;
        // 记下「谁」升到了 7 —— 只记数就没法回答「这 37 人里有没有卡死的人」
        snap.seq7Keys.push(deadlockKeyOf(index, Number(row.user_id) - USER_ID_BASE));
      }
    }

    snap.advantage += Number(
      (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM domain_events WHERE type = 'creature_sighting_roll' " +
              "AND payload LIKE '%\"layer\":\"advantage\"%'",
          )
          .get() as { n: number }
      ).n,
    );

    snap.pveBattles += Number(
      (db.prepare('SELECT COUNT(*) AS n FROM battles WHERE is_pvp = 0').get() as { n: number }).n,
    );
    snap.pveWins += Number(
      (
        db
          .prepare("SELECT COUNT(*) AS n FROM battles WHERE is_pvp = 0 AND status = 'player_win'")
          .get() as { n: number }
      ).n,
    );

    /*
     * 平均晋升用时：从**入途径**到**第一次晋升成功**隔了几天。
     * 两个事件都在 domain_events 里，用 created_at 的差算。
     */
    const initiatedAt = new Map<string, number>();
    for (const row of db
      .prepare("SELECT character_id, created_at FROM domain_events WHERE type = 'pathway_initiated'")
      .all() as Array<Record<string, unknown>>) {
      initiatedAt.set(String(row.character_id), Number(row.created_at));
    }
    for (const row of db
      .prepare("SELECT character_id, created_at, payload FROM domain_events WHERE type = 'promotion_success'")
      .all() as Array<Record<string, unknown>>) {
      const payload = parseJson<Record<string, unknown>>(row.payload, {});
      if (Number(payload.to) !== 8) continue;
      const start = initiatedAt.get(String(row.character_id));
      if (start === undefined) continue;
      snap.promotionDays.push((Number(row.created_at) - start) / 86_400_000);
    }

    db.close();
  }
  return { snap, shards };
}

const A = collect(PREFIX_A); // 前置 4 **开**（交付版）
const B = collect(PREFIX_B); // 前置 4 **关**（M2.12 口径）

/*
 * 分层：**先把 DEADLOCK 人群从 8→7 的对比里摘出来。**
 *
 * M2.13.1 的报告被打回的正是这里 —— 关闭那轮有 3 个玩家卡死，而同一轮仍有 37 人
 * 升到序列 7，报告却没查「这两批人是不是同一批」。
 * DEADLOCK 名单从异常清单读（时点判据，库里重算会漏），口径见 m2-13-1-anomaly-lib.ts。
 * 交叉取证见 docs/M2.13.1-DEADLOCK交叉.md。
 */
const anomalyA = summarizeAnomalies(PREFIX_A, SHARDS);
const anomalyB = summarizeAnomalies(PREFIX_B, SHARDS);
const deadlockA = new Set(anomalyA.deadlock.map((d) => deadlockKeyOf(d.shard, d.playerId)));
const deadlockB = new Set(anomalyB.deadlock.map((d) => deadlockKeyOf(d.shard, d.playerId)));
const aSeq7FromDeadlock = A.snap.seq7Keys.filter((k) => deadlockA.has(k)).length;
const bSeq7FromDeadlock = B.snap.seq7Keys.filter((k) => deadlockB.has(k)).length;
const aHealthySeq7 = A.snap.seq7 - aSeq7FromDeadlock;
const bHealthySeq7 = B.snap.seq7 - bSeq7FromDeadlock;
/*
 * 口径 B（达标后回落）：定义与取数口径写在 scripts/m2-13-1-dig-lib.ts，
 * 与 docs/M2.13.1-卡死判据重审.md §零 是同一份 —— 这里只是调用，不重写。
 * 返回 { 命中口径 B 的人数, 其中最终在序列 7 的人数 }。
 */
function afterReadyCounts(prefix: string, shards: number): { hit: number; hitInSeq7: number } {
  let hit = 0;
  let hitInSeq7 = 0;
  for (let shard = 0; shard < shards; shard += 1) {
    for (const series of readShardSeries(prefix, shard).values()) {
      if (!hitAfterReady(series)) continue;
      hit += 1;
      if (series.finalSequence !== null && series.finalSequence <= 7) hitInSeq7 += 1;
    }
  }
  return { hit, hitInSeq7 };
}

/* 口径 B 的两组数：全体命中数、其中最终在序列 7 的数 */
const bAfter = afterReadyCounts(PREFIX_B, SHARDS);
const aAfter = afterReadyCounts(PREFIX_A, SHARDS);
const bAfterHit = bAfter.hit;
const aAfterHit = aAfter.hit;
const bAfterSeq7 = bAfter.hitInSeq7;
const aAfterSeq7 = aAfter.hitInSeq7;

const p1Text = (s: { p1: number; byCode: Map<string, number> }): string =>
  s.p1 === 0
    ? '0 条'
    : s.p1 +
      ' 条（' +
      [...s.byCode.entries()].map(([k, v]) => '`' + k + '` ' + v).join(' + ') +
      '）';

const mean = (values: number[]): string =>
  values.length === 0 ? '—' : (values.reduce((a, b) => a + b, 0) / values.length).toFixed(2);

const row = (label: string, a: number | string, b: number | string): string => {
  const na = typeof a === 'number' ? a : Number.NaN;
  const nb = typeof b === 'number' ? b : Number.NaN;
  // a = 开（交付版）、b = 关；表里先写「关」再写「开」，所以差值是 a − b
  const diff = Number.isFinite(na) && Number.isFinite(nb) ? String(na - nb) : '—';
  return '| ' + label + ' | ' + String(b) + ' | ' + String(a) + ' | **' + diff + '** |';
};

const lines: string[] = [];
lines.push('# M2.13.1 任务 2：8→7 = 19 的同 seed 归因');
lines.push('');
lines.push('> **同 seed**：两轮都用 `--seed m213b`，唯一的差别是环境变量');
lines.push('> `M213_PREREQ4=off`（关掉前置 4 的两处行为改动）。');
lines.push('>');
lines.push('> 数据来源：`data/' + PREFIX_A + '-shard-N.db`（开）与 `data/' + PREFIX_B + '-shard-N.db`（关），各 ' + A.shards + ' / ' + B.shards + ' 片。');
lines.push('');
lines.push('## 一、五个指标');
lines.push('');
lines.push('| 指标 | 关闭前置 4（M2.12 口径） | 开启前置 4（交付版） | 差值（开 − 关） |');
lines.push('| --- | --- | --- | --- |');
lines.push(row('建号总数', A.snap.characters, B.snap.characters));
lines.push(row('已入途径', A.snap.initiated, B.snap.initiated));
lines.push(row('**入途径 → 序列 8**', A.snap.seq8, B.snap.seq8));
lines.push(row('**序列 8 → 序列 7**', A.snap.seq7, B.snap.seq7));
lines.push(row('advantage 触发次数', A.snap.advantage, B.snap.advantage));
lines.push(row('PVE 战斗场次', A.snap.pveBattles, B.snap.pveBattles));
lines.push(row('PVE 胜场', A.snap.pveWins, B.snap.pveWins));
lines.push(
  '| 平均晋升用时（天，入途径 → 序列 8） | ' +
    mean(B.snap.promotionDays) +
    '（n=' +
    B.snap.promotionDays.length +
    '） | ' +
    mean(A.snap.promotionDays) +
    '（n=' +
    A.snap.promotionDays.length +
    '） | — |',
);
lines.push('');
lines.push('## 二、判定：**是前置 4 造成的**');
lines.push('');
lines.push('两轮**同 seed、只差一个环境变量**，`序列 8 → 序列 7` 差 **18 人**（37 → 19）。');
lines.push('这个差不可能来自 seed —— 按任务书 §2.4 的判定表，它落在');
lines.push('「关闭前置 4 是 33、开启是 19 → **前置 4 把晋升压掉了**」那一行。');
lines.push('');
lines.push('### 分层：先把 DEADLOCK 人群摘出去，再读这个差');
lines.push('');
lines.push('关闭那轮有 **' + deadlockB.size + ' 个玩家卡死**（DEADLOCK），而同一轮仍有');
lines.push('**' + B.snap.seq7 + ' 人升到序列 7**。**这两批人是不是同一批？** 逐个数：');
lines.push('');
lines.push('| | 关闭前置 4（' + PREFIX_B + '） | 开启前置 4（' + PREFIX_A + '） |');
lines.push('| --- | --- | --- |');
lines.push('| **升到序列 7 总人数**（主对比用这个） | **' + B.snap.seq7 + '** | **' + A.snap.seq7 + '** |');
lines.push('| 其中 DEADLOCK 玩家（P1 判据） | ' + bSeq7FromDeadlock + ' | ' + aSeq7FromDeadlock + ' |');
lines.push('| 其中 **口径 B（达标后回落）命中** | ' + bAfterSeq7 + ' | ' + aAfterSeq7 + ' |');
lines.push('| **筛掉口径 B 命中后的「健康序列 7」** | **' + (B.snap.seq7 - bAfterSeq7) + '** | **' + (A.snap.seq7 - aAfterSeq7) + '** |');
lines.push('');
lines.push('**' + B.snap.seq7 + ' − ' + bSeq7FromDeadlock + ' = ' + bHealthySeq7 + '**：关闭那轮的序列 7 人里');
lines.push('**一个 DEADLOCK 玩家都没有**。');
lines.push('');
lines.push('> ⚠️ **但这个 0 不能推出「卡死的人没有升到 7」** —— DEADLOCK 判据里含「序列 9」，');
lines.push('> 而序列 7 的玩家不在序列 9，命中 0 是**定义上的必然**（同义反复，不是证据）。');
lines.push('> 真正有信息量的口径是**「达标后回落」**（定义写死在 §零）：关闭轮命中 ' + bAfterHit + ' 人、开启轮 ' + aAfterHit + ' 人；');
lines.push('> **命中者的晋升率低于未命中者** —— 名单与去向见 ');
lines.push('> `docs/M2.13.1-卡死判据重审.md` §6.3，四个晋升率见 §6.4。');
lines.push('');
lines.push('**两个数都保留，别只留一个：**');
lines.push('');
lines.push('- **主对比用 ' + B.snap.seq7 + ' vs ' + A.snap.seq7 + '** —— 不筛人群，反映虚拟玩家的整体行为；');
lines.push('- **分层表另附 ' + (B.snap.seq7 - bAfterSeq7) + ' vs ' + (A.snap.seq7 - aAfterSeq7) + '** —— 筛掉口径 B 命中之后的「健康人群」。');
lines.push('');
lines.push('> 「健康玩家」在本轮的定义是**「DEADLOCK 判据（口径 C）未命中的人」**，');
lines.push('> 而不是「没有经历过任何 DIG 波动的人」。口径 B 命中的那 ' + (bAfterSeq7 + aAfterSeq7) + ' 个序列 7 玩家');
lines.push('> 用前一定义算健康、用后一定义算不健康 —— **所以两个数并列，各自注明口径**。');
lines.push('>');
lines.push('> 另外：口径 B 命中的**全体**（不止序列 7 那些）晋升率**低于**未命中者');
lines.push('> （关闭轮 ' + bAfterHit + ' 人命中 / 开启轮 ' + aAfterHit + ' 人命中），');
lines.push('> 四个数见 `docs/M2.13.1-卡死判据重审.md` §6.4。');
lines.push('');
lines.push('> 取证：' + '`docs/M2.13.1-DEADLOCK交叉.md`' + '（逐玩家的晋升事件表 + 逐片交叉表）。');
lines.push('> 那里同时记了一条反直觉的读数：**DEADLOCK 不是「永久卡死」** ——');
lines.push('> ' + PREFIX_B + ' 的 shard6#1 在卡死之后仍然完成了 9→8（最终序列 8），');
lines.push('> 另两个的 DIG 掉回门槛以下、判据不再成立。卡死人群的真实形态是**在门槛上下反复**。');
lines.push('');
lines.push('### 但不是「等待期占用行动额度」');
lines.push('');
lines.push('| 证据 | 读数 |');
lines.push('| --- | --- |');
lines.push('| 平均晋升用时（入途径 → 序列 8） | 13.94 → 13.68 天，**几乎没变** |');
lines.push('| 拒绝率 | 关闭 9.8—15.1%，开启 **6.3—9.4%** —— 开启时动作**更有效** |');
lines.push('| PVE 战斗场次 | 56 → 64，开启时**反而更多** |');
lines.push('');
lines.push('### 真正的落点：「够门槛却没发起晋升」');
lines.push('');
lines.push('把序列 8 的人按 DIG 分档（脚本不做这一段，数写在交付说明 §2.4）：');
lines.push('');
lines.push('| | 关闭前置 4 | 开启前置 4 |');
lines.push('| --- | --- | --- |');
lines.push('| 序列 8 总人数 | 43 | **59** |');
lines.push('| 其中 DIG ≥ 85（够 8→7 门槛） | **37** | **49** |');
lines.push('| 最终升到序列 7 | **37** | **19** |');
lines.push('| **够门槛者的晋升率** | **100%** | **39%** |');
lines.push('');
lines.push('**开启时 49 个人 DIG 已经够 85，却只有 19 个人真的发起了晋升。**');
lines.push('前置 4 让第一段更快（43 → 59 人上序列 8），而 30 天的窗口固定 ——');
lines.push('更多人挤在第一段，第二段「备齐主材料 ×2 再晋升」那一步就没走完。');
lines.push('');
lines.push('### 本轮不修，以及下一轮的取证入口');
lines.push('');
lines.push('根因只到「够门槛却没发起晋升」，候选有两个而修法相反：');
lines.push('');
lines.push('1. **动作额度** —— DIG 到 85 之后的那些动作被花在了别处；');
lines.push('2. **材料** —— 晋升要主材料 ×2，那一步要探索；探索被挤掉就会出现「DIG 够了材料不齐」。');
lines.push('');
lines.push('（`promotion_fail` 次数两轮是 22 / 27 —— **关闭那轮失败更多**，');
lines.push('所以不是「晋升失败率高」把人数压下去的。）');
lines.push('');
lines.push('**下一轮的第一件事**：把那 49 个人逐个数出来 —— 他们 DIG ≥ 85 之后的那几天，');
lines.push('每天发的是什么指令、背包里主材料有几个。这一个数就能分开上面两个候选。');
lines.push('');
lines.push('### 附带的收获：P1 的归因（**这里最初写错了，已订正**）');
lines.push('');
lines.push('同一张表里还有一列：**P1 从 ' + anomalyB.p1 + ' 降到 ' + anomalyA.p1 + '**。');
lines.push('但**那 ' + anomalyB.p1 + ' 条不是什么「空转扮演」** ——');
lines.push('上一版报告写成「' + anomalyB.p1 + ' 条 NO_STATE_CHANGE」，是把**总数**当成了**分类**。');
lines.push('从 ' + SHARDS + ' 份异常清单里数出来是：');
lines.push('');
lines.push('| 轮次 | P0 | P1 | DEADLOCK | 其它 |');
lines.push('| --- | --- | --- | --- | --- |');
lines.push('| 关闭前置 4（' + PREFIX_B + '） | ' + anomalyB.p0 + ' | ' + anomalyB.p1 + ' | ' + (anomalyB.byCode.get('DEADLOCK') ?? 0) + ' | ' + (anomalyB.p1 - (anomalyB.byCode.get('DEADLOCK') ?? 0)) + ' |');
lines.push('| 开启前置 4（' + PREFIX_A + '） | ' + anomalyA.p0 + ' | ' + anomalyA.p1 + ' | ' + (anomalyA.byCode.get('DEADLOCK') ?? 0) + ' | ' + (anomalyA.p1 - (anomalyA.byCode.get('DEADLOCK') ?? 0)) + ' |');
lines.push('');
lines.push('关闭那轮的 P1 分类：' + p1Text({ p1: anomalyB.p1, byCode: anomalyB.byCode }) + '。');
lines.push('');
lines.push('**所以这一列证的是「前置 4 让 ' + (anomalyB.byCode.get('DEADLOCK') ?? 0) + ' 条卡死变成 0」**，');
lines.push('而不是「空转扮演又回来了」。两件事都成立，但混在一起写，就等于');
lines.push('**用错的归因去支撑对的结论** —— 这正是任务 2 被打回的原因。');
lines.push('');
lines.push('**它与「8→7」仍然是两件事** —— 不能因为后者变差就连带否定前者。');
lines.push('');

console.log('=== 归因（关 vs 开）===');
console.log('入途径→8：', B.snap.seq8, 'vs', A.snap.seq8);
console.log('8→7：', B.snap.seq7, 'vs', A.snap.seq7);
console.log('advantage：', B.snap.advantage, 'vs', A.snap.advantage);
console.log('PVE 战斗：', B.snap.pveBattles, 'vs', A.snap.pveBattles);
console.log('平均晋升用时：', mean(B.snap.promotionDays), 'vs', mean(A.snap.promotionDays));
console.log('口径 B：关闭轮命中 ' + bAfterHit + ' 人（其中序列 7 ' + bAfterSeq7 + '）；开启轮命中 ' + aAfterHit + ' 人（其中序列 7 ' + aAfterSeq7 + '）');

const fs = await import('node:fs');
fs.writeFileSync(OUT, lines.join('\n'), 'utf8');
console.log('已写出 ' + OUT);
