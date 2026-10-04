/**
 * 晋升仪式的**档位**（M2.76）—— 把「仪式有几关、每关多难、要什么条件」从硬编码里搬出来。
 *
 * ## 这一层要解决的问题
 *
 * 在这之前，仪式的阶段表**只有一套**：3 关（布置 0.8 / 引导 0.7 / 融合走公式），
 * 参数写死在 `NUMERIC.ritual`。于是序列 9 和序列 3 的玩家做的是**同一件事**，
 * 只差公式里那一项 `−0.05 × (9 − 序列)`。
 *
 * 而设计书给的难度杠杆不是 DIG，是**仪式配置与时间预算**（docs/M2.28-全链路框架.md:154-175）：
 * 「越往上越不能取巧」要落成**更多关、更多前置条件、更重的失败**，不是再加一个乘数。
 *
 * ## 兼容口径（这一条决定了整个改动的风险）
 *
 * `rite_novice`（序列 9—7）的阶段与参数**逐位等于**原来的硬编码值：
 * 3 关、0.8 / 0.7、阶段 1 损 30%、阶段 2 失败 −20%。
 * ⇒ 低序列的玩家**行为一个字节都不变**，既有用例与跑批读数不受影响。
 * 差异只从序列 6 起出现。这不是顺手写的兼容，是**让改动可验证**的前提。
 *
 * ## 数据要能开放地加
 *
 * 一个档位 = `rituals.yaml` 里的一段。阶段是**列表**（不是固定的 stage1/stage2），
 * 所以「加一关」不需要改判定层 —— 判定层按列表循环。
 */
import { z } from 'zod';
import type { PathwayId } from '../character/types.ts';

/** 一个阶段 */
export interface RitualStageDef {
  id: string;
  label: string;
  /**
   * 通过率；`null` = **融合关**，它的成功率由 `preview.ts` 的公式算
   * （那里才有 DIG / MAD / COR / 地点 / 天气 / 见证 / 材料 的全部输入）。
   */
  base: number | null;
  /**
   * 这一关失败时，给**融合关**叠加的惩罚（负数）。
   * 融合关自己不用这一项。
   */
  fusePenalty: number;
  /** 这一关失败就把仪式打散（只有布置类的关会这样） */
  interrupts: boolean;
  /** 打散时损失的材料比例（0—1） */
  materialLoss: number;
  /** 失败旁白（写在这里而不是代码里 —— 它是内容） */
  failNote: string;
  /** 成功旁白 */
  okNote: string;
}

/** 一个档位 */
export interface RitualProfile {
  id: string;
  name: string;
  /**
   * 适用范围：**可用的最高序列**与**最低序列**（数字越小越高，与 min_seq 同一口径）。
   * `minSeq: 9, maxSeq: 7` = 序列 7—9 用这一档。
   */
  minSeq: number;
  maxSeq: number;
  stages: RitualStageDef[];
  /** 至少要几个见证人（0 = 可以有，但不强制） */
  witnessMin: number;
  /** 融合关的固定惩罚（负数）；「越往上越难」的第二处落点 */
  fusePenalty: number;
  /** 后台与回执里的一句说明 */
  note: string;
}

/**
 * 按当前序列取档位。
 *
 * **缺失即抛**（K19：不隐含一个默认档）—— 「序列 4 的玩家没有对应仪式」
 * 是一件必须当场暴露的内容缺口，而不是悄悄套用低序列那一套。
 */
export function ritualProfileFor(
  profiles: readonly RitualProfile[],
  pathway: PathwayId,
  sequence: number,
): RitualProfile {
  void pathway;
  const hit = profiles.find((profile) => sequence <= profile.minSeq && sequence >= profile.maxSeq);
  if (hit === undefined) {
    throw new Error(
      `没有序列 ${sequence} 对应的晋升仪式档 —— 内容表 rituals.yaml 的区间有缺口（K19：不隐含默认档）。`,
    );
  }
  return hit;
}

/** 融合关（`base === null`）在阶段列表里的位置；没有就返回 -1 */
export function fuseStageIndex(profile: RitualProfile): number {
  return profile.stages.findIndex((stage) => stage.base === null);
}
/* ------------------------------------------------------------------ *
 * schema（铁律 9：YAML 里的字段必须显式声明，否则会被静默剥掉）
 * ------------------------------------------------------------------ */

export const RitualStageSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  /** null = 融合关（成功率走 preview 的公式） */
  base: z.number().min(0).max(1).nullable(),
  /** 失败时给融合关叠的惩罚。**必须 ≤ 0** —— 写成正数就成了「失败反而更容易」，
   *  而那种错在数值上完全说得通（0.1 是个合法概率），只有这里能拦。 */
  fuse_penalty: z.number().max(0).default(0),
  interrupts: z.boolean().default(false),
  material_loss: z.number().min(0).max(1).default(0),
  ok_note: z.string().min(1),
  fail_note: z.string().min(1),
});

export const RitualProfileSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  min_seq: z.number().int().min(0).max(9),
  max_seq: z.number().int().min(0).max(9),
  witness_min: z.number().int().min(0).max(3).default(0),
  fuse_penalty: z.number().max(0).default(0),
  note: z.string().default(''),
  stages: z.array(RitualStageSchema).min(1),
}).superRefine((profile, ctx) => {
  if (profile.min_seq < profile.max_seq) {
    ctx.addIssue({
      code: 'custom',
      path: ['max_seq'],
      message: `${profile.id}: min_seq(${profile.min_seq}) 必须 ≥ max_seq(${profile.max_seq})` +
        ' —— 本仓库口径是「数字越小序列越高」，写反的区间会静默匹配不到任何序列',
    });
  }
});

export const RitualsFileSchema = z.object({
  rituals: z.array(RitualProfileSchema).default([]),
});

export type RitualProfileRaw = z.infer<typeof RitualProfileSchema>;

/** YAML（snake_case）→ 领域类型（camelCase）。字段一一对应，不猜名字。 */
export function toRitualProfile(raw: RitualProfileRaw): RitualProfile {
  return {
    id: raw.id,
    name: raw.name,
    minSeq: raw.min_seq,
    maxSeq: raw.max_seq,
    witnessMin: raw.witness_min,
    fusePenalty: raw.fuse_penalty,
    note: raw.note,
    stages: raw.stages.map((stage) => ({
      id: stage.id,
      label: stage.label,
      base: stage.base,
      fusePenalty: stage.fuse_penalty,
      interrupts: stage.interrupts,
      materialLoss: stage.material_loss,
      okNote: stage.ok_note,
      failNote: stage.fail_note,
    })),
  };
}

export type ParseRitualsResult =
  | { ok: true; rituals: RitualProfile[] }
  | { ok: false; issues: string[] };

export function parseRitualsFile(raw: unknown): ParseRitualsResult {
  const result = RitualsFileSchema.safeParse(raw);
  if (!result.success) {
    return {
      ok: false,
      issues: result.error.issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`),
    };
  }
  return { ok: true, rituals: result.data.rituals.map(toRitualProfile) };
}

