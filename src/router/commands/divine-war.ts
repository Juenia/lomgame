/**
 * `.神战`（M2.169）—— **玩家插手神明的阴谋**。
 *
 * 用户口径：「要刺激感」。所以这一条不是「看一眼世界状态」，而是**让人能被卷进去**：
 *
 * ```
 * .神战            看见正在进行的阴谋：谁在图谋谁、走到哪一步、还剩多久
 * .神战 告密       把消息递给被图谋的那一位 —— 会让这一局**提前败露**
 * .神战 助推       替动手的那一位办事 —— 会让陨落**来得更快**
 * ```
 *
 * 刺激感来自三处，每一处都是机制：
 *
 *   ① **会挨打**：插手有 35% 左右被发现（序列越高越稳）——
 *      告密被发现 ⇒ 邪神降罚（理智与身体都要掉）；助推被发现 ⇒ 对方教会通缉你
 *   ② **不可逆**：一局里只能插手一次，而这一次会被记在案上（divine_meddling）——
 *      那位神赢了会赏你，输了会清算你
 *   ③ **有分量**：告密 +30 暴露度（那一局更容易被察觉）、助推直接把时间表拽快 30 天，
 *      而**成神仪式**读的正是这本账（原作：在自身参与之事导致一位神灵陨落时晋升）
 */
import { createSeededRng, seedFrom } from '../../domain/rng.ts';
import { mergeThroneState } from '../../domain/world/divine-throne-state.ts';
import {
  MEDDLE_SIDE_LABELS,
  contributionOf,
  creditLineOf,
  meddleEffect,
  meddleOutcome,
  revengeLineOf,
  type MeddleSide,
} from '../../domain/world/divine-meddling.ts';
import type { CommandContext, CommandResult } from '../index.ts';

const DAY_MS = 86_400_000;

/**
 * **玩家自己的账**（`.神战` 与插手回执都带上它）。
 *
 * 为什么它必须出现在这里：`fallsCaused` 是**成神仪式的判据**
 * （原作刺客途径序列 1 → 0：「在自身参与之事导致一位神灵陨落时晋升」），
 * 但一条只写在库里、玩家看不见的账等于没写 —— 他不知道自己离那条路还有多远。
 *
 * 口径：只报**次数与结果**，不报「你获得了晋升资格」这种许诺 ——
 * 众神的事没有保证，玩家该感觉到的是分量，不是进度条。
 */
function myLedger(
  deps: { divineMeddling?: { ofCharacter(id: string): Array<{ side: string; success: boolean; exposed: boolean }>; firstCreditCaused(id: string): number; meddledAndWon(id: string): number } },
  characterId: string,
  justDid?: string,
): string[] {
  const meddling = deps.divineMeddling;
  if (meddling === undefined) return [];
  const mine = meddling.ofCharacter(characterId);
  if (mine.length === 0) return [];
  const falls = meddling.firstCreditCaused(characterId);
  const involved = meddling.meddledAndWon(characterId);
  const lines = ['你插过手的局：' + mine.length + ' 场' + (justDid === undefined ? '' : '（含刚才这一场）')];
  for (const row of mine.slice(0, 5)) {
    const side = row.side === 'inform' ? '告密' : '助推';
    const result = row.success ? '成了' : '没成';
    const seen = row.exposed ? ' —— 而对面知道是你' : '';
    lines.push(' · ' + side + '（' + result + '）' + seen);
  }
  if (involved > 0) {
    lines.push('而其中 ' + involved + ' 场，真的有东西从那个位置上下来了。');
  }
  /*
   * **首功**与「参与过」是两件事 —— 一场陨落只认分量最重的那一个（序列 0 是唯一的）。
   * 这一行只在他真拿到过首功时出现。
   */
  if (falls > 0) {
    lines.push('而那 ' + falls + ' 场里，**分量最重的是你**。');
  }
  return lines;
}

export async function handleDivineWar(ctx: CommandContext): Promise<CommandResult> {
  const { deps, now, msg } = ctx;
  const character = deps.characters.findByUserId(msg.userId);
  if (character === null) {
    return { privateText: '先建一个角色 —— 众神的事与路人无关。', detailToPrivate: true };
  }
  const schemes = deps.divineSchemes;
  const meddling = deps.divineMeddling;
  if (schemes === undefined || meddling === undefined) {
    return { privateText: '（这个世界里，众神还没有开始动。）', detailToPrivate: true };
  }
  const arg = ctx.args.join(' ').trim();
  const open = schemes.open();
  /*
   * 神座要走**合并之后**的那一份（内容是底、状态覆盖）——
   * 只看内容的话，一位已经陨落/被取代的神在这里还念着旧名字，
   * 而玩家读到的就是「一个不存在的人在图谋另一个不存在的人」。
   */
  const thrones = mergeThroneState(deps.divineThrones, deps.divineThroneState?.all() ?? []);

  /* ---------------- 看 ---------------- */
  if (arg === '') {
    if (open.length === 0) {
      return {
        privateText: '【神战】\n\n现在没有哪位存在在谋划什么 —— 或者，你看不出来。\n' +
          '（这种事本来就不该被凡人看见。你能看见，是因为它在变大。）',
        detailToPrivate: true,
      };
    }
    const lines = ['【神战】', '', '有人在图谋一位存在的位置：'];
    for (const scheme of open) {
      const schemer = thrones.find((t) => t.pathway === scheme.schemer)?.seat ?? scheme.schemer;
      const target = thrones.find((t) => t.pathway === scheme.target)?.seat ?? scheme.target;
      const stageLabel: Record<string, string> = {
        ally: '才刚搭上线', infiltrate: '正在往对面的人里渗',
        weaken: '已经在收网了', war: '**已经动手了**', fall: '快到底了',
      };
      const daysLeft = Math.max(0, Math.round((scheme.dueAt - now) / DAY_MS));
      const seen = scheme.exposed >= 60 ? '而那边**已经察觉**了' : scheme.exposed >= 30 ? '那边似乎有点感觉' : '而那边似乎还没察觉';
      lines.push('', ' · ' + schemer + ' → ' + target + '（' + (scheme.goal === 'usurp' ? '取而代之' : '让祂陨落') + '）');
      lines.push('   ' + (stageLabel[scheme.stage] ?? scheme.stage) + ' —— ' + seen);
      lines.push('   ' + (daysLeft > 0 ? '这一步还剩约 ' + daysLeft + ' 天' : '这一步随时可能落地'));
      const mine = meddling.ofScheme(scheme.id).filter((m) => m.characterId === character.id);
      if (mine.length > 0) lines.push('   （你已经插过手：' + MEDDLE_SIDE_LABELS[mine[0]!.side] + '）');
    }
    lines.push('', '你可以插手：.神战 告密（递给被图谋的那位）/ .神战 助推（替动手的那位办事）');
    lines.push('（插手可能被发现 —— 而被发现，是要挨的。）');
    lines.push('', ...myLedger(deps, character.id));
    return { privateText: lines.join('\n'), detailToPrivate: true };
  }

  /* ---------------- 插手 ---------------- */
  const side: MeddleSide | null = arg === '告密' ? 'inform' : arg === '助推' ? 'aid' : null;
  if (side === null) {
    return { privateText: '用法：.神战 / .神战 告密 / .神战 助推', detailToPrivate: true };
  }
  const scheme = open[0];
  if (scheme === undefined) {
    return { privateText: '现在没有可以插手的局 —— 等有人开始动了再说。', detailToPrivate: true };
  }
  if (meddling.ofScheme(scheme.id).some((m) => m.characterId === character.id)) {
    return {
      privateText: '这一局你已经插过手了。\n再做一次就不是「插手」，是「站队」—— 而站队要等它落地。',
      detailToPrivate: true,
    };
  }
  const sequence = character.sequence ?? 9;
  const rng = createSeededRng(seedFrom([character.id, scheme.id, String(now), side]));
  const outcome = meddleOutcome({ side, sequence, rng });
  const effect = meddleEffect({ side, success: outcome.success });
  /*
   * **分量在插手这一刻冻结**（M2.169 修正：起因是「多位玩家参与了怎么算？」）。
   *
   * `first` = 他是不是这一局第一个伸手的 —— 先动手的 +3，因为他承担了最大的风险
   * （被发现时最先挨的就是他）。
   */
  const first = meddling.ofScheme(scheme.id).length === 0;
  const score = contributionOf({ side, success: outcome.success, sequence, first });
  schemes.advance({
    id: scheme.id,
    stage: scheme.stage,
    progress: scheme.progress,
    exposed: Math.min(100, scheme.exposed + effect.exposure),
    dueAt: scheme.dueAt - effect.accelerateDays * DAY_MS,
  });
  meddling.record({
    characterId: character.id, schemeId: scheme.id, side,
    success: outcome.success, exposed: outcome.exposed, score, at: now,
  });
  const schemerName = thrones.find((t) => t.pathway === scheme.schemer)?.seat ?? scheme.schemer;
  const targetName = thrones.find((t) => t.pathway === scheme.target)?.seat ?? scheme.target;
  const lines = ['【神战 · ' + MEDDLE_SIDE_LABELS[side] + '】', '', outcome.note];
  if (effect.exposure > 0) lines.push('', '（这一局更容易被人看出来了：暴露 +' + effect.exposure + '）');
  if (effect.accelerateDays > 0) lines.push('', '（时间表被往前拽了 ' + effect.accelerateDays + ' 天）');
  /* 被发现 ⇒ 当场挨一下（这才是「刺激」的落点，不是好感 -5） */
  if (outcome.exposed) {
    const pains: string[] = [];
    if (side === 'inform') {
      deps.characters.update({
        ...character,
        mad: Math.min(100, character.mad + 10),
        hp: Math.max(1, character.hp - 8),
        updatedAt: now,
      });
      pains.push(revengeLineOf('inform', schemerName));
      pains.push('（理智 +10、身体挨了一下 —— 祂的东西夜里来过。）');
    } else {
      const factionId = deps.factions.all()[0]?.id ?? 'none';
      deps.wanted.upsert({
        id: 'divine-meddle-' + character.id,
        characterId: character.id,
        level: 2,
        factionId,
        reason: '在一位存在的事上伸了手',
        createdAt: now,
        expiresAt: now + 30 * DAY_MS,
      });
      pains.push(revengeLineOf('aid', targetName));
      pains.push('（你被通缉了 —— 30 天。）');
    }
    lines.push('', ...pains);
  }
  lines.push('', '（这件事记在你账上了：那位神赢了会赏你，输了会清算你。）');
  /*
   * 那一局有几个人的手 —— 玩家会看到有人在跟他抢（这是「多位玩家」那一问的正面回答）。
   * 只有一个人拿到首功，其余人拿次功。
   */
  const everyone = meddling.ofScheme(scheme.id);
  if (everyone.length > 1) {
    const ranked = [...everyone].sort((a, b) => b.score - a.score || a.at - b.at);
    const rank = ranked.findIndex((row) => row.characterId === character.id) + 1;
    lines.push('', creditLineOf({ rank, total: everyone.length, score }));
    if (rank > 1) lines.push('（首功只有一个人 —— 那一位会成神，而你拿到的是别的。）');
  }
  lines.push('', ...myLedger(deps, character.id, scheme.id));
  return { privateText: lines.join('\n'), detailToPrivate: true };
}
