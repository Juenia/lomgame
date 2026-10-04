/**
 * .干扰 指令（M2.5）：去搅别人的晋升仪式。
 *
 *   .干扰 @某人     消耗圣盐 ×1，判定一次（M2.85：原来的 1 AP 随行动值机制移除）
 *
 * 设计意图（任务书 §4.3）：**每日 1 次 + 消耗材料**，让干扰是「决策」而不是「骚扰」。
 * 这条线不许为了「更好玩」放宽 —— 放宽之后晋升就变成互相破坏的战场了。
 *
 * 目标必须是**此刻正在举行仪式的人**（rituals.status = running 且没过窗口）：
 * 这也是为什么 `.仪式 开始` 与 `.仪式 融合` 要分成两条指令 ——
 * 中间那段窗口就是干扰唯一的作用点，同时它也让「群内匿名播报某处有人在举行仪式」
 * 变成一条真的有用的信息，而不是一句装饰。
 */
import { NUMERIC } from '../../config/numeric.ts';
import { createSeededRng, seedFrom } from '../../domain/rng.ts';
import { dayIndexOf, dayStartOf } from '../../domain/world/clock.ts';
import { resolveInterference, interferenceChance } from '../../domain/ritual/index.ts';
import type { CommandContext, CommandResult } from '../index.ts';
import { applyFor, requireCharacter } from './common.ts';
import { renderDeltaSummary } from './render.ts';
import { tollOnAction } from './wanted-hooks.ts';
import { mortalGuard } from './mortal-guard.ts';

export const INTERFERE_USAGE =
  '用法：.干扰 @某人（对方必须正在举行仪式；消耗 ' +
  NUMERIC.interference.materialCost + ' ×' + NUMERIC.interference.materialQty +
  '，每日 ' + NUMERIC.interference.dailyLimit + ' 次）';

const CFG = NUMERIC.interference;

export async function handleInterfere(ctx: CommandContext): Promise<CommandResult> {
  const gate = requireCharacter(ctx);
  if (!gate.ok) return gate.result;
  const character = gate.character;
  const { deps, msg, now } = ctx;

  // M2.7.6：普通人看不见别人在做什么，也就无从干扰（M2.7.7 起走统一入口守卫）
  {
    const guard = mortalGuard(ctx, '干扰');
    if (guard) return guard;
  }

  const raw = ctx.args.join(' ').trim().replace(/^@/, '');
  if (!raw) return { privateText: INTERFERE_USAGE, detailToPrivate: true };

  // 目标解析：先按 QQ 号，再按角色名
  const target =
    deps.characters.findByUserId(raw) ??
    deps.characters.all().find((candidate) => candidate.name === raw) ??
    null;
  if (!target) return { privateText: '找不到这个人：' + raw + '\n' + INTERFERE_USAGE, detailToPrivate: true };
  if (target.id === character.id) {
    return { privateText: '干扰自己没有任何意义。', detailToPrivate: true };
  }

  // 目标必须正在举行仪式
  const ritual = deps.rituals.runningOf(target.id);
  if (!ritual) {
    return { privateText: target.name + ' 现在没有在举行仪式 —— 没有可干扰的东西。', detailToPrivate: true };
  }
  const startedAt = ritual.startedAt ?? 0;
  if (startedAt + CFG.windowMs <= now) {
    return {
      privateText: target.name + ' 的仪式已经开始太久了（超过 ' + Math.round(CFG.windowMs / 60000) + ' 分钟），打不到了。',
      detailToPrivate: true,
    };
  }

  // 每日上限
  const dayStart = dayStartOf(dayIndexOf(now));
  const usedToday = deps.rituals.countInterferencesSince(character.id, dayStart);
  if (usedToday >= CFG.dailyLimit) {
    return {
      privateText: '今天已经干扰过 ' + usedToday + ' 次了（上限 ' + CFG.dailyLimit + ' 次）—— 明天再来。',
      groupText: '【' + character.name + '】想做点什么，但没做成。',
      detailToPrivate: true,
    };
  }

  // 先校验后扣（S1 §4：失败不产生副作用）
  if (deps.inventory.count(character.id, CFG.materialCost) < CFG.materialQty) {
    return { privateText: '没有' + CFG.materialCost + '了（需要 ×' + CFG.materialQty + '）。', detailToPrivate: true };
  }

  const seed = seedFrom([msg.messageId, character.id, now, 'interfere', target.id]);
  const outcome = resolveInterference({ targetMad: target.mad, rng: createSeededRng(seed) });

  deps.rituals.addInterference({
    id: seedFrom(['ritual-interference', msg.messageId, character.id]),
    ritualId: ritual.id,
    interfererId: character.id,
    success: outcome.success,
    createdAt: now,
  });
  if (outcome.success) {
    const config = {
      ...ritual.config,
      interferenceCount: ritual.config.interferenceCount + 1,
    };
    deps.rituals.bumpInterference(ritual.id, config);
  }

  // 代价与结果：材料 / 失败时的 COR
  const deltas = [...outcome.deltas];
  const applied = applyFor(deps, character, deltas, '干扰:' + target.name, now, seed);
  deps.inventory.tryRemoveMany(character.id, [{ itemId: CFG.materialCost, qty: CFG.materialQty }], now);
  // M2.6：干扰者自己也暴露在通缉判定下 —— 蹲在别人仪式外的人，同样会被巡警注意到
  const toll = tollOnAction({ deps, state: applied.newState, now, seed });
  deps.characters.update(toll.state);
  deps.characters.appendEvents([
    ...applied.events,
    {
      type: outcome.success ? 'interference_success' : 'interference_fail',
      characterId: character.id,
      payload: {
        ritualId: ritual.id,
        targetId: target.id,
        chance: outcome.chance,
        roll: outcome.roll,
      },
      reason: '干扰判定',
      seed,
      createdAt: now,
    },
  ]);

  const lines: string[] = [];
  lines.push('【干扰 · ' + target.name + '】');
  lines.push('');
  lines.push(...outcome.narrative);
  lines.push('');
  lines.push(
    '成功率 ' + (outcome.chance * 100).toFixed(1) + '%（对方 MAD ' + Math.round(target.mad) + '），' +
      '抽样 ' + outcome.roll.toFixed(3),
  );
  lines.push('');
  lines.push(...renderDeltaSummary(applied.events, false, (id) => deps.items.nameOf(id)));
  lines.push(...toll.lines);
  lines.push('');
  if (outcome.success) {
    lines.push('对方接下来的融合成功率 -' + Math.round(Math.abs(CFG.targetPenalty) * 100) + '%。');
  } else {
    lines.push('失败了：污染 +' + CFG.failCorPenalty + '。');
  }

  // 双方私聊（M2.5 §4.4）：被干扰的人要知道发生了什么
  const victimUserId = target.userId;
  return {
    privateText: lines.join('\n'),
    groupText: outcome.success ? '某处的仪式被打断了。' : undefined,
    detailToPrivate: true,
    extra: [
      {
        scene: 'private',
        targetId: victimUserId,
        text: outcome.success
          ? '有人在你的仪式外面动了手脚 —— 融合成功率 -' + Math.round(Math.abs(CFG.targetPenalty) * 100) + '%。'
          : '有人在你的仪式外面晃了一圈，被你察觉了。（对方没得手）',
      },
    ],
  };
}
