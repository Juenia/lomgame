/**
 * .袭击 指令（M2.6 起，M2.6.1 改为序列差判定）。
 *
 *   .袭击 @某人      消耗 1 AP，把对方打到重伤 → 你在**对方所在地点**的势力那里吃通缉
 *
 * 为什么 M2.6 需要这条指令（任务书里没列，是本轮补的）：
 *   任务书 §主任务五 说「MVP 只做：重伤玩家 → 1 级通缉（盘查）」，
 *   §五 又要求虚拟玩家「随机一部分玩家尝试犯罪（重伤他人）」——
 *   但交付物清单里没有任何一条能造成伤害的指令。
 *   没有它，「1 级通缉的触发条件生效」这条验收就没有触发源，
 *   通缉系统会是一个永远为空的功能。所以补这一条，并在交付说明里写明。
 *
 * ⚠️ **本文件里没有任何序列比较**（M2.6.1 硬约束）。
 *    「谁比谁强」「命中率多少」「要不要过抗性」「高打低该签几级通缉」
 *    全部由 `domain/wanted/assault.ts` 的 `resolveAssault` 给出，
 *    命令层只做四件事：渲染文本、扣 AP、落库、发播报。
 *    连「你比他弱几个序列」这句人话都是判定层给的（`gapLabel`）。
 *
 * 与「杀人」的边界（任务书 §主任务五）：
 *   本版**只重伤，不杀死**。伤害区间 30—60（numeric.assault）打不穿一个满血新号，
 *   也不会有任何一条路径把 status 变成"死亡"（角色表里根本没有这个状态）。
 *   杀死 → 2/4 级通缉的分支已经写在 domain/wanted 里，等 M2.7 非凡物品接上触发源。
 *
 * ⚠️ MVP 已知短板（写在这里，别让下一轮的人当成 bug 来查）：
 *   1. 无反击、无防御、无先手判定 —— 挨打的人只是掉血；
 *   2. 袭击不需要道具门槛（封印物 / 仪式），因为本版没有可用的道具；
 *      任务书 §主任务五 列的三个条件里，**「高序列能力」这一条已由 M2.6.1 的
 *      序列差判定实现**（弱 3 级直接不可行、高打低代价极高），另两条等 M2.7。
 */
import { NUMERIC } from '../../config/numeric.ts';
import { createSeededRng, seedFrom } from '../../domain/rng.ts';
import { factionOfLocation } from '../../domain/faction/faction.ts';
import { levelForTrigger, wantedDurationOf } from '../../domain/wanted/wanted.ts';
import { resistIsCertain, resolveAssault } from '../../domain/wanted/assault.ts';
import { sequenceOrInitiate, type CharacterState, type DomainEvent } from '../../domain/character/types.ts';
import type { CommandContext, CommandResult } from '../index.ts';
import { applyFor, requireCharacter } from './common.ts';
import { renderDeltaSummary } from './render.ts';
import {
  applyWantedToll,
  locationOrDefault,
  setCurrentLocation,
  wantedStatusLine,
} from './wanted-hooks.ts';

const CFG = NUMERIC.assault;

export const ASSAULT_USAGE =
  '用法：.袭击 @某人（会把对方打成重伤，并让你成为被通缉的人）\n' +
  '序列差会决定成败：你比他弱 ' + CFG.sequenceGating.blockThreshold +
  ' 个序列及以上时根本近不了他的身；弱 1—2 个序列命中率与伤害都会大打折扣；' +
  '比他强则反过来 —— 但重伤比你弱的人会直接吃 ' +
  CFG.reverseWanted.highAttacksLow.wantedLevelOverride + ' 级通缉。';

/** 同一对玩家之间的袭击冷却 flag 名 */
const cooldownFlagOf = (targetId: string): string => 'assault_cd:' + targetId;

function resolveTarget(ctx: CommandContext, raw: string): CharacterState | null {
  const { deps } = ctx;
  return (
    deps.characters.findByUserId(raw) ??
    deps.characters.all().find((candidate) => candidate.name === raw) ??
    null
  );
}

export async function handleAssault(ctx: CommandContext): Promise<CommandResult> {
  const gate = requireCharacter(ctx);
  if (!gate.ok) return gate.result;
  const attacker = gate.character;
  const { deps, msg, now } = ctx;

  const raw = ctx.args.join(' ').trim().replace(/^@/, '');
  if (!raw) return { privateText: ASSAULT_USAGE, detailToPrivate: true };

  const target = resolveTarget(ctx, raw);
  if (!target) return { privateText: '找不到这个人：' + raw + '\n' + ASSAULT_USAGE, detailToPrivate: true };
  if (target.id === attacker.id) {
    return { privateText: '袭击自己没有任何意义。', detailToPrivate: true };
  }
  if (target.status === 'injured' || target.hp <= 0) {
    return { privateText: target.name + ' 已经倒下了 —— 再动手就不是重伤，是杀人了。', detailToPrivate: true };
  }
  if (attacker.status === 'injured') {
    return { privateText: '你自己还在重伤状态，连站都站不稳。', detailToPrivate: true };
  }

  // 冷却：防两个人互相刷通缉（也防一个人被反复打）
  const lastAssault = Number(deps.flags.value(attacker.id, cooldownFlagOf(target.id)) ?? 0);
  if (Number.isFinite(lastAssault) && lastAssault > 0 && now - lastAssault < CFG.cooldownMs) {
    const leftMin = Math.ceil((CFG.cooldownMs - (now - lastAssault)) / 60000);
    return {
      privateText: '你刚对他动过手，' + leftMin + ' 分钟内再来会太显眼。',
      detailToPrivate: true,
    };
  }

  // 目标此刻在哪 —— 通缉归**那个地点的势力**管，不是归攻击者所在地管
  const sceneLocationId = locationOrDefault(deps, target.id);
  const sceneFactionId = factionOfLocation(sceneLocationId);
  // ⚠️ 位置挪动（"你是找上门去动的手"）放在**判定之后、真的动手时**才做 ——
  // 先挪再判的话，序列差被拦那条路径会把一个根本没靠近过的人挪到案发地。

  const seed = seedFrom([msg.messageId, attacker.id, now, 'assault', target.id]);

  // 基准伤害：**独立随机源**。判定层只乘序列差倍率，抽样与判定互不干扰，
  // 这样同一个 seed 下"基准伤害是多少"与"有没有打中"可以分别复现。
  const damageRng = createSeededRng(seedFrom([seed, 'damage']));
  const baseDamage =
    CFG.baseDamageMin +
    Math.floor(damageRng.next() * (CFG.baseDamageMax - CFG.baseDamageMin + 1));

  // ★ 判定：命令层把序列原样交给它，不做任何比较
  const judgment = resolveAssault(
    {
      // M2.7.6：普通人按序列 9 参与序列差判定（他确实是「序列 9 的新人」那一档）
      attackerSeq: sequenceOrInitiate(attacker),
      targetSeq: sequenceOrInitiate(target),
      attackerState: attacker,
      targetState: target,
      baseHit: CFG.baseHit,
      baseDamage,
      baseDamageMax: CFG.baseDamageMax,
    },
    createSeededRng(seedFrom([seed, 'judge'])),
  );

  const judgeEvent: DomainEvent = {
    type: judgment.blocked ? 'assault_blocked' : 'assault_resolved',
    characterId: attacker.id,
    payload: {
      targetId: target.id,
      targetName: target.name,
      diff: judgment.diff,
      // M2.7.6：普通人按序列 9 参与序列差判定（他确实是「序列 9 的新人」那一档）
      attackerSeq: sequenceOrInitiate(attacker),
      targetSeq: sequenceOrInitiate(target),
      blocked: judgment.blocked,
      blockedBy: judgment.blockedBy ?? null,
      hit: judgment.hit ?? false,
      damage: judgment.damage ?? 0,
      baseDamage,
      hitChance: judgment.hitChance,
      roll: judgment.roll,
      resistChecked: judgment.resistChecked,
      resisted: judgment.resisted,
      resistChance: judgment.resistChance,
      resistRoll: judgment.resistRoll,
      wantedLevelOverride: judgment.wantedLevelOverride,
      bountyMultiplier: judgment.bountyMultiplier,
      locationId: sceneLocationId,
    },
    reason: judgment.blocked
      ? '袭击被拦:' + judgment.blockedBy
      : judgment.hit
        ? '袭击命中'
        : '袭击落空',
    seed,
    createdAt: now,
  };

  // ① 序列差被拦：**根本没动手** —— 不扣 AP、不进冷却、不留痕、不挪位置。
  //    这不是"做了没成功"，而是"做不到"，和「行动点不足」同一类前置校验失败。
  if (judgment.blocked && judgment.blockedBy === 'sequence_gap') {
    deps.characters.appendEvents([judgeEvent]);
    return {
      privateText: renderBlockedByGap(attacker, target, judgment),
      groupText: '【' + attacker.name + '】好像想对【' + target.name + '】做点什么，但没能靠近。',
      detailToPrivate: true,
    };
  }

  // 攻击者：疯狂 + 污染（动手本身就脏手）
  const paid = applyFor(
    deps,
    attacker,
    [
      { type: 'mad', value: CFG.madGain },
      { type: 'cor', value: CFG.corGain },
    ],
    '袭击:' + target.name,
    now,
    seed,
  );
  if (paid.rejected) {
    return { privateText: paid.rejected, detailToPrivate: true };
  }
  let attackerState = paid.newState;
  deps.flags.set(attacker.id, cooldownFlagOf(target.id), now, String(now));
  // 你是"找上门去"动的手：真的动了手，位置才挪到案发地
  setCurrentLocation(deps, attacker.id, sceneLocationId, now);

  const events: DomainEvent[] = [...paid.events, judgeEvent];
  const lines: string[] = [];
  lines.push('【袭击 · ' + target.name + '】');
  lines.push('');
  lines.push(judgment.gapLabel + '。');

  // ② 高序列抗性挡下 / ③ 扑空：都是"没造成伤害"
  const landed = judgment.blocked !== true && judgment.hit === true;
  let targetState = target;
  let down = false;

  if (!landed) {
    lines.push('');
    lines.push(...renderMissLines(judgment, target));
    lines.push('');
    lines.push('你没有造成任何伤害，对方甚至没看清是谁动的手。');
  } else {
    const damage = judgment.damage ?? 0;
    const wounded = applyFor(deps, target, [{ type: 'hp', value: -damage }], '被袭击', now, seed);
    targetState = wounded.newState;
    down = targetState.hp <= 0;
    if (down) targetState = { ...targetState, status: 'injured', updatedAt: now };
    events.push(...wounded.events);

    lines.push('');
    lines.push('你击中了 ' + target.name + '，造成 ' + damage + ' 点伤害。');
    lines.push(
      down
        ? target.name + ' 倒了下去，血在青石板上摊开 —— 他还活着，但站不起来了。'
        : target.name + ' 踉跄着退开，捂着伤口瞪着你。',
    );
    lines.push('');
    lines.push(
      '伤害 ' + damage + '（伤害上限 ' + judgment.damageMax + '），' + target.name +
        ' 生命 ' + target.hp + ' → ' + targetState.hp + '（' + (down ? '重伤' : '未倒') + '）',
    );
  }
  deps.characters.update(targetState);

  // 先按**动手之前就存在的通缉**结算一次遭遇 —— 顺序不能反。
  // 反了的话，刚签发的这条通缉令会在同一条指令里立刻回头咬他一口
  // （实测：袭击成功的回执里紧跟着「通缉 · 1 级 · 盘查」，玩家会觉得系统在针对他）。
  const preToll = applyWantedToll({
    deps,
    state: attackerState,
    locationId: sceneLocationId,
    action: 'assault',
    now,
    seed,
  });
  attackerState = preToll.state;

  // 通缉：**只在真的造成了伤害、且案发地归某个势力管的时候才签发**
  // （在无主地点动手，没人管 —— 这正是"安全区"的另一面）
  let wantedLines: string[] = [];
  let broadcastText: string | null = null;
  if (landed && sceneFactionId !== 'none') {
    // 高打低时判定层给出覆盖等级（3 级围剿）；否则用触发源对应的默认等级（1 级）
    const level = judgment.wantedLevelOverride ?? levelForTrigger('injured_player');
    if (level !== null) {
      const reason = down ? '重伤了 ' + target.name : '袭击了 ' + target.name;
      const state = {
        id: seedFrom(['wanted', attacker.id, sceneFactionId, String(level)]),
        characterId: attacker.id,
        level,
        factionId: sceneFactionId,
        reason,
        createdAt: now,
        expiresAt: now + wantedDurationOf(level),
        // 高打低时赏金按目标序列缩放；必须在签发时就定下来，
        // 否则举报那一刻没有"当初打的是谁"这个信息（见 0014 迁移的注释）
        bountyMultiplier: judgment.bountyMultiplier,
      };
      deps.wanted.upsert(state);
      events.push({
        type: 'wanted_issued',
        characterId: attacker.id,
        payload: {
          wantedId: state.id,
          level,
          factionId: sceneFactionId,
          locationId: sceneLocationId,
          targetId: target.id,
          targetSeq: target.sequence,
          bountyMultiplier: judgment.bountyMultiplier,
          durationMs: wantedDurationOf(level),
        },
        reason: '通缉签发:' + reason,
        seed,
        createdAt: now,
      });
      broadcastText =
        '【' + (sceneFactionId === 'police' ? '廷根市警方' : '治安官') +
        '】某处发生命案，正在查一个' + (attacker.pathway === 'seer' ? '占卜家' : '可疑的人') + '。';
      if (judgment.wantedLevelOverride !== null) {
        lines.push('');
        lines.push(
          '你' + (down ? '重伤' : '袭击') + '了 ' + target.name +
            '。这条街的人都知道你做了什么 —— **通缉 ' + level + ' 级**。',
        );
      }
    }
  }
  deps.characters.appendEvents(events);
  deps.characters.update(attackerState);
  if (preToll.toll.suspiciousBroadcast) deps.broadcast?.(preToll.toll.suspiciousBroadcast);
  if (broadcastText) deps.broadcast?.(broadcastText);

  const status = wantedStatusLine(deps, attacker.id, now);
  if (status) wantedLines = ['', status];

  if (broadcastText) lines.push('附近有人看见了，喊声顺着街传了出去。');
  lines.push(...preToll.toll.lines);
  lines.push(...wantedLines);
  const deltaLines = renderDeltaSummary(events, false, (id) => deps.items.nameOf(id));
  if (deltaLines.length > 0) {
    lines.push('');
    lines.push(...deltaLines);
  }

  // 群播报：只有真的造成了伤害才算"起了冲突"
  const groupText = broadcastText
    ? broadcastText
    : landed
      ? '【' + attackerState.name + '】和【' + target.name + '】起了冲突。'
      : '【' + attackerState.name + '】对【' + target.name + '】动了手，但对方纹丝不动。';

  const targetNotice = landed
    ? '有人在暗处对你动了手。\n生命 -' + (judgment.damage ?? 0) + '（' + target.hp + ' → ' + targetState.hp + '）' +
      (down ? '\n你已经重伤，先想办法离开这里。' : '')
    : judgment.blockedBy === 'resist'
      ? '有人在暗处对你动了手 —— 但你身上有什么东西替他挡了下来。'
      : '有人在暗处对你动了手，但扑了个空。';

  return {
    privateText: lines.join('\n'),
    groupText,
    detailToPrivate: true,
    extra: [{ scene: 'private', targetId: target.userId, text: targetNotice }],
  };
}

/* ------------------------------------------------------------------ *
 * 文案：**回执要明确告诉玩家「为什么失败」**
 * ------------------------------------------------------------------ */

/** 序列差被拦：这是本版最常见的「为什么打不到」 */
function renderBlockedByGap(
  attacker: CharacterState,
  target: CharacterState,
  judgment: ReturnType<typeof resolveAssault>,
): string {
  return [
    '【袭击 · ' + target.name + '】',
    '',
    judgment.reason ?? '你根本近不了他的身。',
    '',
    judgment.gapLabel + ' —— 序列差达到 ' + CFG.sequenceGating.blockThreshold +
      ' 级及以上时，你连他的身都近不了，连出手的机会都没有。',
    '（序列 ' + attacker.sequence + ' 对序列 ' + target.sequence +
      '。想动他，先把自己的序列提上去。）',
    '',
    '什么也没消耗 —— 你根本没动成手。',
  ].join('\n');
}

/** 没造成伤害的两种情况：抗性挡下 / 扑空。**两种都要说清为什么** */
function renderMissLines(
  judgment: ReturnType<typeof resolveAssault>,
  target: CharacterState,
): string[] {
  // ⚠️ 这里读的 target.sequence 只用来**渲染一句解释**，不参与任何判断
  //（判断已经在 resolveAssault 里做完了）。命令层不比较序列，这条约束没有破。
  if (judgment.blockedBy === 'resist') {
    return [
      judgment.reason ?? '伤害被什么东西挡下了。',
      '他已经是序列 ' + target.sequence + ' 的非凡者，凡人层面的袭击对他有天然抗性 —— ' +
        /*
         * M2.38 任务 3：概率饱和时**说「必然」，不再报一个假的百分比**。
         * 报「100%」读起来像「运气好」，而真相是「这一档的判定已经恒真」（K14 的形状）。
         */
        (resistIsCertain(target.sequence ?? 9)
          ? '这一档的抗性已经**饱和**（必然触发），你这次撞上了。'
          : '抗性 ' + Math.round(judgment.resistChance * 100) + '%，你这次撞上了。'),
    ];
  }
  // 不写 `judgment.diff > 0 ? '命中率被压到' : '命中率'` 这种分支 ——
  // 那是命令层在做序列语义的判断。谁强谁弱已经由 gapLabel 说清楚了，
  // 命令层只需要把判定层给的数字念出来。
  const chance = Math.round(judgment.hitChance * 100);
  return [
    '你扑了个空。',
    '（' + judgment.gapLabel + '，命中率 ' + chance + '%。运气不站在你这边。）',
  ];
}
