/**
 * M2.13：**封印物的判定层类型**（纯函数，无 IO）。
 *
 * 三类封印物共用一套接口，因为它们在**判定这一侧**是同一件事：
 *   「用掉一件东西，换来一次本来没有的机会，并当场付掉代价」。
 * 差别只在 `action` 是哪一支 —— 命令层按 `action.kind` 分发，判定层不认识指令。
 */
import type { EffectDelta } from '../effect/apply.ts';
import type { Rng } from '../character/types.ts';

/** 三类封印物（与 `items.yaml` 的 `type` 字段同值） */
export type ExtraordinaryKind = 'wonder' | 'sealed' | 'charm';

/**
 * 掉落档位：按**地点的序列门槛**分三档（见 `NUMERIC.extraordinary.dropRates`）。
 *
 * 为什么是地点门槛而不是地点 id：内容表里「危险度」与「序列门槛」是同一件事的两面
 * （每一个 `min_seq: 7` 的地点都是 danger 4—5），
 * 而写成档位之后，同一张表对所有地点成立 —— 加地点不用改数值。
 */
export type DropTier = 'seq9' | 'seq8' | 'seq7';

/** 一次掉落判定的结果（抽样值一并返回，落 `domain_events` 供复现） */
export interface ExtraordinaryDrop {
  kind: ExtraordinaryKind;
  tier: DropTier;
  /** 这一次的抽样值（0—1） */
  roll: number;
  /** 这一次比对的概率 */
  chance: number;
}

/**
 * M2.14：一次**灾厄产出**的判定结果。
 *
 * 与 ExtraordinaryDrop 分开而不是复用它：灾厄掉落**没有档位**（tier）——
 * 档位是「地点序列门槛」的概念，而灾厄按**灾厄等级**分档。
 * 硬塞一个 tier 进去只会让报告里出现一个没有意义的字段。
 */
export interface CalamityDrop {
  kind: ExtraordinaryKind;
  /** 这一次的抽样值（0—1） */
  roll: number;
  /** 这一次比对的概率 */
  chance: number;
}

/**
 * 判定需要的「目标视图」。
 *
 * ⚠️ 它是**纯数据**，不是任何仓储对象 —— 判定层不查库、不认识 SQL。
 * 命令层查好之后喂进来（与 `BattleSpeciesView` 同一手法）。
 */
export interface ExtraordinaryTarget {
  /** 对手的序列（封印之刃 / 灰雾之眼要用它） */
  sequence?: number;
  /** 对手的血（灰雾之眼要显示它） */
  hp?: number;
  maxHp?: number;
  /** 对手的显示名 */
  name?: string;
  /** 对手此刻在哪（灰雾之眼要显示它） */
  locationId?: string | null;
  locationName?: string | null;
}

/**
 * 判定层给命令层的「接下来做什么」。
 *
 * 分得这么细是为了守住一条纪律：**判定层不做 IO，命令层不做判定**。
 * 例如灰雾之眼的 `reveal` 只说明「要看哪几项」，具体去哪里查是命令层的事；
 * 封印之刃的 `attack` 只说明「这一次攻击无视序列差」，真正的攻击由战斗判定层执行。
 */
export type ExtraordinaryAction =
  /**
   * 命运骰子：本回合打空后重抽一次。
   * 判定层把它实现成「同一判定掷两次、取更好的那次」（见 `resolveAssaultWithFateDice`）。
   */
  | { kind: 'reroll' }
  /** 封印之刃：这一次攻击**无视一次序列差拦截**（`AssaultInput.ignoreSequenceGap`） */
  | { kind: 'attack'; ignoreSequenceGap: true; hitModifier: number }
  /** 血月之刃：这一次攻击的伤害 ×N */
  | { kind: 'power_attack'; damageMultiplier: number }
  /** 灰雾之眼：把目标的这几项显示出来（命令层去查） */
  | { kind: 'reveal'; fields: readonly string[] }
  /*
   * 时间沙漏（M2.85）：原 `restore_ap`（行动点回到 to、之后几天恢复减半）
   * 随行动值机制移除 —— 这个 kind 已经不存在了。
   */
  /** 隐身符：这么多小时之内不被通缉 */
  | { kind: 'hide_wanted'; hours: number }
  /** 传送符：传送到已标记的地点 */
  | { kind: 'teleport'; toMarked: true }
  /** 神奇物品：它是**被动**生效的（在背包里就管用），主动使用什么都不会额外发生 */
  | { kind: 'passive' };

/** 一次「使用封印物」的判定结果 */
export interface UseResult {
  ok: boolean;
  /** ok = false 时的原因（回执直接用） */
  reason?: string;
  /**
   * 要提交给 `apply()` 的数值变化 —— **恒包含使用代价**。
   *
   * 「代价在失败时也照付」是刻意的（见 `extraordinary.ts` 的注释）：
   * 命运骰子借的是一次运气，不是一次成功。
   */
  deltas: EffectDelta[];
  /** 接下来做什么（null = 纯被动，没有动作） */
  action: ExtraordinaryAction | null;
  /** 这次的抽样值；这一轮的封印物效果都是确定性的，恒为 null */
  roll: number | null;
  /** 封印等级 ≥ 阈值时给一句警告（不影响判定） */
  sealWarning: string | null;
}

export type { Rng };
