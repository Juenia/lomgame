/**
 * M2.12 主任务的覆盖报告：**序列 8 → 7**。
 *
 * 用法：node scripts/m2-12-sequence7-report.ts [片数]
 *
 * 这一份报告要回答的是任务书 §2.11 的那几行硬指标，而且每一行都必须
 * **从库里数出来**（不靠人抄 stdout）：
 *   - 入途径率 / 序列 8 率 / 序列 8→7 率
 *   - 长链路走完 9→8→7 的人数（要求 ≥ 50）
 *   - advantage / essence 两层感知各出现几次（M2.8 起一直是 0）
 *   - 暴走 / 求援 / 进化各出现几次（M2.9 起一直是 0）
 *   - 序列 7 技能用了多少次 / 序列 7 地点被探索过几次 / 序列 7 卡触发过几次
 */
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase } from '../src/infra/db/sqlite.ts';

const SHARDS = Number(process.argv[2] ?? 8);
const OUT = process.argv[3] ?? join('docs', 'M2.12-序列7覆盖.md');
/** 库前缀：默认是最终那一轮（m212b）；初轮是 m212 */
const PREFIX = process.argv[4] ?? 'm212b';

interface Totals {
  characters: number;
  mortal: number;
  initiated: number;
  seq9: number;
  seq8: number;
  seq7: number;
  /** 走完 9→8→7 的人数（序列 ≤ 7） */
  longChain: number;
  layers: Map<string, number>;
  creatureActs: Map<string, number>;
  skills: Map<string, number>;
  /** 序列 7 门槛地点的探索次数 */
  seq7LocationExplores: number;
  seq7LocationNames: Set<string>;
  seq7Cards: Map<string, number>;
  promotionsByTarget: Map<string, number>;
  pvpBattles: number;
  pveBattles: number;
}

function bump(map: Map<string, number>, key: string, by = 1): void {
  map.set(key, (map.get(key) ?? 0) + by);
}

function collect(): Totals {
  const t: Totals = {
    characters: 0,
    mortal: 0,
    initiated: 0,
    seq9: 0,
    seq8: 0,
    seq7: 0,
    longChain: 0,
    layers: new Map(),
    creatureActs: new Map(),
    skills: new Map(),
    seq7LocationExplores: 0,
    seq7LocationNames: new Set(),
    seq7Cards: new Map(),
    promotionsByTarget: new Map(),
    pvpBattles: 0,
    pveBattles: 0,
  };

  for (let index = 0; index < SHARDS; index += 1) {
    const path = join('data', PREFIX + '-shard-' + index + '.db');
    if (!existsSync(path)) {
      console.log('跳过不存在的库：' + path);
      continue;
    }
    const db = openDatabase(path);

    // 1) 序列分布
    for (const row of db.prepare('SELECT sequence, pathway FROM characters').all() as Array<Record<string, unknown>>) {
      t.characters += 1;
      if (row.pathway === null || row.pathway === undefined) {
        t.mortal += 1;
        continue;
      }
      t.initiated += 1;
      const seq = Number(row.sequence);
      if (seq === 9) t.seq9 += 1;
      if (seq === 8) t.seq8 += 1;
      if (seq <= 7) {
        t.seq7 += 1;
        t.longChain += 1;
      }
    }

    // 2) 感知分层（M2.8 的五层）
    for (const row of db.prepare('SELECT layer, COUNT(*) AS n FROM sightings GROUP BY layer').all() as Array<Record<string, unknown>>) {
      bump(t.layers, String(row.layer), Number(row.n));
    }

    // 3) 战斗里的生物行为（暴走 / 求援 / 进化）
    for (const row of db.prepare('SELECT result_json FROM battle_rounds').all() as Array<Record<string, unknown>>) {
      try {
        const parsed = JSON.parse(String(row.result_json)) as { events?: string[]; creatureAction?: { kind?: string } };
        for (const kind of parsed.events ?? []) bump(t.creatureActs, String(kind));
        if (parsed.creatureAction?.kind) bump(t.creatureActs, 'action:' + parsed.creatureAction.kind);
      } catch {
        /* 忽略 */
      }
    }

    // 4) 技能使用（domain_events 里的战斗回合与 PVP 回合）
    for (const row of db
      .prepare("SELECT type, payload FROM domain_events WHERE type IN ('battle_round', 'pvp_round', 'battle_skill')")
      .all() as Array<Record<string, unknown>>) {
      try {
        const payload = JSON.parse(String(row.payload)) as Record<string, unknown>;
        const skill = payload.skill ?? payload.playerSkill ?? payload.challengerSkill ?? null;
        if (typeof skill === 'string') bump(t.skills, skill);
        if (typeof payload.opponentSkill === 'string' && payload.opponentSkill.length > 0) {
          bump(t.skills, String(payload.opponentSkill));
        }
      } catch {
        /* 忽略 */
      }
    }

    // 5) 序列 7 门槛地点被探索了多少次
    for (const row of db
      .prepare(
        'SELECT l.id AS id, l.name AS name, SUM(e.count) AS n FROM explore_daily e ' +
          'JOIN locations l ON l.id = e.location_id WHERE l.min_seq = 7 GROUP BY l.id',
      )
      .all() as Array<Record<string, unknown>>) {
      t.seq7LocationExplores += Number(row.n ?? 0);
      t.seq7LocationNames.add(String(row.name));
    }

    // 6) 序列 7 的卡触发了几次
    for (const row of db
      .prepare("SELECT event_id, COUNT(*) AS n FROM event_triggers WHERE event_id LIKE 'seq7%' GROUP BY event_id")
      .all() as Array<Record<string, unknown>>) {
      bump(t.seq7Cards, String(row.event_id), Number(row.n));
    }

    // 7) 晋升的目标序列（区分 9→8 与 8→7）
    for (const row of db
      .prepare("SELECT payload FROM domain_events WHERE type = 'promotion_success'")
      .all() as Array<Record<string, unknown>>) {
      try {
        const payload = JSON.parse(String(row.payload)) as { to?: number };
        if (typeof payload.to === 'number') bump(t.promotionsByTarget, 'to ' + payload.to);
      } catch {
        /* 忽略 */
      }
    }

    t.pvpBattles += Number((db.prepare('SELECT COUNT(*) AS n FROM battles WHERE is_pvp = 1').get() as { n: number }).n);
    t.pveBattles += Number((db.prepare('SELECT COUNT(*) AS n FROM battles WHERE is_pvp = 0').get() as { n: number }).n);
    db.close();
  }
  return t;
}

const t = collect();
const rate = (value: number): string => (t.characters > 0 ? ((value / t.characters) * 100).toFixed(1) + '%' : '—');
const rows = (map: Map<string, number>): string =>
  [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([key, value]) => '| ' + key + ' | ' + value + ' |')
    .join('\n') || '（无）';

const lines: string[] = [];
lines.push('# M2.12 序列 8→7 覆盖（200×30，8 分片）');
lines.push('');
lines.push('> 数据来源：' + SHARDS + ' 个分片库（data/' + PREFIX + '-shard-N.db），从库里数出来，不靠人抄 stdout。');
lines.push('');
lines.push('## 一、长链路：序列分布');
lines.push('');
lines.push('| 阶段 | 人数 | 占建号比例 |');
lines.push('| --- | --- | --- |');
lines.push('| 建号总数 | ' + t.characters + ' | 100% |');
lines.push('| 普通人（还没入途径） | ' + t.mortal + ' | ' + rate(t.mortal) + ' |');
lines.push('| 已入途径（序列 9 及以上） | ' + t.initiated + ' | ' + rate(t.initiated) + ' |');
lines.push('| 序列 9 | ' + t.seq9 + ' | ' + rate(t.seq9) + ' |');
lines.push('| 序列 8（走完 9→8） | ' + t.seq8 + ' | ' + rate(t.seq8) + ' |');
lines.push('| **序列 7（走完 9→8→7）** | **' + t.seq7 + '** | **' + rate(t.seq7) + '** |');
lines.push('');
lines.push('**长链路 9→8→7 走完的人数：' + t.longChain + '**（任务书要求 ≥ 50）');
lines.push('');
lines.push('| 晋升落点（事件口径） | 次数 |');
lines.push('| --- | --- |');
lines.push(rows(t.promotionsByTarget));
lines.push('');
lines.push('## 二、感知分层（M2.8 的五层，advantage / essence 是这一轮的硬指标）');
lines.push('');
lines.push('| 层 | 次数 |');
lines.push('| --- | --- |');
lines.push(rows(t.layers));
lines.push('');
lines.push('## 三、战斗里的生物行为（暴走 / 求援 / 进化 是硬指标）');
lines.push('');
lines.push('| 事件 | 次数 |');
lines.push('| --- | --- |');
lines.push(rows(t.creatureActs));
lines.push('');
lines.push('## 四、技能使用');
lines.push('');
lines.push('| 技能 | 次数 |');
lines.push('| --- | --- |');
lines.push(rows(t.skills));
lines.push('');
lines.push('## 五、序列 7 的内容被碰到了多少');
lines.push('');
lines.push('| 项 | 次数 |');
lines.push('| --- | --- |');
lines.push('| 序列 7 门槛地点被探索 | ' + t.seq7LocationExplores + ' |');
lines.push('| 序列 7 的地点（' + t.seq7LocationNames.size + ' 个） | ' + [...t.seq7LocationNames].join('、') + ' |');
lines.push('| 序列 7 的卡被触发 | ' + [...t.seq7Cards.values()].reduce((sum, n) => sum + n, 0) + ' |');
lines.push('');
lines.push('| 卡 | 触发次数 |');
lines.push('| --- | --- |');
lines.push(rows(t.seq7Cards));
lines.push('');
lines.push('## 六、战斗总量（对照用）');
lines.push('');
lines.push('| 类型 | 场次 |');
lines.push('| --- | --- |');
lines.push('| PVE | ' + t.pveBattles + ' |');
lines.push('| PVP | ' + t.pvpBattles + ' |');
lines.push('');

writeFileSync(OUT, lines.join('\n'), 'utf8');
console.log('已写出 ' + OUT);
console.log('长链路 ' + t.longChain + ' 人（序列 8：' + t.seq8 + ' / 序列 7：' + t.seq7 + '）');
console.log('感知层：' + JSON.stringify([...t.layers.entries()]));
console.log('序列 7 地点探索 ' + t.seq7LocationExplores + ' 次；序列 7 卡 ' + [...t.seq7Cards.values()].reduce((s, n) => s + n, 0) + ' 次');
