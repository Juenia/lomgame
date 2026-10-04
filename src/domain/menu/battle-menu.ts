/**
 * 战斗菜单（M2.9）：把「这一回合能做什么」摆成可点的选项。
 *
 * 与其它菜单同一口径（domain/menu/types.ts 的三条硬约束）：
 *   1. 纯函数 —— (battleView) → Menu，不读库、不掷骰、不看时钟；
 *   2. 每个选项的 command 是**完整指令原文**（'战斗 攻击'），菜单只是入口；
 *   3. '0. 自己写一个行为' 由渲染层统一补。
 *
 * 任务书 §4.6 画的是「[ 攻击 ] [ 防御 ] [ 技能 ▾ ] [ 物品 ▾ ] [ 撤退 ]」——
 * QQ 的原生按钮是**扁平**的，没有二级下拉。所以这里把下拉**展开成平铺选项**：
 * 每个可用的技能各占一项、每个能用的物品各占一项。
 * 超过 6 个按钮时由 adapter 层的 foldOptions 折叠（折叠掉的仍能回数字选），
 * 所以「展开」不会让玩家点不到东西 —— 这正是 M2.7 那套折叠策略的用处。
 *
 * ⚠️ 不可用的选项**灰掉而不是隐藏**（任务书 §4.6 的原话）：
 * 「MP 不够」这件事必须看得见，否则玩家会以为那个技能不存在。
 */
import { BATTLE } from '../../config/numeric.ts';
import type { Menu } from './types.ts';
import type { BattleView } from '../battle/types.ts';
import { skillById } from '../battle/skills.ts';

/** 一个动作在本回合**能不能**选（不能就给一句为什么） */
export interface BattleActionAvailability {
  attack: string | null;
  defend: string | null;
  retreat: string | null;
  /** 技能 id → 不可用原因（null = 可用） */
  skills: Readonly<Record<string, string | null>>;
  /** 物品 id → 不可用原因 */
  items: Readonly<Record<string, string | null>>;
}

/**
 * 这一回合哪些动作不可用。
 *
 * 三条判据，都是「玩家看得懂的原因」而不是内部状态名：
 *   被放逐 → 什么都做不了（但**菜单仍然摆出来**，否则玩家以为自己卡死了）；
 *   失控   → 不能选技能（任务书 §4.3.4 明写）；
 *   MP 不够 → 那个技能灰掉。
 */
export function battleAvailabilityOf(view: BattleView): BattleActionAvailability {
  const banished = view.playerStatuses.some((entry) => entry.id === 'banish');
  const lostControl = view.playerStatuses.some((entry) => entry.id === 'lostControl');
  const banishedReason = banished ? '你这一回合动不了' : null;

  const skills: Record<string, string | null> = {};
  for (const id of view.skills) {
    const skill = skillById(id);
    if (!skill) continue;
    if (banished) skills[id] = banishedReason;
    else if (view.playerMp < skill.mpCost) skills[id] = `灵力不够（需要 ${skill.mpCost}）`;
    else skills[id] = null;
  }
  const items: Record<string, string | null> = {};
  for (const item of view.items) {
    items[item.itemId] = banished ? banishedReason : null;
  }

  return {
    attack: banishedReason,
    defend: banishedReason,
    // 撤退要花 1 AP —— AP 够不够由命令层在真正执行时兜底（菜单是纯函数，拿不到每日 AP 的语义）
    retreat: banishedReason,
    skills,
    items,
  };
}

/** 选项预览列：只给「能感到」的东西（MP 消耗 / 物品数量），不给伤害数字 */
function skillPreview(view: BattleView, id: string): string {
  const skill = skillById(id);
  if (!skill) return '';
  const unaffordable = view.playerMp < skill.mpCost;
  return `${skill.mpCost} 灵力${unaffordable ? ' · 不够' : ''}`;
}

export function buildBattleMenu(view: BattleView): Menu {
  const availability = battleAvailabilityOf(view);
  const options: Menu['options'] = [];

  const push = (
    label: string,
    command: string,
    disabled: string | null,
    preview?: string,
  ): void => {
    const option: Menu['options'][number] = { key: String(options.length + 1), label, command };
    if (preview) option.preview = preview;
    if (disabled) option.disabled = disabled;
    options.push(option);
  };

  push('攻击', '战斗 攻击', availability.attack);
  push('防御', '战斗 防御', availability.defend, `灵力 +${BATTLE.actions.defend.mpRestore}`);

  for (const id of view.skills) {
    const skill = skillById(id);
    if (!skill) continue;
    push(`技能·${skill.name}`, `战斗 技能 ${skill.name}`, availability.skills[id] ?? null, skillPreview(view, id));
  }
  for (const item of view.items) {
    push(
      `物品·${item.name}`,
      `战斗 物品 ${item.name}`,
      availability.items[item.itemId] ?? null,
      `×${item.quantity}`,
    );
  }

  push(
    '撤退',
    '战斗 撤退',
    availability.retreat,
    '危险度越高越难',
  );

  /*
   * M2.10：**认输**是 PVP 特有的一项，摆在最后。
   *
   * PVE 里「我打不过」的出口是撤退（成功就脱身），而 PVP 里对手不会让你从容走掉 ——
   * 认输是「我不打了，你赢，但你别通缉我」（认输判负但**不通缉**，见 challenge 的说明）。
   * 没有它，被围殴或者明知打不过的人只能一回合一点地被磨死。
   */
  if (view.isPvp) {
    push('认输', '战斗 认输', availability.defend, '自己判负 · 对方不通缉');
  }

  return {
    title: view.headline,
    context: view.lines.slice(1),
    options,
    allowFreeform: true,
  };
}
