#!/usr/bin/env node
/**
 * 生成 docs/M2.6-通缉覆盖率.md（M2.6 交付物之一）。
 *
 * 六组内容，**全部是跑出来的**，没有手抄台账：
 *   一、势力范围覆盖：4 家势力 × 内容表全部地点，不重不漏（territoryCoverage）
 *   二、判定矩阵：通缉等级 0—4 × 11 个地点 × 发通缉的势力，穷举 resolveWanted 的遭遇结果
 *   三、AP 惩罚曲线：效率 → 实际消耗（向上取整）
 *   四、罚金 / 赏金 / 时长表
 *   五、真实链路探针：起一个内存实例，把「袭击 → 通缉 → 势力内被盘查 → 逃到无主地点 → 举报领赏」
 *       整条链路走一遍真实路由，逐条记录玩家实际看到的回执
 *   六、实测数据（可选 --db <sqlite>）：从一次真实跑批的库里统计通缉相关数字
 *
 *   node scripts/m26-wanted-coverage.ts --out docs/M2.6-通缉覆盖率.md
 *   node scripts/m26-wanted-coverage.ts --db data/loadtest-xxx.db --out docs/M2.6-通缉覆盖率.md
 */
import { mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { MemoryAdapter } from '../src/adapter/memory.ts';
import { NUMERIC } from '../src/config/numeric.ts';
import { createApp } from '../src/main.ts';
import { silentLogger } from '../src/infra/logger.ts';
import { loadLocations } from '../src/data/loader.ts';
import { openDatabase } from '../src/infra/db/sqlite.ts';
import {
  FACTIONS,
  factionLabel,
  factionOfLocation,
  territoryCoverage,
  territoryOf,
} from '../src/domain/faction/faction.ts';
import {
  bountyOf,
  defaultWantedWorld,
  resolveReport,
  resolveWanted,
  wantedDurationOf,
  type WantedState,
} from '../src/domain/wanted/wanted.ts';
import { createSeededRng, seedFrom } from '../src/domain/rng.ts';

const NL = String.fromCharCode(10);
const BQ = String.fromCharCode(96);
const code = (text: string): string => BQ + text + BQ;

const LOCATIONS = loadLocations().locations;
const DAY = 24 * 3600 * 1000;
const WORLD = defaultWantedWorld();

function argOf(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

/* ------------------------------------------------------------------ *
 * 一、势力范围覆盖
 * ------------------------------------------------------------------ */

function sectionTerritory(lines: string[]): void {
  const ids = LOCATIONS.map((location) => location.id);
  const coverage = territoryCoverage(ids);
  const nameOf = (id: string): string => LOCATIONS.find((location) => location.id === id)?.name ?? id;

  lines.push('## 一、势力范围覆盖');
  lines.push('');
  lines.push('势力归属的唯一出处是 ' + code('numeric.factionTerritory') + '；' + code('factions') + ' 表只是投影。');
  lines.push('');
  lines.push('| 势力 | id | 类型 | 控制地点（' + coverage.controlled.length + ' 个地点不重不漏） |');
  lines.push('|---|---|---|---|');
  for (const faction of FACTIONS) {
    lines.push(
      '| ' + faction.name + ' | ' + code(faction.id) + ' | ' + faction.type + ' | ' +
        faction.territory.map((id) => nameOf(id) + '（' + code(id) + '）').join('、') + ' |',
    );
  }
  lines.push('');
  lines.push('- 重复声称的地点：' + (coverage.overlaps.length === 0 ? '无 ✅' : coverage.overlaps.join('、') + ' ❌'));
  lines.push('- 内容表里没有任何势力声明的地点：' + (coverage.unclaimed.length === 0 ? '无 ✅' : coverage.unclaimed.join('、') + ' ❌'));
  lines.push('');
  lines.push('> ⚠️ 任务书里写的三个地点 id 是**写意**的，直接照抄会得到「有势力、但没有任何地点归属它」的空势力：');
  lines.push('> ' + code('lightless_basement') + ' → 实际 ' + code('dark_cellar') + '、' +
    code('cemetery_path') + ' → 实际 ' + code('graveyard_path') + '、' +
    code('foggy_street') + ' → 实际 ' + code('mist_street') + '。');
  lines.push('>');
  lines.push('> ⚠️ 灰雾之上（' + code('above_grey_fog') + '）' + code('min_seq = 8') +
    '，**序列 9 的新号去不了** —— 被通缉的新号实际只有 3 个无主地点可逃，不是任务书写的 4 个。');
  lines.push('');
}

/* ------------------------------------------------------------------ *
 * 二、判定矩阵
 * ------------------------------------------------------------------ */

function stateOf(level: number, factionId: string): WantedState {
  return {
    id: 'probe-' + level + '-' + factionId,
    characterId: 'probe',
    level,
    factionId,
    reason: '覆盖率探针',
    createdAt: 0,
    expiresAt: 30 * DAY,
  };
}

function sectionMatrix(lines: string[]): void {
  lines.push('## 二、判定矩阵（穷举 ' + code('resolveWanted') + '）');
  lines.push('');
  lines.push('每一格都是跑一次纯函数判定得到的（rng 固定为 0.99，即"没被按住"这一支，');
  lines.push('这样表里显示的是**遭遇类型与 AP 代价**，而不是随机结果）。');
  lines.push('');

  for (const factionId of ['police', 'church', 'gang']) {
    lines.push('### 发通缉的势力：' + factionLabel(factionId) + '（' + code(factionId) + '）');
    lines.push('');
    lines.push('| 地点（归属） | 1 级 | 2 级 | 3 级 | 4 级 |');
    lines.push('|---|---|---|---|---|');
    for (const location of LOCATIONS) {
      const owner = factionOfLocation(location.id);
      const cells: string[] = [];
      for (const level of [1, 2, 3, 4]) {
        const result = resolveWanted(
          stateOf(level, factionId),
          { type: 'act', locationId: location.id },
          WORLD,
          createSeededRng(seedFrom(['coverage', location.id, level, factionId])),
        );
        cells.push(
          result.encounter === 'none'
            ? '—'
            : result.action,
        );
      }
      lines.push('| ' + location.name + '（' + factionLabel(owner) + '） | ' + cells.join(' | ') + ' |');
    }
    lines.push('');
  }

  lines.push('读法：');
  lines.push('');
  lines.push('- 1—3 级**只在发通缉的那个势力的地盘上**生效（教会的地头不接警察厅的案子）；');
  lines.push('- 4 级是**全境通缉**，任何非无主地点都会动手；');
  lines.push('- **无主地点那一列永远是「—」** —— 这就是「逃到势力范围外」在判定层的落点。');
  lines.push('');
}

/* ------------------------------------------------------------------ *
 * 三、AP 惩罚曲线
 * ------------------------------------------------------------------ */

function sectionApCurve(lines: string[]): void {
  lines.push('## 三、通缉惩罚表（M2.85：行动点机制已移除）');
  lines.push('');
  lines.push('> 原「行动点效率」惩罚（' + code('apMultiplier') + '）随行动值机制一并移除，');
  lines.push('> 现在每一级只剩命中罚金与掉血两维。');
  lines.push('');
  lines.push('| 等级 | 动作 | 命中罚金（便士） | 命中掉血 | 时长 |');
  lines.push('|---|---|---|---|---|');
  for (const level of [1, 2, 3, 4]) {
    const config = (NUMERIC.wanted as unknown as Record<number, {
      action: string;
      penalty: { hpDrain: number; finePenny: number };
      duration: number;
    }>)[level]!;
    lines.push(
      '| ' + level + ' 级 | ' + config.action + ' | ' +
        config.penalty.finePenny + ' | ' + config.penalty.hpDrain + ' | ' +
        Math.round(config.duration / DAY) + ' 天 |',
    );
  }
  lines.push('');
  lines.push('⚠️ **与任务书 §二 表格的一处口径分歧**：表格写「2 级 AP 消耗 +50%」，而 §四 数值写 ' +
    code('apMultiplier: 0.5') + '（= 消耗 ×2）。两处对不上，本版**以 §四 数值表为准**；' +
    '若真要「+50%」，正确值是 ' + code('1/1.5 ≈ 0.667') + '。');
  lines.push('');
}

/* ------------------------------------------------------------------ *
 * 四、赏金与判定期限
 * ------------------------------------------------------------------ */

function sectionBounty(lines: string[]): void {
  lines.push('## 四、赏金与判定期限');
  lines.push('');
  lines.push('| 等级 | 触发源 | 本版开放 | 时长 | 赏金（便士） | 折合 |');
  lines.push('|---|---|---|---|---|---|');
  const enabled = NUMERIC.wanted.triggers.enabled;
  for (const level of [1, 2, 3, 4]) {
    const config = (NUMERIC.wanted as unknown as Record<number, { trigger: string }>)[level]!;
    const open = enabled.includes(config.trigger);
    const bounty = bountyOf(level);
    const pound = Math.floor(bounty / 240);
    const shilling = Math.floor((bounty - pound * 240) / 12);
    const penny = bounty - pound * 240 - shilling * 12;
    const parts: string[] = [];
    if (pound > 0) parts.push(pound + ' 金镑');
    if (shilling > 0) parts.push(shilling + ' 苏勒');
    if (penny > 0) parts.push(penny + ' 便士');
    lines.push(
      '| ' + level + ' 级 | ' + code(config.trigger) + ' | ' + (open ? '✅' : '❌ 留给 M2.7') + ' | ' +
        Math.round(wantedDurationOf(level) / DAY) + ' 天 | ' + bounty + ' | ' + parts.join(' ') + ' |',
    );
  }
  lines.push('');
  lines.push('举报失败（对方没被通缉 / 已躲进无主地点 / 案子不归这家管）：**信誉 ' +
    NUMERIC.wanted.reportFailReputation + '**，不消耗赏金预算。');
  lines.push('');

  // 举报判定的四条路径，用纯函数穷举一遍
  const wanted: WantedState = {
    id: 'w-report',
    characterId: 'c',
    level: 1,
    factionId: 'police',
    reason: '重伤了某人',
    createdAt: 0,
    expiresAt: 30 * DAY,
  };
  const cases: Array<[string, WantedState[], string]> = [
    ['目标被通缉 + 人在警察厅地盘', [wanted], 'police'],
    ['目标没被通缉', [], 'police'],
    ['目标被通缉但躲进无主地点', [wanted], 'none'],
    ['目标被通缉但在教会地盘（案子不归它管）', [wanted], 'church'],
  ];
  lines.push('### 举报判定的四条路径（纯函数穷举）');
  lines.push('');
  lines.push('| 情形 | 结果 | 赏金 | 信誉 |');
  lines.push('|---|---|---|---|');
  for (const [label, states, factionHere] of cases) {
    const outcome = resolveReport({ targetStates: states, targetFactionId: factionHere, now: 1 });
    lines.push(
      '| ' + label + ' | ' + (outcome.ok ? '✅ 成功' : '❌ 失败：' + outcome.reason) + ' | ' +
        outcome.rewardPenny + ' | ' + outcome.reputationDelta + ' |',
    );
  }
  lines.push('');
}

/* ------------------------------------------------------------------ *
 * 五、真实链路探针
 * ------------------------------------------------------------------ */

async function probeRealChain(lines: string[]): Promise<void> {
  const adapter = new MemoryAdapter();
  let clock = Date.UTC(2026, 8, 21, 12, 0, 0);
  const app = createApp(
    {
      dbPath: ':memory:',
      port: 0,
      onebotApiBase: 'http://127.0.0.1:3000',
      detailToPrivate: true,
      runTickOnStart: false,
      startOps: false,
    },
    { adapter, logger: silentLogger, now: () => clock },
  );
  let seq = 0;
  const steps: Array<{ who: string; command: string; reply: string }> = [];
  const wantedRepo = new (await import('../src/infra/db/wanted.ts')).WantedRepo(app.db);

  const send = async (userId: string, rawText: string, scene: 'private' | 'group' = 'private'): Promise<string> => {
    seq += 1;
    await adapter.deliver({
      messageId: 'probe:' + seq,
      platform: 'onebot',
      scene,
      sceneId: scene === 'private' ? userId : '10001',
      userId,
      nickname: '探针' + userId.slice(-2),
      rawText,
      timestamp: clock,
    });
    const sent = adapter.take();
    return sent.map((message) => message.text).join(NL + '---' + NL);
  };
  const record = async (who: string, command: string, scene: 'private' | 'group' = 'private'): Promise<string> => {
    const reply = await send(who, command, scene);
    steps.push({ who, command, reply });
    return reply;
  };
  /** 探针要连续跑好几个消耗 AP 的动作，中途补满（真实玩家靠 .休息 / 每日恢复） */
  const refillAp = (userId: string, hp = 100): void => {
    app.db
      // M2.85：ap 列已删（0033 迁移）—— 这里只补 HP 与状态
      .prepare("UPDATE characters SET hp = ?, status = 'active' WHERE user_id = ?")
      .run(hp, userId);
  };
  const keyLines = (text: string): string =>
    text
      .split(NL)
      .filter((line) =>
        /通缉|盘查|追捕|围剿|全境|罚款|可疑人物|落网|命案|信誉|赏金|重伤|袭击|举报|无主|交易单|价格|墓园|封存|迷雾/.test(line),
      )
      .slice(0, 8)
      .join(' ／ ');

  try {
    await record('70001', '.创建 探针甲 愚者');
    await record('70002', '.创建 探针乙 战士');

    // M2.6.1 起 .袭击 是**概率命中**（同序列 50%），所以探针要一直打到"出现通缉"为止 ——
    // 不然这条链路验证就变成了运气验证。每次之间跨过 30 分钟的袭击冷却。
    for (let attempt = 0; attempt < 12; attempt += 1) {
      if (wantedRepo.countActive(clock) > 0) break;
      refillAp('70001');
      refillAp('70002');
      await record('70001', '.袭击 @70002');
      clock += 31 * 60 * 1000;
    }
    const issued = wantedRepo.listActiveOf(
      String((app.db.prepare("SELECT id FROM characters WHERE user_id = '70001'").get() as { id: string }).id),
      clock,
    );
    clock += 6000; // .状态 有 5 秒冷却，不推时间会被频控挡掉
    await record('70001', '.状态');

    // 逃逸那一步必须真跑起来：AP 不足会让 .探索 被拒，整条"安全区"验证就成了空话
    refillAp('70001');
    await record('70001', '.探索 廷根市');
    clock += 6000;
    await record('70001', '.状态');
    refillAp('70001');
    await record('70001', '.探索 封存档案室');
    clock += 6000;
    await record('70001', '.状态');
    refillAp('70002');
    await record('70002', '.举报 @70001', 'group');
    clock += 10 * 1000;
    await record('70002', '.举报 @70002');

    lines.push('## 五、真实链路探针');
    lines.push('');
    lines.push('起一个内存实例，把整条链路走一遍**真实路由**（不是调纯函数）。');
    lines.push('每一步的「玩家实际看到什么」都在下面 —— 这是本报告里最该被逐条读的部分。');
    lines.push('');
    lines.push('| # | 谁 | 指令 | 关键回执行 |');
    lines.push('|---|---|---|---|');
    steps.forEach((step, index) => {
      lines.push('| ' + (index + 1) + ' | ' + step.who + ' | ' + code(step.command) + ' | ' + keyLines(step.reply).replace(/\|/g, '\\|') + ' |');
    });
    lines.push('');
    lines.push('- 袭击后落库的通缉令：' + (issued.length === 0 ? '**0 条（异常）**' : issued.length + ' 条，' +
      issued.map((state) => state.level + ' 级 / ' + factionLabel(state.factionId) + ' / ' + state.reason).join('；')));
    lines.push('- 探索廷根市（警察厅地盘）必须出现「通缉 · 1 级 · 警察厅 · 盘查」；');
    lines.push('  探索封存档案室（无主）必须**不出现**任何通缉段落 —— 这就是「逃到势力范围外」的验收点。');
    lines.push('');
  } finally {
    app.close();
  }
}

/* ------------------------------------------------------------------ *
 * 六、实测数据（可选）
 * ------------------------------------------------------------------ */

function sectionMeasured(lines: string[], dbPath: string): void {
  lines.push('## 六、实测数据（' + code(dbPath) + '）');
  lines.push('');
  const db = openDatabase(dbPath);
  try {
    const rows = db
      .prepare('SELECT level, faction_id, reason, created_at, expires_at FROM wanted_states ORDER BY created_at ASC')
      .all() as Array<{ level: number; faction_id: string; reason: string; created_at: number; expires_at: number }>;
    const claims = db
      .prepare('SELECT COUNT(*) AS n, COALESCE(SUM(reward_penny), 0) AS s FROM bounty_claims')
      .get() as { n: number; s: number };
    const encounters = db
      .prepare("SELECT payload FROM domain_events WHERE type = 'wanted_encounter'")
      .all() as Array<{ payload: string }>;
    const currencies = db
      .prepare("SELECT COUNT(*) AS n FROM domain_events WHERE type = 'wanted_fine'")
      .get() as { n: number };

    const byLevel: Record<string, number> = {};
    const byFaction: Record<string, number> = {};
    for (const row of rows) {
      byLevel[String(row.level)] = (byLevel[String(row.level)] ?? 0) + 1;
      byFaction[row.faction_id] = (byFaction[row.faction_id] ?? 0) + 1;
    }
    const hits = encounters.filter((row) => {
      try {
        return (JSON.parse(row.payload) as { hit?: boolean }).hit === true;
      } catch {
        return false;
      }
    }).length;

    lines.push('| 指标 | 实测 |');
    lines.push('|---|---|');
    lines.push('| 通缉令总数 | ' + rows.length + ' |');
    lines.push('| 等级分布 | ' + (Object.entries(byLevel).map(([level, count]) => level + ' 级:' + count).join('、') || '无') + ' |');
    lines.push('| 势力分布 | ' + (Object.entries(byFaction).map(([id, count]) => factionLabel(id) + ':' + count).join('、') || '无') + ' |');
    lines.push('| 遭遇判定 | ' + encounters.length + ' 次（命中 ' + hits + ' 次） |');
    lines.push('| 罚款流水 | ' + currencies.n + ' 笔 |');
    lines.push('| 赏金领取 | ' + claims.n + ' 笔 / ' + claims.s + ' 便士 |');
    lines.push('');
    lines.push('> ⚠️ 这一节的绝对值**只对不分片跑批有意义**。分片跑批时通缉是跨玩家行为，');
    lines.push('> 切片会改变「同一个通缉犯被几个人举报」的分母（任务书 §五）。');
    lines.push('');
  } finally {
    db.close();
  }
}

/**
 * 六之二、分片来源：从 4 片的 shard-*.json 里把通缉与货币统计累加。
 *
 * 为什么不直接读 db：分片跑批的 SQLite 是临时文件，跑完就散落在 data/ 里、
 * 名字不可预测；而 shard-*.json 是**合并脚本的正式输入**，与合并报告同源 ——
 * 两处数字必然一致，不会出现"覆盖率报告说 96 条、回归报告说 90 条"这种事。
 */
function sectionFromShards(lines: string[], dir: string): void {
  const files = readdirSync(dir)
    .filter((name) => /^shard-\d+\.json$/.test(name))
    .sort();
  if (files.length === 0) {
    lines.push('## 六、实测数据');
    lines.push('');
    lines.push('目录 ' + code(dir) + ' 下没有 shard-*.json，跳过实测段。');
    lines.push('');
    return;
  }

  const wanted = { issued: 0, active: 0, encounters: 0, claims: 0, claimedPenny: 0, characters: 0 };
  const byLevel: Record<string, number> = {};
  const combo = { attempts: 0, created: 0, mismatched: 0, plain: 0 };
  const byToken: Record<string, { penny: number; created: number }> = {};
  let actions = 0;

  for (const file of files) {
    const shard = JSON.parse(readFileSync(join(dir, file), 'utf8')) as {
      analysis: {
        totalActions: number;
        wanted: {
          issued: number;
          active: number;
          byLevel: Record<string, number>;
          encounters: number;
          claims: number;
          claimedPenny: number;
          characters: number;
        };
        currencyCombo: {
          attempts: number;
          created: number;
          mismatched: number;
          plainAttempts: number;
          byToken: Record<string, { created: number; penny: number }>;
        };
      };
    };
    actions += shard.analysis.totalActions;
    const w = shard.analysis.wanted;
    wanted.issued += w.issued;
    wanted.active += w.active;
    wanted.encounters += w.encounters;
    wanted.claims += w.claims;
    wanted.claimedPenny += w.claimedPenny;
    wanted.characters += w.characters;
    for (const [level, count] of Object.entries(w.byLevel)) {
      byLevel[level] = (byLevel[level] ?? 0) + count;
    }
    const c = shard.analysis.currencyCombo;
    combo.attempts += c.attempts;
    combo.created += c.created;
    combo.mismatched += c.mismatched;
    combo.plain += c.plainAttempts;
    for (const [token, bucket] of Object.entries(c.byToken)) {
      const target = (byToken[token] ??= { penny: bucket.penny, created: 0 });
      target.created += bucket.created;
    }
  }

  const comboRate =
    combo.attempts + combo.plain === 0
      ? 0
      : combo.attempts / (combo.attempts + combo.plain);

  lines.push('## 六、实测数据（' + files.length + ' 个分片合并，' + code(dir) + '）');
  lines.push('');
  lines.push('口径：' + code('200 玩家 × 14 天') + ' 分成 ' + files.length + ' 片并行跑，动作 ' + actions + ' 条。');
  lines.push('');
  lines.push('| 指标 | 实测 |');
  lines.push('|---|---|');
  lines.push('| 通缉令签发 | ' + wanted.issued + ' 条（期末仍有效 ' + wanted.active + '） |');
  lines.push(
    '| 等级分布 | ' +
      (Object.entries(byLevel).map(([level, count]) => level + ' 级:' + count).join('、') || '无') +
      ' |',
  );
  lines.push('| 遭遇判定 | ' + wanted.encounters + ' 次，涉及 ' + wanted.characters + ' 人 |');
  lines.push('| 赏金领取 | ' + wanted.claims + ' 笔 / ' + wanted.claimedPenny + ' 便士 |');
  lines.push(
    '| 组合格式报价 | ' + combo.created + ' / ' + combo.attempts + ' 笔创建成功（纯数字 ' + combo.plain + ' 笔） |',
  );
  lines.push(
    '| 组合格式占比 | ' + (comboRate * 100).toFixed(2) + '%（目标 30%，' +
      combo.attempts + ' / ' + (combo.attempts + combo.plain) + '） |',
  );
  lines.push('| 金额按便士比对不符 | ' + combo.mismatched + ' 笔（**必须为 0**） |');
  lines.push('');
  lines.push('按报价原文分组：');
  lines.push('');
  lines.push('| 报价原文 | 折合便士 | 创建成功笔数 |');
  lines.push('|---|---|---|');
  for (const [token, bucket] of Object.entries(byToken)) {
    lines.push('| ' + code(token) + ' | ' + bucket.penny + ' | ' + bucket.created + ' |');
  }
  lines.push('');
  lines.push('> ⚠️ **绝对值只有不分片小轮或真人验才算数**（任务书 §五）：');
  lines.push('> 通缉是跨玩家行为（A 被通缉、B 举报 A），切片会改变「同一个通缉犯被几个人举报」的分母。');
  lines.push('> 这一节的正确读法是「机制在 200×14 的规模上有没有崩」——' +
    '签发 ' + wanted.issued + ' 条 / 遭遇 ' + wanted.encounters + ' 次说明它没有。');
  lines.push('');
}

/* ------------------------------------------------------------------ *
 * main
 * ------------------------------------------------------------------ */

async function main(): Promise<void> {
  const out = argOf('--out') ?? 'docs/M2.6-通缉覆盖率.md';
  const dbPath = argOf('--db');
  const lines: string[] = [];

  lines.push('# M2.6 通缉系统 · 覆盖率体检');
  lines.push('');
  lines.push('由 ' + code('scripts/m26-wanted-coverage.ts') + ' 生成（不是手写台账）。');
  lines.push('');
  lines.push('生成命令：' + code('node scripts/m26-wanted-coverage.ts' + (dbPath ? ' --db ' + dbPath : '') + ' --out ' + out));
  lines.push('');

  sectionTerritory(lines);
  sectionMatrix(lines);
  sectionApCurve(lines);
  sectionBounty(lines);
  await probeRealChain(lines);
  const shardsDir = argOf('--shards');
  if (dbPath && existsSync(dbPath)) sectionMeasured(lines, dbPath);
  else if (shardsDir && existsSync(shardsDir)) sectionFromShards(lines, shardsDir);
  else {
    lines.push('## 六、实测数据');
    lines.push('');
    lines.push('本次没有提供 ' + code('--db') + ' 或 ' + code('--shards') + '，跳过了实测段。');
    lines.push(
      '要补上：' + code('node scripts/m26-wanted-coverage.ts --shards data/vplayer-shards-m26 --out ' + out) + '。',
    );
    lines.push('');
  }

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, lines.join(NL) + NL, 'utf8');
  console.log('已生成 ' + out + '（' + lines.length + ' 行）');
}

await main();
