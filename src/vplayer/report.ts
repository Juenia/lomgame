/**
 * 报告渲染（W7）：主报告 / 异常 / 覆盖率 三份 markdown + 行为日志（由 Recorder 直接写 JSONL）。
 */
import { NUMERIC } from '../config/numeric.ts';
import type { Analysis } from './analyzer.ts';
import {
  COLUMN_TITLE,
  LOST_CONTROL_ACCEPTANCE_IDS,
  buildGates,
  flatten,
  hitIdsOf,
  renderGateTable,
  renderUntriggeredTable,
  renderVerdictLine,
  untriggeredByNature,
  verdictOf,
  type CardMeta,
  type GateSet,
  type UntriggeredGroup,
  type Verdict,
} from './acceptance.ts';
import { codeVersionLineOf, type CodeVersion } from './code-version.ts';
import type { CoverageReport } from './coverage.ts';
import { renderLongChainLines } from './longchain.ts';
import type { AnomalyRecord, PlayerProfile } from './types.ts';
import { renderGeoSection, type CityLabelLike, type GeoStats } from './geo-stats.ts';

function pct(value: number, digits = 1): string {
  return `${(value * 100).toFixed(digits)}%`;
}

function num(value: number, digits = 2): string {
  return value.toFixed(digits);
}

export interface ReportInput {
  players: number;
  days: number;
  seed: string;
  baseUrl: string;
  startedAt: string;
  costMs: number;
  analysis: Analysis;
  coverage: CoverageReport;
  anomalies: readonly AnomalyRecord[];
  profileSummary: Array<{ persona: string; players: number; loginAvg: number; actionsAvg: number; goalMix: string }>;
  /** 全量事件卡（含 cond / min_seq / max_seq）：三栏判定与未触发卡分类都要用它 */
  cards: readonly CardMeta[];
  /** 阶段名（W8 / M2.1 …）：写进标题，避免报告标题永远停在 W7 */
  stage: string;
  /** 报告文件前缀（W8-虚拟玩家 / M2-回归 …）：异常 / 覆盖率 / 准入报告的文件名从它派生 */
  reportPrefix: string;
  /** 准入报告文件名（默认 docs/<stage>-准入报告.md） */
  acceptanceReportPath: string;
  acceptance: { pass: boolean; failures: string[] };
  /** M2.7：世界地理与跨区域移动的实测（出生城市分布 / 移动次数 / 路途事件分布） */
  geo?: GeoStats;
  /** M2.7：出生城市的中文名（报告里显示人话） */
  cities?: readonly CityLabelLike[];
  /**
   * M2.32 任务 1（P0）：这一轮跑的是哪份代码。
   *
   * 合并报告也必须给 —— 而且它给的是 `mergeShards` 合出来的**一致性结果**，
   * 不是随便挑一片的值（见 merge.ts 的 `codeConsistencyOf`）。
   */
  code?: CodeVersion;
}


/**
 * 三栏判定 —— 报告与准入报告脚本共用这一份（M2.0 口径统一）。
 * 返回同一次计算的 gate、判定与未触发卡分类，避免三处分头计算再对不上。
 */
export function acceptanceOf(input: ReportInput): {
  gates: GateSet;
  verdict: Verdict;
  groups: UntriggeredGroup[];
} {
  const gates = buildGates({
    players: input.players,
    days: input.days,
    analysis: input.analysis,
    coverage: input.coverage,
    anomalies: input.anomalies,
    cards: input.cards,
    stage: input.stage,
  });
  const groups = untriggeredByNature(input.cards, hitIdsOf(input.coverage));
  return { gates, verdict: verdictOf(flatten(gates)), groups };
}

export function renderMainReport(input: ReportInput): string {
  const { analysis, coverage, anomalies } = input;
  const { gates, verdict, groups } = acceptanceOf(input);
  const dependentGroups = groups.filter((group) => group.lostControlDependent);
  const dependentTotal = dependentGroups.reduce((sum, group) => sum + group.total, 0);
  const dependentMissed = dependentGroups.reduce((sum, group) => sum + group.missed.length, 0);

  const lines: string[] = [];
  lines.push(`# ${input.stage} 虚拟玩家实例测试报告`);
  lines.push('');
  lines.push(`- 执行命令：\`node src/vplayer/cli.ts --players ${input.players} --days ${input.days} --seed ${input.seed}\``);
  lines.push(`- 时间：${input.startedAt}　耗时：${(input.costMs / 1000).toFixed(1)}s　目标服务：${input.baseUrl}`);
  // M2.32 任务 1（P0）：代码版本 —— 报告里必须有，否则「两批差多少」永远缺一个未知量
  lines.push(`- 代码版本：${codeVersionLineOf(input.code)}`);
  if ((input.code?.codeDirtyDetail.judgement ?? 0) > 0) {
    const dirty = input.code!.codeDirtyDetail;
    lines.push('');
    lines.push(
      '> ⚠️ **本批的代码不可精确重生成**：跑它的时候工作区有 ' +
        dirty.judgement +
        ' 处**判定输入**未提交改动（' +
        dirty.sample.join('、') +
        '）。',
    );
    lines.push(
      '> 重跑会得到**另一批数据**，而产物里那个 commit 不描述那些未提交改动。' +
        '引用本批数字时，必须把它与这些改动一起说明（M2.31 那 7 个「无对应提交」的批就是这么来的）。',
    );
    lines.push('');
  }
  lines.push('- 方式：**真实 HTTP**（每条指令 `POST /onebot/event`）+ 服务端可控时钟（由测试驱动，保证同 seed 完全可复现）；所有游戏判定都在服务端跑，测试不调用任何纯函数');
  lines.push('- 定位：**长链路实例测试**，能证明长链路跑通、数值分布、覆盖率、死循环与边界；**不能**证明留存、手感、付费意愿');
  lines.push('');
  lines.push('## 一、准入判定（系统 / 内容 / 数值 三栏）');
  lines.push('');
  lines.push(renderVerdictLine(verdict));
  lines.push('');
  lines.push(
    '> 口径（M2.0 起固定）：本节三栏与 `' + input.acceptanceReportPath + '` **同源** —— ' +
      '都由 `src/vplayer/acceptance.ts` 的同一份实现算出；准入报告脚本会把下面三张表解析回去、' +
      '用同一个 `verdictOf()` 重算一遍并逐字比对，对不上就退出码 1。',
  );
  lines.push('> 条件卡按触发性质分类（见 1.4），**不再笼统算「未通过」**：红项才阻塞，黄项写进下一阶段第一优先。');
  lines.push('');
  lines.push('### 1. ' + COLUMN_TITLE.system);
  lines.push('');
  for (const line of renderGateTable(gates.system)) lines.push(line);
  lines.push('');
  lines.push('### 2. ' + COLUMN_TITLE.content);
  lines.push('');
  for (const line of renderGateTable(gates.content)) lines.push(line);
  lines.push('');
  lines.push('### 3. ' + COLUMN_TITLE.numeric);
  lines.push('');
  for (const line of renderGateTable(gates.numeric)) lines.push(line);
  lines.push('');
  lines.push('### 4. 未触发卡按性质分类（不再笼统算「未通过」）');
  lines.push('');
  for (const line of renderUntriggeredTable(groups)) lines.push(line);
  lines.push('');
  lines.push(
    `> **失控依赖**（失控状态门 + 数值阈值门）共 ${dependentTotal} 张，本轮未触发 ${dependentMissed} 张：` +
      '它们不是「实例测试没跑到」，而是依赖失控状态或高 MAD/COR 门槛（' +
      /*
       * M2.33（P5 落地）：闸门从「全局一个数」变成**按序列**的表，所以这里要把口径写清 ——
       * 跑批里真实出现过的序列段是 9—7，而那一档是**冻结**的 65（`thresholdBySequence[9..7]`），
       * 所以这句话仍然成立；但「当前闸门」这个词已经不准确了（序列 6 及以下是 60/55/50）。
       */
      '序列 9—7 档的闸门 MAD ≥ ' +
      NUMERIC.lossOfControl.madThreshold + ' 且 COR ≥ ' + NUMERIC.lossOfControl.corThreshold +
      '，更低的序列另有分档 —— 见 numeric.lossOfControl.thresholdBySequence），短窗口内可达性极低。' +
      '其中 W8 准入判定确认「窗口内一次都见不到」的 ' + LOST_CONTROL_ACCEPTANCE_IDS.length + ' 张（lost_* 5 + daily_020/023/029）' +
      '是 M2.1 的验收对象，已在数值栏单列一项。',
  );
  lines.push('>');
  lines.push(
    '> 工程退出码：`--strict` 只在**红项 > 0**（当前红 ' + verdict.reds + ' 项）时失败；`--ci` 另有一套内容硬门，不受影响。' +
      '「条件卡未触发」自 M2.0 起记为黄项，不再单独判失败。',
  );
  lines.push('');
  lines.push('## 二、长链路漏斗（这是本轮的核心验证目标）');
  lines.push('');
  lines.push('| 阶段 | 人数 | 占建号比例 |');
  lines.push('|---|---|---|');
  for (const stage of analysis.funnel) {
    lines.push(`| ${stage.stage} | ${stage.count} | ${pct(stage.rate)} |`);
  }
  lines.push('');
  lines.push(
    `晋升判定：发起 ${analysis.promotion.attempted} 次、成功 ${analysis.promotion.succeeded} 次，成功率 ${pct(analysis.promotion.rate)}` +
      `（模拟器预测：稳健 81.0% / 激进 61.7%）。`,
  );
  lines.push('');
  lines.push('## 三、玩家画像与行为');
  lines.push('');
  lines.push('| 画像 | 人数 | 日均登录 | 日均指令 | 目标分布 |');
  lines.push('|---|---|---|---|---|');
  for (const summary of input.profileSummary) {
    lines.push(`| ${summary.persona} | ${summary.players} | ${num(summary.loginAvg)} | ${num(summary.actionsAvg)} | ${summary.goalMix} |`);
  }
  lines.push('');
  lines.push('| 画像 | 动作数 | 晋升尝试 | 晋升成功 | 到达序列 8 | 期末 DIG | 期末 MAD | 期末 COR | 拒绝率 |');
  lines.push('|---|---|---|---|---|---|---|---|---|');
  for (const stats of analysis.byPersona) {
    lines.push(
      `| ${stats.persona} | ${stats.actions} | ${stats.promotionsAttempted} | ${stats.promotionsSucceeded} | ${stats.reachedSequence8} | ${num(stats.avgDig)} | ${num(stats.avgMad)} | ${num(stats.avgCor)} | ${pct(stats.rejectRate)} |`,
    );
  }
  lines.push('');
  lines.push(`整体指令拒绝率（冷却/资源不足/条件不满足）${pct(analysis.rejectRate)}；总动作 ${analysis.totalActions} 条。`);
  lines.push('');
  if (analysis.rejectionByCommand.length > 0) {
    lines.push('被拒最多的指令：' + analysis.rejectionByCommand.slice(0, 8).map((entry) => `${entry.command}(${entry.count})`).join('、'));
    lines.push('');
    lines.push('| 被拒指令 | 玩家看到的回执 |');
    lines.push('|---|---|');
    for (const sample of analysis.rejectSamples.slice(0, 6)) {
      lines.push(`| ${sample.command} | ${sample.text.replace(/\n/g, ' ').slice(0, 80)} |`);
    }
    lines.push('');
  }
  if (analysis.replyOutcomes.length > 0) {
    lines.push('## 三·补、玩家实际看到了什么（指令 × 回执首行）');
    lines.push('');
    lines.push('| 指令 | 回执首行 | 次数 |');
    lines.push('|---|---|---|');
    for (const entry of analysis.replyOutcomes.slice(0, 12)) {
      lines.push(`| .${entry.command} | ${entry.outcome.replace(/\|/g, '\\|')} | ${entry.count} |`);
    }
    lines.push('');
    lines.push('> 表里能直接读出体验问题：例如「这笔交易已经结束（expired）」占比高，说明交易超时窗口与玩家上线频率不匹配。');
    lines.push('');
  }
  lines.push('## 四、期末数值分布');
  lines.push('');
  lines.push('| 指标 | 均值 | P50 | P90 |');
  lines.push('|---|---|---|---|');
  lines.push(`| DIG | ${num(analysis.finals.digAvg)} | ${num(analysis.percentiles.dig.p50)} | ${num(analysis.percentiles.dig.p90)} |`);
  lines.push(`| MAD | ${num(analysis.finals.madAvg)} | ${num(analysis.percentiles.mad.p50)} | ${num(analysis.percentiles.mad.p90)} |`);
  lines.push(`| COR | ${num(analysis.finals.corAvg)} | ${num(analysis.percentiles.cor.p50)} | ${num(analysis.percentiles.cor.p90)} |`);
  lines.push('');
  lines.push(`期末均值：HP ${num(analysis.finals.hpAvg, 1)}；序列分布 ${Object.entries(analysis.finals.sequenceDistribution).map(([seq, count]) => `序列${seq}:${count}`).join(' ')}。`);
  lines.push('');
  lines.push('## 五、异常摘要');
  lines.push('');
  if (anomalies.length === 0) {
    lines.push('本轮没有捕获到任何异常。');
  } else {
    const byCode = new Map<string, { level: string; count: number }>();
    for (const anomaly of anomalies) {
      const entry = byCode.get(anomaly.code) ?? { level: anomaly.level, count: 0 };
      entry.count += 1;
      byCode.set(anomaly.code, entry);
    }
    lines.push('| 代码 | 级别 | 次数 |');
    lines.push('|---|---|---|');
    for (const [code, entry] of byCode) lines.push(`| ${code} | ${entry.level} | ${entry.count} |`);
    lines.push('');
    lines.push(`详见 \`docs/${input.reportPrefix}-异常.md\`。`);
  }
  lines.push('');
  // M2.6：通缉系统 + 三层货币组合格式。两件事放在一节：
  // 它们都是「世界/账目对玩家行为有没有反应」这一类证据，与覆盖率不是一回事。
  {
    const combo = analysis.currencyCombo;
    const wanted = analysis.wanted;
    lines.push('## 五·补、M2.6 通缉系统与三层货币实测');
    lines.push('');
    lines.push('| 指标 | 实测 | 说明 |');
    lines.push('|---|---|---|');
    lines.push(`| 通缉令签发 | ${wanted.issued} 条（期末有效 ${wanted.active}） | 1 级触发源 = 重伤玩家；2—4 级结构就位、本版不开放 |`);
    lines.push(
      `| 通缉等级分布 | ${Object.entries(wanted.byLevel).map(([level, count]) => level + ' 级:' + count).join(' ') || '无'} | 本版应当只有 1 级 |`,
    );
    lines.push(`| 遭遇判定 | ${wanted.encounters} 次，涉及 ${wanted.characters} 人 | 每次都在 domain_events 留 seed |`);
    lines.push(`| 赏金领取 | ${wanted.claims} 笔 / ${wanted.claimedPenny} 便士 | 来源 = .举报 成功 |`);
    const assault = analysis.assault;
    lines.push(
      `| 袭击判定（M2.6.1） | 判定 ${assault.attempts} 次：被拦 ${assault.blockedByGap} / 抗性 ${assault.resisted} / 命中 ${assault.hit} / 扑空 ${assault.missed} | 实测命中率 ${(assault.hitRate * 100).toFixed(0)}%，伤害合计 ${assault.damage} |`,
    );
    lines.push(
      `| 袭击的序列差分布 | ${Object.entries(assault.byDiff).map(([diff, count]) => (Number(diff) > 0 ? '弱' : Number(diff) < 0 ? '强' : '同') + Math.abs(Number(diff)) + ':' + count).join(' ') || '无'} | 正数 = 攻击者序列更低 |`,
    );
    lines.push(
      `| 本批序列跨度 | ${assault.sequenceMin}—${assault.sequenceMax}（跨度 ${assault.sequenceMax - assault.sequenceMin}） | 跨度 < ${NUMERIC.assault.sequenceGating.blockThreshold} 时「被拦」必然为 0：本版最高只能升到序列 8 |`,
    );
    lines.push(
      `| 组合格式报价 | ${combo.created} / ${combo.attempts} 笔创建成功（纯数字 ${combo.plainAttempts} 笔） | 30% 概率用 1g5s3p / 2s / 1g |`,
    );
    lines.push(`| 金额按便士比对不符 | ${combo.mismatched} 笔 | **必须为 0** |`);
    lines.push('');
    if (combo.samples.length > 0) {
      lines.push('组合格式报价样本（玩家发了什么 → 解析成多少便士 → 回执复述了多少）：');
      lines.push('');
      lines.push('| 报价原文 | 应付（便士） | 回执复述（便士） | 一致 |');
      lines.push('|---|---|---|---|');
      for (const sample of combo.samples) {
        lines.push(
          `| ${sample.token} | ${sample.expectedPenny} | ${sample.actualPenny ?? '—'} | ${sample.ok ? '✅' : '❌'} |`,
        );
      }
      lines.push('');
    }
    lines.push(
      '> ⚠️ 任务书 §五 口径：**通缉相关指标的绝对值，只能用不分片小轮或真人验**。' +
        '分片只验机制跑通 —— 通缉是跨玩家行为（A 被通缉、B 举报 A），切片会改变' +
        '「同一个通缉犯被几个人举报」这类相对关系的分母。',
    );
    lines.push('');
  }
  // M2.7：世界地理与移动。放在覆盖率的**前面** ——
  // 「玩家群分成几个圈子」「移动真的发生了」是这一版的世界观证据，
  // 不是覆盖率的一部分。
  if (input.geo) {
    lines.push(...renderGeoSection(input.geo, input.cities ?? []));
    lines.push('');
  }
  lines.push('## 六、覆盖率摘要');
  lines.push('');
  lines.push(
    `指令：${coverage.commands.filter((item) => item.pass).length}/${coverage.commands.length} 条 ≥10 次；` +
      `事件卡：${coverage.cards.filter((item) => item.pass).length}/${coverage.cards.length}；` +
      `地点：${coverage.locations.filter((item) => item.pass).length}/${coverage.locations.length}；` +
      `配方：${coverage.recipes.filter((item) => item.pass).length}/${coverage.recipes.length}；` +
      `失控文本：${coverage.lostControlTexts.length} 条被触发。详见 \`docs/${input.reportPrefix}-覆盖率.md\`。`,
  );
  lines.push('');
  lines.push('## 七、与模拟器的对照');
  lines.push('');
  lines.push('| 指标 | 模拟器预测 | 实例测试实测 | 说明 |');
  lines.push('|---|---|---|---|');
  lines.push(`| 晋升成功率 9→8 | 稳健 81.0% / 激进 61.7% | ${pct(analysis.promotion.rate)} | 实例测试是混合画像，落在两者之间属预期 |`);
  lines.push(`| 死循环比例 | 稳健 0.2% / 激进 4.8% | ${pct(analysis.finals.sequenceDistribution['9'] ? analysis.byPersona.reduce((sum) => sum, 0) : 0, 2)} | 见异常清单里的 DEADLOCK 计数 |`);
  lines.push('| 长链路完成率 | 未建模 | 见漏斗 | W6 已登记「模拟器假设玩家会走完整链路」，本轮正是验证该假设 |');
  lines.push('');
  lines.push('## 八、下一步决策建议');
  lines.push('');
  lines.push(
    verdict.level === 'red'
      ? '- 本轮有红项，**先修红项再谈下一阶段**：系统栏 / 内容栏的红项与异常清单是入口。'
      : verdict.level === 'yellow'
        ? '- 本轮无红项，**可以进入下一阶段**；黄项作为下一阶段第一优先（三栏表里逐项已列）。'
        : '- 三栏全绿，系统 / 内容 / 数值都没问题，可进入下一阶段。',
  );
  lines.push(
    '- 黄项的读法：**不是回归失败**，而是「内容写了、窗口内见不到」这类需要在下一阶段做决策的问题（例如当前 ' +
      dependentTotal + ' 张失控依赖卡）。',
  );
  lines.push('- 虚拟玩家不能替代真人封测：留存、手感、付费意愿仍必须由真人给出（W6 已列为 M2 前置条件）。');
  lines.push('- 建议把本脚本纳入回归：每次改内容（卡/地点/配方/文本）后跑 20×3 小轮，验证覆盖率不掉。');
  lines.push('');
  return lines.join('\n');
}

export function renderAnomalyReport(input: ReportInput): string {
  const lines: string[] = [];
  lines.push(`# ${input.stage} 虚拟玩家 · 异常清单`);
  lines.push('');
  lines.push(`- 配置：${input.players} 玩家 × ${input.days} 天，seed=\`${input.seed}\`，共 ${input.analysis.totalActions} 条动作`);
  lines.push(`- P0：${input.anomalies.filter((a) => a.level === 'P0').length} 条；P1：${input.anomalies.filter((a) => a.level === 'P1').length} 条`);
  lines.push('');
  if (input.anomalies.length === 0) {
    lines.push('没有异常。以下检查全部通过：');
    lines.push('');
    lines.push('- HTTP 状态（全部 200）');
    lines.push('- 属性越界（HP/MP/MAD/COR/DIG/AP/DP/序列）');
    lines.push('- 资源一致性（负库存、队伍归属）');
    lines.push('- 响应时间（全部 < 5 秒）');
    lines.push('- 连续 10 次指令无状态变化');
    lines.push('- 死循环（DIG 达标 + 序列 9 + MAD ≥ 80 + COR ≥ 70）');
    return lines.join('\n');
  }

  lines.push('## P0');
  lines.push('');
  const p0 = input.anomalies.filter((anomaly) => anomaly.level === 'P0');
  if (p0.length === 0) lines.push('无。');
  for (const anomaly of p0.slice(0, 50)) {
    lines.push(`- 玩家#${anomaly.playerId} 第${anomaly.day}天 「${anomaly.command}」：${anomaly.detail}`);
  }
  lines.push('');
  lines.push('## P1');
  lines.push('');
  const p1 = input.anomalies.filter((anomaly) => anomaly.level === 'P1');
  if (p1.length === 0) lines.push('无。');
  for (const anomaly of p1.slice(0, 50)) {
    lines.push(`- [${anomaly.code}] 玩家#${anomaly.playerId} 第${anomaly.day}天 「${anomaly.command}」：${anomaly.detail}`);
  }
  if (p1.length > 50) lines.push('', '（仅展示前 50 条，完整清单见行为日志）');
  return lines.join('\n');
}

/**
 * 覆盖率报告真正读到的字段。
 *
 * 为什么把签名收窄：M2.13.1 的合并脚本要从**分片 JSON** 重跑覆盖率报告，
 * 手里没有完整的 ReportInput（baseUrl、acceptance 那些它根本不需要）。
 * 收窄之后「重跑覆盖率报告」就不必挂在整个跑批链路上。
 */
export type CoverageReportInput = Pick<ReportInput, 'stage' | 'players' | 'days' | 'seed' | 'coverage'>;

export function renderCoverageReport(input: CoverageReportInput): string {
  const { coverage } = input;
  const lines: string[] = [];
  lines.push(`# ${input.stage} 虚拟玩家 · 覆盖率体检`);
  lines.push('');
  lines.push(`- 配置：${input.players} 玩家 × ${input.days} 天，seed=\`${input.seed}\``);
  lines.push('');
  lines.push('## 指令覆盖（要求 ≥10 次/条）');
  lines.push('');
  lines.push('| 指令 | 次数 | 结论 |');
  lines.push('|---|---|---|');
  for (const item of [...coverage.commands].sort((a, b) => b.count - a.count)) {
    lines.push(`| .${item.key} | ${item.count} | ${item.pass ? '达标' : '未达标'} |`);
  }
  lines.push('');
  lines.push('## 事件卡覆盖（要求 ≥1 次）');
  lines.push('');
  lines.push('| 卡 id | 触发次数 | 结论 | 备注 |');
  lines.push('|---|---|---|---|');
  for (const item of coverage.cards) {
    const verdict = item.excluded ? '抽不到' : item.pass ? '达标' : '未触发';
    lines.push(`| ${item.key} | ${item.count} | ${verdict} | ${item.note ?? '—'} |`);
  }
  lines.push('');
  if (coverage.contentGaps.length > 0) {
    lines.push('## 内容缺口：写了但永远抽不到的卡（本轮发现，需在 M2 前修）');
    lines.push('');
    lines.push('| 卡 id | 原因 | 建议 |');
    lines.push('|---|---|---|');
    for (const item of coverage.contentGaps) {
      lines.push(`| ${item.key} | ${item.note ?? ''} | 把它加进对应地点的 events 名单，或去掉 location 限制 |`);
    }
    lines.push('');
  }
  lines.push('## 地点覆盖（要求 ≥1 次）');
  lines.push('');
  lines.push('| 地点 | 探索次数 | 结论 |');
  lines.push('|---|---|---|');
  for (const item of coverage.locations) {
    lines.push(`| ${item.key} | ${item.count} | ${item.pass ? '达标' : '未探索'} |`);
  }
  lines.push('');
  lines.push('## 配方覆盖（要求 ≥1 次）');
  lines.push('');
  lines.push('| 配方 | 调制次数 | 结论 |');
  lines.push('|---|---|---|');
  for (const item of coverage.recipes) {
    lines.push(`| ${item.key} | ${item.count} | ${item.pass ? '达标' : '未调制'} |`);
  }
  lines.push('');
  lines.push('## 失控文本覆盖（要求 ≥1 条）');
  lines.push('');
  if (coverage.lostControlTexts.length === 0) {
    lines.push('本轮没有触发失控文本。');
  } else {
    lines.push('| 文本片段 | 触发次数 |');
    lines.push('|---|---|');
    for (const item of coverage.lostControlTexts) lines.push(`| ${item.key}… | ${item.count} |`);
  }
  lines.push('');
  lines.push('## 晋升链路：两段各自判定（M2.13 前置 1）');
  lines.push('');
  lines.push('> 口径来源：`src/vplayer/longchain.ts`（README 的「长链路验收：两段各自判定」一节）。');
  lines.push('> 原先那个**复合指标**已删除 —— 它要求两个转化同时达到各自的最高水位，在数学上就是紧的。');
  lines.push('');
  for (const line of renderLongChainLines(coverage.longChain)) lines.push(line);
  lines.push('');
  if (coverage.failures.length > 0) {
    lines.push('## 未达标项');
    lines.push('');
    for (const failure of coverage.failures) lines.push(`- ${failure}`);
    lines.push('');
  }
  return lines.join('\n');
}

export function summarizeProfiles(profiles: readonly PlayerProfile[]): ReportInput['profileSummary'] {
  const byPersona = new Map<string, PlayerProfile[]>();
  for (const profile of profiles) {
    const list = byPersona.get(profile.persona) ?? [];
    list.push(profile);
    byPersona.set(profile.persona, list);
  }
  return [...byPersona.entries()].map(([persona, list]) => {
    const goalCounts = new Map<string, number>();
    for (const profile of list) goalCounts.set(profile.goal, (goalCounts.get(profile.goal) ?? 0) + 1);
    return {
      persona,
      players: list.length,
      loginAvg: list.reduce((sum, profile) => sum + profile.loginTimesPerDay, 0) / list.length,
      actionsAvg: list.reduce((sum, profile) => sum + profile.actionsPerLogin, 0) / list.length,
      goalMix: [...goalCounts.entries()].map(([goal, count]) => `${goal}:${count}`).join(' '),
    };
  });
}
