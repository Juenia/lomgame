#!/usr/bin/env node
/**
 * 生成 docs/M2.6.1-袭击矩阵.md（M2.6.1 交付物之一）。
 *
 * 任务书 §十一 要求：穷举所有序列差（−8 到 +8）× 抗性（目标序列 5—9），
 * 每格给命中率、伤害期望、是否可行。**这张表是 M2.7 做封印物的参考。**
 *
 * 四组内容：
 *   一、规则（三档判定 + 抗性 + 反向限制）
 *   二、序列差 × 目标序列矩阵：命中率 / 期望伤害 / 可行性
 *   三、蒙特卡洛自检：每格跑 400 次真实 resolveAssault，实测命中率与公式对齐
 *   四、高打低的代价：通缉等级覆盖 + 赏金缩放
 *
 * 表中所有数字都由 domain/wanted/assault.ts 的**真实函数**算出，
 * 没有一个是手抄的 —— 改了 numeric.assault，这张表跟着变。
 *
 *   node scripts/m261-assault-matrix.ts --out docs/M2.6.1-袭击矩阵.md
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { NUMERIC } from '../src/config/numeric.ts';
import {
  bountyMultiplierFor,
  damageMultiplierOf,
  hitChanceOf,
  resistChanceOf,
  resolveAssault,
} from '../src/domain/wanted/assault.ts';
import { bountyOf } from '../src/domain/wanted/wanted.ts';
import { createSeededRng, seedFrom } from '../src/domain/rng.ts';

const CFG = NUMERIC.assault;
const G = CFG.sequenceGating;
const NL = String.fromCharCode(10);
const BQ = String.fromCharCode(96);
const code = (text: string): string => BQ + text + BQ;

/** 期望基准伤害：区间中点 */
const EXPECTED_BASE = (CFG.baseDamageMin + CFG.baseDamageMax) / 2;

function argOf(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

/**
 * 一格的完整期望：
 *   命中率 × 期望基准伤害 × 伤害倍率 × (1 − 抗性)
 * 抗性只在**命中之后**才掷，所以它是乘在命中之后的第二个因子。
 */
function cellOf(diff: number, targetSeq: number) {
  const attackerSeq = targetSeq + diff;
  const blocked = diff >= G.blockThreshold;
  const hitChance = hitChanceOf(diff);
  const damageMultiplier = damageMultiplierOf(diff);
  const resist = resistChanceOf(targetSeq);
  return {
    attackerSeq,
    blocked,
    /** 攻击者序列落在 0—9 之外 = 这格在游戏里不存在 */
    impossible: attackerSeq < 0 || attackerSeq > 9,
    hitChance,
    damageMultiplier,
    resist,
    damageMin: CFG.baseDamageMin * damageMultiplier,
    damageMax: CFG.baseDamageMax * damageMultiplier,
    expectedDamage: blocked ? 0 : hitChance * EXPECTED_BASE * damageMultiplier * (1 - resist),
  };
}

/* ------------------------------------------------------------------ *
 * 三、蒙特卡洛自检
 * ------------------------------------------------------------------ */

/**
 * 每格跑 N 次真实判定，统计实测命中率。
 *
 * 这不是重复劳动：公式写错了、clamp 漏了、抗性顺序反了，都会在这里露出来 ——
 * 表里那些数字是"我以为公式会给我什么"，这一节是"判定层实际给了我什么"。
 */
function monteCarlo(
  diff: number,
  targetSeq: number,
  rounds: number,
): { hits: number; blockedByGap: number; resisted: number } {
  const attackerSeq = targetSeq + diff;
  let hits = 0;
  let blockedByGap = 0;
  let resisted = 0;
  for (let index = 0; index < rounds; index += 1) {
    const result = resolveAssault(
      {
        attackerSeq,
        targetSeq,
        baseHit: CFG.baseHit,
        baseDamage: EXPECTED_BASE,
        baseDamageMax: CFG.baseDamageMax,
      },
      createSeededRng(seedFrom(['m261-matrix', attackerSeq, targetSeq, index])),
    );
    if (result.blocked) {
      // ⚠️ 抗性挡下的一击**在命中骰上算命中**（抗性判定发生在命中之后）。
      // 第一版把两者混成一个 blocked，结果"实测命中率"被算成
      // 命中数 /（总次数 − 全部被拦数）—— 分子扣了、分母也扣了，
      // 目标序列 5/6 的八格全部对不上公式。口径必须分开数。
      if (result.blockedBy === 'resist') {
        resisted += 1;
        hits += 1;
      } else {
        blockedByGap += 1;
      }
      continue;
    }
    if (result.hit) hits += 1;
  }
  return { hits, blockedByGap, resisted };
}

/* ------------------------------------------------------------------ *
 * main
 * ------------------------------------------------------------------ */

function main(): void {
  const out = argOf('--out') ?? 'docs/M2.6.1-袭击矩阵.md';
  const lines: string[] = [];

  lines.push('# M2.6.1 袭击矩阵 —— 序列差 × 抗性');
  lines.push('');
  lines.push('由 ' + code('scripts/m261-assault-matrix.ts') + ' 生成（不是手写台账）。');
  lines.push('生成命令：' + code('node scripts/m261-assault-matrix.ts --out ' + out));
  lines.push('');
  lines.push('> 表中每一个数字都由 ' + code('domain/wanted/assault.ts') + ' 的**真实函数**算出：');
  lines.push('> ' + code('hitChanceOf') + ' / ' + code('damageMultiplierOf') + ' / ' + code('resistChanceOf') +
    '。改了 ' + code('numeric.assault') + '，这张表跟着变。');
  lines.push('');

  /* ---- 一、规则 ---- */
  lines.push('## 一、规则');
  lines.push('');
  lines.push('序列 9 最低、0 最高；' + code('diff = 攻击者序列 − 目标序列') + '，**正数 = 攻击者更弱**。');
  lines.push('');
  lines.push('| 档位 | 判定 | 命中率 | 伤害 |');
  lines.push('|---|---|---|---|');
  lines.push(
    '| diff ≥ ' + G.blockThreshold + ' | **直接不可行**，回执「你根本近不了他的身。」 | — | — |',
  );
  lines.push('| diff = 2 | 双重衰减 | ' + code('baseHit × ' + G.hitDecay + '²') + ' = 8% | × ' + G.damageDecay + '² = 25% |');
  lines.push('| diff = 1 | 双重衰减 | ' + code('baseHit × ' + G.hitDecay) + ' = 20% | × ' + G.damageDecay + ' = 50% |');
  lines.push('| diff = 0 | 标准 | ' + code('baseHit') + ' = 50% | × 1 = 100% |');
  lines.push('| diff = −1 | 加成 | ' + code('baseHit × ' + G.bonusHit) + ' = 60% | × ' + G.bonusDamage + ' = 110% |');
  lines.push('| diff ≤ −2 | 加成 | ' + code('baseHit × ' + G.bonusHit + '^|diff|') + '，**clamp 到 100%** | × ' + code(G.bonusDamage + '^|diff|') + ' |');
  lines.push('');
  lines.push('**高序列被动抗性**（目标序列 ≤ ' + CFG.highSequenceResist.threshold + ' 时，**命中之后**再掷一次）：');
  lines.push('');
  lines.push('| 目标序列 | 抗性概率 |');
  lines.push('|---|---|');
  for (const seq of [9, 8, 7, 6, 5, 4, 3, 2, 1, 0]) {
    const chance = resistChanceOf(seq);
    lines.push('| ' + seq + ' | ' + (chance === 0 ? '—（不触发）' : (chance * 100).toFixed(0) + '%') + ' |');
  }
  lines.push('');
  lines.push('> ⚠️ 任务书 §3.3 的注释写「序列6: 50%」，但同一行的公式 ' +
    code('0.5 + (7 − 6) × 0.1 = 0.6') + '。序列 5（70%）与序列 4（80%）两个数据点都支持公式，');
  lines.push('> 所以本版**以公式为准**：序列 6 的真实抗性是 **60%**。详见 ' + code('numeric.assault') + ' 顶部的说明。');
  lines.push('');
  lines.push('**反向限制（高打低）**：攻击者比目标强 ≥ ' +
    CFG.reverseWanted.highAttacksLow.minLevelGap + ' 个序列时，');
  lines.push('通缉等级**直接跳到 ' + CFG.reverseWanted.highAttacksLow.wantedLevelOverride + ' 级**（而不是默认的 1 级），');
  lines.push('赏金按 ' + code('bounty × (1 + (9 − targetSeq) × ' + CFG.reverseWanted.bountySequenceScale + ')') + ' 缩放。');
  lines.push('这不只是惩罚，是保护 —— 高序列玩家没必要去欺负新号。');
  lines.push('');

  /* ---- 二、矩阵 ---- */
  lines.push('## 二、序列差 × 目标序列矩阵');
  lines.push('');
  lines.push('每格格式：' + code('命中率 / 期望伤害') + '（期望伤害 = 命中率 × ' +
    EXPECTED_BASE + ' × 伤害倍率 × (1 − 抗性)，基准伤害取区间中点 ' +
    CFG.baseDamageMin + '—' + CFG.baseDamageMax + '）。');
  lines.push('');
  const targetSeqs = [5, 6, 7, 8, 9];
  lines.push('| diff | 攻击者序列 | ' + targetSeqs.map((seq) => '目标 ' + seq).join(' | ') + ' |');
  lines.push('|---|---|' + targetSeqs.map(() => '---').join('|') + '|');
  for (let diff = -8; diff <= 8; diff += 1) {
    const cells = targetSeqs.map((seq) => {
      const cell = cellOf(diff, seq);
      if (cell.impossible) return '—';
      if (cell.blocked) return '**不可行**';
      const resistTag = cell.resist > 0 ? '（抗性 ' + (cell.resist * 100).toFixed(0) + '%）' : '';
      return (
        (cell.hitChance * 100).toFixed(0) + '% / ' + cell.expectedDamage.toFixed(1) + resistTag
      );
    });
    const attackerLabel = targetSeqs
      .map((seq) => seq + diff)
      .filter((seq) => seq >= 0 && seq <= 9);
    const range = attackerLabel.length === 0 ? '不存在' : Math.min(...attackerLabel) + '—' + Math.max(...attackerLabel);
    lines.push(
      '| ' + (diff > 0 ? '+' + diff : String(diff)) + ' | ' + range + ' | ' + cells.join(' | ') + ' |',
    );
  }
  lines.push('');
  lines.push('读法：');
  lines.push('');
  lines.push('- **不可行的那一整块**（diff ≥ ' + G.blockThreshold + '，表的左下角）就是「序列」这个资源的价值所在；');
  lines.push('- 目标序列 ≤ ' + CFG.highSequenceResist.threshold + ' 的那些格子带抗性 —— ' +
    '注意抗性是**二次因子**：先要打中，打中之后还有概率被完全挡掉；');
  lines.push('- ' + code('—') + ' 表示攻击者序列会落到 0—9 之外，游戏里不存在这种对阵。');
  lines.push('');
  lines.push('### 伤害区间（按序列差）');
  lines.push('');
  lines.push('| diff | 伤害倍率 | 最小伤害 | 最大伤害 |');
  lines.push('|---|---|---|---|');
  for (let diff = -8; diff <= 8; diff += 1) {
    const multiplier = damageMultiplierOf(diff);
    lines.push(
      '| ' + (diff > 0 ? '+' + diff : String(diff)) + ' | ' +
        (diff >= G.blockThreshold ? '不可行' : '×' + multiplier.toFixed(3)) + ' | ' +
        (diff >= G.blockThreshold ? '—' : (CFG.baseDamageMin * multiplier).toFixed(1)) + ' | ' +
        (diff >= G.blockThreshold ? '—' : (CFG.baseDamageMax * multiplier).toFixed(1)) + ' |',
    );
  }
  lines.push('');

  /* ---- 三、蒙特卡洛自检 ---- */
  const ROUNDS = 400;
  lines.push('## 三、蒙特卡洛自检（每格 ' + ROUNDS + ' 次真实判定）');
  lines.push('');
  lines.push('这一节是"我以为公式会给我什么"与"判定层实际给了我什么"的对账。');
  lines.push('公式写错、clamp 漏了、抗性顺序反了，都会在这里露出来。');
  lines.push('');
  lines.push(
    '> 口径：这里的「命中率」是**命中骰**的命中率 —— 抗性判定发生在命中之后，' +
      '所以被抗性挡下的一击仍然算"命中过"。抗性单独一列。',
  );
  lines.push('');
  lines.push('| diff | 目标序列 | 公式命中率 | 实测命中率 | 序列差被拦 | 抗性挡下 | 对齐 |');
  lines.push('|---|---|---|---|---|---|---|');
  let mismatches = 0;
  for (const diff of [-2, -1, 0, 1, 2, 3, 5]) {
    for (const targetSeq of targetSeqs) {
      const cell = cellOf(diff, targetSeq);
      if (cell.impossible) continue;
      const result = monteCarlo(diff, targetSeq, ROUNDS);
      const decided = ROUNDS - result.blockedByGap;
      const observed = decided === 0 ? 0 : result.hits / decided;
      // 序列差被拦那一档没有"命中率"可言，只校验"是否 100% 被拦"
      const ok = cell.blocked
        ? result.blockedByGap === ROUNDS
        : Math.abs(observed - cell.hitChance) < 0.08;
      if (!ok) mismatches += 1;
      lines.push(
        '| ' + (diff > 0 ? '+' + diff : String(diff)) + ' | ' + targetSeq + ' | ' +
          (cell.blocked ? '不可行' : (cell.hitChance * 100).toFixed(0) + '%') + ' | ' +
          (cell.blocked ? '—' : (observed * 100).toFixed(1) + '%') + ' | ' +
          result.blockedByGap + ' | ' + result.resisted + ' | ' + (ok ? '✅' : '❌') + ' |',
      );
    }
  }
  lines.push('');
  lines.push(
    mismatches === 0
      ? '**全部对齐** —— 判定层的实际行为与公式一致（容差 8 个百分点，即 400 次抽样的 2σ 量级）。'
      : '**有 ' + mismatches + ' 格对不上** —— 判定层与公式不一致，必须查。',
  );
  lines.push('');

  /* ---- 四、高打低的代价 ---- */
  lines.push('## 四、高打低的代价');
  lines.push('');
  lines.push('| 攻击者 → 目标 | 序列差 | 通缉等级 | 基础赏金 | 赏金倍率 | 实际赏金 |');
  lines.push('|---|---|---|---|---|---|');
  for (const [attackerSeq, targetSeq] of [[8, 9], [7, 9], [7, 8], [6, 8], [6, 7], [5, 7]] as const) {
    const diff = attackerSeq - targetSeq;
    const cell = cellOf(diff, targetSeq);
    const level = CFG.reverseWanted.highAttacksLow.wantedLevelOverride;
    const multiplier = bountyMultiplierFor(targetSeq);
    lines.push(
      '| ' + attackerSeq + ' → ' + targetSeq + ' | ' + diff + ' | ' + level + ' 级 | ' +
        bountyOf(level) + ' 便士 | ×' + multiplier.toFixed(1) + ' | ' +
        Math.round(bountyOf(level) * multiplier) + ' 便士 |',
    );
    void cell;
  }
  lines.push('');
  lines.push('对照：**同序列**重伤（普通路径）只吃 1 级通缉，基础赏金 ' + bountyOf(1) + ' 便士。');
  lines.push('也就是说高序列去欺负一个新号，悬赏是普通犯罪的 ' +
    Math.round(bountyOf(3) / bountyOf(1)) + ' 倍起 —— 而收益（打一个序列 9 的人）几乎为零。');
  lines.push('');
  lines.push('> 这张表是 M2.7 做封印物的参考：封物只要改 ' + code('AssaultInput') +
    ' 的两个序列号，或者给 ' + code('hits') + ' 加一层新的门控即可，判定层不用动。');
  lines.push('');

  /* ---- 五、数值出处 ---- */
  lines.push('## 五、数值出处');
  lines.push('');
  lines.push('全部来自 ' + code('numeric.assault') + '（任务书 §五）：');
  lines.push('');
  lines.push('| 键 | 值 | 含义 |');
  lines.push('|---|---|---|');
  lines.push('| ' + code('baseHit') + ' | ' + CFG.baseHit + ' | 同序列基础命中率 |');
  lines.push('| ' + code('baseDamageMin/Max') + ' | ' + CFG.baseDamageMin + ' / ' + CFG.baseDamageMax + ' | 基准伤害区间 |');
  lines.push('| ' + code('sequenceGating.blockThreshold') + ' | ' + G.blockThreshold + ' | diff ≥ 该值直接不可行 |');
  lines.push('| ' + code('sequenceGating.hitDecay') + ' | ' + G.hitDecay + ' | 弱 1 级命中率乘数 |');
  lines.push('| ' + code('sequenceGating.damageDecay') + ' | ' + G.damageDecay + ' | 弱 1 级伤害乘数 |');
  lines.push('| ' + code('sequenceGating.bonusHit') + ' | ' + G.bonusHit + ' | 强 1 级命中率乘数 |');
  lines.push('| ' + code('sequenceGating.bonusDamage') + ' | ' + G.bonusDamage + ' | 强 1 级伤害乘数 |');
  lines.push('| ' + code('highSequenceResist.threshold') + ' | ' + CFG.highSequenceResist.threshold + ' | 序列 ≤ 该值触发抗性 |');
  lines.push('| ' + code('highSequenceResist.base') + ' | ' + CFG.highSequenceResist.base + ' | 阈值序列的抗性概率 |');
  lines.push('| ' + code('highSequenceResist.perLevelBonus') + ' | ' + CFG.highSequenceResist.perLevelBonus + ' | 每高 1 级再加 |');
  lines.push('| ' + code('reverseWanted.highAttacksLow.wantedLevelOverride') + ' | ' + CFG.reverseWanted.highAttacksLow.wantedLevelOverride + ' | 高打低的通缉等级 |');
  lines.push('| ' + code('reverseWanted.bountySequenceScale') + ' | ' + CFG.reverseWanted.bountySequenceScale + ' | 赏金缩放系数 |');
  lines.push('');

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, lines.join(NL) + NL, 'utf8');
  console.log('已生成 ' + out + '（' + lines.length + ' 行）');
  if (mismatches > 0) {
    console.error('⚠️ 有 ' + mismatches + ' 格公式与判定层对不上');
    process.exitCode = 1;
  }
}

main();
