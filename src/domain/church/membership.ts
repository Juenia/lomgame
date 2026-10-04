/**
 * 教会成员（M2.16）—— 判定层纯函数，**零 IO、零随机**。
 *
 * 三件事，全部只读入参 + `NUMERIC.church`：
 *   - `canJoin`       能不能入这家教会（五条判据，失败给**具体原因**）
 *   - `canDonate` / `contribute`  捐献能换多少贡献（**不掷骰**——铁律 6 的直接落地）
 *   - `currentRank` / `checkRankUp`  现在在第几档、什么时候升
 *
 * ## 档位是**算出来的**，不是存出来的
 *
 * `characters` 只存 `church_id` 与 `church_contribution` 两列（M2.16 迁移只加这两列）——
 * **没有 rank 列**。档位完全由「贡献 + 序列」两个门槛算出来，
 * 于是「序列升上来了但档位没升」这种不一致状态在数据结构上就不可能存在；
 * 代价是**必须有人定期去算**（捐款后 + 每日 tick，见 E3 的双触发）。
 *
 * ## 为什么等级用**索引**而不是 `ranks[i].id`
 *
 * 见 `RankIndex` 的注释：档位 id 不是全局 id 空间。
 */
import { NUMERIC } from '../../config/numeric.ts';
import type { PathwayId } from '../character/types.ts';
import type { ChurchDef } from './schema.ts';

/**
 * 教内档位的**索引**（0 起），与 `NUMERIC.church.ranks` 的两个数组一一对应。
 *
 * ⚠️ 为什么不是 `ranks[i].id`：**档位 id 不是全局 id 空间**。七家里只有
 * `believer` / `bishop` / `archbishop` / `pontiff` 四个 id 是共享的，第 2、3 档各家不同
 * （战神的 `soldier`、女神的 `night_watch`、蒸汽的 `craftsman`、知识的 `scribe`…），
 * 而且**同一个 id 在不同教会是不同的名字**：`storm_lord` 的 `priest` 叫「司铎」、
 * `earth_mother` 的 `priest` 叫「司祭」。
 *
 * 所以 `ranks[i].id` **只在教会内可比**；跨教会的统计（以及门槛数组的查表）
 * 一律用索引。这与「档位名是内容、阈值是数值」（铁律 4）是同一件事的两面。
 */
export type RankIndex = number;

/**
 * 已实现途径的中文名（回执文案用；与 PATHWAY_LABELS 同源但这里不引入整个模块）。
 *
 * M2.19 加了 sailor —— 少一行不会报错（`?? id` 兜底），只会让水手玩家在入教回执里
 * 看到「你是 sailor 途径」。这种静默降级正是这张表要跟着途径一起改的理由。
 */
const PATHWAY_LABELS: Record<string, string> = {
  seer: '愚者',
  warrior: '战士',
  sleepless: '不眠者',
  sailor: '水手',
};

function pathwayLabel(id: string): string {
  return PATHWAY_LABELS[id] ?? id;
}

export interface JoinState {
  pathway: PathwayId | null;
  pathwayStatus: string;
  churchId?: string | null;
}

export interface JoinContext {
  /** 玩家此刻所在城市 id（命令层从 `characters.current_city_id` 读） */
  cityId: string | null;
  /** 该城市的中文名（回执文案用；缺省时退回 id） */
  cityName?: string;
}

export interface JoinCheck {
  ok: boolean;
  /** 不 ok 时给玩家看的**具体原因** —— 不是「不能入教」四个字 */
  reason: string;
}

/**
 * 能不能入教。五条判据，顺序即优先级（先说的先卡）：
 *
 *   1. 已经走上途径（`pathway_status === 'initiated'`）；
 *   2. 还没入过教（**硬互斥**：一人一家，本版不做出退）；
 *   3. 这家教会的途径**已实现**（七家里五家 `pathway: null`）；
 *   4. 途径对得上（教会与途径强绑定）；
 *   5. 教会在这座城市**有堂口**（`seats`）。
 *
 * ⚠️ 第 3 条不是防御性代码：`seer` 玩家会走到这里，而他没有任何正神教会可入 ——
 * 那条路走的是 `factions.yaml` 的本地势力权重（线索的途径落点，见 M2.16 交付说明 §1.2）。
 * 回执要把这件事说清楚（「还没有开放」），而不是让他以为是自己条件不够。
 */
export function canJoin(state: JoinState, church: ChurchDef, context: JoinContext): JoinCheck {
  const city = context.cityId ?? null;
  const cityLabel = context.cityName ?? city ?? '这里';

  if (state.pathwayStatus !== 'initiated' || !state.pathway) {
    return { ok: false, reason: '你还没有走上任何途径。去 .探索 翻线索（.线索 看进展）。' };
  }
  if (state.churchId) {
    return {
      ok: false,
      reason: '你已经入了一家教会。一个人只能属于一家 —— 这一版没有退出的路。',
    };
  }
  if (!church.pathway) {
    return {
      ok: false,
      reason: church.name + ' 的途径还没有开放，现在还没有人能入这家教会。',
    };
  }
  if (church.pathway !== state.pathway) {
    return {
      ok: false,
      reason:
        church.name + ' 只收走' + pathwayLabel(church.pathway) + '途径的人，' +
        '而你是' + pathwayLabel(state.pathway) + '途径。',
    };
  }
  if (!city) {
    return { ok: false, reason: '你还没有落脚的城市。' };
  }
  if (!church.seats.includes(city)) {
    return { ok: false, reason: church.name + ' 在' + cityLabel + '没有堂口。' };
  }
  return { ok: true, reason: '' };
}

export interface DonateState {
  churchId?: string | null;
  /** 累计贡献点 */
  churchContribution?: number;
  /** 当前持有的便士（命令层从背包读；判定层不碰库） */
  penny: number;
}

/** 单次捐献的上界（便士）：当前持有的 maxShareOfHolding */
export function donationCap(penny: number): number {
  return Math.floor(penny * NUMERIC.church.donation.maxShareOfHolding);
}

/**
 * 能不能捐献。四条判据：
 *   1. 已经入了**这家**教会；
 *   2. 金额是正整数；
 *   3. 钱够；
 *   4. **单次不超过当前持有的一半**（补充一）。
 *
 * 第 4 条的理由：只校验「钱够」的话，P90 玩家（M2.14 实测持有一两千便士）
 * 一次把积蓄全捐了 = 从档 1 直接跳到档 5，三十年功力一日之功。
 * 「一次把全部积蓄给教会」在世界观上也说不通（人要留钱买材料、赶路、净化）。
 */
export function canDonate(state: DonateState, church: ChurchDef, amount: number): JoinCheck {
  if (state.churchId !== church.id) {
    return { ok: false, reason: '你还没有加入 ' + church.name + '。' };
  }
  if (!Number.isInteger(amount) || amount <= 0) {
    return { ok: false, reason: '捐献金额要是正整数（单位：便士）。' };
  }
  if (amount > state.penny) {
    return { ok: false, reason: '你只有 ' + state.penny + ' 便士。' };
  }
  const cap = donationCap(state.penny);
  if (cap <= 0) {
    return { ok: false, reason: '你手上的钱太少了，教会不收。' };
  }
  if (amount > cap) {
    return {
      ok: false,
      reason:
        '一次最多捐献 ' + cap + ' 便士（当前持有的 ' +
        Math.round(NUMERIC.church.donation.maxShareOfHolding * 100) + '%）。' +
        '教会不收倾家荡产的那一份。',
    };
  }
  return { ok: true, reason: '' };
}

/**
 * 便士 → 贡献点：`floor(penny / pennyPerContribution)`。
 *
 * **纯换算，不掷骰**（铁律 6）：捐献是确定性的，它不该消耗随机数，
 * 也不该让同 seed 的其它判定因为「有人捐了一次钱」而漂移。
 * 零头**不退也不进位**（捐 9 便士 = 0 点）—— 这条在回执里要写出来。
 */
export function contributionOf(penny: number): number {
  return Math.floor(penny / NUMERIC.church.donation.pennyPerContribution);
}

export interface ContributionDelta {
  /** 这一次捐献换来的贡献点 */
  contribution: number;
  /** 捐献之后的累计贡献 */
  total: number;
}

export function contribute(penny: number, current: number): ContributionDelta {
  const contribution = contributionOf(penny);
  return { contribution, total: current + contribution };
}

/**
 * 玩家**此刻**的档位索引。
 *
 * 算法是「双门槛都满足的最高档」，而不是「贡献档」或「序列档」的任一个：
 *   - 只看贡献 → 序列没跟上的人会挂着一个读不出来的头衔；
 *   - 只看序列 → 贡献就白捐了。
 * 于是 `currentRank` 是**单调不减**的（贡献只增、序列只降），
 * 这让「档位会不会掉」这个问题在结构上不存在。
 *
 * 未入途径（`sequence === null`）按序列 9 处理 —— 与 `sequenceOrInitiate` 同一口径，
 * 而且那种玩家根本入不了教（`canJoin` 第 1 条）。
 */
export function currentRank(
  state: { churchContribution?: number; sequence: number | null },
  _church: ChurchDef,
): RankIndex {
  const cfg = NUMERIC.church.ranks;
  const contribution = state.churchContribution ?? 0;
  const sequence = state.sequence ?? 9;
  let rank = 0;
  for (let i = 0; i < cfg.contributionThreshold.length; i += 1) {
    if (contribution >= (cfg.contributionThreshold[i] ?? 0) && sequence <= (cfg.sequenceGate[i] ?? 9)) {
      rank = i;
    }
  }
  return rank;
}

/** 某一档的名字（内容侧）。越界时退回一个不会崩的字符串 */
export function rankNameOf(church: ChurchDef, rank: RankIndex): string {
  return church.ranks[rank]?.name ?? '第 ' + (rank + 1) + ' 档';
}

/** 某一档的机器名（事件 payload 里带一份，便于回放时不必查内容表） */
export function rankIdOf(church: ChurchDef, rank: RankIndex): string {
  return church.ranks[rank]?.id ?? 'unknown';
}

export interface NextRank {
  index: RankIndex;
  name: string;
  /** 这一档要的贡献点 */
  contribution: number;
  /** 这一档要的序列（越小越高） */
  sequence: number;
  /** 还差多少贡献点（0 = 够了） */
  missingContribution: number;
  /** 序列够不够 */
  sequenceOk: boolean;
}

/** 下一档的门槛与差额；已经在最高档 → null */
export function nextRankOf(
  state: { churchContribution?: number; sequence: number | null },
  church: ChurchDef,
): NextRank | null {
  const cfg = NUMERIC.church.ranks;
  const from = currentRank(state, church);
  const index = from + 1;
  if (index >= cfg.contributionThreshold.length) return null;
  const contribution = cfg.contributionThreshold[index] ?? 0;
  const sequence = cfg.sequenceGate[index] ?? 9;
  const held = state.churchContribution ?? 0;
  const playerSequence = state.sequence ?? 9;
  return {
    index,
    name: rankNameOf(church, index),
    contribution,
    sequence,
    missingContribution: Math.max(0, contribution - held),
    sequenceOk: playerSequence <= sequence,
  };
}

export interface RankUpCheck {
  canUp: boolean;
  from: RankIndex;
  to: RankIndex;
  /** 不能升时卡在哪一边（回执与报告用） */
  blockedBy: 'contribution' | 'sequence' | 'max' | null;
}

/**
 * 该不该升档。`knownRank` 是**上一次记到第几档**（命令层与 tick 层从
 * `church_rank_up` 事件里读；入教时是 0）。
 *
 * 为什么需要它而不是只算一次 `currentRank`：档位是算出来的、没有存储列，
 * 于是「变了没有」只能跟**上一次记录下来**的那个值比 —— 否则每次 tick
 * 都会给所有人重记一条 `church_rank_up`。
 *
 * `knownRank` 缺省 0 = 「从信徒算起」，这就是捐款后立即检测的用法
 * （那一次捐献之前玩家至少是信徒）。
 */
export function checkRankUp(
  state: { churchContribution?: number; sequence: number | null },
  church: ChurchDef,
  knownRank: RankIndex = 0,
): RankUpCheck {
  const to = currentRank(state, church);
  const maxIndex = NUMERIC.church.ranks.contributionThreshold.length - 1;
  if (to > knownRank) return { canUp: true, from: knownRank, to, blockedBy: null };
  const next = nextRankOf(state, church);
  return {
    canUp: false,
    from: knownRank,
    to,
    blockedBy: next === null ? 'max' : next.sequenceOk ? 'contribution' : 'sequence',
  };
}
