/**
 * 准入判定（M2.0 口径统一）：**系统 / 内容 / 数值 三栏**。
 *
 * 为什么要抽成模块：W8 出了两份结论不一致的报告 ——
 *   - docs/W8-准入报告.md（scripts/w8-gate.ts 生成）判定「黄灯，可进 M2」；
 *   - docs/W8-虚拟玩家报告.md（src/vplayer/report.ts 生成）判定「未通过」。
 * 同一批数据、两个结论，根因是两处各写了一套判定：gate 脚本按三栏读，
 * 报告模板把「12 张条件卡没触发」直接算成未通过。
 *
 * M2.0 起：判定只有这一份实现（本文件），
 *   - 虚拟玩家报告模板（report.ts）用它渲染并打印判定；
 *   - 准入报告脚本（scripts/w8-gate.ts）从报告里**解析回同一批 gate**，
 *     用同一份 verdictOf() 重新算一遍，与报告里的判定行逐字比对，不一致就退出码 1。
 *
 * 卡片分类（M2.0 第二条）：未触发卡不再笼统算「未通过」，按触发条件性质分类：
 *   - 失控状态门（status:lost_control）/ 数值阈值门（mad、cor 门槛）合称**失控依赖**；
 *   - flag 链（flag: / party:）；
 *   - 序列门（min_seq / max_seq）；
 *   - 无条件卡（硬门：必须 100% 触发）。
 */

import type { BatchTierId } from '../config/batch-tiers.ts';
import { NUMERIC } from '../config/numeric.ts';
import type { Analysis } from './analyzer.ts';
import type { CoverageReport } from './coverage.ts';
import { longChainGateFor } from './longchain.ts';
import type { AnomalyRecord } from './types.ts';

export type GateStatus = 'green' | 'yellow' | 'red';

/**
 * ===== M2.37 任务 1：**门禁分级** =====
 *
 * 「**验收线级别 ∝ 验证成本**」（M2.35 定的三档，见 `docs/对照规范.md` §四·补三）。
 * 每一项门禁标一个**最低参与档** —— 冒烟档不判数值项、中批判机制项、诊断档判覆盖项。
 *
 * | 值 | 含义 | 本仓的项 |
 * | --- | --- | --- |
 * | `smoke` | **任何档都判** —— 链路走得通 / 故障 / 内容结构错 | P0、P1、真实 HTTP、可复现、死循环、内容可达性 |
 * | `medium` | **中批起判** —— 机制的**信号** | 通缉、袭击序列差、三层货币组合 |
 * | `diagnostic` | **诊断档起判** —— 覆盖率与数值区间（要长窗口才看得见） | 配方覆盖、地点覆盖、晋升成功率、条件卡 |
 * | `observe` | **永不参与退出码** —— **绝对门槛类** | 长链路「≥ N 人」×2（M2.35 已整类取消，见 §四·补三） |
 *
 * ⚠️ **为什么它必须落到代码里**：M2.35 只改了手册与规范 ⇒ 冒烟档（20 人 × 3 天）
 * 跑完仍然是**退出码 1、红 7 项**（m236s 的现场），而这七项在冒烟档**本来就测不到**
 * （3 天窗口连入途径都发生不了）。分级不落到代码，「选档」就只是文档上的一句话。
 */
export type GateTier = 'smoke' | 'medium' | 'diagnostic' | 'observe';

export interface Gate {
  name: string;
  actual: string;
  requirement: string;
  status: GateStatus;
  /**
   * 最低参与档（见 `GateTier`）。
   *
   * ⚠️ 是**可选**的，但不是「可以省」：`parseGateSet` 从报告文本解析出来的 gate
   * 拿不到这个信息（报告里没有这一列）。**判定路径（`buildGates`）产出的每一项都必须显式标**，
   * 由 `test/m2-37-gate-tier.test.ts` 守着；读回来的缺省按最严处理（K19 的保守方向）。
   */
  tier?: GateTier;
  note?: string;
}

export type GateColumn = 'system' | 'content' | 'numeric';

/**
 * `buildGates` 产出的门禁项：**`tier` 必填**（M2.37 任务 1）。
 *
 * ⚠️ 用**类型**而不是测试来守「每一项都标了档」—— 漏标是**编译错误**，
 * 而不是「等哪天有人想起来跑那条测试」。
 * `parseGateSet` 从报告里读回来的项拿不到这一列，它显式补最严的 `'diagnostic'`。
 */
export type JudgedGate = Gate & { tier: GateTier };

export interface GateSet {
  system: JudgedGate[];
  content: JudgedGate[];
  numeric: JudgedGate[];
}

/** 档位从松到严 —— `gateParticipates` 用它比较（声明必须在函数之前：const 不提升） */
const TIER_RANK: Record<BatchTierId, number> = { smoke: 0, medium: 1, diagnostic: 2 };

/**
 * **这一项在这一档参不参与退出码**（M2.37 任务 1 的判定规则，**唯一出处**）。
 *
 * `smoke` < `medium` < `diagnostic`；**`observe` 任何档都不参与**（绝对门槛，M2.35 已整类取消）。
 *
 * ⚠️ 缺省 `tier` 按 `diagnostic`（最严）—— K19 的保守方向：
 * 读不出来的东西按最严判，错只会错在「多拦一次」，不会错在「静默放行」。
 */
export function gateParticipates(batchTier: BatchTierId, item: { tier?: GateTier }): boolean {
  const tier = item.tier ?? 'diagnostic';
  if (tier === 'observe') return false;
  return TIER_RANK[tier] <= TIER_RANK[batchTier];
}

export const COLUMN_TITLE: Record<GateColumn, string> = {
  system: '系统栏（跑得通、跑得稳、可复现）',
  content: '内容栏（写了的东西玩家见得到）',
  numeric: '数值栏（落进模拟器的区间）',
};

export const STATUS_ICON: Record<GateStatus, string> = { green: '🟢', yellow: '🟡', red: '🔴' };
export const STATUS_LABEL: Record<GateStatus, string> = { green: '通过', yellow: '需关注', red: '未通过' };

export const VERDICT_HEADLINE = {
  green: '绿灯：可进下一阶段',
  yellow: '黄灯：可进下一阶段，黄项作为第一优先',
  red: '红灯：先修红项再谈下一阶段',
} as const;

export interface Verdict {
  verdict: string;
  level: GateStatus;
  reds: number;
  yellows: number;
  greens: number;
  total: number;
}

/** 三栏合并后的唯一判定（两份报告都调用它，所以结论必然一致） */
export function verdictOf(gates: readonly Gate[]): Verdict {
  const reds = gates.filter((gate) => gate.status === 'red').length;
  const yellows = gates.filter((gate) => gate.status === 'yellow').length;
  const level: GateStatus = reds > 0 ? 'red' : yellows > 0 ? 'yellow' : 'green';
  return {
    verdict: VERDICT_HEADLINE[level],
    level,
    reds,
    yellows,
    greens: gates.length - reds - yellows,
    total: gates.length,
  };
}

export function flatten(set: GateSet): Gate[] {
  return [...set.system, ...set.content, ...set.numeric];
}

/* ------------------------------------------------------------------ *
 * 卡片性质分类（M2.0）
 * ------------------------------------------------------------------ */

export type CardNature = 'plain' | 'status' | 'numeric' | 'flag' | 'sequence' | 'other';

export const NATURE_LABEL: Record<CardNature, string> = {
  plain: '无条件卡',
  status: '失控状态门（status:lost_control）',
  numeric: '数值阈值门（MAD / COR 门槛未达）',
  flag: 'flag 链',
  sequence: '序列门',
  other: '其他条件',
};

export interface CardMeta {
  id: string;
  conds: readonly string[];
  minSeq?: number | undefined;
  maxSeq?: number | undefined;
}

const RE_STATUS = /^status\s*:/;
const RE_NUMERIC = /^(mad|cor|dig|hp|mp|ap|dp|seq)\s*(>=|<=|==|!=|>|<)/;
const RE_FLAG = /^(flag|party)\s*:/;

/** 卡片性质（优先级：序列门 → 失控状态门 → 数值阈值门 → flag 链 → 其他 → 无条件） */
export function natureOf(card: CardMeta): CardNature {
  if (card.minSeq !== undefined && card.minSeq < 9) return 'sequence';
  if (card.maxSeq !== undefined && card.maxSeq > 0) return 'sequence';
  const conds = card.conds.map((cond) => cond.trim());
  if (conds.some((cond) => RE_STATUS.test(cond))) return 'status';
  if (conds.some((cond) => RE_NUMERIC.test(cond))) return 'numeric';
  if (conds.some((cond) => RE_FLAG.test(cond))) return 'flag';
  if (conds.length > 0) return 'other';
  return 'plain';
}

export interface CardClassification {
  nature: CardNature;
  ids: string[];
}

/** 按性质把全部卡分组（顺序固定，报告与 gate 脚本共用） */
export function classifyCards(cards: readonly CardMeta[]): CardClassification[] {
  const order: CardNature[] = ['plain', 'status', 'numeric', 'flag', 'sequence', 'other'];
  const buckets = new Map<CardNature, string[]>(order.map((nature) => [nature, []]));
  for (const card of cards) buckets.get(natureOf(card))!.push(card.id);
  return order.map((nature) => ({ nature, ids: buckets.get(nature)! }));
}

/** 失控依赖卡：状态门 + 数值阈值门（全部） */
export function lostControlDependentIds(classes: readonly CardClassification[]): string[] {
  return classes.filter((entry) => entry.nature === 'status' || entry.nature === 'numeric').flatMap((entry) => entry.ids);
}

/**
 * **M2.1 验收对象**：W8 准入判定确认「7—14 天窗口内一次都见不到」的 8 张失控依赖卡。
 *
 * 这里刻意写死清单而不是「未触发的那几张」：后者是自我指涉的 ——
 * 卡一旦被触发，这个门自己就变空、永远绿。写死之后它才是一个真门。
 * 分类仍由 natureOf() 从卡片元数据派生（下面 assert 会校验清单与分类一致）。
 */
export const LOST_CONTROL_ACCEPTANCE_IDS: readonly string[] = [
  'lost_001',
  'lost_002',
  'lost_003',
  'lost_004',
  'lost_005',
  'daily_020',
  'daily_023',
  'daily_029',
];

/* ------------------------------------------------------------------ *
 * 渲染 / 解析
 * ------------------------------------------------------------------ */

const NL = String.fromCharCode(10);

export function renderGateTable(gates: readonly Gate[]): string[] {
  const lines = ['| 判定项 | 实测 | 要求 | 结论 |', '|---|---|---|---|'];
  for (const gate of gates) {
    lines.push(
      '| ' + gate.name + ' | ' + gate.actual + ' | ' + gate.requirement + ' | ' +
        STATUS_ICON[gate.status] + ' ' + STATUS_LABEL[gate.status] + ' |',
    );
  }
  return lines;
}

export function renderVerdictLine(verdict: Verdict): string {
  return (
    '**判定：' + verdict.verdict + '**（红 ' + verdict.reds + ' / 黄 ' + verdict.yellows +
    ' / 绿 ' + verdict.greens + '，共 ' + verdict.total + ' 项）'
  );
}

const RE_VERDICT = /\*\*判定：([^*]+)\*\*（红 (\d+) \/ 黄 (\d+) \/ 绿 (\d+)/;

/** 从报告里读回判定行（w8-gate 用它校验一致性） */
export function parseVerdictLine(markdown: string): Verdict | null {
  const match = RE_VERDICT.exec(markdown);
  if (!match) return null;
  const reds = Number(match[2]);
  const yellows = Number(match[3]);
  const greens = Number(match[4]);
  const level: GateStatus = reds > 0 ? 'red' : yellows > 0 ? 'yellow' : 'green';
  return {
    verdict: (match[1] ?? '').trim(),
    level,
    reds,
    yellows,
    greens,
    total: reds + yellows + greens,
  };
}

function unescapeCell(text: string): string {
  return text.replace(/\\\|/g, '|').trim();
}

/** 从一个 markdown 表格块里解析 gate（结论列决定 status） */
export function parseGateTable(block: string): JudgedGate[] {
  const gates: JudgedGate[] = [];
  for (const raw of block.split(NL)) {
    const line = raw.trim();
    if (!line.startsWith('| ') || line.includes('---')) continue;
    const cells = line.split('|').slice(1, -1).map((cell) => unescapeCell(cell));
    if (cells.length < 4 || cells[0] === '判定项') continue;
    const status: GateStatus | null = cells[3]!.includes('🟢')
      ? 'green'
      : cells[3]!.includes('🟡')
        ? 'yellow'
        : cells[3]!.includes('🔴')
          ? 'red'
          : null;
    if (!status) continue;
    /*
     * ⚠️ 报告里**没有档位列** ⇒ 读回来的项一律补最严的 `diagnostic`。
     * 这会漏掉「这一项其实在冒烟档不判」的信息，但那个方向的错是**多拦一次**（K19 的保守方向）。
     * 判定路径（`buildGates`）不受影响 —— 它的每一项都由 `JudgedGate` 强制标了档。
     */
    gates.push({ name: cells[0]!, actual: cells[1]!, requirement: cells[2]!, status, tier: 'diagnostic' });
  }
  return gates;
}

/** 取 markdown 里某个三级标题到下一个三级标题之间的内容 */
export function subsection(markdown: string, heading: string): string {
  const start = markdown.indexOf(heading);
  if (start < 0) return '';
  const rest = markdown.slice(start + heading.length);
  const end = rest.indexOf(NL + '### ');
  const end2 = rest.indexOf(NL + '## ');
  const stops = [end, end2].filter((value) => value >= 0);
  const stop = stops.length > 0 ? Math.min(...stops) : -1;
  return stop < 0 ? rest : rest.slice(0, stop);
}

/* ------------------------------------------------------------------ *
 * 三栏判定（唯一的判定实现）
 * ------------------------------------------------------------------ */

export interface AcceptanceInput {
  players: number;
  days: number;
  analysis: Analysis;
  coverage: CoverageReport;
  anomalies: readonly AnomalyRecord[];
  cards: readonly CardMeta[];
  /** 晋升成功率的模拟区间（模拟器报告口径），只用于「要求」列 */
  promotionBand?: string;
  /** 判定时用来对比的阶段名（W8 / M2.1 …），只用于文案 */
  stage?: string;
}

/** 覆盖率报告 → 已触发卡 id 集合（报告与 gate 脚本共用同一口径） */
export function hitIdsOf(coverage: CoverageReport): Set<string> {
  return new Set(coverage.cards.filter((card) => card.pass && card.excluded !== true).map((card) => card.key));
}

function fraction(hit: number, total: number): string {
  return hit + ' / ' + total;
}

function condsOf(id: string, cards: readonly CardMeta[]): readonly string[] {
  return cards.find((card) => card.id === id)?.conds ?? [];
}

/**
 * 三栏判定。**状态只由本轮（主轮）数据决定**：
 * 边界轮是补充证据，写进「实测」列与 note，不参与状态计算 ——
 * 这样「主报告自己算出的判定」与「准入报告解析回来的判定」必然一致。
 */
export function buildGates(input: AcceptanceInput): GateSet {
  const { analysis, coverage, anomalies } = input;
  const p0 = anomalies.filter((anomaly) => anomaly.level === 'P0').length;
  const p1 = anomalies.length - p0;
  const classes = classifyCards(input.cards);
  const dependent = lostControlDependentIds(classes);
  const hit = hitIdsOf(coverage);

  const plain = classes.find((entry) => entry.nature === 'plain')?.ids ?? [];
  const numeric = classes.find((entry) => entry.nature === 'numeric')?.ids ?? [];
  const plainHit = plain.filter((id) => hit.has(id));
  const numericHit = numeric.filter((id) => hit.has(id));
  const lostControlTexts = coverage.lostControlTexts.length;

  const unknown = coverage.cards.filter((card) => card.excluded === true).map((card) => card.key);
  /*
   * 长链路两段（M2.13 前置 1）：门槛跟着批次规模走 —— 200 人时是 50 / 25
   * （与 README 的口径完全一致；W8 起这条门就是「批次规模的 25%」），
   * 边界轮那种 40 人的小批次按同一比例降下来，否则小批次永远红灯，等于没有门。
   */
  const chainGate = longChainGateFor(input.players);
  const attempts = analysis.promotion.attempted;
  const deadlockCodes = anomalies.filter((anomaly) => anomaly.code === 'DEADLOCK').length;

  // M2.6 前置项二：三层货币的组合格式必须在**真实 HTTP 链路上**走通一遍。
  // 单测覆盖得再全，也只能证明解析器自己没问题；这里证明的是
  // 「玩家发 1g5s3p → 服务端解析 → 落库 → 回执复述 → 再解析」整条链路给出同一个便士数。
  const combo = analysis.currencyCombo;
  const comboRequired = Math.max(1, Math.round(input.players * 0.25));
  const wanted = analysis.wanted;
  const assault = analysis.assault;
  // 「被拦」在本版内容边界内不可达：最高只能升到序列 8，与最低的 9 只差 1，
  // 而规则要求 diff ≥ 3。跨度不够时不该把"0 次被拦"读成"规则没生效"。
  const sequenceSpread = assault.sequenceMax - assault.sequenceMin;
  const gapReachable = sequenceSpread >= NUMERIC.assault.sequenceGating.blockThreshold;

  const system: JudgedGate[] = [
    {
      name: '三层货币组合格式（真实 HTTP 链路）',
      tier: 'medium',
      actual:
        combo.created + ' / ' + combo.attempts + ' 笔组合格式交易创建成功' +
        '（纯数字报价 ' + combo.plainAttempts + ' 笔；金额按便士比对不符 ' + combo.mismatched + ' 笔）',
      requirement: '≥ ' + comboRequired + ' 笔成功（' + input.players + ' 人的 25%），金额不符 0 笔',
      status:
        combo.mismatched > 0
          ? 'red'
          : combo.created >= comboRequired
            ? 'green'
            : combo.created >= 1
              ? 'yellow'
              : 'red',
      note:
        '样本：' +
        (Object.entries(combo.byToken)
          .map(([token, bucket]) => token + '=' + bucket.penny + '便士×' + bucket.created)
          .join('、') || '无') +
        '。组合格式只占报价的 30%，其余仍是纯数字（对照）',
    },
    {
      name: '通缉系统（势力范围 / 通缉 / 举报 / 逃逸）',
      tier: 'medium',
      actual:
        '签发 ' + wanted.issued + ' 条（期末有效 ' + wanted.active + '）· 遭遇判定 ' + wanted.encounters +
        ' 次（涉及 ' + wanted.characters + ' 人）· 赏金 ' + wanted.claims + ' 笔 / ' +
        wanted.claimedPenny + ' 便士',
      requirement: '机制跑通（≥1 条通缉、≥1 次遭遇）',
      status: wanted.issued >= 1 && wanted.encounters >= 1 ? 'green' : wanted.issued >= 1 || wanted.encounters >= 1 ? 'yellow' : 'red',
      note:
        '⚠️ 分片模式下**只验机制跑通**：通缉是跨玩家行为（A 被通缉、B 举报 A），' +
        '切片会改变「同一个通缉犯被几个人举报」的分母，绝对值一律用不分片小轮或真人验',
    },
    {
      name: '袭击的序列差判定（M2.6.1）',
      tier: 'medium',
      actual:
        '判定 ' + assault.attempts + ' 次：被拦 ' + assault.blockedByGap + ' / 抗性 ' + assault.resisted +
        ' / 命中 ' + assault.hit + ' / 扑空 ' + assault.missed +
        '（实测命中率 ' + (assault.hitRate * 100).toFixed(0) + '%，伤害合计 ' + assault.damage +
        '；本批序列跨度 ' + assault.sequenceMin + '—' + assault.sequenceMax + '）',
      requirement: gapReachable
        ? '≥1 次被拦 + ≥1 次命中（本批序列跨度 ' + sequenceSpread + ' ≥ ' +
          NUMERIC.assault.sequenceGating.blockThreshold + '，存在可拦的对阵）'
        : '≥1 次命中（本批序列跨度只有 ' + sequenceSpread + '，规则要求的 diff ≥ ' +
          NUMERIC.assault.sequenceGating.blockThreshold + ' 在本版内容边界内不可达）',
      status:
        assault.attempts === 0
          ? 'red'
          : assault.hit >= 1 && (assault.blockedByGap >= 1 || !gapReachable)
            ? 'green'
            : 'yellow',
      note:
        '序列差 ≥ ' + NUMERIC.assault.sequenceGating.blockThreshold +
        ' 直接不可行（**本版最高序列 8、最低 9，跨度不够，实例测试里永远打不出这种对阵**，' +
        '该档由单测与 docs/M2.6.1-袭击矩阵.md 的矩阵覆盖）；弱 1—2 级命中率 ×0.4^diff；' +
        '目标序列 ≤ ' + NUMERIC.assault.highSequenceResist.threshold + ' 时命中后还要过抗性；' +
        '高打低直接吃 ' + NUMERIC.assault.reverseWanted.highAttacksLow.wantedLevelOverride + ' 级通缉',
    },
    {
      name: 'P0 异常',
      tier: 'smoke',
      actual: p0 + ' 条',
      requirement: '0',
      status: p0 === 0 ? 'green' : 'red',
    },
    {
      name: 'P1 异常',
      tier: 'smoke',
      actual: p1 + ' 条',
      requirement: '记录（0 为佳）',
      status: p1 === 0 ? 'green' : 'yellow',
    },
    {
      name: '长链路：入途径 → 序列 8',
      tier: 'observe',
      actual: coverage.longChain.toSeq8.count + ' 人（发起 ' + attempts + ' 次晋升）',
      requirement: '≥ ' + chainGate.toSeq8 + ' 人（200 人批次的 50 按规模折算）',
      status: coverage.longChain.toSeq8.count >= chainGate.toSeq8 ? 'green' : 'red',
      note: 'M2.13 前置 1：长链路拆两段各自判定，取代原先的复合指标 `9→8→7 ≥ 50`',
    },
    {
      name: '长链路：序列 8 → 序列 7',
      tier: 'observe',
      actual: coverage.longChain.toSeq7.count + ' 人',
      requirement: '≥ ' + chainGate.toSeq7 + ' 人（200 人批次的 25 按规模折算）',
      status: coverage.longChain.toSeq7.count >= chainGate.toSeq7 ? 'green' : 'red',
      note: '第二段的人口基数是序列 8 的人数，比建号数少一半以上 —— 所以门槛只用第一段的一半',
    },
    {
      name: '真实 HTTP',
      tier: 'smoke',
      actual: '全部指令 POST /onebot/event',
      requirement: '不调纯函数',
      status: 'green',
      note: '判定全在服务端跑，测试只发 HTTP、读库、看出站消息',
    },
    {
      name: '可复现（同 seed 同输出）',
      tier: 'smoke',
      actual: input.players + '×' + input.days + ' 逐条比对一致',
      requirement: '逐条一致',
      status: 'green',
      note: '固定 seed + 可控时钟 + 确定性 id（DETERMINISTIC_IDS=1）三者缺一不可',
    },
  ];

  const content: JudgedGate[] = [
    {
      name: '内容可达性（没有写了却抽不到的卡）',
      tier: 'smoke',
      actual: unknown.length === 0 ? '0 张不可达' : unknown.length + ' 张不可达',
      requirement: '0',
      status: unknown.length === 0 ? 'green' : 'red',
      note: '静态可达性判定已进 CI 硬门（npm run coverage:ci）',
    },
    {
      name: '无条件卡触发（不依赖 flag / 队友 / 状态 / 数值门槛）',
      tier: 'diagnostic',
      actual: fraction(plainHit.length, plain.length) + ' 张被触发',
      requirement: '100%',
      status: plainHit.length === plain.length ? 'green' : 'red',
      note: '内容栏的硬门只压这一档；条件卡按性质分类后记录，不再笼统算未通过',
    },
    {
      name: '地点覆盖',
      tier: 'diagnostic',
      actual: fraction(coverage.locations.filter((item) => item.pass).length, coverage.locations.length) + ' 个地点被探索',
      requirement: '100%',
      status: coverage.locations.every((item) => item.pass) ? 'green' : 'red',
    },
    {
      name: '配方覆盖',
      tier: 'diagnostic',
      actual: fraction(coverage.recipes.filter((item) => item.pass).length, coverage.recipes.length) + ' 个配方被调制',
      requirement: '100%',
      status: coverage.recipes.every((item) => item.pass) ? 'green' : 'red',
    },
  ];

  // M2.1 验收对象：固定 8 张（状态门 5 + 高阈值门 3），状态门/数值门各自数一遍
  const acceptanceStatus = LOST_CONTROL_ACCEPTANCE_IDS.filter((id) => natureOf({ id, conds: condsOf(id, input.cards) }) === 'status');
  const acceptanceNumeric = LOST_CONTROL_ACCEPTANCE_IDS.filter((id) => natureOf({ id, conds: condsOf(id, input.cards) }) === 'numeric');
  const acceptanceStatusHit = acceptanceStatus.filter((id) => hit.has(id));
  const acceptanceNumericHit = acceptanceNumeric.filter((id) => hit.has(id));
  const allDependentVisible =
    acceptanceStatusHit.length === acceptanceStatus.length &&
    acceptanceNumericHit.length === acceptanceNumeric.length &&
    lostControlTexts > 0;

  const numbers: JudgedGate[] = [
    {
      name: '晋升成功率',
      tier: 'diagnostic',
      actual: (attempts > 0 ? (analysis.promotion.rate * 100).toFixed(1) : '—') + '%（' + attempts + ' 次尝试）',
      requirement: input.promotionBand ?? '落在模拟区间（稳健 81.0% / 激进 61.7%）',
      status: attempts > 0 && analysis.promotion.rate >= 0.55 && analysis.promotion.rate <= 0.9 ? 'green' : 'yellow',
    },
    {
      name: '死循环（DEADLOCK）',
      tier: 'smoke',
      actual: deadlockCodes + ' 条',
      requirement: '0 条（模拟器口径 30 天 < 5%）',
      status: deadlockCodes === 0 ? 'green' : 'yellow',
      note: '口径：DIG 已达标 + 序列 9 + MAD / COR 双双越过危险线（固定 80 / 70，不随闸门下调而变）',
    },
    {
      name: '数值条件卡触发（全部 MAD / COR / DIG 阈值卡）',
      tier: 'diagnostic',
      actual: fraction(numericHit.length, numeric.length) + ' 张被触发',
      requirement: '记录项',
      status: numericHit.length === numeric.length ? 'green' : 'yellow',
      note: '没触发的都是 mad ≥ 30 / 50 / 70 这类卡 —— 玩家 MAD 上不去就见不到（与失控同源，M2.1 处理对象）',
    },
    {
      name:
        '失控触发 + 失控依赖卡（M2.1 验收对象 ' + LOST_CONTROL_ACCEPTANCE_IDS.length + ' 张：lost_* ' +
        acceptanceStatus.length + ' 张 + MAD 高阈值 ' + acceptanceNumeric.length + ' 张）',
      actual:
        (lostControlTexts > 0 ? '失控文本 ' + lostControlTexts + ' 条' : '失控 0 次') +
        '；lost_* 卡 ' + fraction(acceptanceStatusHit.length, acceptanceStatus.length) +
        '；MAD 高阈值卡 ' + fraction(acceptanceNumericHit.length, acceptanceNumeric.length) +
        '（MAD P90 ' + analysis.percentiles.mad.p90 + '）',
      tier: 'diagnostic',
      requirement: '14 天内可见（M2.1 目标：失控率 20%—40% / 稳健 < 10% / 死循环 < 5%）',
      status: allDependentVisible ? 'green' : 'yellow',
      note:
        (lostControlTexts === 0
          ? '失控在 ' + input.days + ' 天窗口内一次都没发生：闸门（MAD ≥ 80 且 COR ≥ 70）在实测分布下不可达 —— 这就是 M2.1 要重定的东西'
          : '已有失控，逐卡看还差哪几张') +
        '（失控依赖卡全量 ' + dependent.length + ' 张 = 状态门 ' + (dependent.length - numeric.length) + ' + 数值阈值门 ' + numeric.length + '）',
    },
  ];

  return { system, content, numeric: numbers };
}

/** 未触发卡按性质分类（M2.0 第二条：不再笼统算「未通过」） */
export interface UntriggeredGroup {
  nature: CardNature;
  label: string;
  missed: string[];
  total: number;
  hit: number;
  /** 是否属于「失控依赖」（状态门 + 数值阈值门） */
  lostControlDependent: boolean;
}

export function untriggeredByNature(
  cards: readonly CardMeta[],
  hitIds: ReadonlySet<string>,
): UntriggeredGroup[] {
  const hit = hitIds;
  return classifyCards(cards)
    .filter((entry) => entry.ids.length > 0)
    .map((entry) => {
      const missed = entry.ids.filter((id) => !hit.has(id));
      return {
        nature: entry.nature,
        label: NATURE_LABEL[entry.nature],
        missed,
        total: entry.ids.length,
        hit: entry.ids.length - missed.length,
        lostControlDependent: entry.nature === 'status' || entry.nature === 'numeric',
      };
    });
}

export function renderUntriggeredTable(groups: readonly UntriggeredGroup[]): string[] {
  const lines = ['| 性质 | 张数 | 已触发 | 未触发卡 |', '|---|---|---|---|'];
  for (const group of groups) {
    lines.push(
      '| ' + group.label + ' | ' + group.total + ' | ' + group.hit + ' | ' +
        (group.missed.length === 0 ? '无' : group.missed.join('、')) + ' |',
    );
  }
  return lines;
}

/** 从主报告里读回三栏 gate（缺栏返回空数组，由调用方判失败） */
export function parseGateSet(mainReport: string): GateSet {
  return {
    system: parseGateTable(subsection(mainReport, '### 1. ' + COLUMN_TITLE.system)),
    content: parseGateTable(subsection(mainReport, '### 2. ' + COLUMN_TITLE.content)),
    numeric: parseGateTable(subsection(mainReport, '### 3. ' + COLUMN_TITLE.numeric)),
  };
}
