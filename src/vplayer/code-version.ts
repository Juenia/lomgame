/**
 * 跑批产物的**代码版本标记**（M2.32 任务 1，P0）。
 *
 * ## 为什么它必须存在
 *
 * M2.31 任务 0.2 查出：**7 个历史批次的产物里，没有任何一处记着跑它的是哪份代码。**
 * 后果不是「重生成数字不逐条相同」，是**归因链断在源头** ——
 * M2.18 之后的每一次「这批比上批多 N 人」，都建立在「两批代码差多少」这个**未知量**上。
 *
 * `docs/跑批手册.md` §二 读表须知第 2 条其实早就写着这件事：
 *
 * > 「代码状态」是**批跑那一刻**工作树的状态。要知道某批到底跑的是哪个 commit，
 * > 只能靠当时的提交记录 —— **报告里没有记 `git rev-parse HEAD`，这是本手册第 5.1 条要求补的第一件事。**
 *
 * 本文件就是那一件事。
 *
 * ## 四个字段
 *
 * | 字段 | 来源 | 用途 |
 * | --- | --- | --- |
 * | `codeRev` | `git rev-parse HEAD` | 精确重生成 |
 * | `codeDirty` | `git status --porcelain` 非空 | 标注「工作区有未提交改动」 |
 * | `builtAt` | ISO 时间 | 时序定位 |
 * | `codeDirtyDetail` | 上面那些 porcelain 行的分类 | **让布尔可归因**（见下） |
 *
 * **`builtAt` 的口径**：本项目没有独立构建步骤（直接 `node src/...ts`），
 * 所以它是**这一个进程开始跑批的那一刻**。8 片各自有自己的 `builtAt` ——
 * 它们不是同一个值，这没关系：`builtAt` 回答的是「这一片什么时候跑的」，
 * 「这一批是不是同一份代码」由 `codeRev` 回答（合并脚本负责判）。
 *
 * ## 为什么要有第四字段（任务书三字段之外的补充）
 *
 * 本仓 `docs/` 下**存着跑批产物本身**（`*-shard-*.json`、`*报告.md`），
 * 而它们**不受 .gitignore 保护**（只有 `/data/`、`*.db`、`*.jsonl` 被忽略）。
 * ⇒ 一次跑批自己就会让 `git status --porcelain` 非空 ⇒ **`codeDirty` 几乎恒为 true。**
 *
 * 一个恒为 true 的布尔**没有任何鉴别力**（K11 的形状：门槛要能区分两件事）。
 * 所以第四个字段把 dirty 拆成两半：
 *
 *   · `judgement` —— **判定输入**（`src/` / `scripts/` / `test/` 以及一切不在产物目录下的路径）
 *     有未提交改动，**这一批就不可精确重生成**（K20 那次事故：`src/data/*.yaml` 积压了 45 处改动）；
 *   · `artifacts` —— 只有产物 / 归档目录（`docs/` / `data/` / `backups/`）脏，判定不受影响。
 *
 * **保守方向**：不在产物目录白名单里的路径**一律算判定输入**。
 * 判错的方向只会是「警告多一次」，不会是「漏警告」。
 *
 * ## 「取不到」不是「干净」（K19 的形状）
 *
 * git 不可用（没装 git、不是仓库、命令超时）时**不回一个看起来像正常值的值**：
 *
 *   · `codeRev` → `'unknown'`（**不是空串**：空串看起来像「没这一项」）；
 *   · `codeDirty` → `true`（**无法证明工作区干净，就不声明它干净**）。
 *
 * 方向是安全的：多警告一次「这批不可精确重生成」，好过把一批不可重生成的产物标成可重生成。
 */
import { execFileSync } from 'node:child_process';

/** 只有落在这些目录下的改动才算「产物」；其余一律算判定输入（保守） */
/**
 * 只有落在这些目录下的改动才算「产物」；其余一律算判定输入（保守）。
 *
 * `m220-baseline/` 是 M2.20 任务 0.5 留下的**归档工作区副本**（那一轮验证「逐条相同」用的独立目录），
 * 它整目录未跟踪 ⇒ 会**长期**挂在 `git status` 上。它不进任何判定，算成判定输入只会让警告多一条噪声。
 */
const ARTIFACT_PREFIXES: readonly string[] = ['docs/', 'data/', 'backups/', 'm220-baseline/'];

/** 样例路径最多记几条（够看出「脏在哪」就行，不把 JSON 撑大） */
const SAMPLE_LIMIT = 8;

export interface CodeDirtyBreakdown {
  /** **判定输入**里有几处未提交改动 —— 非 0 ⇒ 这一批不可精确重生成（量词随 `dirtyScope` 变） */
  judgement: number;
  /** 产物 / 归档目录里有几处（跑批自己就会产生） */
  artifacts: number;
  /** 判定输入的样例路径（最多 8 条）；空数组 = 判定输入是干净的（**不等于没有脏文件**，见 `describeCodeVersion`） */
  sample: string[];
}

export interface CodeVersion {
  /** `git rev-parse HEAD`；取不到时是 `'unknown'` */
  codeRev: string;
  /** `git status --porcelain` 非空；取不到 git 时按 true（保守） */
  codeDirty: boolean;
  /** 跑批开始那一刻（ISO 8601） */
  builtAt: string;
  /** 为什么 dirty（`codeDirty` 为 false 时两个计数都是 0） */
  codeDirtyDetail: CodeDirtyBreakdown;
  /**
   * 两个计数的**量词**（默认按单片读）：
   *
   *   · `'shard'`（默认，单片产物）：N **处**脏文件；
   *   · `'merged'`（合并报告）：N **片**工作区不干净。
   *
   * 为什么要分开：合并层手上只有逐片的布尔（它不去收集 8 片的路径 —— 那会让报告变成文件清单），
   * 所以它的 `judgement` 是**片数**。M2.32 实测踩到：合并报告把「1 片脏」写成了「判定输入 1 处」，
   * 读者会以为工作区只有一个脏文件 —— 一个**看着像结论的量词错误**，比数字错更难发现。
   */
  dirtyScope?: 'shard' | 'merged';
}

export interface CodeVersionInput {
  /** 显式指定 rev（命令行 `--code-rev` / 环境变量）：给了就不再跑 git */
  codeRev?: string;
  /** 显式指定 dirty（`--code-dirty` / 环境变量）：给了就不再跑 git status */
  codeDirty?: string | boolean;
  /** 显式指定 builtAt（`--built-at` / 环境变量） */
  builtAt?: string;
  /** git 命令的工作目录，默认 `process.cwd()` */
  cwd?: string;
  /** 注入用（测试要能模拟「没有 git」），默认走 `execFileSync` */
  readGit?: (args: readonly string[], cwd: string) => string | null;
}

/**
 * 跑一条 git 命令，返回 stdout。**任何失败都返回 `null`**（不抛）——
 * 跑批不该因为「这台机器上没有 git」而停下来。
 */
export function defaultReadGit(args: readonly string[], cwd: string): string | null {
  try {
    const out = execFileSync('git', [...args], {
      cwd,
      encoding: 'utf8',
      // stderr 直接丢掉：不是仓库时 git 会往 stderr 写一堆提示，跑批日志不需要它
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
      windowsHide: true,
    });
    return String(out);
  } catch {
    return null;
  }
}

/**
 * `git status --porcelain -z` 的路径列表。
 *
 * **为什么用 `-z`**：默认输出对非 ASCII 路径做八进制转义 + 加引号
 * （`core.quotepath` 默认 true）⇒ 本仓满地的中文路径会变成 `"docs/\346\226\207..."`，
 * 既看不出是哪个文件，也没法用来做前缀分类。`-z` 用 NUL 分隔且**不转义**。
 */
export function gitStatusPaths(readGit: (args: readonly string[], cwd: string) => string | null, cwd: string): string[] | null {
  const out = readGit(['status', '--porcelain', '-z'], cwd);
  if (out === null) return null; // git 不可用 —— 与「干净」是两回事
  return out
    .split('\0')
    .filter((entry) => entry.length > 0)
    //  porcelain 的每一条是 "XY <path>"（X/Y 两列状态 + 一个空格）
    .map((entry) => entry.slice(3));
}

/**
 * 把一条输入规范成「路径」。
 *
 * **为什么要有这一步**：调用方手里可能是 `gitStatusPaths` 的产物（纯路径），
 * 也可能是原始的 porcelain 行（`' M src/a.ts'`）—— 而这两种**看起来差不多**，
 * 用错了的症状是：前缀匹配全部落空 ⇒ **每一处改动都被算成判定输入** ⇒
 * 警告恒为真（K11 的零鉴别力），而它看起来完全正常。
 * 与其要求调用方记住自己手里是哪一种（K2 的形状），不如在这里容错。
 */
function toPath(entry: string): string {
  // porcelain 的形状是 "XY <path>"：两列状态 + 一个空格。真实路径不会以空格开头。
  return /^[ MADRCU?!]{2} /.test(entry) ? entry.slice(3) : entry;
}

/** 把 porcelain 的路径列表（或原始 porcelain 行）分成「判定输入」与「产物」两半 */
export function breakdownOf(entries: readonly string[]): CodeDirtyBreakdown {
  const judgement: string[] = [];
  let artifacts = 0;
  for (const entry of entries) {
    const path = toPath(entry);
    if (ARTIFACT_PREFIXES.some((prefix) => path.startsWith(prefix))) artifacts += 1;
    else judgement.push(path);
  }
  return { judgement: judgement.length, artifacts, sample: judgement.slice(0, SAMPLE_LIMIT) };
}

/** `'true' / '1' / 'yes'` 之类都当 true；其余当 false（命令行与环境变量都是字符串） */
function truthy(value: string | boolean): boolean {
  if (typeof value === 'boolean') return value;
  return ['true', '1', 'yes', 'y'].includes(value.trim().toLowerCase());
}

/**
 * 取本次跑批的代码版本标记。
 *
 * 优先级（每一项独立判断）：**显式入参 > git 现场读**。
 * 「显式」的来源是命令行（`--code-rev` 等）与环境变量（`M213_CODE_REV` 等）——
 * 让复现时可以手动钉住一个 rev，也方便在没有 git 的环境里（CI 容器）从外部注入。
 */
export function codeVersionOf(input: CodeVersionInput = {}): CodeVersion {
  const cwd = input.cwd ?? process.cwd();
  const readGit = input.readGit ?? defaultReadGit;

  const explicitRev = input.codeRev?.trim();
  const codeRev =
    explicitRev !== undefined && explicitRev.length > 0
      ? explicitRev
      : (readGit(['rev-parse', 'HEAD'], cwd) ?? '').trim() || 'unknown';

  const paths = gitStatusPaths(readGit, cwd);
  const detail = breakdownOf(paths ?? []);
  const codeDirty = input.codeDirty !== undefined ? truthy(input.codeDirty) : paths === null || paths.length > 0;

  return {
    codeRev,
    codeDirty,
    builtAt: input.builtAt ?? new Date().toISOString(),
    codeDirtyDetail: detail,
  };
}

/**
 * 报告里用的**一行**代码版本摘要（主报告与合并报告共用，避免两处各写一套格式）。
 *
 * `dirty` 时的措辞刻意分成两档 —— 因为这两件事的后果不同：
 *   · 判定输入脏 ⇒ **这一批不可精确重生成**（重跑会得到另一批数据）；
 *   · 只有产物脏 ⇒ 判定不受影响，但仍要标出来（K12：产物名相同就会静默覆盖）。
 */
/**
 * 产物**完全没有版本记录**时的那句话（M2.32 之前的批）。
 *
 * 放在这里而不是各自写一份：主报告与合并报告都要说同一句话，
 * 两份文案漂开之后，读者会以为是两件不同的事（而它们本来就是同一件）。
 */
export const CODE_VERSION_UNRECORDED =
  '**未记录** —— 本产物生成于 M2.32 之前（跑批产物加代码版本之前）⇒ **这批无法归因到某个 commit**';

/**
 * 报告首段的「代码版本」那一行 —— **没有记录时不许沉默**。
 *
 * ⚠️ 别把「没有记录」和「工作区干净」混起来（K19 的形状）：
 * 一个空白的字段看起来像「一切正常」，而它实际的含义是「这批无从查证」。
 *
 * @param recorded 合并层用：有几片带了版本字段（0 ⇒ 未记录）
 */
export function codeVersionLineOf(code: CodeVersion | undefined, recorded = true): string {
  if (!code || !recorded) return CODE_VERSION_UNRECORDED;
  return describeCodeVersion(code);
}

export function describeCodeVersion(code: CodeVersion): string {
  const rev = code.codeRev === 'unknown' ? 'unknown（这台机器上取不到 git）' : code.codeRev;
  // 量词跟着来源走：单片说「处」，合并层说「片」（见 CodeVersion.dirtyScope）
  const unit = code.dirtyScope === 'merged' ? '片' : '处';
  if (!code.codeDirty) return `${rev}（工作区干净）`;
  if (code.codeDirtyDetail.judgement > 0) {
    return (
      `${rev}（**工作区有未提交改动：判定输入 ${code.codeDirtyDetail.judgement} ${unit}** —— ` +
      '这批**不可精确重生成**；' +
      /*
       * 样例为空**不等于**「没有脏文件」：合并层不逐片收集路径（那会让报告变成一张文件清单），
       * 所以那里给的是指路而不是一个看起来像结论的空值（K19：空白读起来像「一切正常」）。
       */
      (code.codeDirtyDetail.sample.length > 0
        ? `样例：${code.codeDirtyDetail.sample.join('、')}`
        : '逐片明细见各分片 JSON 的 codeDirtyDetail') +
      '）'
    );
  }
  return (
    `${rev}（工作区有未提交改动，但**只在产物目录**：${code.codeDirtyDetail.artifacts} ${unit} —— ` +
    `判定输入是干净的，可精确重生成）`
  );
}
