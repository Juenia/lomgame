/**
 * **神座的运行时状态**（M2.169）—— 内容为底、状态覆盖。
 *
 * `divine-thrones.yaml` 说「黑铁纪元谁坐在那儿」；这张表说「现在谁坐在那儿」。
 * 两者分开的理由与 `npc-tracks`（原作记载）vs `npc_progress`（世界状态）完全一样：
 * **一演化就把原著数据写花了**。
 *
 * ⚠️ 这里只放纯数据与纯函数；落库在 infra/db/divine-throne-state.ts。
 */
import type { DivineThrone, SeatKind, ThroneState } from './divine-throne.ts';

/** 一条覆盖记录（只有被阴谋碰过的位置才在表里） */
export interface ThroneStateRow {
  pathway: string;
  /** 现在坐着谁；**陨落时不清空** —— 它是「上一任」，而「疑似留有复活后手」那句话靠它 */
  seat: string;
  seatKind: string;
  state: ThroneState;
  since: number;
  /** 哪一场阴谋 / 哪一次事件改的 */
  changedBy: string;
  /** 怎么变的（编年史与 `.图鉴 途径` 读它） */
  fallNote: string;
}

/**
 * **把状态盖到内容上**（唯一一处合并实现）。
 *
 * 少了它、或者某处读取点忘了调它，后果是「神座换人了，但那个地方还念着旧名字」——
 * 而**不报错**。所以 world-tick 与 `.图鉴` 都走这一个函数。
 */
export function mergeThroneState(
  content: readonly DivineThrone[],
  states: readonly ThroneStateRow[],
): DivineThrone[] {
  if (states.length === 0) return [...content];
  const byPathway = new Map(states.map((row) => [row.pathway, row]));
  return content.map((throne) => {
    const row = byPathway.get(throne.pathway);
    if (row === undefined) return throne;
    return {
      ...throne,
      seat: row.seat === '' ? throne.seat : row.seat,
      seatKind: (row.seatKind === '' ? throne.seatKind : row.seatKind) as SeatKind,
      state: row.state,
    };
  });
}

/** 这条途径的座位现在是什么状态（没记录 = 内容里那个状态） */
export function throneStateOf(
  states: readonly ThroneStateRow[],
  pathway: string,
): ThroneStateRow | null {
  return states.find((row) => row.pathway === pathway) ?? null;
}

/** 玩家读到的那一句（`.图鉴 途径` 与编年史都用它） */
export function throneLineOf(row: ThroneStateRow): string {
  const who = row.seat === '' ? '那个位置' : row.seat;
  if (row.state === 'vacant') return who + '已经陨落 —— 那个位置空着。' + (row.fallNote === '' ? '' : row.fallNote);
  if (row.state === 'contested') return who + '还没坐稳 —— 有人在争这个位置。' + row.fallNote;
  if (row.state === 'sealed') return who + '还在那儿，但动不了。' + row.fallNote;
  return who + '在位。' + row.fallNote;
}
