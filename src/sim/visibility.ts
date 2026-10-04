/**
 * 可见性预算（M2.1）：把「闸门重定」翻译成「玩家能不能看见那 8 张卡」。
 *
 * 链路（每一步都用真实规则/真实卡池算，不拍脑袋）：
 *   失控天数（经验投影）
 *     × 每天 .扮演 次数（实测行为日志里的画像均值）
 *     × 暴露概率（NUMERIC.play.exposureChance）
 *     = 失控日的抽卡次数
 *   再乘以「该卡在失控状态下的随机池权重占比」（EventEngine.eligible + 真实权重）
 *     = 该卡在窗口内的期望触发次数
 *
 * 关键前提（报告里必须写清楚）：**只有混乱型会留在失控状态里继续玩**。
 * 其余画像在失控当天的第一条指令就会 .净化 / .休息 解除状态（decide.ts 第 2 步），
 * 而这两条恢复路径都会清除失控（domain/recovery/recovery.ts），所以它们一次都碰不到 lost_*。
 */
import { NUMERIC } from '../config/numeric.ts';
import { loadCards } from '../cards/loader.ts';
import { EventEngine } from '../domain/event/engine.ts';
import type { CharacterState } from '../domain/character/types.ts';
import type { PersonaProjection } from './empirical.ts';

export interface PoolShare {
  cardId: string;
  weight: number;
  share: number;
}

/** 失控状态下「.扮演 暴露抽卡」的可用池与各卡权重占比（走真实 EventEngine.eligible） */
export function lostControlPoolShares(options: { partySize: number }): PoolShare[] {
  const engine = new EventEngine(loadCards().cards);
  const state: CharacterState = {
    id: 'probe',
    userId: 'probe',
    name: 'probe',
    pathway: 'seer',
    sequence: 9,
    // 这是一个「已入途径的探针角色」——它用来量失控卡池的权重分布
    pathwayStatus: 'initiated',
    gender: 'male',
    hp: 100,
    mp: 100,
    mad: 45,
    cor: 20,
    dig: 60,
    dp: 0,
    status: 'lost_control',
    promotionFails: 0,
    createdAt: 0,
    updatedAt: 0,
  };
  const pool = engine.eligible(
    {
      character: state,
      flags: new Set<string>(),
      date: '2026-01-01',
      partySize: options.partySize,
    },
    { date: '2026-01-01', types: ['random'] },
  );
  const total = pool.reduce((sum, card) => sum + card.trigger.weight, 0);
  return pool.map((card) => ({
    cardId: card.id,
    weight: card.trigger.weight,
    share: total > 0 ? card.trigger.weight / total : 0,
  }));
}

export interface VisibilityRow {
  cardId: string;
  /** 期望触发次数（窗口内，全批次） */
  expectedHits: number;
  /** 一次都不出现的概率 */
  zeroProbability: number;
  note: string;
}

/**
 * 估算 8 张验收卡在窗口内的期望触发次数。
 * 只有能留在失控状态里继续玩的画像（默认 chaotic）会产生 lost_* 抽卡。
 */
export function cardVisibility(input: {
  cards: readonly string[];
  /** 各画像在窗口内的人均失控天数（经验投影给） */
  lostControlDaysPerCharacter: Readonly<Record<string, number>>;
  /** 该窗口内、每画像的玩家数 */
  playersPerPersona: number;
  /** 能在失控状态里继续玩的画像（其余画像第一条指令就解除） */
  activePersonas?: readonly string[];
  /** 各画像每天 .扮演 次数（实测） */
  playsPerDay: Readonly<Record<string, number>>;
  /** 窗口天数 */
  days: number;
  /** 落在失控日里的队伍占比（lost_001 / lost_005 需要队伍 ≥ 2） */
  partyShare: number;
  /** 每天在同一状态下最多抽到同一张卡一次（triggeredToday） */
}): VisibilityRow[] {
  const active = input.activePersonas ?? ['chaotic'];
  const solo = lostControlPoolShares({ partySize: 1 });
  const party = lostControlPoolShares({ partySize: 2 });

  const rows: VisibilityRow[] = [];
  for (const cardId of input.cards) {
    const needsParty = (party.find((entry) => entry.cardId === cardId)?.weight ?? 0) > 0 &&
      !(solo.find((entry) => entry.cardId === cardId));
    let expected = 0;
    for (const persona of active) {
      const lostDays = (input.lostControlDaysPerCharacter[persona] ?? 0) * input.playersPerPersona;
      const drawsPerLostDay = (input.playsPerDay[persona] ?? 0) * NUMERIC.play.exposureChance;
      if (drawsPerLostDay <= 0) continue;
      const soloShare = solo.find((entry) => entry.cardId === cardId)?.share ?? 0;
      const partyShare = party.find((entry) => entry.cardId === cardId)?.share ?? 0;
      const share = needsParty
        ? partyShare * input.partyShare + soloShare * (1 - input.partyShare)
        : soloShare;
      if (share <= 0) continue;
      // 每天最多抽到同一张卡一次：按天做一次「至少一次」的二项近似
      const perDay = 1 - Math.pow(1 - share, Math.max(0.01, drawsPerLostDay));
      expected += lostDays * perDay;
    }
    rows.push({
      cardId,
      expectedHits: expected,
      zeroProbability: Math.exp(-expected),
      note: needsParty ? '需要队伍 ≥ 2（random_007/008 同池）' : '只要失控状态即可',
    });
  }
  return rows;
}

export { type PersonaProjection };
