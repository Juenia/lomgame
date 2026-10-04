#!/usr/bin/env node
/**
 * M2.11 的 PVP 专项覆盖报告。
 *
 * 与 M2.10 的 scripts/m2-10-pvp-report.ts 是同一类东西，但有两处关键扩充：
 *
 *   1. **被挑战者那一侧**（M2.10 只统计了「谁发起挑战」）：谁被挑战、什么画像、
 *      他有没有真的接战。M2.11 的核心问题不是「发起者胜率 74% 高不高」，
 *      而是「**被挑战的人愿不愿意接**」—— 一个不对称的机制如果让所有人都躲，
 *      它就不再是社交机制，而是单方面骚扰。
 *   2. **不分片小轮也能跑**：M2.11 的社交小轮是 40 人单库（没有分片），
 *      所以本脚本按 --db 收一串库路径，1 个或 N 个都行。
 *
 * 用法：
 *   node scripts/m2-11-pvp-report.ts --db data/vplayer-social/m211-social.db
 *     --players 40 --seed m211-social-pvp --label "40×7 不分片"
 *     --out docs/M2.11-社交-PVP覆盖.md --append docs/M2.11-社交-PVP报告.md
 *
 * ⚠️ 口径（必须写进报告，不许省）：**虚拟玩家不会「躲」。**
 *    它们在被挑战之后没有躲避逻辑 —— 要么出招、要么超时被系统代打。
 *    所以「接受率」在这份报告里测的是**机制有没有给玩家留退路**，
 *    不是「真人愿不愿意接」。真人接受率只有真人封测能给。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { openDatabase } from '../src/infra/db/sqlite.ts';
import { buildProfiles } from '../src/vplayer/profiles.ts';

function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf('--' + name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

type Counts = Map<string, number>;

function bump(map: Counts, key: string | number, by = 1): void {
  const id = String(key);
  map.set(id, (map.get(id) ?? 0) + by);
}

const DB_PATHS = (arg('db') ?? '')
  .split(',')
  .map((entry) => entry.trim())
  .filter((entry) => entry.length > 0);
if (DB_PATHS.length === 0) throw new Error('必须给 --db <sqlite 路径>（逗号分隔可给多个）');
const PLAYERS = Number(arg('players', '40'));
const SEED = arg('seed') ?? 'm211-social-pvp';
const LABEL = arg('label') ?? (DB_PATHS.length > 1 ? DB_PATHS.length + ' 分片' : '单库');
const OUT = arg('out') ?? 'docs/M2.11-PVP覆盖.md';
const APPEND = arg('append');

/** 角色 → 画像。画像只存在于虚拟玩家那一侧（库里没有这一列），所以按 seed 重建。 */
const personaByUserId = new Map<string, string>();
for (const profile of buildProfiles({ players: PLAYERS, seed: SEED })) {
  personaByUserId.set(profile.userId, profile.persona);
}

interface Sides {
  opponent: number[];
  challenger: number[];
  /** 这一场里「触发结算的那一方是超时代打」的回合数 */
  autoRounds: number;
  /** 这一场的回合总数（从 battle_rounds 数出来） */
  rounds: number;
}

interface PvpTotals {
  battles: number;
  rounds: number;
  roundRows: number;
  /** 判定层 flags.autoDefend：**player 侧（= 发起者）** 那一手是不是超时代打 */
  autoDefend: number;
  /**
   * pvp_round.auto：**触发结算的那一方**是不是超时代打（M2.11 新增）。
   *
   * 为什么必须与上面那个数分开列：M2.10 的报告只用了 flags.autoDefend
   * （278 / 958 = 29%），而那个 flag 只覆盖**发起者一侧** ——
   * 实测 4 个分片库里 pvp_round.auto=true 有 676 个回合。
   * 两个数一起列出来，读者才知道「超时」到底发生在谁身上。
   */
  autoByRound: number;
  /** M2.11 方向 B：应战者明确表态的次数（接受 / 拒绝） */
  accepted: number;
  declined: number;
  /** 「零次主动出招」那些场次的回合总数 / 其中由超时代打的回合数 */
  silentRounds: number;
  silentAutoRounds: number;
  status: Counts;
  roundDist: Counts;
  rejected: Counts;
  flags: Counts;
  challengerPersona: Counts;
  challengedPersona: Counts;
  surrenderBy: Counts;
  opponentMoved: number;
  opponentSilent: number;
  unresolved: number;
  opponentMoves: Counts;
  challengerMoved: number;
  challengerSilent: number;
  firstMoveRounds: number[];
}

function collect(): PvpTotals {
  const totals: PvpTotals = {
    battles: 0,
    rounds: 0,
    roundRows: 0,
    autoDefend: 0,
    autoByRound: 0,
    accepted: 0,
    declined: 0,
    silentRounds: 0,
    silentAutoRounds: 0,
    status: new Map(),
    roundDist: new Map(),
    rejected: new Map(),
    flags: new Map(),
    challengerPersona: new Map(),
    challengedPersona: new Map(),
    surrenderBy: new Map(),
    opponentMoved: 0,
    opponentSilent: 0,
    unresolved: 0,
    opponentMoves: new Map(),
    challengerMoved: 0,
    challengerSilent: 0,
    firstMoveRounds: [],
  };

  for (const path of DB_PATHS) {
    if (!existsSync(path)) {
      console.log('跳过不存在的库：' + path);
      continue;
    }
    const db = openDatabase(path);

    const personaOfChar = new Map<string, string>();
    for (const row of db.prepare('SELECT id, user_id FROM characters').all() as Array<Record<string, unknown>>) {
      const persona = personaByUserId.get(String(row.user_id));
      if (persona) personaOfChar.set(String(row.id), persona);
    }

    const battles = db
      .prepare('SELECT id, character_id, opponent_character_id, status FROM battles WHERE is_pvp = 1')
      .all() as Array<Record<string, unknown>>;
    totals.battles += battles.length;
    for (const battle of battles) {
      bump(totals.status, String(battle.status));
      const challengerPersona = personaOfChar.get(String(battle.character_id));
      if (challengerPersona) bump(totals.challengerPersona, challengerPersona);
      const opponentId = battle.opponent_character_id === null ? null : String(battle.opponent_character_id);
      const challengedPersona = opponentId ? personaOfChar.get(opponentId) : undefined;
      if (challengedPersona) bump(totals.challengedPersona, challengedPersona);
    }

    // 每回合一条：超时自动防御与各类 flag 都在 result_json 里
    for (const row of db
      .prepare(
        'SELECT r.result_json AS result_json FROM battle_rounds r ' +
          'JOIN battles b ON b.id = r.battle_id WHERE b.is_pvp = 1',
      )
      .all() as Array<Record<string, unknown>>) {
      totals.rounds += 1;
      totals.roundRows += 1;
      let parsed: { flags?: Record<string, boolean> } = {};
      try {
        parsed = JSON.parse(String(row.result_json)) as { flags?: Record<string, boolean> };
      } catch {
        parsed = {};
      }
      if (parsed.flags?.autoDefend) totals.autoDefend += 1;
      for (const [key, value] of Object.entries(parsed.flags ?? {})) {
        if (value === true) bump(totals.flags, key);
      }
    }

    for (const row of db
      .prepare(
        'SELECT n AS rounds, COUNT(*) AS battles FROM (' +
          'SELECT r.battle_id, COUNT(*) AS n FROM battle_rounds r JOIN battles b ON b.id = r.battle_id ' +
          'WHERE b.is_pvp = 1 GROUP BY r.battle_id) GROUP BY n ORDER BY n ASC',
      )
      .all() as Array<Record<string, unknown>>) {
      bump(totals.roundDist, String(row.rounds), Number(row.battles));
    }
    // 每场打了几个回合（「沉默场次」的证据要按场算：那些回合是不是全被超时代打掉的）
    const roundsPerBattle = new Map<string, number>();
    for (const row of db
      .prepare(
        'SELECT r.battle_id AS battle_id, COUNT(*) AS n FROM battle_rounds r ' +
          'JOIN battles b ON b.id = r.battle_id WHERE b.is_pvp = 1 GROUP BY r.battle_id',
      )
      .all() as Array<Record<string, unknown>>) {
      roundsPerBattle.set(String(row.battle_id), Number(row.n));
    }

    /*
     * 事件流：发起 / 被挑战 / 被拒 / 出招（等对方）/ 结算回合 / 终局。
     *
     * 「应战者有没有真的接战」= 他有没有主动出过招。两个来源取并集：
     *   - pvp_action_pending：他出招了但还没结算（side = opponent）；
     *   - pvp_round：他的动作参与了结算（actor = opponent 且 auto = false）。
     * 只看其中一个会漏：一回合就结束的战斗不会有 pending，而挂机到最后的人不会有 pending。
     */
    const movedByBattle = new Map<string, Sides>();
    const sidesOf = (battleId: string): Sides => {
      let entry = movedByBattle.get(battleId);
      if (!entry) {
        entry = { opponent: [], challenger: [], autoRounds: 0, rounds: 0 };
        movedByBattle.set(battleId, entry);
      }
      return entry;
    };

    for (const event of db
      .prepare(
        "SELECT type, payload FROM domain_events WHERE type IN " +
          "('pvp_challenge', 'pvp_challenged', 'pvp_challenge_rejected', 'pvp_action_pending', 'pvp_round', 'pvp_end', " +
            "'pvp_challenge_accepted', 'pvp_challenge_declined')",
      )
      .all() as Array<Record<string, unknown>>) {
      let payload: Record<string, unknown> = {};
      try {
        payload = JSON.parse(String(event.payload)) as Record<string, unknown>;
      } catch {
        payload = {};
      }
      if (event.type === 'pvp_challenge_rejected') {
        const reason = String(payload.reason ?? '未知');
        const kind = reason.includes('不在同一个地方')
          ? '跨地点'
          : reason.includes('正在打')
            ? '对方/自己正在战斗中'
            : reason.includes('重伤')
              ? '有一方重伤'
              : '其他';
        bump(totals.rejected, kind);
      }
      if (event.type === 'pvp_end' && payload.surrenderedBy) {
        bump(totals.surrenderBy, String(payload.surrenderedBy));
      }
      // M2.11 方向 B：应战者的两个明确表态
      if (event.type === 'pvp_challenge_accepted') totals.accepted += 1;
      if (event.type === 'pvp_challenge_declined') totals.declined += 1;
      // 触发结算的那一方是不是超时代打（与 flags.autoDefend 是**两个不同的口径**）
      if (event.type === 'pvp_round' && payload.auto === true) totals.autoByRound += 1;
      if (event.type === 'pvp_action_pending') {
        const battleId = String(payload.battleId ?? '');
        const round = Number(payload.round ?? 0);
        if (payload.side === 'opponent') sidesOf(battleId).opponent.push(round);
        if (payload.side === 'challenger') sidesOf(battleId).challenger.push(round);
      }
      if (event.type === 'pvp_round') {
        const battleId = String(payload.battleId ?? '');
        const round = Number(payload.round ?? 0);
        if (payload.auto === true) sidesOf(battleId).autoRounds += 1;
        if (payload.actor === 'opponent' && payload.auto !== true) sidesOf(battleId).opponent.push(round);
        if (payload.actor === 'challenger' && payload.auto !== true) sidesOf(battleId).challenger.push(round);
      }
    }

    for (const battle of battles) {
      const sides = movedByBattle.get(String(battle.id)) ?? { opponent: [], challenger: [], autoRounds: 0, rounds: 0 };
      const status = String(battle.status);
      if (sides.opponent.length > 0) {
        totals.opponentMoved += 1;
        bump(totals.opponentMoves, sides.opponent.length);
        totals.firstMoveRounds.push(Math.min(...sides.opponent));
      } else if (status === 'active') {
        totals.unresolved += 1;
      } else {
        totals.opponentSilent += 1;
        /*
         * 「沉默」的场次里，那些回合是靠什么打完的？
         * M2.11 实测：**几乎全是超时代打** —— 应战者一次都没主动出招，
         * 系统按「5 分钟一格」替他防御，直到分出胜负。
         * 这正是「接受率 43.8% 测的是上线窗口，不是意愿」的直接证据。
         */
        const rounds = roundsPerBattle.get(String(battle.id)) ?? 0;
        totals.silentRounds += rounds;
        totals.silentAutoRounds += sides.autoRounds;
      }
      if (sides.challenger.length > 0) totals.challengerMoved += 1;
      else if (status !== 'active') totals.challengerSilent += 1;
    }

    db.close();
  }
  return totals;
}

function table(entries: Array<[string, number]>, columns: string): string {
  if (entries.length === 0) return '（无数据）';
  const total = entries.reduce((sum, [, value]) => sum + value, 0);
  return [...entries]
    .sort((a, b) => b[1] - a[1])
    .map(([key, value]) => '| ' + key + ' | ' + value + ' | ' + ((value / total) * 100).toFixed(1) + '% |')
    .join('\n');
}

function countsRows(entries: Array<[string, number]>, columns: string): string {
  if (entries.length === 0) return '（无数据）';
  return [...entries].sort((a, b) => b[1] - a[1]).map(([key, value]) => '| ' + key + ' | ' + value + ' |').join('\n');
}

const t = collect();
const avgRounds = t.battles > 0 ? t.rounds / t.battles : 0;
const finished = [...t.status.entries()].filter(([key]) => key !== 'active');
const judged = t.opponentMoved + t.opponentSilent;
const acceptRate = judged > 0 ? t.opponentMoved / judged : 0;
const firstMoveAvg =
  t.firstMoveRounds.length > 0 ? t.firstMoveRounds.reduce((sum, value) => sum + value, 0) / t.firstMoveRounds.length : 0;
const winCount = t.status.get('player_win') ?? 0;
const winRate = t.battles > 0 ? winCount / t.battles : 0;
const surrenders = [...t.surrenderBy.values()].reduce((sum, value) => sum + value, 0);
const pctOf = (value: number): string => (t.battles > 0 ? ((value / t.battles) * 100).toFixed(1) + '%' : '0%');

const lines: string[] = [];
lines.push('# M2.11 PVP 专项覆盖（' + LABEL + '）');
lines.push('');
lines.push('> 数据来源：' + DB_PATHS.join('、') + '与对应的行为日志。');
lines.push('> 口径：每一场 PVP 落一行 battles（is_pvp = 1），每一个回合落一行 battle_rounds（带 seed）。');
lines.push('');
lines.push('## 一、PVP 总览');
lines.push('');
lines.push('| 指标 | 实测 | M2.10 分片（200×14） |');
lines.push('| --- | --- | --- |');
lines.push('| PVP 场次 | ' + t.battles + ' | 210 |');
lines.push('| 总回合数 | ' + t.rounds + ' | 958 |');
lines.push('| 平均回合数 | ' + avgRounds.toFixed(2) + ' | 4.56 |');
/*
 * ⚠️ M2.11 修正的一处口径：**「超时自动防御」原来只统计了发起者那一侧。**
 *
 * 判定层的 flags.autoDefend 记的是 **player 侧**（PVP 里永远是发起者）那一手
 * 是不是超时代打；应战者的超时落在对手侧的动作里，不进这个 flag。
 * M2.10 报告只列了前者（278 / 958 = 29%），于是「PVP 大部分回合是两个人在博弈」
 * 这个印象是错的 —— 用 pvp_round.auto 复算，触发结算的那一方超时的回合有 676 个（71%）。
 * 两个数一起列，读者才知道超时到底发生在谁身上。
 */
lines.push(
  '| 超时自动防御（判定层 flag，只覆盖发起者那一侧） | ' +
    t.autoDefend +
    ' / ' +
    t.roundRows +
    ' 回合（' +
    (t.roundRows > 0 ? ((t.autoDefend / t.roundRows) * 100).toFixed(0) : '0') +
    '%） | 278 / 958（29%） |',
);
lines.push(
  '| **超时自动防御（全口径：触发结算的那一方）** | **' +
    t.autoByRound +
    ' / ' +
    t.roundRows +
    ' 回合（' +
    (t.roundRows > 0 ? ((t.autoByRound / t.roundRows) * 100).toFixed(0) : '0') +
    '%）** | **676 / 958（71%）**（M2.11 复算） |',
);
lines.push(
  '| 应战者明确表态：接受 / 拒绝 | ' + t.accepted + ' / ' + t.declined + ' | 这条链路 M2.11 才有 |',
);
lines.push('| **发起者胜率** | **' + (winRate * 100).toFixed(1) + '%**（' + winCount + '/' + t.battles + '） | 74%（155/210） |');
lines.push('');
lines.push('## 二、结局分布');
lines.push('');
lines.push('| 结局 | 场次 | 占比 |');
lines.push('| --- | --- | --- |');
lines.push(table([...t.status.entries()], ''));
lines.push('');
lines.push('| 认输方 | 次数 |');
lines.push('| --- | --- |');
lines.push(
  [...t.surrenderBy.entries()]
    .map(([key, value]) => '| ' + (key === 'challenger' ? '发起者' : '应战者') + ' | ' + value + ' |')
    .join('\n') || '（没有人认输）',
);
lines.push('');
lines.push('## 三、回合数分布');
lines.push('');
lines.push('| 打了几个回合 | 场次 | 占比 |');
lines.push('| --- | --- | --- |');
lines.push(table([...t.roundDist.entries()], ''));
lines.push('');
lines.push('## 四、发起条件的拦截（约束真的生效了吗）');
lines.push('');
lines.push('| 被拒的原因 | 次数 |');
lines.push('| --- | --- |');
lines.push(countsRows([...t.rejected.entries()], '') || '（一次都没有被拒）');
lines.push('');
lines.push('**跨地点：' + (t.rejected.get('跨地点') ?? 0) + ' 次。**');
lines.push('');
lines.push('> 跑批里它是 0 是预期的：虚拟玩家在决策时就筛掉了不同地点的对象 —— 它不去撞那条约束。');
lines.push('> 约束本身由端到端的「跨地点明确拒绝」用例直接钉住（断言回执 + 不落库）。');
lines.push('>');
lines.push('> **真人的触发频率需真人验证**：真人比虚拟玩家更可能撞这条约束（他会试图挑战任何人，');
lines.push('> 然后被系统拒绝）。它与「玩家是否知道要同地点」直接相关，而这个认知只有在真人封测里才看得到。');
lines.push('');
lines.push('## 五、挑战发起者的画像分布');
lines.push('');
lines.push('| 画像 | 发起次数 |');
lines.push('| --- | --- |');
lines.push(countsRows([...t.challengerPersona.entries()], ''));
lines.push('');
lines.push('> 意愿是构造的（激进 0.3 / 混乱 0.25 / 完美主义 0.1 / 稳健 0.05 / 轻量 0.05），');
lines.push('> 所以这张表证明的是「分档生效了」，不是「真人会这样打」。见 README 的「战斗的样本量口径」。');
lines.push('');
lines.push('## 六、被挑战者那一侧（M2.11 新增）');
lines.push('');
lines.push('### 6.1 被挑战者的画像分布');
lines.push('');
lines.push('| 画像 | 被挑战次数 |');
lines.push('| --- | --- |');
lines.push(countsRows([...t.challengedPersona.entries()], ''));
lines.push('');
lines.push('### 6.2 应战者的响应分布（这一轮的核心指标）');
lines.push('');
lines.push('| 应战者做了什么 | 场次 | 占比 |');
lines.push('| --- | --- | --- |');
lines.push('| **接战**（至少主动出过一次招） | ' + t.opponentMoved + ' | ' + pctOf(t.opponentMoved) + ' |');
lines.push('| 全程被系统代打（零次主动出招） | ' + t.opponentSilent + ' | ' + pctOf(t.opponentSilent) + ' |');
lines.push('| 还在打（无法判定） | ' + t.unresolved + ' | ' + pctOf(t.unresolved) + ' |');
lines.push('');
lines.push(
  '**应战者接受率 = ' +
    (acceptRate * 100).toFixed(1) +
    '%**（接战 ' +
    t.opponentMoved +
    ' / 可判定 ' +
    judged +
    '）。首次主动出招平均发生在第 ' +
    firstMoveAvg.toFixed(2) +
    ' 回合。',
);
lines.push('');
lines.push('| 应战者主动出招次数 | 场次 |');
lines.push('| --- | --- |');
lines.push(countsRows([...t.opponentMoves.entries()], ''));
lines.push('');
lines.push(
  '> ⚠️ **这张表不能直接当成真人意愿**：虚拟玩家没有躲避逻辑 —— 它被挑战之后' +
    '要么出招、要么因为两次登录之间的虚拟时间跨过 5 分钟而被系统代打。' +
    '所以这里的「接受率」测的是机制有没有给玩家留退路，不是「真人愿不愿意接」。' +
    '真人接受率只有真人封测能给（见 M2.11 交付说明的前置 2）。',
);
lines.push('');
lines.push('### 6.3 发起者那一侧的对照（他也可能中途不出招）');
lines.push('');
lines.push('| 发起者做了什么 | 场次 |');
lines.push('| --- | --- |');
lines.push('| 主动出过招 | ' + t.challengerMoved + ' |');
lines.push('| 零次主动出招（已结束的场次里） | ' + t.challengerSilent + ' |');
lines.push('');
lines.push('### 6.4 「接受率 43.8%」到底测的是什么（**本轮最该被读懂的一节**）');
lines.push('');
lines.push(
  '把那 ' + t.opponentSilent + ' 场「应战者零次主动出招」的场次拆开看：它们一共 ' +
    t.silentRounds + ' 个回合，其中 **' + t.silentAutoRounds + ' 个回合是超时代打**。',
);
lines.push('');
lines.push('也就是说：**应战者不是「不想接」，而是「没在 5 分钟的窗口里上线」。**');
lines.push('');
lines.push('\x60\x60\x60text');
lines.push('挑战发起 → 应战者收到菜单/通知 → 他此刻不在自己回合（或干脆没上线）');
lines.push('  → 去做别的事（这是对的，真人也会）→ 这次登录结束');
lines.push('  → 几小时后他再上线时，服务端早已按「5 分钟一格」把他那几手全代打完了');
lines.push('\x60\x60\x60');
lines.push('');
lines.push(
  '所以这一栏的准确读法是：**它是「机制在多大程度上逼着玩家在窗口内回应」，' +
    '不是「玩家的意愿」**。虚拟玩家不会躲（它没有躲避逻辑）—— 真人会不会躲，' +
    '这份报告回答不了；但真人的接受率**很可能低于**这个数，因为真人会权衡「打不打得过」。',
);
lines.push('');
lines.push('## 七、回合内的可统计事件');
lines.push('');
lines.push('| 事件 | 次数 |');
lines.push('| --- | --- |');
lines.push(countsRows([...t.flags.entries()], ''));
lines.push('');
lines.push('## 八、与 M2.10 分片的对照');
lines.push('');
lines.push('| 指标 | M2.10（4 分片 200×14） | M2.11（' + LABEL + '） | 读法 |');
lines.push('| --- | --- | --- | --- |');
lines.push('| PVP 场次 | 210 | ' + t.battles + ' | 分母不同，只看量级 |');
lines.push('| 平均回合数 | 4.56 | ' + avgRounds.toFixed(2) + ' | 分片不影响回合长度（战斗是两人之间的事） |');
lines.push('| 发起者胜率 | 74%（155/210） | ' + (winRate * 100).toFixed(1) + '%（' + winCount + '/' + t.battles + '） | 前置 1 要验的第一件事 |');
lines.push(
  '| 超时自动防御占比（**全口径**） | 71%（M2.11 复算；M2.10 报告只列了发起者侧的 29%） | ' +
    (t.roundRows > 0 ? ((t.autoByRound / t.roundRows) * 100).toFixed(0) : '0') +
    '% | 分片切断了跨片玩家，同片血线更接近 —— 但两边都是「大部分回合靠代打」 |',
);
lines.push(
  '| 应战者明确表态（接受/拒绝） | 该链路 M2.11 才有 | ' +
    t.accepted +
    ' / ' +
    t.declined +
    ' | 虚拟玩家一律接受（它不会躲），所以拒绝在跑批里是 0 次 |',
);
lines.push(
  '| 认输 | 10（全部应战者） | ' +
    surrenders +
    '（' +
    [...t.surrenderBy.entries()].map(([key, value]) => (key === 'challenger' ? '发起者 ' : '应战者 ') + value).join(' / ') +
    '） | M2.10 全是应战者，本轮两边都有 —— 样本太小，不下结论 |',
);
lines.push(
  '| 被挑战者画像分布 | 未统计 | ' +
    (countsRows([...t.challengedPersona.entries()], '').replace(/\n/g, ' · ').replace(/\|\s*/g, '').trim() || '无') +
    ' | M2.11 新增 |',
);
lines.push('| 应战者接受率 | 未统计 | ' + (acceptRate * 100).toFixed(1) + '% | 前置 2 定调的唯一依据 |');
lines.push('');
lines.push('## 九、验收判定');
lines.push('');
lines.push('| 项 | 实测 | 要求 | 判定 |');
lines.push('| --- | --- | --- | --- |');
lines.push('| PVP 场次 | ' + t.battles + ' | ≥ 5（不足则扩到 60×7） | ' + (t.battles >= 5 ? '通过' : '**不足**') + ' |');
lines.push('| 回合数取值个数 | ' + t.roundDist.size + ' | ≥ 2 | ' + (t.roundDist.size >= 2 ? '通过' : '**单点**') + ' |');
lines.push('| 结局取值个数 | ' + finished.length + ' | ≥ 2 | ' + (finished.length >= 2 ? '通过' : '**单点**') + ' |');
lines.push(
  '| 被挑战者画像可统计 | ' + t.challengedPersona.size + ' 种 | ≥ 2 | ' + (t.challengedPersona.size >= 2 ? '通过' : '**不足**') + ' |',
);
lines.push(
  '| 应战者接受率可计算 | ' + (acceptRate * 100).toFixed(1) + '%（分母 ' + judged + '） | 有分母 | ' + (judged > 0 ? '通过' : '**无数据**') + ' |',
);
lines.push('');

const body = lines.join('\n');
writeFileSync(OUT, body, 'utf8');
console.log('已写出 ' + OUT);
console.log(
  'PVP 场次 ' + t.battles + '，发起者胜率 ' + (winRate * 100).toFixed(1) + '%，应战者接受率 ' + (acceptRate * 100).toFixed(1) +
    '%（接战 ' + t.opponentMoved + ' / 沉默 ' + t.opponentSilent + ' / 未结束 ' + t.unresolved + '）',
);

if (APPEND) {
  const marker = '<!-- M2.11-PVP-专项 -->';
  const existing = existsSync(APPEND) ? readFileSync(APPEND, 'utf8') : '';
  if (existing.includes(marker)) {
    writeFileSync(APPEND, existing.slice(0, existing.indexOf(marker)) + marker + '\n\n' + body, 'utf8');
    console.log('已刷新 ' + APPEND + ' 末尾的 PVP 专项一节');
  } else if (existing.length > 0) {
    writeFileSync(APPEND, existing.replace(/\s+$/, '') + '\n\n---\n\n' + marker + '\n\n' + body, 'utf8');
    console.log('已把 PVP 专项一节追加到 ' + APPEND);
  } else {
    console.log('（' + APPEND + ' 还不存在，跳过追加）');
  }
}
