/**
 * 普通人阶段与途径获得（M2.7.6；M2.85 修订）—— 领域类型。
 *
 * 这一层的全部东西都是**纯数据 + 纯函数**：没有 IO、没有数据库、没有时钟。
 * 落库由 infra/db/initiation.ts，装配由 router/commands/*.ts 负责。
 * 判定的种子统一由调用方派生（seedFrom）后传进来，所以同一条指令重放必然得到同一结果。
 *
 * M2.85：势力引导的邀约与任务类型（OfferStage / GuidedTask / PathwayOffer）
 * 随引导玩法一并删除 —— 「走上途径」只剩探索翻线索这一条路。
 */
import type { PathwayId } from '../character/types.ts';

/** 角色此刻是否已经走上途径 */
export type PathwayStatus = 'mortal' | 'initiated';

/** 一家本地势力（内容来自 src/data/factions.yaml） */
export interface GuidedFaction {
  id: string;
  name: string;
  /** 所在城市 id */
  cityId: string;
  /** 这家势力传承的途径 —— M2.85 起它决定「本城翻到的线索指向哪条途径」 */
  pathway: PathwayId;
  /**
   * 同城两家势力之间的主/次优先级。
   * 权重来自 NUMERIC.initiation.factionPriority（primary 0.7 / secondary 0.3），
   * 也就是「这座城市里谁的东西更常流传」—— 不是硬性配额。
   */
  priority: 'primary' | 'secondary';
  /** 势力给人的第一印象（氛围文案；M2.85 起仅作内容存档，运行时不再播报） */
  greeting: string;
  /**
   * 引导任务模板（M2.85 起仅作内容存档）。
   *
   * 引导玩法下线后，运行时不再读取这个字段；数据留在 factions.yaml 里，
   * 因为它是世界观内容（每家势力平时让人办什么差事），不是死代码 ——
   * 将来做势力任务、声望之类的玩法时，这张表还是第一手素材。
   */
  tasks: readonly unknown[];
}

/** 一条配方线索（recipe_clues 的一行） */
export interface RecipeClue {
  id: string;
  characterId: string;
  pathway: PathwayId;
  clueText: string;
  foundAt: number;
  usedAt: number | null;
}

/** 判定层的世界输入：调用方查库后喂进来，判定层不认识数据库 */
export interface InitiationWorld {
  /** 角色出生/此刻所在城市的本地势力（按城市过滤后的内容表） */
  factions: readonly GuidedFaction[];
  /** 玩家手上还没用掉的配方线索 */
  openClues: readonly RecipeClue[];
  /** 角色创建于哪一天（用于算「第几天」与线索保底），毫秒时间戳 */
  bornAt: number;
}
