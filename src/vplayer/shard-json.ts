/**
 * 分片结果的结构化落盘（M2.3 任务四）。
 *
 * 为什么要在 markdown 之外再存一份 JSON：
 *   合并脚本（scripts/vplayer-merge.ts）**不许手动拼数字**（任务书第十二节）。
 *   所以每一片跑完就把「合并需要的全部原始量」写成一份统一格式的 JSON，
 *   合并脚本只做累加/加权，不做任何二次猜测。
 *
 * 几个刻意的设计：
 *   - `values` 存**期末数值全量数组**而不是只有均值：分片的 P50/P90 不能再平均一次
 *     （那是错的），必须把原始值拼起来重算。50 个数字一片，代价可以忽略。
 *   - `rejectedActions` 存拒绝**条数**而不是只存比率：合并后的拒绝率必须用总条数算。
 *   - `anomalies` 存全量：P0/P1 要按 code 累加，不能只存一个计数。
 */
import type { WorldEvent } from '../domain/world/events.ts';
import type { Analysis } from './analyzer.ts';
import type { CoverageReport } from './coverage.ts';
import type { AnomalyRecord } from './types.ts';
import type { GeoStats } from './geo-stats.ts';
import type { CodeDirtyBreakdown } from './code-version.ts';

/**
 * 结构化口径的版本号：合并脚本按它拒绝不认识的输入。
 * M2.4 从 m2.3-vplayer-shard/1 升到 /2：新增 worldSeed 与 worldEvents，
 * 老口径的 JSON 里没有这两个字段，合并脚本必须明确拒绝（而不是拿 undefined 当成"一致"）。
 *
 * M2.7 从 /2 升到 /3：新增 geo（出生城市分布 / 移动次数 / 路途事件分布）。
 * 同样必须明确拒绝老 JSON —— 否则合并报告里的「移动次数」会静默变成 0，
 * 而 0 恰恰是「这一轮没人移动过」的正常取值，两者没法区分。
 */
export const SHARD_SCHEMA = 'm2.7-vplayer-shard/3';

export interface CharacterFinalValues {
  dig: number[];
  mad: number[];
  cor: number[];
  hp: number[];
}

/**
 * 世界事件的实测证据（M2.4 验收的核心素材）。
 *
 * 为什么按「事件 id 序列的摘要」比而不是只比条数：
 *   条数相同但内容不同（两片各自看到不同的传闻）恰恰是最需要被抓住的那种 bug。
 *   id 是由**原因**拼出来的（env:地点:天气:起始时刻 / rumor:天:序号 / disc:地点:天），
 *   所以「id 序列逐字节相同」= 「4 片看到的是同一串世界事件」。
 */
export interface WorldEventEvidence {
  /** 落库事件总数 */
  count: number;
  /** 分类型条数 */
  byType: Record<string, number>;
  /** 分可见性条数（群播报口径核对） */
  byVisibility: Record<string, number>;
  /** 按 (created_at, id) 排序后的事件 id 序列（逐字节可比） */
  ids: string[];
  /** ids 的稳定摘要（FNV-1a 32 位）；4 片相同才叫「世界一致」 */
  digest: string;
}

export interface ShardJson {
  schema: string;
  /** 分片序号；不分片跑时是 0、shards 是 1 */
  shard: number;
  shards: number;
  seed: string;
  /**
   * M2.4：世界种子。**不随分片派生** —— 4 片必须完全相同，
   * 合并脚本据此判定「世界 seed 是不是全局的」。
   */
  worldSeed: string;
  /** M2.4：本片看到的世界事件（4 片必须逐字节一致） */
  worldEvents: WorldEventEvidence;
  players: number;
  days: number;
  baseEpoch: number;
  startedAt: string;
  costMs: number;
  stage: string;
  analysis: Analysis;
  coverage: CoverageReport;
  anomalies: AnomalyRecord[];
  profileSummary: Array<{ persona: string; players: number; loginAvg: number; actionsAvg: number; goalMix: string }>;
  cards: Array<{ id: string; conds: string[]; minSeq?: number; maxSeq?: number }>;
  values: CharacterFinalValues;
  /** 每个画像的角色数（加权用） */
  personaPlayers: Record<string, number>;
  /** 期末处于失控状态的角色数 */
  lostControl: number;
  /** 期末角色总数 */
  characters: number;
  /** 被系统拒绝的动作条数（合并后重算拒绝率） */
  rejectedActions: number;
  /** 本轮的判定门槛（合并脚本要按同一套门槛重算 pass，不能各片各算） */
  thresholds: { minCommandCount: number; minPromotions: number };
  /** M2.7：世界地理与跨区域移动（出生城市分布 / 移动次数 / 路途事件分布） */
  geo: GeoStats;
  /** 不分片小轮专用：社交指标（分片模式下这些数字失真，见任务书 §6.5） */
  social?: SocialMetrics;
  /**
   * ===== M2.32 任务 1（P0）：**这一片跑的是哪份代码** =====
   *
   * 在此之前的 7 个批次里，产物没有一处记着代码版本 ⇒
   * 「这批比上批多 N 人」永远缺一个「两批代码差多少」的未知量（M2.31 任务 0.2）。
   *
   * **为什么是可选字段、为什么不升 `SHARD_SCHEMA`**：
   * `worldSeed` / `geo` 那种字段一次升级就**必须**拒绝老 JSON（缺了会让合并结论变成假的；
   * 老 JSON 里 `geo` 缺失会把「移动次数」静默读成 0，而 0 正是「没人移动过」的正常取值）。
   * 这四个字段不同：**它们不参与任何合并计算**，缺了不会让任何一个数字变假 ——
   * 它只影响「这批能不能归因」。升 schema 会让 m219c—m226a 那批历史 JSON 全部被合并脚本拒收，
   * 代价远大于收益。**历史批不回溯补（不可考），新批一律有。**
   *
   * 读老 JSON 的人看到 `undefined` 时，正确的读法是「**M2.32 之前的批，代码版本未记录**」，
   * 不是「这批的代码与别批一样」。
   */
  codeRev?: string;
  codeDirty?: boolean;
  builtAt?: string;
  /** 为什么 dirty（判定输入 vs 产物）—— 让布尔可归因，见 code-version.ts */
  codeDirtyDetail?: CodeDirtyBreakdown;
}

/**
 * 事件 id 序列的稳定摘要（FNV-1a 32 位 → 8 位十六进制）。
 * 只是个「4 片是不是同一串」的比对键，不承担密码学职责。
 */
export function digestOfIds(ids: readonly string[]): string {
  let hash = 0x811c9dc5;
  for (const id of ids) {
    for (let index = 0; index < id.length; index += 1) {
      hash ^= id.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    hash ^= 0x0a; // 分隔符：没有它 ['ab','c'] 与 ['a','bc'] 会撞
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** 世界事件证据（cli.ts 从库里读出来后交给它算摘要） */
export function worldEventEvidenceOf(events: readonly WorldEvent[]): WorldEventEvidence {
  const ids = events.map((event) => event.id);
  const byType: Record<string, number> = {};
  const byVisibility: Record<string, number> = {};
  for (const event of events) {
    byType[event.type] = (byType[event.type] ?? 0) + 1;
    byVisibility[event.visibility] = (byVisibility[event.visibility] ?? 0) + 1;
  }
  return { count: events.length, byType, byVisibility, ids, digest: digestOfIds(ids) };
}

/** 只在**不分片**模式下才有意义的指标（分片会让跨玩家交互失真） */
export interface SocialMetrics {
  tradesCreated: number;
  tradesConfirmed: number;
  tradesExpired: number;
  /** 组队相关指令的出现次数（.队伍 任一子命令） */
  partyActions: number;
  partyTasks: number;
  /** 期末至少 2 人的队伍数 */
  partiesWithTwoPlus: number;
}
