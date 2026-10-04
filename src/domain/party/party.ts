/**
 * 队伍规则（W4 最小实现：上限 4 人，队长离开即解散）
 * 纯函数：只判断能不能做，不碰数据库。
 */
import { NUMERIC } from '../../config/numeric.ts';

export type PartyCheck = { ok: true } | { ok: false; reason: string };

export function maxPartyMembers(): number {
  return NUMERIC.party.maxMembers;
}

export function canCreateParty(currentPartyId: string | null): PartyCheck {
  if (currentPartyId) return { ok: false, reason: '你已经在一个队伍里了，先 .队伍 离开。' };
  return { ok: true };
}

export function canJoinParty(input: {
  currentPartyId: string | null;
  targetStatus: string;
  size: number;
}): PartyCheck {
  if (input.currentPartyId) return { ok: false, reason: '你已经在一个队伍里了，先 .队伍 离开。' };
  if (input.targetStatus !== 'active') return { ok: false, reason: '这个队伍已经解散了。' };
  if (input.size >= NUMERIC.party.maxMembers) {
    return { ok: false, reason: `队伍已满（上限 ${NUMERIC.party.maxMembers} 人）。` };
  }
  return { ok: true };
}

export function canLeaveParty(currentPartyId: string | null): PartyCheck {
  if (!currentPartyId) return { ok: false, reason: '你不在任何队伍里。' };
  return { ok: true };
}

/** 队伍规模是否满足组队卡门槛（cond: party:size>=N） */
export function meetsPartyThreshold(size: number, threshold: number): boolean {
  return size >= threshold;
}
