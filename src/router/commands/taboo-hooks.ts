/**
 * 教义判据的**命令层钩子**（M2.17 任务 B2 / B3 / B4）。
 *
 * ## 为什么是「三个 handler 里显式调用」，不是「路由器上的通用后置钩子」
 *
 * 任务书 §三 B2 问过这个问题。答案是显式调用，理由是**路由器层判定不了「这条指令成功了没有」**：
 *
 *   - .探索 太阳神殿 可能因为「序列不够」「行动点不足」「那个地方不在脚下的城市」被拒；
 *     被拒的指令不该算「动了念头」—— 教义惩罚的是**做出来的事**。
 *   - 「成功」是 handler 内部的知识：它知道自己在哪一步真的落了库。
 *     路由器只看到一段回执文本，用文本去猜成功与否，正是最难查的那类假判定。
 *
 * 代价是三处调用点（explore / use / ritual）。换来的是：每一处都能写出
 * 「这一步为什么算违反」的集成测试，而 NUMERIC.church.taboo.checkAfter
 * 仍然是真开关（isTabooChecked 在钩子第一行就问了）。
 *
 * ## 罚则怎么落
 *
 *   数值  →  applyFor（**唯一数值入口**，铁律 2）—— MAD / COR 走 caps，不会溢出
 *   事件  →  domain_events，type = church_taboo_violation，payload = { churchId, tabooId, penalty }
 *   seed  →  **显式 null**：教义判定不掷骰（M2.16 拍板补充二的同一约定）
 *
 * applyFor 产生的那两条 mad_delta / cor_delta 事件本来会带 `seed: undefined`；
 * 这里统一补成显式 null —— 这一次判定一次骰子都没掷，它产生的每个事件都该这么说。
 */
import type { CharacterState, DomainEvent } from '../../domain/character/types.ts';
import { currentRank } from '../../domain/church/membership.ts';
import type { TabooAction } from '../../domain/church/schema.ts';
import { isTabooChecked, matchTaboos, mergeTabooPenalties, type TabooViolation } from '../../domain/church/taboo.ts';
import type { EffectDelta } from '../../domain/effect/apply.ts';
import type { CommandContext } from '../index.ts';
import { applyFor } from './common.ts';

/** 检测点告诉钩子的「此刻在哪」：两个字段都可空（不在任何被打点的地方时是 null） */
export interface TabooWhere {
  locationId?: string | null;
  cityId?: string | null;
  /** M2.18（F）：战斗类判据的目标情形（fleeing / mortal） */
  target?: import('../../domain/church/schema.ts').TabooTarget;
}

export interface TabooOutcome {
  /** 这一步违反的禁忌（0 条 = 没违反） */
  violations: TabooViolation[];
  /** 追加到回执末尾的行；空数组 = 什么都不追加 */
  receipt: string[];
  /** 扣完罚之后的角色状态（没违反时就是传进来的那一个） */
  state: CharacterState;
}

/** 代价的中文说法（回执用）。只列非零项 —— 写「疯狂 +0」是噪声 */
function penaltyText(mad: number, cor: number): string {
  const parts: string[] = [];
  if (mad > 0) parts.push('疯狂 +' + mad);
  if (cor > 0) parts.push('污染 +' + cor);
  return parts.join(' · ');
}

/**
 * 这一步有没有违反教义；有就当场扣罚、落库、并给出回执行。
 *
 * ⚠️ **调用时机**：必须在 handler 完成自己的工作（含落库）**之后**再调 ——
 * 本函数内部会 `deps.characters.update`，早调用会被 handler 后续的 write 覆盖掉。
 */
export function checkTaboosFor(
  ctx: CommandContext,
  character: CharacterState,
  action: TabooAction,
  where: TabooWhere = {},
): TabooOutcome {
  const none: TabooOutcome = { violations: [], receipt: [], state: character };
  // 第一道：这一类的动作在不在检查名单里（NUMERIC.church.taboo.checkAfter）
  if (!isTabooChecked(action)) return none;
  // 第二道：教义只约束**自己人** —— 没入教的人不受任何教义约束
  const churchId = character.churchId ?? null;
  if (!churchId) return none;
  const church = ctx.deps.churches.byId(churchId);
  if (!church) return none;

  const rank = currentRank(
    { churchContribution: character.churchContribution, sequence: character.sequence },
    church,
  );
  const violations = matchTaboos({
    action,
    locationId: where.locationId ?? null,
    cityId: where.cityId ?? null,
    rank,
    church,
    ...(where.target ? { target: where.target } : {}),
  });
  if (violations.length === 0) return none;

  const { deps, now } = ctx;
  /*
   * M2.85 RPG 化：**违反教义会让走这条路的人对你失望**。
   *
   * 用户拍板「玩家的行为可能交恶或者交好 NPC」—— 这是比杀人更"讲道理"的一种交恶：
   * 你违反了谁家的规矩，谁家的人就记你一次。每人 −2，攒三次就是「冷淡」。
   */
  for (const disp of deps.npcDispositions) {
    if (church.pathway !== null && disp.pathways.includes(church.pathway)) deps.npcRelations.bump(disp.npcId, character.id, -2, now);
  }
  const penalty = mergeTabooPenalties(violations);
  const deltas: EffectDelta[] = [];
  if (penalty.mad > 0) deltas.push({ type: 'mad', value: penalty.mad });
  if (penalty.cor > 0) deltas.push({ type: 'cor', value: penalty.cor });
  const reason = '教义违反:' + violations.map((v) => v.tabooId).join('+');
  const applied = applyFor(deps, character, deltas, reason, now);

  const events: DomainEvent[] = [
    // applyFor 的产物：这一次不掷骰，所以补成显式 null（见文件头）
    ...applied.events.map((event) => ({ ...event, seed: null })),
  ];
  for (const violation of violations) {
    events.push({
      type: 'church_taboo_violation',
      characterId: character.id,
      payload: {
        churchId: violation.churchId,
        tabooId: violation.tabooId,
        penalty: { mad: violation.penalty.mad, cor: violation.penalty.cor },
      },
      reason,
      seed: null,
      createdAt: now,
    });
  }
  deps.characters.update(applied.newState);
  deps.characters.appendEvents(events);

  /*
   * 回执（B4）：违反必须在**玩家看得见的地方**说清楚，
   * 不能只在 domain_events 里记一笔 —— 玩家下一次 .状态 看不到任何痕迹，
   * 那这条机制在他眼里就是「莫名其妙掉 SAN」。
   *
   * 文案三行：教会 + 「违反了」的判定、逐条禁忌原文（内容表里的 text，原样带出）、
   * 以及这次的实际代价（合并后的数，不是单条的）。
   */
  const receipt = [
    '',
    '【教义 · ' + church.name + '】这一步违反了禁忌。',
    ...violations.map((violation) => '· ' + violation.text),
    '代价：' + penaltyText(penalty.mad, penalty.cor),
  ];
  return { violations, receipt, state: applied.newState };
}
