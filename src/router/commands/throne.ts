/**
 * `.王座`（M2.170）—— **神位的争夺**。用户口径：「神位得竞争本来就是残酷的」。
 *
 * ```
 * .王座              看：哪些位置空着、谁正在往上坐、你够不够格
 * .王座 登位 <编号>   开始登位 —— 接下来 7 天你必须在灰雾之上，而所有人都知道
 * .王座 放弃         自己下来（保住性命，那个位置这次不坐了）
 * ```
 *
 * 残酷的三处（都是机制）：
 *   ① **公开**   上去的 7 天里他下不来，而所有人都看得见他在那儿
 *   ② **脆弱**   每天被神性啃掉理智（序列 1 是 6/天，7 天 42 点）—— 掉了就可能失控
 *   ③ **可被杀** 别的够格者能直接打断他：那不是抢分，**那是杀人**
 *
 * ⚠️ 打断走的是既有的袭击机制（本项目的战斗会死人）—— 这里不新造一套战斗。
 */
import {
  THRONE_CLASH_MAX_EXTENSIONS,
  THRONE_RITE_DAYS,
  canClaimThrone,
  claimantsOf,
  clashLineOf,
  contestLineOf,
  daysLeftOf,
  inClash,
  riteDaysFor,
  riteStrain,
} from '../../domain/world/throne-contest.ts';
import { mergeThroneState } from '../../domain/world/divine-throne-state.ts';
import type { CommandContext, CommandResult } from '../index.ts';

const DAY_MS = 86_400_000;

export async function handleThrone(ctx: CommandContext): Promise<CommandResult> {
  const { deps, now, msg } = ctx;
  const character = deps.characters.findByUserId(msg.userId);
  if (character === null) {
    return { privateText: '先建一个角色 —— 那个位置不认路人。', detailToPrivate: true };
  }
  const contests = deps.throneContests;
  const meddling = deps.divineMeddling;
  if (contests === undefined || deps.divineThroneState === undefined) {
    return { privateText: '（这个世界里的神座还没有空过。）', detailToPrivate: true };
  }
  const thrones = mergeThroneState(deps.divineThrones, deps.divineThroneState.all());
  const firstCredits = meddling?.firstCreditCaused(character.id) ?? 0;
  const sequence = character.sequence ?? 9;
  const arg = ctx.args.join(' ').trim();
  const vacant = thrones.filter((t) => t.state === 'vacant');

  /* ---------------- 看 ---------------- */
  if (arg === '') {
    const lines = ['【王座】'];
    if (vacant.length === 0) {
      lines.push('', '现在没有空着的位置。');
      lines.push('（想要一个位置空出来，得先有人把上面那位推下去。）');
    } else {
      lines.push('', '空着的位置：');
      let index = 1;
      for (const throne of vacant) {
        const contest = contests.of(throne.pathway);
        /*
         * ⚠️ 登位的是**玩家**（角色 id），不是 NPC —— 名字只能从角色表查。
         * 第一版写成了 `npcRoster.nameOf(...)`：查不到时会返回一个不是名字的东西，
         * 而玩家读到的就是「某个看不懂的 id 正在往上坐」。
         */
        const claimant = contest?.status === 'rite'
          ? (deps.characters.findById(contest.claimantId)?.name ?? '有人')
          : '';
        lines.push(' ' + index + '. ' + contestLineOf({
          pathwayName: throne.title,
          contest: contest?.status === 'rite' ? contest : null,
          claimantName: claimant,
          now,
        }));
        // 对撞：两个人撞在同一个位置上 —— 这一行必须被看见
        if (contest !== null && contest !== undefined && contest.status === 'rite' && inClash(contest)) {
          const names = claimantsOf(contest).map((id) => deps.characters.findById(id)?.name ?? '有人');
          lines.push('   ' + clashLineOf({
            pathwayName: throne.title,
            names,
            daysLeft: daysLeftOf(contest, now),
          }));
        }
        index += 1;
      }
      const gate = canClaimThrone({
        sequence, firstCredits,
        seatState: vacant[0]!.state,
        claimantId: contests.of(vacant[0]!.pathway)?.status === 'rite'
          ? (contests.of(vacant[0]!.pathway)?.claimantId ?? '')
          : '',
        me: character.id,
      });
      lines.push('', gate.ok
        ? '你可以登位：.王座 登位 1（上去之后 7 天里下不来 —— 而所有人都知道你在那儿。）'
        : '你还不能登位：' + gate.reason);
    }
    lines.push('', '（你推下去过的神：' + firstCredits + ' 位。那个位置只认这一条。）');
    return { privateText: lines.join('\n'), detailToPrivate: true };
  }

  /* ---------------- 放弃 ---------------- */
  if (arg === '放弃') {
    const mine = contests.byClaimant(character.id);
    if (mine === null) return { privateText: '你现在没有坐在任何位置上。', detailToPrivate: true };
    contests.lapse({ pathway: mine.pathway, brokenBy: character.id, note: '他自己下来了。' });
    return {
      privateText: '你从灰雾之上退了下来。\n那个位置继续空着 —— 而它会记得你曾经坐在那儿过。',
      detailToPrivate: true,
    };
  }

  /* ---------------- 登位 ---------------- */
  if (arg.startsWith('登位')) {
    const pick = Number(arg.replace('登位', '').trim() || '1');
    const throne = vacant[pick - 1];
    if (throne === undefined) return { privateText: '没有第 ' + pick + ' 个空位。', detailToPrivate: true };
    const contest = contests.of(throne.pathway);
    const gate = canClaimThrone({
      sequence, firstCredits, seatState: throne.state,
      claimantId: contest?.status === 'rite' ? contest.claimantId : '',
      me: character.id,
    });
    if (!gate.ok) return { privateText: gate.reason ?? '你不能登位。', detailToPrivate: true };
    /*
     * 已经有人在上面了 ⇒ 「登位」这个词不对 —— 他那一步叫**抢登**（一起上去争）。
     * 两个词分开是为了让玩家明白自己在做什么：一个是坐上去，一个是**抢**。
     */
    if (gate.clash === true) {
      return {
        privateText: '已经有人先上去了 —— 而你现在上去就是**抢**：两人同争一个位置。\n' +
          '（两个人一起争的后果：仪式更久、神性啃得更狠、到期不作数。用 .王座 抢登 <编号>。）',
        detailToPrivate: true,
      };
    }
    if (contests.byClaimant(character.id) !== null) {
      return { privateText: '你已经在一条途径上坐着了 —— 一个人同时只能争一个位置。', detailToPrivate: true };
    }
    contests.begin({
      pathway: throne.pathway, claimantId: character.id,
      startedAt: now, endsAt: now + THRONE_RITE_DAYS * DAY_MS,
    });
    deps.worldEvents.insert({
      id: 'throne-claim-' + throne.pathway + '-' + now,
      type: 'power',
      text: '【世界 · 王座】' + throne.title + '的位置上有人了 —— ' + character.name +
        '正在往上坐。他在灰雾之上，7 天里下不来。',
      visibility: 'public',
      createdAt: now,
    });
    return {
      privateText: [
        '【王座 · 登位】',
        '',
        '你踏上了灰雾之上。',
        throne.title + '的位置就在前面 —— 而它比你想的要重。',
        '',
        '接下来的 ' + THRONE_RITE_DAYS + ' 天你下不来：',
        ' · 每天都有人知道你在这儿（这件事已经传出去了）',
        ' · 每天神性都会啃你一口（理智 -' + riteStrain(sequence) + '）',
        ' · 而其他够格的人，可以直接上来打断你 —— 那不是抢分，那是杀人',
        '',
        '（撑到最后，那个位置就是你的。撑不住——）',
      ].join('\n'),
      detailToPrivate: true,
    };
  }

  /* ---------------- 抢登（对撞） ---------------- */
  if (arg.startsWith('抢登')) {
    const pick = Number(arg.replace('抢登', '').trim() || '1');
    const throne = vacant[pick - 1];
    if (throne === undefined) return { privateText: '没有第 ' + pick + ' 个空位。', detailToPrivate: true };
    const contest = contests.of(throne.pathway);
    if (contest === null || contest.status !== 'rite') {
      return { privateText: '那个位置上现在没人 —— 直接用 .王座 登位。', detailToPrivate: true };
    }
    if (contest.claimantId === character.id || contest.rivals.includes(character.id)) {
      return { privateText: '你已经在争那个位置了。', detailToPrivate: true };
    }
    const gate = canClaimThrone({
      sequence, firstCredits, seatState: throne.state, claimantId: contest.claimantId, me: character.id,
    });
    if (!gate.ok) return { privateText: gate.reason ?? '你不能登位。', detailToPrivate: true };
    if (contests.byClaimant(character.id) !== null) {
      return { privateText: '你已经在一条途径上坐着了 —— 一个人同时只能争一个位置。', detailToPrivate: true };
    }
    /* 人多了 ⇒ 时间表重算（那个位置只有一份，两个人一起往上坐，谁也坐不实） */
    const claimantChar = deps.characters.findById(contest.claimantId);
    const claimantName = claimantChar?.name ?? '有人';
    const after = [...claimantsOf(contest), character.id];
    contests.joinClash({
      pathway: throne.pathway,
      rivalId: character.id,
      endsAt: now + riteDaysFor(after.length) * DAY_MS,
    });
    deps.worldEvents.insert({
      id: 'throne-clash-' + throne.pathway + '-' + now,
      type: 'power',
      text: '【世界 · 王座】' + throne.title + '的位置上，两个人撞在了一起 —— ' +
        claimantName + '与' + character.name + '。**那个位置只坐得下一个。**',
      visibility: 'public',
      createdAt: now,
    });
    return {
      privateText: [
        '【王座 · 抢登】',
        '',
        '你也踏上了灰雾之上 —— 而上面已经有人了。',
        '',
        '接下来的 ' + riteDaysFor(after.length) + ' 天（比一个人的时候更久）：',
        ' · 神性只有一份，而你们在抢它（理智 -' + riteStrain(sequence, after.length) + ' 每天）',
        ' · 到期时只要还有别人在争，**谁都不算数**',
        ' · 而拖满 ' + THRONE_CLASH_MAX_EXTENSIONS + ' 次，两个人都得下来 —— 位置继续空着',
        '',
        '（唯一的出路是把对方逼死或逼退。这不是抢分，这是相杀。）',
      ].join('\n'),
      detailToPrivate: true,
    };
  }

  return { privateText: '用法：.王座 / .王座 登位 <编号> / .王座 抢登 <编号> / .王座 放弃', detailToPrivate: true };
}
