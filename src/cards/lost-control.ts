import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import type { DataIssue } from '../data/loader.ts';
import { PATHWAY_LABELS } from '../domain/character/rules.ts';
import type { LostForm } from '../domain/character/lost-form.ts';
import type { PathwayId } from '../domain/character/types.ts';
import { parseLostControlFile } from './lost-control.schema.ts';
import { CARDS_DIR } from './paths.ts';
import { join } from 'node:path';

export const LOST_CONTROL_FILE = join(CARDS_DIR, 'lost-control.yaml');

/** 每条途径至少 10 条，总计至少 30 条（W5 内容指标） */
export const MIN_LOST_CONTROL_PER_PATHWAY = 10;
export const MIN_AFTERSHOCK = 3;

export interface LostControlPool {
  byPathway: Record<PathwayId, string[]>;
  aftershock: string[];
  /** 全部失控文本（按途径顺序拼接），供测试与统计 */
  all: string[];
  /**
   * M2.76：**堕落形态池**（YAML 的 `forms:` 段）。
   *
   * 空的含义是「内容还没写」，不是错误 —— 那时失控走 `NUMERIC.tick` 的全局缺省后果，
   * 与 M2.76 之前的行为逐位一致（既有用例因此不受影响）。
   */
  forms: LostForm[];
  issues: DataIssue[];
}

/*
 * M2.76：**这份清单不再手抄**（K16 的标本，现场已经咬过一次）。
 *
 * 原状是 `['seer', 'warrior', 'sleepless']` —— 一份写死的三条途径清单，
 * 而 `byPathway` 的类型是 `Record<PathwayId, string[]>`，**声称 7 个键齐全**。
 * 于是 M2.19/M2.26 落地的 sailor / perfect / reader / mother 四条途径：
 *   · tsc 一声不吭（类型上「齐全」）；
 *   · 加载器不去读它们的文本段（YAML 里写了也当作不存在）；
 *   · `all` 只拼三条途径 ⇒ 新写的文本**一条都进不来**，而读数看着没变。
 *
 * 这就是「手抄一份会漂的副本」最贵的地方：**它不报错，它只是安静地少读一半**。
 *
 * ⇒ 唯一出处是 `PATHWAY_LABELS`（`Record<PathwayId, string>`，加途径时 tsc 必红）。
 * 加一条途径只需在那里加一行，这里自动跟上 —— 这也是「数据要能开放地加」的第一条：
 * **代码里不出现途径清单的第二份副本**。
 */
const PATHWAYS: PathwayId[] = Object.keys(PATHWAY_LABELS) as PathwayId[];

/** 空池：schema 不过时用它兜底，让 loadLostControlOrThrow 负责抛出 */
function emptyPool(issues: DataIssue[]): LostControlPool {
  const byPathway = {} as Record<PathwayId, string[]>;
  for (const pathway of PATHWAYS) byPathway[pathway] = [];
  return { byPathway, aftershock: [], all: [], forms: [], issues };
}

export function loadLostControlPool(file: string = LOST_CONTROL_FILE): LostControlPool {
  const issues: DataIssue[] = [];
  /*
   * M2.76：这个文件过去**没有任何 schema 兜底** —— 加载器只手动取两个顶层键，
   * 其余字段读不到也不报错，而且旧代码还会 `String(entry)` 强转，
   * 于是一个写错的结构会变成一句看起来正常的字符串。现在先过 schema（铁律 9）。
   */
  const parsed = parseLostControlFile(parseYaml(readFileSync(file, 'utf8')));
  if (!parsed.ok) {
    for (const message of parsed.issues) issues.push({ file, level: 'error', message });
    return emptyPool(issues);
  }
  const raw = parsed.data;

  /*
   * 键的合法性在这里校验，**不写进 schema**：`lost_control` 是一张稀疏表
   * （正在补的途径可以缺席，缺席时走 pool.all 兜底），所以 schema 用的是 z.string()。
   * 而「哪些是合法途径」的唯一出处是 PATHWAY_LABELS —— 与上面那份 PATHWAYS 同源，
   * 不在这里抄第三份（抄了就会在加途径时漏掉一处，而漏掉的那处不报错）。
   */
  const known = new Set<string>(PATHWAYS);
  for (const key of Object.keys(raw.lost_control)) {
    if (!known.has(key)) {
      issues.push({ file, level: 'error', message: `lost_control 里的 "${key}" 不是已实现的途径（拼写错误？）` });
    }
  }

  const byPathway = {} as Record<PathwayId, string[]>;
  for (const pathway of PATHWAYS) {
    const texts = (raw.lost_control[pathway] ?? []).map((t) => t.trim()).filter((t) => t.length > 0);
    if (texts.length < MIN_LOST_CONTROL_PER_PATHWAY) {
      issues.push({
        file,
        level: 'error',
        message: `${pathway} 的失控文本至少 ${MIN_LOST_CONTROL_PER_PATHWAY} 条，当前 ${texts.length} 条`,
      });
    }
    byPathway[pathway] = texts;
  }

  const aftershock = raw.aftershock.map((t) => t.trim()).filter((t) => t.length > 0);
  if (aftershock.length < MIN_AFTERSHOCK) {
    issues.push({
      file,
      level: 'error',
      message: `余波文本至少 ${MIN_AFTERSHOCK} 条，当前 ${aftershock.length} 条`,
    });
  }

  const all = PATHWAYS.flatMap((pathway) => byPathway[pathway]);
  /*
   * 下限跟着途径数走，**不再写死 30**：写死之后「加途径」与「加文本」两件事
   * 会互相掩盖 —— 7 条途径各 10 条本应是 70，而常量还停在 30，检查静默通过。
   */
  const minTotal = MIN_LOST_CONTROL_PER_PATHWAY * PATHWAYS.length;
  if (all.length < minTotal) {
    issues.push({
      file,
      level: 'error',
      message: `失控文本总数至少 ${minTotal} 条（${MIN_LOST_CONTROL_PER_PATHWAY} × ${PATHWAYS.length} 条途径），当前 ${all.length} 条`,
    });
  }

  /* ---------------- M2.76：堕落形态 ---------------- */
  const forms: LostForm[] = raw.forms.map((form) => ({
    id: form.id,
    pathway: form.pathway,
    name: form.name,
    minSeq: form.min_seq,
    weight: form.weight,
    hpLossMin: form.hp_loss_min,
    hpLossMax: form.hp_loss_max,
    madGain: form.mad_gain,
    corGain: form.cor_gain,
    blurb: form.blurb,
    group: form.group,
  }));

  const seenFormIds = new Set<string>();
  for (const form of forms) {
    if (seenFormIds.has(form.id)) {
      issues.push({ file, level: 'error', message: `堕落形态 id 重复：${form.id}` });
    }
    seenFormIds.add(form.id);
  }
  /*
   * 每条已实现途径都必须有形态 —— **error 不是 warn**，与「每条途径至少 10 条文本」同一条口径：
   * 失控是核心机制，一条途径没有自己的堕落形态就等于它的玩家失控时走的是一句通用后果。
   * 代价是「加一条途径必须同时写形态」，那正是我们要的（内容缺一层不该等到跑批才发现）。
   */
  for (const pathway of PATHWAYS) {
    if (!forms.some((form) => form.pathway === pathway)) {
      issues.push({
        file,
        level: 'error',
        message: `${pathway} 没有任何堕落形态（forms: 段里缺这条途径）`,
      });
    }
  }

  return { byPathway, aftershock, all, forms, issues };
}

export function loadLostControlOrThrow(file: string = LOST_CONTROL_FILE): LostControlPool {
  const pool = loadLostControlPool(file);
  const errors = pool.issues.filter((issue) => issue.level === 'error');
  if (errors.length > 0) {
    throw new Error(`失控文本池有问题：\n${errors.map((issue) => `  ${issue.message}`).join('\n')}`);
  }
  return pool;
}

/** 随机取一条该途径的失控文本（调用方给 rng 与 seed） */
export function pickLostControlText(pool: LostControlPool, pathway: PathwayId, index: number): string {
  /*
   * M2.19：`?? []` 不能省。
   *
   * 失控文本是**逐途径**写的，而 PATHWAYS 这个常量列的是「有专属文本的途径」；
   * 新途径（M2.19 的 sailor）落地时，它的玩家会失控，但还没有人为它写 10 条文本 ——
   * 没有这一行，`texts.length` 会当场抛 TypeError，而抛出的位置在**每日结算**里，
   * 玩家看到的是一句「系统繁忙」。
   * 空数组会走下面既有的兜底链（用 pool.all 的 30 条通用失控文本），
   * 也就是「这条途径还没有专属的失控文本」（与水手这一轮只做「能走通」口径一致）。
   */
  const texts = pool.byPathway[pathway] ?? [];
  const safe = texts.length > 0 ? texts : pool.all;
  return safe[index % Math.max(1, safe.length)] ?? '你失控了。';
}

export function pickAftershockText(pool: LostControlPool, index: number): string {
  const texts = pool.aftershock;
  return texts[index % Math.max(1, texts.length)] ?? '你花了一点时间找回自己。';
}
