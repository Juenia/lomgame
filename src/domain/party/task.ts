/**
 * 队伍任务（W5 次级项）：队长发起，全体成员分赃。
 * 纯函数只负责「选哪个任务、给什么奖励」，落库与发放由指令层做。
 */
import { NUMERIC } from '../../config/numeric.ts';
import type { Rng } from '../character/types.ts';

export interface PartyTaskDef {
  id: string;
  name: string;
  description: string;
  minMembers: number;
  goldPerMember: number;
  digPerMember: number;
  madPerMember: number;
}

export const PARTY_TASKS: readonly PartyTaskDef[] = [
  {
    id: 'night_patrol',
    name: '夜间巡街',
    description: '两人一组把街区走一遍，遇到不该出现的东西就绕开。',
    minMembers: 2,
    goldPerMember: 2,
    digPerMember: 1,
    madPerMember: 1,
  },
  {
    id: 'archive_run',
    name: '档案搬运',
    description: '把封存的卷宗搬到另一个库房，别读它们。',
    minMembers: 2,
    goldPerMember: 4,
    digPerMember: 0.5,
    madPerMember: 0,
  },
  {
    id: 'ritual_guard',
    name: '仪式护法',
    description: '替同伴守着仪式的外圈。守着的人比做仪式的人更容易被看见。',
    minMembers: 3,
    goldPerMember: 5,
    digPerMember: 2,
    madPerMember: 2,
  },
];

export function partyTaskKey(partyId: string): string {
  return `party_task:${partyId}`;
}

export function minMembersFor(tasks: readonly PartyTaskDef[] = PARTY_TASKS): number {
  return Math.min(...tasks.map((task) => task.minMembers));
}

export function eligiblePartyTasks(memberCount: number): PartyTaskDef[] {
  return PARTY_TASKS.filter((task) => task.minMembers <= memberCount);
}

/** 按 seed 从可用任务里抽一个（同 seed 同任务） */
export function pickPartyTask(memberCount: number, rng: Rng): PartyTaskDef | null {
  const pool = eligiblePartyTasks(memberCount);
  if (pool.length === 0) return null;
  const index = Math.min(pool.length - 1, Math.floor(rng.next() * pool.length));
  return pool[index] ?? null;
}

export type PartyTaskCheck = { ok: true } | { ok: false; reason: string };

export function checkPartyTask(input: {
  isLeader: boolean;
  partyId: string | null;
  memberCount: number;
  usedToday: number;
}): PartyTaskCheck {
  if (!input.partyId) return { ok: false, reason: '你不在任何队伍里，先 .队伍 创建。' };
  if (!input.isLeader) return { ok: false, reason: '只有队长能发起队伍任务。' };
  if (input.memberCount < minMembersFor()) {
    return { ok: false, reason: `队伍任务至少需要 ${minMembersFor()} 人（当前 ${input.memberCount} 人）。` };
  }
  if (input.usedToday >= NUMERIC.party.taskDailyLimit) {
    return { ok: false, reason: '今天已经做过队伍任务了。' };
  }
  return { ok: true };
}
