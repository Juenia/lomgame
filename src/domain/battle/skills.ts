/**
 * 每途径两个技能（M2.9，任务书 §4.3.5）—— **纯函数，无 IO**。
 *
 * **技能是解禁，不是升级。**
 * 序列 9 没有「强攻」，序列 8 才有；而到了序列 8，序列 9 的那个技能**仍然在**。
 * 这与 M2.8 的感知分层是同一条原则 —— 序列正反馈来自「能做以前做不到的事」，
 * 不是「同一个动作的数字变大」。
 *
 * 可用判据就一条：**playerSeq ≤ skill.seq**（序列号越小越强）。
 * 于是序列 8 的玩家技能池是 4 个（9 的两个 + 8 的两个），序列 9 是 2 个 ——
 * 这正是 M2.8 感知分层里「同一片雾，你看到的东西变了」的同一个形状。
 *
 * 普通人的技能池是**空的**（没有途径就没有技能），复用同一个函数，不需要额外分支。
 */
import { BATTLE } from '../../config/numeric.ts';
import type { PathwayId } from '../character/types.ts';
import type { BattleSkill } from './skill-schema.ts';

export interface SkillDef {
  id: string;
  pathway: PathwayId;
  /** 解禁所需的序列（玩家序列必须 ≤ 它） */
  seq: number;
  name: string;
  mpCost: number;
}

/** 全部技能（顺序稳定 —— 菜单与报告都读它，顺序漂了会连带改变断言） */
export const ALL_SKILLS: readonly SkillDef[] = Object.entries(BATTLE.skills)
  .map(([id, value]) => ({
    id,
    pathway: value.pathway as PathwayId,
    seq: value.seq,
    name: value.name,
    mpCost: value.mpCost,
  }))
  .sort((a, b) => (a.pathway === b.pathway ? b.seq - a.seq : a.pathway.localeCompare(b.pathway)));

export function skillById(id: string): SkillDef | null {
  return ALL_SKILLS.find((skill) => skill.id === id) ?? null;
}

/** 同途径的技能名 → id（玩家可以直接敲「.战斗 技能 强攻」） */
export function skillByName(name: string, extra: readonly BattleSkill[] = []): SkillDef | null {
  // 内容表优先（M2.85 C）：它有一百多条，而 numeric 里那 44 条是手调的
  const fromContent = contentSkillsOf(extra).find((skill) => skill.name === name);
  if (fromContent !== undefined) return fromContent;
  return ALL_SKILLS.find((skill) => skill.name === name) ?? null;
}

/**
 * 把内容表（battle-skills.yaml，M2.85 RPG 化 C）里的技能折成同一种形状。
 *
 * 为什么不做成「取代」：numeric 里那 44 个是 M2.9 就定下的**手工调过数值**的技能，
 * 而内容表是从原作能力描述**派生**的 110 个 —— 两者并存，
 * 一个管手感、一个管广度，删掉任何一个都是丢东西。
 */
export function contentSkillsOf(table: readonly BattleSkill[]): SkillDef[] {
  return table.map((s) => ({ id: s.id, pathway: s.pathway as PathwayId, seq: s.seq, name: s.name, mpCost: s.mpCost }));
}

/**
 * 这条途径此刻的技能池。
 *
 * 普通人（pathway = null）返回空数组 —— 「他连那是什么都不知道」，
 * 与 M2.8 遭遇菜单里普通人只有两个选项是同一个口径。
 *
 * M2.85：传入 `extra`（内容表）时把两边的技能池**合并** —— 名字重的以内容表为准。
 */
export function skillsFor(pathway: PathwayId | null, sequence: number, extra: readonly BattleSkill[] = []): SkillDef[] {
  if (!pathway) return [];
  const own = ALL_SKILLS.filter((skill) => skill.pathway === pathway && sequence <= skill.seq);
  const fromContent = contentSkillsOf(extra).filter((skill) => skill.pathway === pathway && sequence <= skill.seq);
  const seen = new Set<string>();
  const out: SkillDef[] = [];
  for (const skill of [...fromContent, ...own]) {
    if (seen.has(skill.name)) continue;
    seen.add(skill.name);
    out.push(skill);
  }
  return out;
}

/** 这个技能此刻能不能用（在池子里 + MP 够） */
export function canUseSkill(
  skill: SkillDef,
  input: { pathway: PathwayId | null; sequence: number; mp: number },
): { ok: boolean; reason?: string } {
  if (!input.pathway) return { ok: false, reason: '你还没有途径。' };
  if (skill.pathway !== input.pathway) return { ok: false, reason: '这不是你那条途径的能力。' };
  if (input.sequence > skill.seq) {
    // 这一句就是「技能是解禁，不是升级」在玩家侧的说法
    return { ok: false, reason: `序列 ${input.sequence} 还没有解锁「${skill.name}」（要到序列 ${skill.seq}）。` };
  }
  if (input.mp < skill.mpCost) return { ok: false, reason: `灵力不够（需要 ${skill.mpCost}）。` };
  return { ok: true };
}

/** 技能数值（numeric.battle.skillEffects 的只读视图） */
export function skillEffectOf(
  id: string,
  /** M2.85 C：内容表折进 BattleWorld 的那一份（优先于 numeric 的手工数值） */
  fromWorld?: Record<string, Record<string, number | boolean>>,
): Record<string, number | boolean> {
  if (fromWorld?.[id] !== undefined) return fromWorld[id]!;
  const table = BATTLE.skillEffects as unknown as Record<string, Record<string, number | boolean>>;
  return table[id] ?? {};
}

/**
 * 技能效果（M2.85 C）：先查内容表（那条能力的原文衍生效果），再退回 numeric 的手工数值。
 *
 * ⚠️ 两边都查不到就返回空对象 —— 一个技能没有效果是**可以发生**的（辅助类），
 * 所以这里不报错；真正要收紧的地方是「内容表里有这个 id，但效果写错了」，
 * 那条由 schema 管（`SkillEffectSchema`）。
 */
export function effectOf(id: string, extra: readonly BattleSkill[] = []): Record<string, number | boolean> {
  const fromContent = extra.find((s) => s.id === id);
  if (fromContent !== undefined) return { ...fromContent.effect };
  return skillEffectOf(id);
}
