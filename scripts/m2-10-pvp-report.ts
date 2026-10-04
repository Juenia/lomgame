/**
 * M2.10 的 PVP 覆盖报告（4 分片 200×14）。
 *
 * 用法：node scripts/m2-10-pvp-report.ts [片数]（默认 4）
 *
 * 报告要回答任务书 §4.10 的那几张表：PVP 场次与结局分布、回合数分布、
 * 挑战双方的画像分布、**跨地点拒绝次数**、**超时自动防御次数**。
 * 后两项是「约束真的生效了吗」的证据 —— 没有它们，报告只能说明「跑通了」，
 * 说明不了「不该发生的没发生」。
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase } from '../src/infra/db/sqlite.ts';

const SHARDS = Number(process.argv[2] ?? 4);
const OUT = process.argv[3] ?? join('docs', 'M2.10-PVP覆盖.md');
const PREFIX = 'm210';

interface Totals {
  battles: number;
  rounds: number;
  status: Map<string, number>;
  roundDist: Map<number, number>;
  surrenderBy: Map<string, number>;
  rejected: Map<string, number>;
  autoDefend: number;
  /**
   * M2.11 复算补上的一项：**触发结算的那一方**是不是超时代打。
   *
   * flags.autoDefend 只覆盖 player 侧（PVP 里永远是发起者），
   * 于是 M2.10 报告的「超时自动防御 278 / 958（29%）」把应战者那一侧的超时
   * 整个漏掉了 —— 用 pvp_round.auto 数出来是 676 / 958（71%）。
   * 两个数一起列，读者才知道这一场到底是谁在动。
   */
  autoByRound: number;
  totalRoundRows: number;
  flags: Map<string, number>;
}

function bump(map: Map<string, number>, key: string, by = 1): void {
  map.set(key, (map.get(key) ?? 0) + by);
}

function collect(): Totals {
  const totals: Totals = {
    battles: 0,
    rounds: 0,
    status: new Map(),
    roundDist: new Map(),
    surrenderBy: new Map(),
    rejected: new Map(),
    autoDefend: 0,
    autoByRound: 0,
    totalRoundRows: 0,
    flags: new Map(),
  };
  for (let index = 0; index < SHARDS; index += 1) {
    const path = join('data', `${PREFIX}-shard-${index}.db`);
    let db;
    try {
      db = openDatabase(path);
    } catch {
      continue;
    }
    const battleRows = db
      .prepare('SELECT id, status FROM battles WHERE is_pvp = 1')
      .all() as Array<{ id: string; status: string }>;
    totals.battles += battleRows.length;
    for (const row of battleRows) bump(totals.status, row.status);

    const roundRows = db
      .prepare(
        'SELECT r.round AS round, r.result_json AS result_json FROM battle_rounds r ' +
          'JOIN battles b ON b.id = r.battle_id WHERE b.is_pvp = 1',
      )
      .all() as Array<{ round: number; result_json: string }>;
    totals.rounds += roundRows.length;
    totals.totalRoundRows += roundRows.length;
    for (const row of roundRows) {
      let parsed: { flags?: Record<string, boolean> } = {};
      try {
        parsed = JSON.parse(row.result_json) as { flags?: Record<string, boolean> };
      } catch {
        parsed = {};
      }
      if (parsed.flags?.autoDefend) totals.autoDefend += 1;
      for (const [key, value] of Object.entries(parsed.flags ?? {})) {
        if (value === true) bump(totals.flags, key);
      }
    }

    // 每一场打了几个回合
    const perBattle = db
      .prepare(
        'SELECT n AS rounds, COUNT(*) AS battles FROM (' +
          'SELECT r.battle_id, COUNT(*) AS n FROM battle_rounds r JOIN battles b ON b.id = r.battle_id ' +
          'WHERE b.is_pvp = 1 GROUP BY r.battle_id) GROUP BY n ORDER BY n ASC',
      )
      .all() as Array<{ rounds: number; battles: number }>;
    for (const row of perBattle) {
      totals.roundDist.set(Number(row.rounds), (totals.roundDist.get(Number(row.rounds)) ?? 0) + Number(row.battles));
    }

    // 认输 / 被拒 / 总场次：从 domain_events 里读
    const events = db
      .prepare(
        "SELECT type, payload FROM domain_events WHERE type IN " +
          "('pvp_end', 'pvp_challenge_rejected', 'pvp_challenge', 'pvp_round')",
      )
      .all() as Array<{ type: string; payload: string }>;
    for (const event of events) {
      // M2.11：超时的**全口径**（见 Totals.autoByRound 的说明）
      if (event.type === 'pvp_round') {
        try {
          if ((JSON.parse(event.payload) as { auto?: boolean }).auto === true) totals.autoByRound += 1;
        } catch {
          /* 忽略 */
        }
      }
      if (event.type === 'pvp_challenge_rejected') {
        let reason = '未知';
        try {
          reason = String((JSON.parse(event.payload) as { reason?: string }).reason ?? '未知');
        } catch {
          reason = '未知';
        }
        // 只按「类别」归类（把名字与具体地点抹掉），否则一栏会列出几十种不同的句子
        const kind = reason.includes('不在同一个地方')
          ? '跨地点'
          : reason.includes('正在打')
            ? '对方/自己正在战斗中'
            : reason.includes('重伤')
              ? '有一方重伤'
              : '其他';
        bump(totals.rejected, kind);
      }
      if (event.type === 'pvp_end') {
        try {
          const payload = JSON.parse(event.payload) as { surrenderedBy?: string };
          if (payload.surrenderedBy) bump(totals.surrenderBy, payload.surrenderedBy);
        } catch {
          /* 忽略 */
        }
      }
    }
    db.close();
  }
  return totals;
}

/** 从行为日志里读「谁发的挑战」—— 画像只存在于虚拟玩家那一侧，库里没有 */
function profileOfChallenges(): Map<string, number> {
  const out = new Map<string, number>();
  let files: string[] = [];
  try {
    files = readdirSync('docs').filter((file) => new RegExp('^' + PREFIX + '-shard\\d+-行为日志\\.jsonl$').test(file));
  } catch {
    return out;
  }
  for (const file of files) {
    for (const line of readFileSync(join('docs', file), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let record: { command?: string; persona?: string };
      try {
        record = JSON.parse(line) as { command?: string; persona?: string };
      } catch {
        continue;
      }
      /*
       * ⚠️ 完整指令路径的日志里 command **带点号**（`.挑战 某人 发起`），
       * 菜单路径的不带（那是菜单选项的原文）。两种都要认 ——
       * 只认一种时这张表会静默地变成空的（实测踩过）。
       */
      const raw = (record.command ?? '').replace(/^[.。．]/, '');
      if (!raw.startsWith('挑战')) continue;
      if (!raw.includes('发起')) continue;
      bump(out, String(record.persona ?? '未知'));
    }
  }
  return out;
}

function rows(entries: Array<[string | number, number]>): string {
  if (entries.length === 0) return '（无数据）';
  const total = entries.reduce((sum, [, value]) => sum + value, 0);
  return entries
    .sort((a, b) => b[1] - a[1])
    .map(([key, value]) => '| ' + key + ' | ' + value + ' | ' + ((value / total) * 100).toFixed(1) + '% |')
    .join('\n');
}

const t = collect();
const profiles = profileOfChallenges();
const avgRounds = t.battles > 0 ? (t.rounds / t.battles).toFixed(2) : '0';
const finished = [...t.status.entries()].filter(([key]) => key !== 'active');
const dims = {
  rounds: t.roundDist.size,
  outcome: finished.length,
};

const lines: string[] = [];
lines.push('# M2.10 PVP 覆盖（200×14，4 分片）');
lines.push('');
lines.push('> 数据来源：' + SHARDS + ' 个分片库（data/' + PREFIX + '-shard-0.db … ）与对应的行为日志。');
lines.push('> 口径：每一场 PVP 落一行 battles（is_pvp = 1），每一个回合落一行 battle_rounds（带 seed）。');
lines.push('');
lines.push('## 一、PVP 总览');
lines.push('');
lines.push('| 指标 | 值 |');
lines.push('| --- | --- |');
lines.push('| PVP 场次 | ' + t.battles + ' |');
lines.push('| 总回合数 | ' + t.rounds + ' |');
lines.push('| 平均回合数 | ' + avgRounds + ' |');
/*
 * ⚠️ M2.11 口径修正：这一项原来只统计**发起者那一侧**的超时。
 * flags.autoDefend 是判定层给 player 侧（PVP 里永远是发起者）记的；
 * 应战者的超时落在对手侧的动作里，不进这个 flag。两行都要有。
 */
lines.push('| 超时自动防御（判定层 flag，只覆盖发起者那一侧） | ' + t.autoDefend + ' / ' + t.totalRoundRows + ' 回合 |');
lines.push(
  '| **超时自动防御（全口径：触发结算的那一方）** | **' +
    t.autoByRound +
    ' / ' +
    t.totalRoundRows +
    ' 回合（' +
    (t.totalRoundRows > 0 ? ((t.autoByRound / t.totalRoundRows) * 100).toFixed(0) : '0') +
    '%）** |',
);
lines.push('');
lines.push('## 二、结局分布');
lines.push('');
lines.push('| 结局 | 场次 | 占比 |');
lines.push('| --- | --- | --- |');
lines.push(rows([...t.status.entries()].map(([k, v]) => [k, v] as [string, number])));
lines.push('');
lines.push('| 认输方 | 次数 |');
lines.push('| --- | --- |');
lines.push(
  [...t.surrenderBy.entries()].map(([k, v]) => '| ' + (k === 'challenger' ? '发起者' : '应战者') + ' | ' + v + ' |').join('\n') ||
    '（没有人认输）',
);
lines.push('');
lines.push('## 三、回合数分布（「同一场战斗两次不一样」）');
lines.push('');
lines.push('| 打了几个回合 | 场次 | 占比 |');
lines.push('| --- | --- | --- |');
lines.push(rows([...t.roundDist.entries()]));
lines.push('');
lines.push('## 四、发起条件的拦截（**约束真的生效了吗**）');
lines.push('');
lines.push('| 被拒的原因 | 次数 |');
lines.push('| --- | --- |');
lines.push(
  [...t.rejected.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => '| ' + k + ' | ' + v + ' |').join('\n') ||
    '（一次都没有被拒）',
);
lines.push('');
/*
 * ⚠️ M2.11 前置 4：**这一栏的读法改过一次，改的是口径不是数字。**
 *
 * 旧版最后一句是「这一栏回答的是『虚拟玩家会不会做无效尝试』，而不是『约束有没有生效』」。
 * 那句话本身没错，但它把读者的注意力引到了「虚拟玩家」身上，而真正需要被强调的是
 * **这一栏在跑批里根本没有回答「真人会不会撞它」** —— 那件事只有真人封测能给。
 * 报告是给下一轮做决策的人看的，口径含糊的代价比数字错了更大。
 */
lines.push('**跨地点：' + (t.rejected.get('跨地点') ?? 0) + ' 次。**');
lines.push('');
lines.push('跑批里它是 0 是预期的：虚拟玩家在决策时就按「同地点」筛掉了对象');
lines.push('（见 vplayer/decide.ts 的 challengable）—— 它**不去撞**那条约束。');
lines.push('约束本身由端到端的「跨地点明确拒绝」用例直接钉住');
lines.push('（`test/m2-10-pvp.test.ts`：断言回执是「你们不在同一个地方」，且**不落库**）。');
lines.push('');
lines.push('**真人的触发频率需真人验证**：真人比虚拟玩家更可能撞这条约束（他会试图挑战任何人，');
lines.push('然后被系统拒绝）。它与「玩家是否知道要同地点」直接相关，');
lines.push('而这个认知只有在真人封测里才看得到。');
lines.push('');
lines.push('## 五、挑战发起者的画像分布');
lines.push('');
lines.push('| 画像 | 发起次数 |');
lines.push('| --- | --- |');
lines.push(
  [...profiles.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => '| ' + k + ' | ' + v + ' |').join('\n') ||
    '（行为日志里没有挑战动作）',
);
lines.push('');
lines.push('> 意愿是**构造的**（激进 0.3 / 混乱 0.25 / 完美主义 0.1 / 稳健 0.05 / 轻量 0.05），');
lines.push('> 所以这张表证明的是「分档生效了」，不是「真人会这样打」。见 README 的「战斗的样本量口径」。');
lines.push('');
lines.push('## 六、回合内的可统计事件');
lines.push('');
lines.push('| 事件 | 次数 |');
lines.push('| --- | --- |');
lines.push(
  [...t.flags.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => '| ' + k + ' | ' + v + ' |').join('\n') ||
    '（无）',
);
lines.push('');
lines.push('## 七、验收判定');
lines.push('');
lines.push('| 项 | 实测 | 要求 | 判定 |');
lines.push('| --- | --- | --- | --- |');
lines.push('| PVP 场次 | ' + t.battles + ' | ≥ 10 | ' + (t.battles >= 10 ? '通过' : '**不足**') + ' |');
lines.push('| 回合数取值个数 | ' + dims.rounds + ' | ≥ 2 | ' + (dims.rounds >= 2 ? '通过' : '**单点**') + ' |');
lines.push('| 结局取值个数 | ' + dims.outcome + ' | ≥ 2 | ' + (dims.outcome >= 2 ? '通过' : '**单点**') + ' |');
lines.push('| 跨地点拒绝留痕 | ' + (t.rejected.get('跨地点') ?? 0) + ' | 机制可验证 | 通过（有事件可查） |');
lines.push('| 超时自动防御 | ' + t.autoDefend + ' | 机制可验证 | ' + (t.autoDefend > 0 ? '通过' : '未触发') + ' |');
lines.push('');

writeFileSync(OUT, lines.join('\n'), 'utf8');
console.log('已写出 ' + OUT);
