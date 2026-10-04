import { formatCurrency } from '../../domain/currency/index.ts';
import { CURRENCY_ITEM_ID } from '../../domain/item/item.ts';
import { canCreateParty, canJoinParty, canLeaveParty, maxPartyMembers } from '../../domain/party/party.ts';
import { checkPartyTask, partyTaskKey, pickPartyTask } from '../../domain/party/task.ts';
import { createSeededRng, seedFrom } from '../../domain/rng.ts';
import type { CommandContext, CommandResult } from '../index.ts';
import { parseAtTarget } from '../args.ts';
import { applyFor, requireCharacter, today } from './common.ts';
import { tollOnAction } from './wanted-hooks.ts';

export const PARTY_USAGE =
  '用法：.队伍 创建 | .队伍 加入 @队长 | .队伍 任务 | .队伍 离开 | .队伍';

function renderParty(
  deps: CommandContext['deps'],
  party: { id: string; leaderId: string },
): string[] {
  const members = deps.parties.members(party.id);
  const lines = [`队伍 ${party.id}（${members.length}/${maxPartyMembers()} 人）`];
  for (const member of members) {
    const character = deps.characters.findById(member.characterId);
    lines.push(`  ${member.role === 'leader' ? '队长' : '成员'}：${character?.name ?? member.characterId}`);
  }
  return lines;
}

export async function handleParty(ctx: CommandContext): Promise<CommandResult> {
  const gate = requireCharacter(ctx);
  if (!gate.ok) return gate.result;
  const character = gate.character;
  const { deps, msg, now } = ctx;

  const action = (ctx.args[0] ?? '').trim();
  const current = deps.parties.partyOf(character.id);

  if (action === '创建') {
    const check = canCreateParty(current?.id ?? null);
    if (!check.ok) return { privateText: check.reason, detailToPrivate: true };
    const party = deps.parties.create(character.id, now);
    return {
      privateText: [...renderParty(deps, party), '', `把队伍号或你的 QQ 号告诉队友，让他们 .队伍 加入`].join('\n'),
      groupText: `【${character.name}】创建了队伍 ${party.id}。`,
      detailToPrivate: true,
    };
  }

  if (action === '加入') {
    const target = (ctx.args[1] ?? '').trim();
    if (!target) return { privateText: '用法：.队伍 加入 @队长', detailToPrivate: true };

    let party = deps.parties.get(target.toUpperCase());
    if (!party) {
      const qq = parseAtTarget(target) ?? target;
      const leader = deps.characters.findByUserId(qq);
      if (leader) party = deps.parties.findByLeader(leader.id);
    }
    if (!party) return { privateText: `找不到这个队伍：${target}`, detailToPrivate: true };

    /*
     * M2.18 任务 C2：**敌对教会不能同队**。
     *
     * 系统里没有独立的「邀请」指令（`加入` 是唯一的入口）——
     * 所以拒绝就落在这里：队长是哪家的，跟你是仇家就进不去。
     * 判据同样是 relationOf，不重实现。
     */
    const leaderCharacter = deps.characters.findById(party.leaderId);
    const myChurchId = character.churchId ?? null;
    const leaderChurchId = leaderCharacter?.churchId ?? null;
    if (
      myChurchId &&
      leaderChurchId &&
      myChurchId !== leaderChurchId &&
      deps.churches.relationOf(myChurchId, leaderChurchId) === 'hostile'
    ) {
      const mine = deps.churches.byId(myChurchId)?.name ?? myChurchId;
      const theirs = deps.churches.byId(leaderChurchId)?.name ?? leaderChurchId;
      return {
        privateText: [
          '队长信的是' + theirs + '，你信的是' + mine + ' —— 你们的神不共戴天。',
          '这个队伍不会收你。同门、或与' + theirs + '不敌对的人才能加入。',
        ].join('\n'),
        detailToPrivate: true,
      };
    }

    const check = canJoinParty({
      currentPartyId: current?.id ?? null,
      targetStatus: party.status,
      size: deps.parties.sizeOf(party.id),
    });
    if (!check.ok) return { privateText: check.reason, detailToPrivate: true };

    deps.parties.addMember(party.id, character.id, now);
    const leader = deps.characters.findById(party.leaderId);
    return {
      privateText: [...renderParty(deps, party), '', '你加入了队伍。'].join('\n'),
      groupText: `【${character.name}】加入了【${leader?.name ?? '队长'}】的队伍。`,
      detailToPrivate: true,
      extra: leader
        ? [
            {
              scene: 'private',
              targetId: leader.userId,
              text: `【${character.name}】加入了你的队伍（${deps.parties.sizeOf(party.id)}/${maxPartyMembers()} 人）。`,
            },
          ]
        : [],
    };
  }

  if (action === '任务') {
    const check = checkPartyTask({
      isLeader: current?.leaderId === character.id,
      partyId: current?.id ?? null,
      memberCount: current ? deps.parties.sizeOf(current.id) : 1,
      usedToday: current
        ? deps.dailyCounters.countOf(
            current.leaderId,
            today(ctx),
            partyTaskKey(current.id),
          )
        : 0,
    });
    if (!check.ok) return { privateText: check.reason, detailToPrivate: true };
    const party = current!;

    const seed = seedFrom([msg.messageId, character.id, now, 'party_task']);
    const task = pickPartyTask(deps.parties.sizeOf(party.id), createSeededRng(seed));
    if (!task) return { privateText: '队伍人数不够，暂时没有可接的任务。', detailToPrivate: true };

    const members = deps.parties
      .members(party.id)
      .map((member) => deps.characters.findById(member.characterId))
      .filter((member): member is NonNullable<typeof member> => member !== null);

    // M2.6：带队出任务也算一次"在势力范围内活动"（M2.85 起队长不再扣行动点）
    const toll = tollOnAction({ deps, state: character, now, seed });
    deps.characters.update(toll.state);

    const lines: string[] = [
      `队伍任务【${task.name}】`,
      task.description,
      '',
      `参与成员（${members.length} 人）：${members.map((member) => member.name).join('、')}`,
    ];
    for (const member of members) {
      const applied = applyFor(
        deps,
        member.id === character.id ? toll.state : member,
        [
          { type: 'dig', value: task.digPerMember },
          ...(task.madPerMember > 0 ? [{ type: 'mad' as const, value: task.madPerMember }] : []),
        ],
        `队伍任务:${task.id}`,
        now,
        seed,
      );
      if (member.id !== character.id) {
        deps.characters.update(applied.newState);
        deps.characters.appendEvents(applied.events);
      } else {
        // 队长的 AP 已经落库，这里只补任务收益
        deps.characters.update(applied.newState);
        deps.characters.appendEvents(applied.events);
      }
      // M2.5 追加：货币内部一律便士；分红值（goldPerMember）不变，只是单位解释成便士
    deps.inventory.add(member.id, CURRENCY_ITEM_ID, task.goldPerMember, 'unbound', now);
      lines.push(
        `  ${member.name}：货币 +${formatCurrency(task.goldPerMember)}，消化 +${task.digPerMember}${task.madPerMember ? `，疯狂 +${task.madPerMember}` : ''}`,
      );
    }

    deps.dailyCounters.increment(party.leaderId, today(ctx), partyTaskKey(party.id));
    deps.db
      .prepare(
        `INSERT INTO party_tasks (party_id, task_id, leader_id, date, members, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(party.id, task.id, party.leaderId, today(ctx), members.length, now);

    const extras = members
      .filter((member) => member.id !== character.id)
      .map((member) => ({
        scene: 'private' as const,
        targetId: member.userId,
        text: [
          `队伍任务【${task.name}】完成`,
          `货币 +${formatCurrency(task.goldPerMember)}，消化 +${task.digPerMember}${task.madPerMember ? `，疯狂 +${task.madPerMember}` : ''}`,
        ].join('\n'),
      }));

    for (const line of toll.lines) lines.push(line);

    return {
      privateText: lines.join('\n'),
      groupText: `【${character.name}】带着队伍做完了「${task.name}」。`,
      detailToPrivate: true,
      extra: extras,
    };
  }

  if (action === '离开') {
    const check = canLeaveParty(current?.id ?? null);
    if (!check.ok) return { privateText: check.reason, detailToPrivate: true };
    const party = current!;
    const isLeader = party.leaderId === character.id;

    if (isLeader) {
      const members = deps.parties.members(party.id).filter((m) => m.characterId !== character.id);
      deps.parties.disband(party.id);
      const extras = members
        .map((member) => deps.characters.findById(member.characterId))
        .filter((member): member is NonNullable<typeof member> => member !== null)
        .map((member) => ({
          scene: 'private' as const,
          targetId: member.userId,
          text: `队伍 ${party.id} 已解散（队长离开）。`,
        }));
      return {
        privateText: `你离开了队伍 ${party.id}，作为队长，队伍随之解散。`,
        groupText: `【${character.name}】解散了队伍。`,
        detailToPrivate: true,
        extra: extras,
      };
    }

    deps.parties.removeMember(party.id, character.id);
    return {
      privateText: `你离开了队伍 ${party.id}。`,
      groupText: `【${character.name}】离开了队伍。`,
      detailToPrivate: true,
    };
  }

  if (!current) {
    return {
      privateText: [
        '你不在任何队伍里。',
        '.队伍 创建 —— 建一个队伍（上限 4 人）',
        '.队伍 加入 @队长 —— 加入别人的队伍',
      ].join('\n'),
      detailToPrivate: true,
    };
  }

  return {
    privateText: [...renderParty(deps, current), '', '组队后可以触发需要两人的事件卡（.扮演 / .事件 / .探索 时判定）。'].join('\n'),
    groupText: `【${character.name}】查看了队伍信息。`,
    detailToPrivate: true,
  };
}
