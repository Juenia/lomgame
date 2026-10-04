/**
 * M2.35 任务 1：**链路检查器**（这一轮的核心）。
 *
 * ## 它为什么存在（三个坑，全部靠人发现）
 *
 * | 坑 | 现场 | 本模块的第几项抓它 |
 * | --- | --- | --- |
 * | **配方缺一层** | seq 7 缺失（M2.32）—— 内容「完成」是链路级的，而当时的检查是文件级的 | 第 1 项 |
 * | **配置没有读取点** | `sequenceGating.planned` 整张表没人读（M2.33 之前的 K19 标本） | 第 2 项 |
 * | **内容做完但跑批够不到** | 序列 6/5 内容做完，跑批一个都到不了（M2.29） | 第 3 项 |
 *
 * 三者的共同形状：**文件都在、校验都过、服务端起得来，而链路是断的**。
 * 文件级检查（schema / 交叉引用）对它们天然免疫 —— 所以要单独一个检查器，
 * 检查的是**链路**而不是**文件**。
 *
 * ## 判据的三条纪律
 *
 * 1. **判据与判定对象分离**：「内容做到哪一层」写在 `src/config/content-scope.ts`，
 *    不是从配方表自己推出来的（否则全途径一起漏一层时，缺口会被读成目标）。
 * 2. **不算的就不报**：第 3 项算的是**人数上界**（只含 `planned` 的累计乘积），
 *    不含 DIG 门槛、材料与天数 —— 所以它报「够不到」时是硬结论，
 *    报「够得到」时**不保证**真的够得到（实测只会更低）。措辞里写清了这一点。
 * 3. **一处定义（K22）**：档位从 `src/config/batch-tiers.ts` 读，梯度从 numeric.ts 读，
 *    本模块**一个数值都不写死**。
 *
 * ## 挂在哪
 *
 * `loadContent()` 调用它，error 级并入 `issues` ⇒ 服务端起不来（K17 的形状：
 * 内容层的错不该等到跑批才发现）。`scripts/content-diagnostics.ts` §4 打印完整剖面。
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BATCH_TIERS, STANDARD_TIER, type BatchTier } from '../config/batch-tiers.ts';
import { CONTENT_MAX_SEQUENCE, CONTENT_TARGET_SEQ } from '../config/content-scope.ts';
import { NUMERIC } from '../config/numeric.ts';
import { birthShares } from './birth-share.ts';
import { PATHWAY_ACTIONS, type PathwayAction } from '../domain/menu/pathway-actions.ts';
import { auditActionEffects, type ActionEffectAudit } from '../domain/menu/pathway-action-resolve.ts';
import { NARRATED_BEHAVIORS } from '../domain/creature/perception.ts';

export type LinkIssueLevel = 'error' | 'warn';

export interface LinkIssue {
  /**
   * 这条账挂在哪个文件上 —— 与 `DataIssue.file` 同形，这样它能直接并进 `loadContent()` 的 issues。
   *
   * ⚠️ 三项检查都**不是**「某个文件写错了」那么简单，所以这里的取值是**该由谁来修**：
   *   ① 配方缺一层 ⇒ `recipes.yaml`（补配方）；
   *   ② 配置没读取点 ⇒ `numeric.ts`（要么接读取点、要么删掉那张表）；
   *   ③ 跑批够不到 ⇒ `content-scope.ts`（内容目标与跑批规模要对齐 —— 或者按 §四·补二 换验法）。
   */
  file: string;
  /** 哪一项检查（用来分组与计数） */
  check:
    | 'recipe-coverage'
    | 'reader'
    | 'batch-reach'
    | 'action-effect'
    | 'creature-behavior'
    /** M2.71：地理内容的两条一致性判据（区域途径 / 城市势力） */
    | 'geo-consistency';
  level: LinkIssueLevel;
  message: string;
}

export interface RecipeDefLike {
  id: string;
  pathway: string;
  seq: number;
}

export interface LinkCheckInput {
  pathways: readonly string[];
  recipes: readonly RecipeDefLike[];
  cities: readonly unknown[];
  factions: readonly unknown[];
  churches: readonly { id: string; pathway?: string | null }[];
  /** M2.66 第 4 项：物种模板（读它的 `behaviors`） */
  creatures: readonly { id: string; behaviors: readonly { kind: string }[] }[];
  /** M2.71 第 5 项：区域（读 `pathways`）与城市（读 `factions` / `pathways` / `locations`） */
  regions: readonly { id: string; pathways: readonly string[] }[];
  geoCities: readonly {
    id: string;
    region_id: string;
    locations: readonly string[];
    factions: readonly string[];
    pathways: readonly string[];
  }[];
}

/* ================================================================== *
 * 第 1 项：每序列有配方
 * ================================================================== */

export interface RecipeCoverageRow {
  pathway: string;
  /** 该途径已有配方的 seq（降序） */
  have: number[];
  /** 目标区间内缺的 seq（降序） */
  missing: number[];
}

/**
 * 逐途径检查「目标区间 `[CONTENT_TARGET_SEQ, 9]` 内每一层都有配方」。
 *
 * ⚠️ **不是**检查「9—0 全齐」：序列 4—0 属于批次 B/C，缺它们是**计划**。
 * 目标由 `src/config/content-scope.ts` 给（唯一出处，K22）。
 */
export function checkRecipeCoverage(input: LinkCheckInput): {
  rows: RecipeCoverageRow[];
  issues: LinkIssue[];
} {
  const issues: LinkIssue[] = [];
  const rows: RecipeCoverageRow[] = [];
  const wanted: number[] = [];
  for (let seq = CONTENT_TARGET_SEQ; seq <= 9; seq += 1) wanted.push(seq);

  for (const pathway of input.pathways) {
    const have = input.recipes
      .filter((recipe) => recipe.pathway === pathway)
      .map((recipe) => recipe.seq)
      .sort((a, b) => b - a);
    const haveSet = new Set(have);
    const missing = wanted.filter((seq) => !haveSet.has(seq));
    rows.push({ pathway, have, missing });

    if (missing.length > 0) {
      issues.push({
        file: 'recipes.yaml',
        check: 'recipe-coverage',
        level: 'error',
        message:
          pathway + ' 缺序列 ' + missing.join('、') + ' 的配方（目标区间 ' + CONTENT_TARGET_SEQ + '—9）—— ' +
          '这条途径的玩家走到序列 ' + (Math.min(...missing) + 1) + ' 就**没有下一步**了：' +
          '晋升要 `c.seq === character.sequence` 的配方，缺一层就是链路断在那里。' +
          '【形状】M2.32 的 seq 7 缺 7 条，当时靠人翻配方表才发现（本项就是那个检查器）',
      });
    }
  }

  /*
   * 反向：**内容超前于目标**（有人做了比 CONTENT_TARGET_SEQ 更深的一层配方）。
   *
   * ⚠️ 这里原来写的是「内容没能做到目标」—— 那是一条**永远不触发**的死判据：
   * missing 为空 ⇒ 目标区间每一层都在 ⇒ 最深配方必然 ≤ 目标，条件恒 false（K14：装饰）。
   * 数学上它被上面那条完全覆盖，所以换成真正会响的那一侧。
   *
   * 它守的是「推目标」这一步别忘了：批次 B 做了 seq 4 的配方而不把 CONTENT_TARGET_SEQ
   * 从 5 推到 4，**新做的那一层就不在第 1 项的保护范围内** —— 它缺一层时检查器不会报，
   * 于是同一个坑（M2.32）在新的深度上重演一次。
   */
  for (const row of rows) {
    const deepest = Math.min(...row.have);
    if (!Number.isFinite(deepest) || deepest >= CONTENT_TARGET_SEQ) continue;
    issues.push({
      file: 'content-scope.ts',
      check: 'recipe-coverage',
      level: 'warn',
      message:
        row.pathway + ' 已经有 seq ' + deepest + ' 的配方，比内容目标 ' + CONTENT_TARGET_SEQ + ' 更深 —— ' +
        '请把 src/config/content-scope.ts 的 CONTENT_TARGET_SEQ 推到 ' + deepest +
        '（否则新做的那一层不在第 1 项的保护范围内：它缺一层时这里不会报）',
    });
  }

  return { rows, issues };
}

/* ================================================================== *
 * 第 2 项：配置有生产读取点
 * ================================================================== */

/**
 * 「必须有生产读取点」的配置清单 —— **一处定义（K22）**。
 *
 * ## 判据为什么是「源码里出现这个表达式」
 *
 * M2.28 的现场读数写着「`promotion.sequenceGating` 在 `src/` 里的引用**全是注释**」——
 * 那正是这个检查器要抓的形状。所以判据必须**先剥掉注释再搜**，
 * 否则注释本身就会被当成读取点（K14：抓不住故障的判据是装饰）。
 *
 * ## `pattern` 是完整路径，不是对象名
 *
 * 写成 `NUMERIC.promotion.sequenceGating` 的话，只读 `active` 的文件也会让它通过。
 * 要求写全路径的好处是**读法明确**；如果哪天把读取点重构成局部变量，
 * 请把本表一起改（那是一次有意识的口径变更，不是误报）。
 */
export interface RequiredReader {
  label: string;
  /** 必须在生产代码（已剥注释）里出现的正则源 */
  pattern: string;
  /** 定义处 —— 它自己不算读取点 */
  definition: string;
  /** 为什么它必须有读取点 */
  why: string;
}

export const REQUIRED_READERS: readonly RequiredReader[] = [
  {
    label: 'promotion.sequenceGating.planned',
    pattern: 'NUMERIC\\.promotion\\.sequenceGating\\.planned',
    definition: 'src/config/numeric.ts',
    why: 'K19 的标本：整张表有类型、有冻结测试、注释写着设计意图，就是没人读（M2.28 登记、M2.33 接上）',
  },
  {
    label: 'promotion.digLadder',
    pattern: 'NUMERIC\\.promotion\\.digLadder',
    definition: 'src/config/numeric.ts',
    why: 'P4 阶梯：写在表里但没人读的话，85/90/95 三档就只是注释（M2.33 任务 0 的现场读数）',
  },
  {
    label: 'longChain',
    pattern: 'NUMERIC\\.longChain',
    definition: 'src/config/numeric.ts',
    why: 'K22 的现场：门槛拍板改成 15，而 longchain.ts 里一直是硬编码的 25（M2.34 才对齐）',
  },
  {
    label: 'promotion.failMaterialLoss',
    pattern: 'NUMERIC\\.promotion\\.failMaterialLoss',
    definition: 'src/config/numeric.ts',
    why: 'K7：失败损失比例，改动它的效果要靠对照批量（M2.19/M2.20）',
  },
];

/** 剥掉行注释与块注释（字符串字面量里的斜杠不算）—— 「配置有没有读取点」这条判据的前提 */
export function stripComments(source: string): string {
  let out = '';
  let i = 0;
  let mode: 'code' | 'line' | 'block' | 'single' | 'double' | 'template' = 'code';
  while (i < source.length) {
    const ch = source[i]!;
    const next = source[i + 1];
    if (mode === 'code') {
      if (ch === '/' && next === '/') { mode = 'line'; i += 2; continue; }
      if (ch === '/' && next === '*') { mode = 'block'; i += 2; continue; }
      if (ch === String.fromCharCode(39)) { mode = 'single'; out += ch; i += 1; continue; }
      if (ch === '"') { mode = 'double'; out += ch; i += 1; continue; }
      if (ch === '`') { mode = 'template'; out += ch; i += 1; continue; }
      out += ch;
      i += 1;
      continue;
    }
    if (mode === 'line') {
      if (ch === String.fromCharCode(10)) { mode = 'code'; out += ch; }
      i += 1;
      continue;
    }
    if (mode === 'block') {
      if (ch === '*' && next === '/') { mode = 'code'; i += 2; continue; }
      if (ch === String.fromCharCode(10)) out += ch; // 保行号
      i += 1;
      continue;
    }
    /*
     * 字符串字面量：**只保留定界符，内容整个清空**。
     *
     * 这一条不是洁癖 —— 第一版原样保留字符串，于是「配置有没有读取点」这项检查
     * 被**它自己的清单**喂饱了：`REQUIRED_READERS` 里写着
     * `'NUMERIC\\.promotion\\.sequenceGating\\.planned'` 这个**字符串**，
     * 于是把 promotion.ts 的读取点整段删掉，检查器照样说「有读取点」（K14 的形状）。
     *
     * ⇒ 判据是「真的读了那个对象」，所以字符串里的同名文本不算数。
     */
    if (ch === String.fromCharCode(92)) { out += ' '; i += 2; continue; }
    const closer = mode === 'single' ? String.fromCharCode(39) : mode === 'double' ? '"' : String.fromCharCode(96);
    if (ch === closer) { mode = 'code'; out += ch; i += 1; continue; }
    out += ' ';
    i += 1;
  }
  return out;
}

/**
 * 本文件的相对路径 —— 「配置有没有读取点」这项检查不能拿自己的清单作证。
 *
 * 编译成 `.js` 之后路径也跟着变，所以按**去后缀**比较（见下方 isSelf）。
 */
const SELF_PATH = 'src/data/link-check.ts';
/** 比自己时忽略扩展名：同名的 .ts 与 .js 都是「检查器自己」 */
function isSelfPath(p: string): boolean {
  return p.replace(/\.(ts|js)$/, '') === SELF_PATH.replace(/\.(ts|js)$/, '');
}

/** `src/` 下全部 `.ts` 的生产源码（相对路径 + 已剥注释、已清空字符串的内容），进程内缓存 */
let sourceCache: { path: string; code: string }[] | null = null;

function productionSources(): { path: string; code: string }[] {
  if (sourceCache) return sourceCache;
  const srcRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const out: { path: string; code: string }[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const full = join(dir, entry.name);
      const rel = prefix === '' ? entry.name : prefix + '/' + entry.name;
      if (entry.isDirectory()) { walk(full, rel); continue; }
      /*
       * **`.js` 也要收**。
       *
       * 内核有两种运行形态：仓库里直接跑 `.ts`（Node 的类型剥离），
       * 或者编译成 `.js` 之后再跑（打包给上游插件用，因为 Node **禁止**
       * 对 node_modules 下的 .ts 做类型剥离）。
       *
       * 只认 `.ts` 的后果是：编译形态下这里**一个文件都扫不到**，
       * 于是「配置有没有读取点」全线判否 —— 启动直接报
       * 「内容数据存在 4 个 error：xxx 没有任何生产读取点」，
       * 而那四个读取点其实好端端地躺在编译产物里。
       */
      const isSource = entry.name.endsWith('.ts') || entry.name.endsWith('.js');
      if (!isSource) continue;
      if (/\.(test|d)\.(ts|js)$/.test(entry.name)) continue;
      out.push({ path: 'src/' + rel, code: stripComments(readFileSync(full, 'utf8')) });
    }
  };
  walk(srcRoot, '');
  sourceCache = out;
  return out;
}

/** 只给测试用：清掉源码缓存（改了源码之后要重扫） */
export function resetSourceCache(): void {
  sourceCache = null;
}

export interface ReaderRow {
  label: string;
  /** 读到它的生产文件（不含定义处） */
  readers: string[];
  ok: boolean;
}

export function checkReaders(required: readonly RequiredReader[] = REQUIRED_READERS): {
  rows: ReaderRow[];
  issues: LinkIssue[];
} {
  const sources = productionSources();
  const rows: ReaderRow[] = [];
  const issues: LinkIssue[] = [];

  for (const item of required) {
    const re = new RegExp(item.pattern);
    /*
     * 排除两处，都不是「读取点」：
     *   · `item.definition` —— 定义处（写在那里不叫有人读）；
     *   · 本文件 —— 检查器不该拿自己的清单给自己作证。
     */
    const readers = sources
      .filter((file) => file.path !== item.definition && !isSelfPath(file.path) && re.test(file.code))
      .map((file) => file.path);
    const ok = readers.length > 0;
    rows.push({ label: item.label, readers, ok });
    if (!ok) {
      issues.push({
        file: 'numeric.ts',
        check: 'reader',
        level: 'error',
        message:
          item.label + ' **没有任何生产读取点**（' + item.definition + ' 是定义处，不算）—— ' +
          '读的人无法区分「值为 0」与「没人读它」（K19）。' +
          '【形状】' + item.why,
      });
    }
  }
  return { rows, issues };
}

/* ================================================================== *
 * 第 4 项：行动表的效果落点（M2.38 任务 1）
 * ================================================================== */

/**
 * **每一条途径行动的 `effect` 都必须有落点。**
 *
 * ## 为什么要单独一项（它是第 2 项的补丁）
 *
 * 第 2 项（`checkReaders`）检的是「某个**配置路径**在源码里有没有人读」——
 * 它管得住 `NUMERIC.promotion.sequenceGating.planned` 那种**单点配置**，
 * 但管不住**一张表里的每一行**：`PATHWAY_ACTIONS` 有 21 行，
 * 而 `pathwayActionFor` 把整行对象返回出去 —— 从「有没有人引用这张表」看，**永远是通过的**。
 *
 * ⇒ M2.29 的行动四件套里，能力 / 技能 / 配方都有落点，**只有行动没有**，
 * 而第 2 项对此一无所知（**K19 + K23 的叠加**：配置表存在 + 检查器不检它）。
 *
 * ## 判据
 *
 * 逐行看 `effect`：`kind` 有分支、`field` / `grant` / `variant` 在
 * `ACTION_FIELD_EFFECTS` 里有登记，**并且那个落点是活的**
 *（M2.65：`mark` 要有读取函数、`item` 要有计划函数）。
 * **`pending` 不算错**（已登记未实现是诚实的记账），但会被单独列出来 ——
 * 「未实现」与「已实现」必须长得不一样（K19）。
 *
 * ⚠️ M2.65 补上的正是最后那一句：在此之前「登记了」与「有人读」是两件事，
 * 于是 `loot` / `nextAttack` / `eventDelay` / `divinationDaily`
 * 四个标记在检查器里一路绿灯，跑起来却没有任何消费者。
 */
export function checkActionEffects(actions: readonly PathwayAction[] = PATHWAY_ACTIONS): {
  rows: ActionEffectAudit[];
  issues: LinkIssue[];
} {
  const rows = auditActionEffects(actions);
  const issues: LinkIssue[] = [];
  for (const row of rows) {
    if (row.status !== 'orphan') continue;
    issues.push({
      file: 'pathway-actions.ts',
      check: 'action-effect',
      level: 'error',
      message:
        '行动 ' + row.actionId + '（kind=' + row.kind + '）**没有任何效果落点**：' + row.note +
        ' —— 加行动等于只加一句提示（M2.29 的现场：14 个节点里行动占 1/4，全是空的）。' +
        '修法：把它的 field / grant 加进 ACTION_FIELD_EFFECTS（标 pending 也算有落点），' +
        '或者改掉这条行动的 effect；M2.65 起「有落点」还要求落点是活的 ——' +
        'mark 要有 ACTION_MARK_READERS 里的读取函数，item 要有 ACTION_ITEM_PLANNERS 里的计划函数。',
    });
  }
  return { rows, issues };
}

/* ================================================================== *
 * 第 3 项：跑批可达
 * ================================================================== */

export interface ReachRow {
  pathway: string;
  /** 该途径在跑批里的期望人数（人数 x 期望出生占比） */
  expectedPlayers: number;
  /** 期望 ≥ 1 人 的最深序列；小于等于 9 表示连序列 9 之后的第一步都够不到 */
  reachSequence: number;
  /** 逐目标序列的累计期望人数（从 8 到 0） */
  byTarget: { target: number; expected: number }[];
}

export interface BatchReach {
  tier: BatchTier;
  rows: ReachRow[];
  issues: LinkIssue[];
}

/** 从序列 9 出发、累计到目标序列 `target` 的期望人数倍率 —— `∏ planned[t]`，t 从 8 降到 target */
function cumulativeGate(target: number): number {
  const planned = NUMERIC.promotion.sequenceGating.planned as Record<number, number>;
  let factor = 1;
  for (let seq = 8; seq >= target; seq -= 1) factor *= planned[seq] ?? 0;
  return factor;
}

/**
 * 「这一档跑批能验到序列几」——**逐途径**算，不跑批。
 *
 * ## 口径（写清楚，因为它报的是结论性的警告）
 *
 *     E_p(序列 s) = (档位人数 x 该途径的期望出生占比) x ∏_{t=s..8} planned[t]
 *
 * 期望出生占比取 `src/data/birth-share.ts`（与 content-diagnostics §1 同一个函数，
 * 铁律 11：报告口径只有一份）。
 *
 * ## ⚠️ 它是**上界**，不是预测
 *
 * 式子里**只有** `planned` 的累计乘积，不含 DIG 门槛、材料齐不齐、以及 30 天够不够磨。
 * 所以：
 *   · `E < 1` ⇒ **一定够不到**（上界都够不到，实际更不可能）—— 这条可以当结论；
 *   · `E >= 1` ⇒ **不保证够得到**（M2.32 实测：50 人 × 30 天最高只到序列 8）。
 *
 * ## ★ 实测校准（M2.36 任务 3：跑了一次冒烟批，把它量出来了）
 *
 * | 批 | 规模 | 实测 | 本估算说 |
 * | --- | --- | --- | --- |
 * | `m236s` | 20 人 × **3 天** | **0 人入途径**（20 人全是普通人） | seer 能到序列 5 |
 * | `m234b` | 200 人 × 30 天 | 最高到序列 **7**（11 人）、序列 6 **一个都没有** | 诊断档说 seer 能到序列 **3** |
 *
 * ⇒ **估算乐观约 4 层**。根因不是 `planned` 算错了，是**模型里根本没有时间**：
 *
 *   · 3 天窗口连**线索保底**（`cluePityDays = 5`）都没跨过 ⇒ 入途径 0；
 *   · 而更关键的是 **`planned` 根本不是主要瓶颈** —— `planned[8] = 1.0`（完全没有惩罚）时，
 *     「入途径 → 序列 8」的实际转化率只有 **18.3%**（m234b：186 人 → 34 人）；
 *     本估算把衰减记成 `∏planned`（0.855 量级），真实衰减是 **0.18** 量级。
 *
 * **⇒ 本项的用法只有一条**：`E < 1` 当**硬结论**用；`E ≥ 1` **不当结论**用。
 * 修法（下一轮，M2.36 硬约束：本轮不改数值）：把 `∏planned` 换成
 * `∏planned × 转化率曲线(天数)`，锚点取 `docs/M2.36-planned依赖点.md` §3.5 那三个库的实测。
 *
 * 这正是它作为**警告**而不是门槛的原因 —— M2.35 的硬约束是「不用跑批标定门槛，
 * 设计意图定值、跑批验可达性」，本项就是那句「验可达性」的落点。
 */
export function checkBatchReach(input: LinkCheckInput, tier: BatchTier = STANDARD_TIER): BatchReach {
  const issues: LinkIssue[] = [];
  const churchOf = (pathway: string): string | null => {
    for (const church of input.churches) if (church.pathway === pathway) return church.id;
    return null;
  };
  const shares = birthShares({
    cities: input.cities,
    pathways: input.pathways,
    factions: input.factions,
    priorityWeight: NUMERIC.initiation.factionPriority,
    expectAt: [tier.players],
    churchOf,
  });

  const rows: ReachRow[] = shares.map((share) => {
    const expectedPlayers = share.share * tier.players;
    const byTarget: { target: number; expected: number }[] = [];
    for (let target = 8; target >= 0; target -= 1) {
      byTarget.push({ target, expected: expectedPlayers * cumulativeGate(target) });
    }
    /*
     * ⚠️ 找的是**最深**的、期望仍 ≥ 1 的那一档 —— 所以从最小的目标序列（最深）往回升。
     * 第一版写成「从 8 往下找第一个 ≥ 1 的」（那就是 8，因为它是起点）——
     * 于是每条途径都报 reach = 8，警告一条都不出（K14 的形状：跑得通、抓不住）。
     */
    let reachSequence = 9;
    for (let target = 0; target <= 8; target += 1) {
      if (expectedPlayers * cumulativeGate(target) >= 1) { reachSequence = target; break; }
    }
    return { pathway: share.pathway, expectedPlayers, reachSequence, byTarget };
  });

  /*
   * ## ★ M2.37 任务 2：判据改成**相对的**，并且**按「差几层」聚合**
   *
   * ### ① 现对不现绝对
   *
   * 原判据是绝对的（`reach > CONTENT_MAX_SEQUENCE ⇒ 逐途径报一条`）。现状（内容可达 **4**）下报
   * 4 条，看着还行；但批次 B 把 `CONTENT_TARGET_SEQ` 推到 3（`CONTENT_MAX_SEQUENCE` 变 **2**）之后，
   * **三档下 7 条途径全部 warn** —— 恒亮的警告等于没有警告（K11）。
   *
   * 现在比的是**层数差**：`gap = reachSequence − CONTENT_MAX_SEQUENCE`。
   *
   * ### ② 聚合：7 条途径差 3 层是**一个事实**，不是七个
   *
   * 同一个 `gap` 只报一条，把受影响的途径列在同一行里。这一条同时解决
   * 「批次 B 之后 warn ≤ 3」这个验收 —— 聚合之后条数由**不同的层数差**决定，不再由途径数决定。
   *
   * ### ⚠️ 方向（这一节被写错过一次，留在这里）
   *
   * **序列号越小越深**：
   *   · `gap > 0`（reach 数字更大 = 更浅）⇒ **够不到**：内容做到了，跑批到不了；
   *   · `gap < 0`（reach 数字更小 = 更深）⇒ **超前**：跑批能到，内容还没做到 ⇒ 提示推目标序列；
   *   · `gap = 0` ⇒ 刚好够得到，不报。
   *
   * ⚠️ 任务书里写的是 `abs(reach − CONTENT_TARGET_SEQ)` —— 这里用的是
   * `CONTENT_MAX_SEQUENCE`（= TARGET − 1）。**两个都是「序列」才可比**：
   * `CONTENT_TARGET_SEQ` 是**配方 seq**，拿它跟 reach（序列）相减是把两种量纲混在一起。
   */
  const grouped = new Map<string, { gap: number; pathways: string[] }>();
  for (const row of rows) {
    const gap = row.reachSequence - CONTENT_MAX_SEQUENCE;
    if (gap === 0) continue;
    const key = String(gap);
    const slot = grouped.get(key) ?? { gap, pathways: [] };
    slot.pathways.push(row.pathway);
    grouped.set(key, slot);
  }

  /*
   * ⚠️ 「超前」这一类的措辞要**把它与第 1 项的区别写出来**，否则会被读成「内容超前了、快推目标」。
   *
   * 第 3 项比的是**估算**；第 1 项比的是**配方表**（真实内容）。
   * M2.36 实测过本项的估算**乐观约 4 层** ⇒ 「估算比内容深」的**默认解释是估算乐观**，
   * 而不是内容超前。**真超前由第 1 项报**（它读 recipes.yaml，不读估算）。
   */
  const shortMsg = (slot: { gap: number; pathways: string[] }, depth: number, scope: string): string =>
    '【够不到】' + slot.pathways.join('、') + '：' + scope +
    '（内容可达序列 ' + CONTENT_MAX_SEQUENCE + ' = seq ' + CONTENT_TARGET_SEQ + ' 的配方做得出来）⇒ ' +
    '序列 ' + CONTENT_MAX_SEQUENCE + '—' + (CONTENT_MAX_SEQUENCE + depth - 1) + ' 这 ' + depth +
    ' 层的机制**跑批验不到**，按 docs/对照规范.md §四·补二 用判定层直调 + 零夹具生产链路用例验它。' +
    '【形状】M2.29 的序列 6/5 内容做完，跑批里一个人都没到（本项就是那个检查器）' +
    '。⚠️ 这是**上界**（不含 DIG 门槛 / 材料 / 天数）：报「够不到」是硬结论，报「够得到」不保证';

  const aheadMsg = (slot: { gap: number; pathways: string[] }, scope: string): string =>
    '【超前 · 待核】' + slot.pathways.join('、') + '：' + scope +
    '（内容可达序列 ' + CONTENT_MAX_SEQUENCE + '）—— **这不等于内容超前**，先分清两件事：' +
    '① 若第 1 项（配方覆盖）也报了「超前」，**那一条才是真的**（它读的是配方表）⇒ 推 CONTENT_TARGET_SEQ；' +
    '② 若第 1 项没报，这一条只说明「**估算**的可达比内容深」，多半是估算乐观' +
    '（M2.36 实测乐观约 4 层，见 docs/M2.36-planned依赖点.md §3.3）⇒ 处置是**核估算**，不是推目标';

  for (const slot of [...grouped.values()].sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap))) {
    const short = slot.gap > 0;
    const depth = Math.abs(slot.gap);
    const scope =
      tier.label + '（' + tier.players + ' 人 × ' + tier.days + ' 天）的可达序列' +
      (short ? '比内容浅' : '比内容深') + ' **' + depth + ' 层**';
    issues.push({
      file: 'content-scope.ts',
      check: 'batch-reach',
      level: 'warn',
      message: short ? shortMsg(slot, depth, scope) : aheadMsg(slot, scope),
    });
  }

  return { tier, rows, issues };
}

/* ================================================================== *
 * 第 4 项（M2.66）：行为名都有旁白
 * ================================================================== */

export interface BehaviorRow {
  /** 内容表里出现的行为名 */
  kind: string;
  /** 是哪些物种在用 */
  species: string[];
  /** 有没有专属旁白 */
  narrated: boolean;
}

/**
 * **行为旁白检查**：内容表里出现的每一个行为名，都必须有一条专属旁白。
 *
 * ## 它抓的是什么
 *
 * `behaviorText` 有一个兜底分支：`它做了些什么（lurk）。` ——
 * 也就是说，**内容同学写了一个没登记的行为名时，玩家会读到半句英文**。
 * 而这件事在文件级校验里看不出来：`behaviors` 的形状是合法的，
 * 触发条件也照常生效，只是那一句旁白变成了占位符。
 *
 * 实测（M2.66 开工时）：11 个物种共用了 10 个行为名，其中 `lurk` 与 `chant`
 * 没有旁白 —— 潮底潜伏者与骨唱诗班的遭遇旁白一直是 `它做了些什么（lurk）。`。
 *
 * ## 为什么是 error 而不是 warn
 *
 * 它**一定会**被玩家看到（那条旁白就写在遭遇回执里），而且修法只有一种（补一行文案）。
 * K17 的口径：内容层的错不该等到玩家看见才发现。
 */
export function checkCreatureBehaviors(
  creatures: readonly { id: string; behaviors: readonly { kind: string }[] }[],
): { rows: BehaviorRow[]; issues: LinkIssue[] } {
  const narrated = new Set(NARRATED_BEHAVIORS);
  const byKind = new Map<string, string[]>();
  for (const species of creatures) {
    for (const behavior of species.behaviors) {
      const list = byKind.get(behavior.kind) ?? [];
      if (!list.includes(species.id)) list.push(species.id);
      byKind.set(behavior.kind, list);
    }
  }
  const rows: BehaviorRow[] = [...byKind.entries()]
    .map(([kind, species]) => ({ kind, species, narrated: narrated.has(kind) }))
    .sort((a, b) => (a.kind < b.kind ? -1 : 1));
  const issues: LinkIssue[] = [];
  for (const row of rows) {
    if (row.narrated) continue;
    issues.push({
      file: 'creatures.yaml',
      check: 'creature-behavior',
      level: 'error',
      message:
        '行为「' + row.kind + '」（' + row.species.join('、') + ' 在用）**没有专属旁白** —— ' +
        '玩家会在遭遇回执里读到「它做了些什么（' + row.kind + '）。」这半句英文。' +
        '修法：在 src/domain/creature/perception.ts 的 BEHAVIOR_TEXT 里补一行。',
    });
  }
  return { rows, issues };
}

/* ================================================================== *
 * 第 5 项（M2.71）：地理内容的两条一致性判据
 * ================================================================== */

export interface GeoRow {
  /** 判据名（报告里分组用） */
  check: string;
  /** 主体（城市 id） */
  subject: string;
  /** 这一条过没过 */
  pass: boolean;
  /** 人读的一句话（过了也写清楚"对的是什么"） */
  message: string;
}

/**
 * **地理内容的两条一致性判据** —— 它们守的是两个「落库了但没人读」的字段。
 *
 * ## 为什么需要判据，而不是把字段接进玩法
 *
 * `region.pathways` 与 `city.factions` 的处境与其它「没人读的字段」不同：
 * 它们**不是机制**，而是**对同一件事的另一处声明**（区域设计上传承哪些途径 / 这座城市有哪几支势力）。
 * 把这种字段硬接进判定，只会造出**第二份真相**（谁在场由领地表说了算，凭什么再听城市的；
 * 出生校验由 City.pathways 说了算，凭什么再听区域的）。
 *
 * 正确的位置是**判据**：让它们与唯一的那份真相**对齐**，不对齐就报出来。
 * 于是它们从「写在那儿没人看」变成「写错了当场红」。
 *
 * ## 判据一：城市的开放途径必须属于它所属区域传承的途径
 *
 * 依据：`regions.yaml` 文件头「pathways 是设计意图」+ `domain/geo/types.ts`
 * 「每城 2 条 —— 任务书 §2.2『每个区域只开 2—3 条途径』」。
 * 一座城市开了一条**它所在区域压根不传承**的途径，两者必有一个是错的。
 *
 * ⚠️ 实测（M2.71 开工时）：**四座城市**对不上 —— backlund 开 perfect、pritz 开 sailor、
 * trier 开 reader、byron 开 mother。原因不是谁写错了，而是
 * **M2.19 / M2.26 实现这四条途径时只改了城市**，区域那份设计记录没人读、也就没人同步。
 * 这正是「没有读取点的字段会腐烂」的现场。
 *
 * ## 判据二：城市声明的势力必须与领地表的实际归属**双向**一致
 *
 * `numeric.factionTerritory` 是「哪个地点归谁」的唯一定义（M2.6 起），
 * `city.factions` 是「这座城市有哪几支势力」的城市级摘要。两者互为投影：
 *
 *   · 一支势力在某城**有地点**却没被声明 → 漏（玩家在菜单里看不到它）；
 *   · 声明了一支在该城**没有地点**的势力 → 多（玩家会去找一支不存在的势力）。
 *
 * `none`（无主）是 pseudo-势力，规则单独一条：当且仅当该城**有无人管的地点**时声明它。
 *
 * ⚠️ 实测：trier 少了 `church` —— M2.39 批次 B 给 trier 加了 `trier_ossuary` 与
 * `trier_war_crypt`（归教会），而城市那份声明同样没人读。
 */
export function checkGeoConsistency(input: {
  regions: readonly { id: string; pathways: readonly string[] }[];
  cities: readonly {
    id: string;
    region_id: string;
    locations: readonly string[];
    factions: readonly string[];
    pathways: readonly string[];
  }[];
  /** 地点 → 势力（唯一定义：numeric.factionTerritory） */
  territory: Readonly<Record<string, readonly string[]>>;
}): { rows: GeoRow[]; issues: LinkIssue[] } {
  const rows: GeoRow[] = [];
  const issues: LinkIssue[] = [];
  const regionById = new Map(input.regions.map((region) => [region.id, region]));

  for (const city of input.cities) {
    /* ---- 判据一：区域传承的途径 ---- */
    const region = regionById.get(city.region_id);
    if (region === undefined) {
      // 区域不存在这件事由 loadCities 的交叉校验管（这里不重复报）
      rows.push({ check: 'region-pathways', subject: city.id, pass: false, message: '区域不存在：' + city.region_id });
    } else {
      const missing = city.pathways.filter((pathway) => !region.pathways.includes(pathway));
      const pass = missing.length === 0;
      rows.push({
        check: 'region-pathways',
        subject: city.id,
        pass,
        message: pass
          ? '开放的途径都在' + region.id + '传承的途径里'
          : '开了' + region.id + '不传承的途径：' + missing.join('、'),
      });
      if (!pass) {
        issues.push({
          file: 'regions.yaml',
          check: 'geo-consistency',
          level: 'error',
          message:
            city.id + ' 开放了 ' + missing.join('、') + '，而它所属的 ' + region.id +
            ' 的 pathways 里没有这几条 —— 出生校验读的是城市那一份，所以玩家真的能选到它们。' +
            '修法：把这几条加进 regions.yaml 的 ' + region.id + '.pathways（实现一条途径时两处一起改），' +
            '或者把它们从城市里去掉。',
        });
      }
    }

    /*
     * ---- 判据二：城市声明的势力 vs 领地表的实际归属 ----
     *
     * ⚠️ `none`（无主）**不做特例**：它在 `factionTerritory` 里就有一份地点名单
     *（安全区的定义就是那些地点），所以它和另外三家走**同一条规则**。
     * 第一版把 none 当成 pseudo-势力单独判（"当且仅当该城有无人管的地点时声明"），
     * 结果 tingen 同时报出「漏了 none」与「没有无主地点却声明了 none」两句自相矛盾的话 ——
     * 因为领地表的 none 名单本来就是**有主**的一种（归无主）。判据自己也踩了一次 K4。
     */
    const declared = [...new Set(city.factions)].sort();
    const derived = new Set<string>();
    for (const locationId of city.locations) {
      for (const [faction, locations] of Object.entries(input.territory)) {
        if (locations.includes(locationId)) derived.add(faction);
      }
    }
    const declaredSet = new Set(declared);
    const missingFactions = [...derived].filter((faction) => !declaredSet.has(faction)).sort();
    const extraFactions = declared.filter((faction) => !derived.has(faction));
    const passFactions = missingFactions.length === 0 && extraFactions.length === 0;
    const parts: string[] = [];
    if (missingFactions.length > 0) parts.push('漏了 ' + missingFactions.join('、'));
    if (extraFactions.length > 0) parts.push('多了 ' + extraFactions.join('、'));
    rows.push({
      check: 'city-factions',
      subject: city.id,
      pass: passFactions,
      message: passFactions ? '与领地表一致（' + declared.join('、') + '）' : parts.join('；'),
    });
    if (!passFactions) {
      issues.push({
        file: 'cities.yaml',
        check: 'geo-consistency',
        level: 'error',
        message:
          city.id + ' 的 factions 与领地表对不上：' + parts.join('；') +
          '（领地表 numeric.factionTerritory 是「哪个地点归谁」的唯一定义，none 也是其中一家）。' +
          '修法：改 cities.yaml 的 ' + city.id + '.factions —— 或者，如果领地表才是错的，改领地表。',
      });
    }
  }

  return { rows, issues };
}

/* ================================================================== *
 * 汇总
 * ================================================================== */

export interface LinkCheckReport {
  recipe: { rows: RecipeCoverageRow[]; issues: LinkIssue[] };
  reader: { rows: ReaderRow[]; issues: LinkIssue[] };
  actionEffect: { rows: ActionEffectAudit[]; issues: LinkIssue[] };
  /** M2.66 第 4 项 */
  creatureBehavior: { rows: BehaviorRow[]; issues: LinkIssue[] };
  /** M2.71 第 5 项 */
  geoConsistency: { rows: GeoRow[]; issues: LinkIssue[] };
  reach: BatchReach[];
  issues: LinkIssue[];
}

/**
 * 四项一起跑。`tiers` 默认给全部三档（剖面），判据只吃标准对照轮那一档。
 *
 * 第 4 项（M2.66）是四项里唯一**不依赖跑批**的：它问的是「内容里写的行为名，
 * 玩家读到的那句话是不是中文」—— 与前三项同一个出身（文件都在、校验都过，而链路是断的）。
 */
export function checkLinks(input: LinkCheckInput, tiers: readonly BatchTier[] = BATCH_TIERS): LinkCheckReport {
  const recipe = checkRecipeCoverage(input);
  const reader = checkReaders();
  const actionEffect = checkActionEffects();
  const creatureBehavior = checkCreatureBehaviors(input.creatures);
  const geoConsistency = checkGeoConsistency({
    regions: input.regions,
    cities: input.geoCities,
    territory: NUMERIC.factionTerritory as Readonly<Record<string, readonly string[]>>,
  });
  const reach = tiers.map((tier) => checkBatchReach(input, tier));
  const standard = reach.find((row) => row.tier.id === STANDARD_TIER.id) ?? reach[0]!;
  const issues = [
    ...recipe.issues,
    ...reader.issues,
    ...actionEffect.issues,
    ...creatureBehavior.issues,
    ...geoConsistency.issues,
    ...standard.issues,
  ];
  return { recipe, reader, actionEffect, creatureBehavior, geoConsistency, reach, issues };
}
