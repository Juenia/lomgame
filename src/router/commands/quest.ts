/**
 * `.委托` / `.接 <编号>` / `.交 <编号>`（M2.85 RPG 化 D：任务系统）。
 *
 * 用户选定 D。这一层的做法是**不新造世界观**，而是把已有的东西接起来：
 *   · **谁给你委托** = 与你交好的 NPC（好感门槛，见他信不信得过你）
 *   · **做什么** = 已有的动作（猎杀某途径的生物 / 探路 / 跑腿）
 *   · **报酬** = 好感 + 便士（并写进 npc_deeds —— 他会记着这件事）
 *
 * ⚠️ 「交」的条件判定是**简化版**（先做闭环）：不查战斗日志，接下之后随时可以交付。
 * 这一步的必要性：没有闭环的任务系统就是一堆写着没人读的字段。
 */
import type { CommandContext, CommandResult } from '../index.ts';
import { requireCharacter } from './common.ts';
import { hl } from '../../adapter/highlight.ts';
import { QUEST_KIND_LABELS, canTakeQuest, renderQuest, type Quest } from '../../domain/world/quest-schema.ts';
import { createSeededRng, seedFrom } from '../../domain/rng.ts';
import { debuffLine } from '../../domain/item/equipment.ts';

/** 委托人的名字（回执要用） */
function giverNameOf(ctx: CommandContext, npcId: string): string {
  return ctx.deps.npcRoster.nameOf(npcId);
}

/** 现在有谁可能给你活儿干：好感够的 NPC（按好感高到低） */
function giversOf(ctx: CommandContext, characterId: string) {
  const dispById = new Map(ctx.deps.npcDispositions.map((d) => [d.npcId, d]));
  return ctx.deps.npcRelations
    .ofCharacter(characterId)
    .filter((r) => r.affinity >= 25 && dispById.get(r.npcId) !== undefined)
    .sort((a, b) => b.affinity - a.affinity)
    .map((r) => ({ relation: r, npcId: r.npcId, name: ctx.deps.npcRoster.nameOf(r.npcId), pathway: dispById.get(r.npcId)!.pathways[0] ?? null }));
}

/** 这个人现在能给的委托清单（按他的途径挑模板） */
function offersFor(ctx: CommandContext, characterId: string) {
  const taken = new Set(ctx.deps.quests.of(characterId).map((q) => `${q.npcId}|${q.questId}`));
  const out: Array<{ quest: Quest; giverName: string; npcId: string }> = [];
  for (const g of giversOf(ctx, characterId)) {
    for (const q of ctx.deps.questTable) {
      const key = `${g.npcId}|${q.id}`;
      if (taken.has(key)) continue;
      if (ctx.deps.quests.hasDone(characterId, q.id)) continue;
      // 委托人的身份与模板要对得上（占卜师给占卜家的活）
      if (q.id.includes('_') && g.pathway !== null && !q.id.startsWith('quest_' + g.pathway)) continue;
      out.push({ quest: q, giverName: g.name, npcId: g.npcId });
    }
  }
  return out.slice(0, 9);
}

export async function handleQuest(ctx: CommandContext): Promise<CommandResult> {
  const gate = requireCharacter(ctx);
  if (!gate.ok) return gate.result;
  const character = gate.character;
  const invoked = (ctx.msg.rawText ?? '').trim().replace(/^[.。]/, '').split(/[\s　]+/)[0] ?? '';
  const arg = ctx.args.join(' ').trim();

  /* ---------------- .委托：看有谁找你办事 ---------------- */
  if (arg === '') {
    const offers = offersFor(ctx, character.id);
    const active = ctx.deps.quests.activeOf(character.id);
    // M2.86：风格化 + 适应化（按钮由产生正文的这一层交出）
    const c = ctx.deps.supportsColor === true;
    const actions: Array<{ label: string; command: string; preview?: string }> = [];
    const lines: string[] = [`【${character.name} 的委托】`];
    if (active.length > 0) {
      lines.push('', '手上还压着的：');
      for (const a of active) {
        const q = ctx.deps.questTable.find((x) => x.id === a.questId);
        const name = ctx.deps.npcRoster.nameOf(a.npcId);
        lines.push(`  · ${q?.title ?? a.questId}（${name}）→ 发 .交 ${a.questId}`);
      }
    }
    if (offers.length === 0) {
      lines.push('', '现在没有人找你办事 —— 这一带的交情还没到那个份上。');
      lines.push('（与人交好：同处一地、入教会、别去动他的人。）');
      return {
      privateText: lines.join('\n'),
      ...(actions.length > 0 ? { nextActions: actions } : {}),
      detailToPrivate: true,
    };
    }
    lines.push('', '有人愿意托付你一件事：');
    offers.forEach((o, i) => {
      /*
       * M2.86：**风格化 + 适应化按钮**。
       * 委托名走亮色（可扫），委托人走青（「谁在托你」是要紧信息），报酬走金（收益）。
       */
      lines.push('', `${i + 1}. ${hl(o.quest.title, 'name', c)}（${QUEST_KIND_LABELS[o.quest.kind]}）—— ${hl(o.giverName, 'clue', c)}`);
      lines.push(`   ${o.quest.text}`);
      lines.push(`   报酬：好感 +${o.quest.reward.affinity}、` + hl(o.quest.reward.penny + ' 便士', 'gain', c));
      // 适应化：直接把「接哪一件」做成按钮，玩家不用回去数编号
      actions.push({ label: '接下', command: '接 ' + (i + 1), preview: o.quest.title.slice(0, 12) });
    });
    lines.push('', '接下：.接 <编号>');
    return {
      privateText: lines.join('\n'),
      ...(actions.length > 0 ? { nextActions: actions } : {}),
      detailToPrivate: true,
    };
  }

  /* ---------------- .接 <编号>：接下 ---------------- */
  if (invoked === '接') {
    const offers = offersFor(ctx, character.id);
    const pick = Number(arg.replace(/[^0-9]/g, '')) || 0;
    const offer = offers[pick - 1];
    if (offer === undefined) return { privateText: `没有第 ${pick} 件事。发 .委托 看一眼。`, detailToPrivate: true };
    const aff = ctx.deps.npcRelations.of(offer.npcId, character.id)?.affinity ?? 0;
    const allowed = canTakeQuest(offer.quest, { affinity: aff, sequence: character.sequence ?? 9 });
    if (!allowed.ok) return { privateText: allowed.reason ?? '接不了。', detailToPrivate: true };
    ctx.deps.quests.take(character.id, offer.quest.id, offer.npcId, ctx.now);
    return { privateText: `你应下了。\n\n${renderQuest(offer.quest, offer.giverName)}\n\n办完发 .交 ${offer.quest.id}`, detailToPrivate: true };
  }

  /* ---------------- .交 <编号>：交付 ---------------- */
  const active = ctx.deps.quests.activeOf(character.id);
  const target = active.find((q) => q.questId === arg) ?? active[Number(arg.replace(/[^0-9]/g, '')) - 1];
  if (target === undefined) return { privateText: `手上没有这件事：${arg}。发 .委托 看一眼。`, detailToPrivate: true };
  const quest = ctx.deps.questTable.find((x) => x.id === target.questId);
  if (quest === undefined) return { privateText: '这件事找不到出处了。', detailToPrivate: true };
  ctx.deps.quests.complete(character.id, target.questId, target.npcId, ctx.now);
  /*
   * **有概率给一件非凡物品**（用户拍板：不该很频繁，不是大白菜）。
   *
   * 掷骰用固定种子（可复现）；只从**委托人那条途径**相关的、且玩家还没拥有的东西里挑 ——
   * 一份委托换来一件「渠道货」，比随机掉一件更说得通。
   */
  let equipmentLine = '';
  const dropChance = quest.reward.equipmentChance ?? 0;
  if (dropChance > 0) {
    const rng = createSeededRng(seedFrom([ctx.msg.messageId, character.id, quest.id, 'quest-equipment']));
    if (rng.next() < dropChance) {
      const giverPathway = ctx.deps.npcDispositions.find((d) => d.npcId === target.npcId)?.pathways[0] ?? null;
      const pool = ctx.deps.equipmentTable.filter((e) =>
        e.level !== '0' &&
        !ctx.deps.equipment.owns(character.id, e.id) &&
        (giverPathway === null || e.pathway === undefined || e.pathway === giverPathway));
      if (pool.length > 0) {
        const got = pool[Math.floor(rng.next() * pool.length)]!;
        ctx.deps.equipment.acquire(character.id, got.id, 'quest', ctx.now);
        ctx.deps.worldEvents.insert({
          id: 'quest-equip-' + character.id + '-' + ctx.now,
          type: 'power',
          text: '【世界 · 谢礼】' + character.name + '办完了一件事，' + giverNameOf(ctx, target.npcId) + '给了他一样东西 —— ' + got.name +
            '\n（这种东西不该随便出现。它有增幅，也有代价：' + debuffLine(got.debuffs) + '）',
          visibility: 'public',
          createdAt: ctx.now,
        });
        equipmentLine = '\n\n' + giverNameOf(ctx, target.npcId) + '还从抽屉里拿出一样东西推给他 —— ' + got.name + '。' +
          '\n「这个你拿着。别问它从哪来。」' +
          '\n（' + debuffLine(got.debuffs) + '）';
      }
    }
  }
  const rel = ctx.deps.npcRelations.bump(target.npcId, character.id, quest.reward.affinity, ctx.now);
  ctx.deps.inventory.addMany(character.id, [{ itemId: '便士', quantity: quest.reward.penny, bindType: 'unbound' }], ctx.now);
  ctx.deps.npcDeeds.record({ npcId: target.npcId, kind: 'quest_done', detail: `${character.name} 办妥了那件事（${quest.title}）`, merit: 0, at: ctx.now });
  ctx.deps.characters.appendEvents([{ type: 'quest_done', characterId: character.id, payload: { questId: quest.id, npcId: target.npcId }, reason: '完成委托', seed: null, createdAt: ctx.now }]);
  const giverName = ctx.deps.npcRoster.nameOf(target.npcId);
  return {
    privateText:
      `你把这件事办完，回去交了差。\n\n` +
      `${giverName}点了点头 —— 没说什么，但记下了。\n` +
      `报酬：便士 +${quest.reward.penny}，他对你的好感 +${quest.reward.affinity}（现在是 ${rel.affinity}）。` +
      equipmentLine,
    detailToPrivate: true,
  };
}
