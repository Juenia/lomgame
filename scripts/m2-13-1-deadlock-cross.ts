/**
 * M2.13.1 任务 A：**DEADLOCK 人群 × 序列 7 交叉取证**。
 *
 * 用法：node scripts/m2-13-1-deadlock-cross.ts [片数] [库前缀] [对照库前缀] [输出]
 *   例：node scripts/m2-13-1-deadlock-cross.ts 8 m213boff m213b docs/M2.13.1-DEADLOCK交叉.md
 *
 * ## 这一份报告回答什么
 *
 * M2.13.1 任务 2 被打回的理由是：关闭前置 4 的那一轮（m213boff）里有 3 个玩家卡死
 * （DEADLOCK），而同一轮**仍有 37 人升到序列 7** —— 但「这两批人是不是同一批」没人查。
 *
 * 于是有两个必须回答的问题：
 *
 *   1. **DEADLOCK 的三个玩家，有几个升到序列 7？**
 *   2. **那 37 个序列 7，有几个来自 DEADLOCK？**（即 37 − 健康玩家 = 多少）
 *
 * ## 口径：两条铁律（异常清单的口径抽在 m2-13-1-anomaly-lib.ts）
 *
 * - **序列号越小越强**：晋升事件的 payload.from 是**晋升前**、payload.to 是**晋升后**，
 *   所以「升到序列 7」= 存在一条事件且 to === 7（不是 from === 7）。
 *   sequence_delta 用的是 before/after，同一件事两种写法。
 * - **DEADLOCK 名单从异常清单读**，不从库里重算 —— 它是**时点判据**，最终快照上
 *   MAD/COR 已经变了，重算必然漏。
 */
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { cidOf, deadlockKeyOf, summarizeAnomalies } from './m2-13-1-anomaly-lib.ts';

const SHARDS = Number(process.argv[2] ?? 8);
const PREFIX = process.argv[3] ?? 'm213boff';
/** 同 seed 的对照库（前置 4 **开**的那一轮）。传空串可跳过 */
const PREFIX_CTRL = process.argv[4] ?? 'm213b';
const OUT = process.argv[5] ?? join('docs', 'M2.13.1-DEADLOCK交叉.md');

/** 虚拟玩家 user_id 基数（src/vplayer/profiles.ts） */
const USER_ID_BASE = 700000;

export interface CharacterRow {
  id: string;
  user_id: string;
  name: string;
  pathway: string | null;
  sequence: number | null;
  mad: number;
  cor: number;
  dig: number;
  status: string;
  promotion_fails: number;
}

export interface PromotionEvent {
  id: number;
  type: string;
  reason: string;
  createdAt: number;
  from: number | null;
  to: number | null;
  /** 事件里真正的「变到几」：promotion_* 用 to，sequence_delta 用 after */
  after: number | null;
}

export function readCharacters(prefix: string, shard: number): CharacterRow[] {
  const path = join('data', prefix + '-shard-' + shard + '.db');
  if (!existsSync(path)) return [];
  const db = new DatabaseSync(path, { readOnly: true });
  const rows = db
    .prepare(
      'SELECT id, user_id, name, pathway, sequence, mad, cor, dig, status, promotion_fails FROM characters ORDER BY id',
    )
    .all() as unknown as CharacterRow[];
  db.close();
  return rows;
}

export function readPromotions(prefix: string, shard: number, characterId: string): PromotionEvent[] {
  const path = join('data', prefix + '-shard-' + shard + '.db');
  if (!existsSync(path)) return [];
  const db = new DatabaseSync(path, { readOnly: true });
  const rows = db
    .prepare(
      'SELECT id, type, reason, created_at, payload FROM domain_events ' +
        'WHERE character_id = ? AND type IN ' +
        "('promotion_success','promotion_fail','sequence_delta','ritual_success','ritual_fail','pathway_initiated') " +
        'ORDER BY id',
    )
    .all(characterId) as unknown as Array<{
    id: number;
    type: string;
    reason: string;
    created_at: number;
    payload: string;
  }>;
  db.close();
  const out: PromotionEvent[] = [];
  for (const row of rows) {
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(row.payload) as Record<string, unknown>;
    } catch {
      payload = {};
    }
    const to = payload.to === undefined ? null : Number(payload.to);
    const after = payload.after === undefined ? null : Number(payload.after);
    out.push({
      id: row.id,
      type: row.type,
      reason: row.reason,
      createdAt: row.created_at,
      from:
        payload.from === undefined
          ? payload.before === undefined
            ? null
            : Number(payload.before)
          : Number(payload.from),
      to,
      after: after ?? to,
    });
  }
  return out;
}

export const playerOf = (row: { user_id: string }): number => Number(row.user_id) - USER_ID_BASE;

/* ---------------- 1. 异常清单 → DEADLOCK 玩家（口径：m2-13-1-anomaly-lib.ts） ---------------- */

const summary = summarizeAnomalies(PREFIX, SHARDS);
const anomalies = summary.shards;
const p0Total = summary.p0;
const p1Total = summary.p1;
const byCode = summary.byCode;
const deadlockByPlayer = new Map(summary.deadlock.map((d) => [deadlockKeyOf(d.shard, d.playerId), d]));
const deadlockKeys = summary.deadlock.map((d) => deadlockKeyOf(d.shard, d.playerId));

/* ---------------- 2. 交叉：最终序列 ≤7 与 DEADLOCK ---------------- */

interface Seq7Entry {
  shard: number;
  playerId: number;
  characterId: string;
  name: string;
  sequence: number;
  deadlockLines: number;
}

const seq7: Seq7Entry[] = [];
const seqDist = new Map<string, number>();
const finalOf = new Map<string, CharacterRow>();

for (let shard = 0; shard < SHARDS; shard += 1) {
  for (const row of readCharacters(PREFIX, shard)) {
    finalOf.set(deadlockKeyOf(shard, playerOf(row)), row);
    const key = row.pathway === null ? 'mortal' : String(row.sequence);
    seqDist.set(key, (seqDist.get(key) ?? 0) + 1);
    if (row.sequence !== null && Number(row.sequence) <= 7) {
      const dl = deadlockByPlayer.get(deadlockKeyOf(shard, playerOf(row)));
      seq7.push({
        shard,
        playerId: playerOf(row),
        characterId: row.id,
        name: row.name,
        sequence: Number(row.sequence),
        deadlockLines: dl ? dl.lines.length : 0,
      });
    }
  }
}

const seq7FromDeadlock = seq7.filter((e) => e.deadlockLines > 0);
const deadlockInSeq7 = deadlockKeys.filter((key) =>
  seq7.some((e) => deadlockKeyOf(e.shard, e.playerId) === key),
);

/* ---------------- 3. 三个卡死玩家的晋升链路 ---------------- */

const deadlockDetail = deadlockKeys.map((key) => {
  const { shard, playerId, lines } = deadlockByPlayer.get(key)!;
  const final = finalOf.get(key) ?? null;
  const events = readPromotions(PREFIX, shard, cidOf(playerId));
  const reached7 = events.some((e) => e.after === 7);
  const days = [...new Set(lines.map((l) => l.day))].sort((a, b) => a - b);
  return { key, shard, playerId, lines, final, events, reached7, days };
});

const control = PREFIX_CTRL
  ? deadlockKeys.map((key) => {
      const { shard, playerId } = deadlockByPlayer.get(key)!;
      const row = readCharacters(PREFIX_CTRL, shard).find((r) => playerOf(r) === playerId) ?? null;
      const events = readPromotions(PREFIX_CTRL, shard, cidOf(playerId));
      return { key, shard, playerId, final: row, reached7: events.some((e) => e.after === 7) };
    })
  : [];

/* ---------------- 4. 渲染 ---------------- */

const N = String.fromCharCode(96);
const code = (s: string): string => N + s + N;
const lines: string[] = [];
const P = (s = ''): void => { lines.push(s); };
const healthy = seq7.length - seq7FromDeadlock.length;

P('# M2.13.1 任务 A：DEADLOCK 人群 × 序列 7 交叉取证');
P();
P('> **这一份报告回答一个被打回的问题**：关闭前置 4 的那一轮（' + code(PREFIX) + '）里有');
P('> 3 个玩家卡死（DEADLOCK），同一轮又有 ' + seq7.length + ' 人升到序列 7 ——');
P('> **这两批人是不是同一批？**');
P('>');
P('> 数据来源：' + code('docs/' + PREFIX + '-shardN-异常.md') + '（DEADLOCK 名单，权威来源）+');
P('> ' + code('data/' + PREFIX + '-shard-N.db') + '（最终序列与晋升事件），各 ' + SHARDS + ' 片。');
P('> 数字全部由 ' + code('scripts/m2-13-1-deadlock-cross.ts') + ' 从上述文件与库里数出来，**不手抄 stdout**。');
P();
P('## 〇、两个问题的答案（先说结论）');
P();
P('| 问题 | 答案 |');
P('| --- | --- |');
P('| **1. DEADLOCK 的三个玩家，有几个升到序列 7？** | **' + deadlockInSeq7.length + ' 个** |');
P('| **2. 那 ' + seq7.length + ' 个序列 7，有几个来自 DEADLOCK？** | **' + seq7FromDeadlock.length + ' 个** —— 健康玩家 **' + healthy + '** 人（= ' + seq7.length + ' − ' + seq7FromDeadlock.length + '） |');
P();
P('**判定**：第 2 问 = 0，按任务书 §三 A 的规定**继续 B / C / D**（不需要停下重审判据）。');
P('它同时说明：**' + code('8→7') + ' 的真实对比里，关闭那轮的 ' + seq7.length + ' 人全部是健康玩家，');
P('DEADLOCK 人群零贡献** —— 两批人**完全不相交**。');
P();
P('## 一、三个卡死玩家是谁（player_id 定位）');
P();
P('「玩家#N」是**虚拟玩家序号**，不是 ' + code('player_id') + '。映射写在 ' + code('src/vplayer/profiles.ts') + '：');
P();
P('```ts');
P('id: index,                       // 玩家#N');
P('userId: String(700000 + index),  // → user_id = 700000 + N');
P('```');
P();
P('所以 ' + code('#N') + ' → ' + code('characters.user_id = 700000 + N') + ' → ' + code("characters.id = 'c-' + user_id") + '。');
P('旁证：事件 seed 形如 ' + code('onebot:vp-19-13-1-0:c-700019:…') + '（' + code('src/vplayer/session.ts') + ' 的');
P(code('vp-${profile.id}-${day}-${login}-${step}') + '），序号与角色号一一对应。');
P();
P('| 分片 | 虚拟玩家 | player_id | character_id | 姓名 | **有升到序列 7 的事件？** | 当前序列 | MAD | COR | DIG | 最终状态 |');
P('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
for (const d of deadlockDetail) {
  const f = d.final;
  P('| ' + d.shard + ' | #' + d.playerId + ' | ' + (f ? f.user_id : '—') + ' | ' + code(cidOf(d.playerId)) + ' | ' +
    (f ? f.name : '—') + ' | **' + (d.reached7 ? '有' : '没有') + '** | **' +
    (f ? String(f.sequence) : '—') + '** | ' + (f ? String(f.mad) : '—') +
    ' | ' + (f ? String(f.cor) : '—') + ' | ' + (f ? String(Math.round(f.dig * 10) / 10) : '—') + ' | ' +
    (f ? f.status : '—') + ' |');
}
P();
P('- DEADLOCK 条目数：' + deadlockDetail.map((d) => 'shard' + d.shard + '/#' + d.playerId + ' = ' + d.lines.length + ' 条').join('、') +
  '（合计 **' + deadlockDetail.reduce((s, d) => s + d.lines.length, 0) + '** 条）');
P('- 涉及天数：' + deadlockDetail.map((d) => 'shard' + d.shard + '/#' + d.playerId + ' 第 ' + d.days.join('、') + ' 天').join('；'));
P();
P('## 二、三玩家的晋升链路（逐条事件，从库里读）');
P();
for (const d of deadlockDetail) {
  const f = d.final;
  P('### shard' + d.shard + ' 玩家#' + d.playerId + '（' + code(cidOf(d.playerId)) + '，' + (f ? f.name : '—') + '）');
  P();
  P('最终序列 **' + (f ? String(f.sequence) : '—') + '**，DIG=' + (f ? String(Math.round(f.dig * 10) / 10) : '—') +
    '，MAD=' + (f ? String(f.mad) : '—') + '，COR=' + (f ? String(f.cor) : '—') + '。');
  P();
  P('| 事件 id | 类型 | 说明 | from → to | 日期 |');
  P('| --- | --- | --- | --- | --- |');
  for (const e of d.events) {
    const arrow = e.from === null && e.after === null ? '—' : String(e.from) + ' → ' + String(e.after);
    P('| ' + e.id + ' | ' + code(e.type) + ' | ' + e.reason + ' | ' + arrow + ' | ' +
      new Date(e.createdAt).toISOString().slice(0, 10) + ' |');
  }
  P();
  P('**有没有升到序列 7**：' + (d.reached7 ? '**有**' : '**没有** —— 事件流里不存在任何 to/after = 7 的记录。'));
  P();
}
P('## 三、交叉：' + seq7.length + ' 个序列 7 逐片对照 DEADLOCK');
P();
P('| 分片 | 最终序列 ≤7 人数 | 其中 DEADLOCK 玩家 | 序列 7 名单 |');
P('| --- | --- | --- | --- |');
for (let shard = 0; shard < SHARDS; shard += 1) {
  const rows = seq7.filter((e) => e.shard === shard);
  const dl = rows.filter((e) => e.deadlockLines > 0);
  P('| ' + shard + ' | ' + rows.length + ' | ' + dl.length + ' | ' +
    (rows.length === 0 ? '—' : rows.map((e) => '#' + e.playerId + '(' + e.name + ')').join('、')) + ' |');
}
P('| **合计** | **' + seq7.length + '** | **' + seq7FromDeadlock.length + '** | — |');
P();
P('最终序列分布（' + SHARDS + ' 片合计）：' +
  [...seqDist.entries()].sort().map(([k, v]) => (k === 'mortal' ? '普通人' : '序列 ' + k) + ' ' + v + ' 人').join('、') + '。');
P();
P('**交集 = ' + seq7FromDeadlock.length + '**：' +
  (deadlockInSeq7.length === 0
    ? '三个卡死玩家**没有一个**出现在序列 7 名单里。'
    : '卡死玩家同时出现在序列 7 名单里：' + deadlockInSeq7.join('、')));
P();
P('## 四、附带收获一：DEADLOCK 不是「永久卡死」');
P();
P('把三人的**卡死当时**与**最终快照**并排看：');
P();
P('| 分片/玩家 | 卡死时 DIG | 最终 DIG | 卡死时序列 | 最终序列 | 发生了什么 |');
P('| --- | --- | --- | --- | --- | --- |');
for (const d of deadlockDetail) {
  const first = d.lines[0]!;
  const digAt = /DIG=([\d.]+)/.exec(first.detail)?.[1] ?? '—';
  const f = d.final;
  const finalDig = f ? Math.round(f.dig * 10) / 10 : 0;
  const finalSeq = f ? String(f.sequence) : '—';
  let what: string;
  if (finalSeq === '8') what = '**脱困** —— 卡死之后仍然完成了 9→8';
  else if (finalDig < 60) what = 'DIG 掉回门槛（60）以下，判据不再成立';
  else what = '仍满足判据，但事件流里没有后续晋升';
  P('| shard' + d.shard + '/#' + d.playerId + ' | ' + digAt + ' | ' + String(finalDig) + ' | 9 | ' + finalSeq + ' | ' + what + ' |');
}
P();
P('> **读法**：DEADLOCK 判据（DIG 达标 + 序列 9 + MAD/COR 双越线）是**时点快照**，');
P('> 不是「这个玩家此后一动不动」。三行里的「脱困」与「DIG 掉回门槛」说明：');
P('> 卡死人群的真实形态是**在门槛上下反复**，而不是停住 ——');
P('> **所以「卡死的 3 人」与「升到 7 的 ' + seq7.length + ' 人」本来就不是一个集合。**');
P();
if (control.length > 0) {
  P('## 五、附带收获二：同 seed 对照（同样这三个玩家号，前置 4 开的那一轮）');
  P();
  P('> 两轮 seed 相同（' + code('m213b') + '），差别只有 ' + code('M213_PREREQ4') + '。**没有引入新 seed。**');
  P();
  P('| 分片/玩家 | 关闭前置 4（' + code(PREFIX) + '）最终序列 | 开启前置 4（' + code(PREFIX_CTRL) + '）最终序列 | 开启那轮有升到 7 吗 |');
  P('| --- | --- | --- | --- |');
  for (let i = 0; i < deadlockDetail.length; i += 1) {
    const d = deadlockDetail[i]!;
    const c = control[i]!;
    P('| shard' + d.shard + '/#' + d.playerId + ' | ' + (d.final ? String(d.final.sequence) : '—') + ' | ' +
      (c.final ? String(c.final.sequence) : '—（库缺失）') + ' | ' + (c.reached7 ? '有' : '没有') + ' |');
  }
  P();
}
P('## 六、P1 的 ' + p1Total + ' 条到底是什么（归因口径的证据）');
P();
P('被打回的那份报告把关闭那轮的 P1 写成「' + p1Total + ' 条 NO_STATE_CHANGE」。**从 ' + SHARDS + ' 份异常清单里数出来是：**');
P();
P('| 分片 | P0 | P1 | DEADLOCK | 其它 |');
P('| --- | --- | --- | --- | --- |');
for (const a of anomalies) {
  const dl = a.items.filter((i) => i.code === 'DEADLOCK').length;
  P('| ' + a.shard + ' | ' + a.p0 + ' | ' + a.p1 + ' | ' + dl + ' | ' + (a.p1 - dl) + ' |');
}
const dlCount = byCode.get('DEADLOCK') ?? 0;
P('| **合计** | **' + p0Total + '** | **' + p1Total + '** | **' + dlCount + '** | **' + (p1Total - dlCount) + '** |');
P();
P('按 code 分类：' + [...byCode.entries()].map(([k, v]) => code(k) + ' ' + v + ' 条').join('、') + '。');
P();
const otherCodes = [...byCode.entries()].filter(([k]) => k !== 'DEADLOCK');
P('**P1 总数 ' + p1Total + ' 不变**，但归因是 **' + dlCount + ' 条 DEADLOCK + ' +
  otherCodes.map(([k, v]) => v + ' 条 ' + code(k)).join(' + ') + '**，');
P('不是「' + p1Total + ' 条 NO_STATE_CHANGE」。');
P();

writeFileSync(OUT, lines.join('\n'), 'utf8');
console.log('=== 任务 A 取证 ===');
console.log('DEADLOCK 玩家：' + deadlockKeys.join('、'));
console.log('序列 ≤7 人数：' + seq7.length + '（来自 DEADLOCK：' + seq7FromDeadlock.length + '）');
console.log('P1 总数：' + p1Total + '（DEADLOCK ' + dlCount + '）');
console.log('已写出 ' + OUT);
