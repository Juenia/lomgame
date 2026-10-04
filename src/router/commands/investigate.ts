/**
 * `.查` 指令（M2.85 RPG 化）—— **把阴谋这条线闭合**。
 *
 * 用户拍的这一整套是：**他布局 → 你察觉 → 你追查 → 你反制（或失败）**。
 * 前两步已经在了（`.看` 会列出「有些地方不太对」），这一条是**后两步**。
 *
 *   .查            列出针对你的端倪（正在 omen 阶段的阴谋）
 *   .查 <编号>     顺着那条线追下去 —— 掷 foilChance
 *
 * ⚠️ **失败是有代价的**：追查失败等于告诉对方「你在查」，那条阴谋会**提前发动**。
 * 没有这个代价，追查就只是「免费的抽奖」；有了它，「查还是不查」才是取舍。
 */
import type { CommandContext, CommandResult } from '../index.ts';
import { npcSequenceOf, requireCharacter } from './common.ts';
import { foilChance } from '../../domain/world/npc-scheme.ts';
import { omenTextFor } from '../../domain/world/scheme-narrative.ts';
import { hl } from '../../adapter/highlight.ts';
import { createSeededRng, seedFrom } from '../../domain/rng.ts';

/** 玩家的序号 → 阴谋 id（回执里给编号，玩家发编号） */
function omensOf(ctx: CommandContext, characterId: string) {
  return ctx.deps.npcSchemes
    .activeOf(characterId)
    .filter((s) => s.stage === 'omen')
    .map((s) => ({ scheme: s, npcName: ctx.deps.npcRoster.nameOf(s.npcId) }));
}

export async function handleInvestigate(ctx: CommandContext): Promise<CommandResult> {
  const gate = requireCharacter(ctx);
  if (!gate.ok) return gate.result;
  const character = gate.character;
  const omens = omensOf(ctx, character.id);
  const want = ctx.args.join(' ').trim();

  /* ---------------- 不带参数：列出端倪 ---------------- */
  if (want === '') {
    if (omens.length === 0) {
      return { privateText: '没有什么可查的 —— 最近你身边没出过说不清的怪事。', detailToPrivate: true };
    }
    // M2.86：端倪走青色 + 把「追查第几条」做成按钮
    const c = ctx.deps.supportsColor === true;
    const actions: Array<{ label: string; command: string; preview?: string }> = [];
    const lines: string[] = ['【不对劲的地方】'];
    lines.push('', '最近有几件事说不通：');
    omens.forEach((o, i) => {
      // M2.86：端倪走青色（线索色），并把「查哪一条」做成按钮
    lines.push('', `${i + 1}. ` + hl(omenTextFor(o.scheme.kind, {}), 'clue', c));
    actions.push({ label: '追查', command: '查 ' + (i + 1), preview: '一旦被发现会提前收网' });
    });
    lines.push('', '要顺着哪一条查下去？发 .查 <编号>');
    lines.push('（追查有风险：一旦被对方发现你在查，那条线会**提前收网**。）');
    return {
      privateText: lines.join('\n'),
      ...(actions.length > 0 ? { nextActions: actions } : {}),
      detailToPrivate: true,
    };
  }

  /* ---------------- 带编号：追查 ---------------- */
  const pick = Number(want.replace(/[^0-9]/g, '')) || 0;
  const target = omens[pick - 1];
  if (target === undefined) {
    return { privateText: `没有第 ${pick} 条。发 .查 看现在有哪几条。`, detailToPrivate: true };
  }
  const playerSeq = character.sequence ?? 9;
  /*
   * ⚠️ M2.90：走 npcSequenceOf（设定层兜底 + 运行时覆盖）——
   * 直接读 npcProgress 会在开局拿到 `?? 9`，于是所有人都是最低档，
   * foilChance 也就永远按「最弱的对手」算，而**不报错**。
   */
  const npcSeq = npcSequenceOf(ctx.deps, target.scheme.npcId);
  const chance = foilChance(playerSeq, npcSeq);
  const rng = createSeededRng(seedFrom([ctx.msg.messageId, character.id, target.scheme.id, 'investigate']));
  const roll = rng.next();
  const success = roll < chance;

  if (success) {
    ctx.deps.npcSchemes.foil(target.scheme.id, ctx.now);
    // 破坏了他的布局 —— 他会记着（好感再降一点）
    ctx.deps.npcRelations.bump(target.scheme.npcId, character.id, -5, ctx.now);
    ctx.deps.characters.appendEvents([{
      type: 'scheme_foiled',
      characterId: character.id,
      payload: { npcId: target.scheme.npcId, schemeId: target.scheme.id, chance, roll },
      reason: '玩家察觉并反制了阴谋',
      seed: null,
      createdAt: ctx.now,
    }]);
    ctx.deps.worldEvents.insert({
      id: 'scheme-foiled-' + target.scheme.id,
      type: 'power',
      text: `【世界 · 有人收回了手】\n${character.name}顺着一条线查下去，把${target.npcName}布的那一局拆了。`,
      visibility: 'public',
      createdAt: ctx.now,
    });
    return {
      privateText:
        `你顺着那条线往下查。（成功率 ${(chance * 100).toFixed(0)}%）\n\n` +
        '查到最后，你找到了那根线的头 —— 然后你把它掐断了。\n' +
        `有人在你之后赶到，什么也没找到。你知道那是${target.npcName}的人。\n\n` +
        '（这一局破了。但他记下了这件事。）',
      detailToPrivate: true,
    };
  }

  /* 失败：对方知道你在查 —— 提前收网 */
  ctx.deps.npcSchemes.reveal(target.scheme.id, ctx.now);
  ctx.deps.npcSchemes.setStage(target.scheme.id, 'strike', ctx.now);
  ctx.deps.characters.appendEvents([{
    type: 'scheme_discovered',
    characterId: character.id,
    payload: { npcId: target.scheme.npcId, schemeId: target.scheme.id, chance, roll },
    reason: '玩家追查被发现，阴谋提前收网',
    seed: null,
    createdAt: ctx.now,
  }]);
  return {
    privateText:
      `你顺着那条线往下查。（成功率 ${(chance * 100).toFixed(0)}%）\n\n` +
      '查到一半，你发现线是**给你留的** —— 有人希望你来查。\n' +
      '你退回去的时候，身后那条路已经没了。\n\n' +
      `（${target.npcName}知道你查过了。那一局会提前收网。）`,
    detailToPrivate: true,
  };
}
