/**
 * 普通人入口守卫（M2.7.7）。
 *
 * **架构原则（这一轮把它落成一个模块）**：
 *   命令层负责「有没有资格做这件事」，判定层负责「这件事能不能成」。
 *
 * 在 M2.7.7 之前，这条原则是靠每个 handler 各写一份 if 实现的 ——
 * 结果是「凡人不能扮演」在 play.ts 里、「不能晋升」在 promote.ts 里，
 * 措辞与口径各不相同；而 `.魔药` 干脆漏了，于是普通人一路走到判定层，
 * 拿到的是一句「材料不足」。
 *
 * 那句回执比拒绝更糟：它**暗示「凑齐材料就能调」**。
 * 一个还没有途径的人不该收到这种暗示 —— 他该听到的是「这件事现在与你无关」。
 *
 * 三条硬要求（任务书 §3.2）：
 *   1. 不消耗 AP；
 *   2. 不进冷却；
 *   3. 不落判定事件。
 * 做法就是**在 handler 的第一行返回** —— 不走任何判定、不碰任何账。
 */
import { isInitiated, type CharacterState } from '../../domain/character/types.ts';
import { MORTAL_ACTION_BLOCKS } from '../../domain/initiation/index.ts';
import type { CommandContext, CommandResult } from '../index.ts';

/** 走统一守卫的动作（与 domain 侧 MORTAL_ACTION_BLOCKS 的键一一对应） */
export const MORTAL_GUARD_ACTIONS = ['扮演', '晋升', '占卜', '仪式', '干扰', '魔药'] as const;
export type MortalGuardAction = (typeof MORTAL_GUARD_ACTIONS)[number];

/**
 * 拒绝回执（口径统一在这一个函数里）。
 *
 * 结构固定为三段：**为什么不行 → 现在能做什么 → 去哪看更多**。
 * 第二段是必要的：只说「不行」的拒绝会让玩家去试下一条，而他现在真正该做的是
 * 四处走走等人来找 —— 这一点必须由系统说出来。
 */
function renderRefusal(character: CharacterState, action: MortalGuardAction, reason: string): string {
  const lines: string[] = [reason, '', '先四处走走吧：'];
  lines.push('  .探索        —— 随便找个地方待一会儿（5% 翻到配方线索）');
  lines.push('  .线索        —— 手上的线索与主材料的下落');
  lines.push('  .今日        —— 今天的推荐');
  if (action === '魔药') {
    lines.push('');
    lines.push('（配方不是凭感觉能想出来的东西 —— 得有人给你，或者你自己翻出一张纸。）');
  }
  void character;
  return lines.join('\n');
}

/**
 * 统一拒绝回执（**必定返回**）。
 *
 * 为什么把「渲染」和「判断」拆成两个函数：
 * handler 里真正需要的是**类型收窄** ——
 *   if (!isInitiated(character)) return mortalRefusal(ctx, character, '晋升');
 * 这一行之后 TS 就知道 character 是 InitiatedCharacter，
 * 后面所有需要途径/序列的调用都不用再断言。
 * 如果只提供「返回 CommandResult | null」的便捷版，收窄就丢了，
 * 每个 handler 都得自己补一句不可达的兜底。
 */
export function mortalRefusal(
  ctx: CommandContext,
  character: CharacterState,
  action: MortalGuardAction,
): CommandResult {
  const reason = MORTAL_ACTION_BLOCKS[action] ?? '这件事现在还轮不到你。';
  void ctx;
  return {
    privateText: renderRefusal(character, action, reason),
    groupText: `【${character.name}】想${action}，但那件事现在与他无关。`,
    detailToPrivate: true,
    // 拒绝不是「没有下一步」——它恰恰是最需要给方向的一种回执，所以不禁用菜单
  };
}

/**
 * 便捷版：自己查角色，不该挡时返回 null。
 *
 * 用在「已经有 character 但不想为收窄写一行 if」的地方；
 * 需要收窄的 handler 请直接用 mortalRefusal（见它的注释）。
 *
 * options.allowWhen：「虽然他是普通人，但这件事他确实做得了」的例外。
 * 目前只有一处用到 —— .魔药：手里真有配方（线索或势力给的那张纸）的普通人**必须**能调制，
 * 那正是入途径两条路里「自己找到」那条的最后一步。
 */
export function mortalGuard(
  ctx: CommandContext,
  action: MortalGuardAction,
  options: { allowWhen?: boolean } = {},
): CommandResult | null {
  const character = ctx.deps.characters.findByUserId(ctx.msg.userId);
  if (!character) return null;
  if (isInitiated(character)) return null;
  if (options.allowWhen === true) return null;
  if (!MORTAL_ACTION_BLOCKS[action]) return null;
  return mortalRefusal(ctx, character, action);
}