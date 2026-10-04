/**
 * 势力引导内容表的 schema（src/data/factions.yaml）。
 *
 * 与 items / locations / cities 一个口径：**代码只认这份 schema**，
 * YAML 写错了在启动时就报错，而不是等到某个玩家接到一个去不了的任务。
 */
import { z } from 'zod';
import { PathwayIdSchema } from '../geo/types.ts';
import type { GuidedFaction } from './types.ts';

export const GuidedTaskSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  /** 给玩家看的指令提示；判定不看它，所以它错了不会导致任务做不完 */
  action: z.string().default(''),
  /** 任务地点 id（locations.yaml） */
  target: z.string().min(1),
  kind: z.enum(['visit', 'explore']).default('explore'),
});

export const GuidedFactionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** 所在城市 id（cities.yaml）；引导只在这座城市里发生 */
  city: z.string().min(1),
  pathway: PathwayIdSchema,
  priority: z.enum(['primary', 'secondary']).default('secondary'),
  /** 接触时的第一句话（不说破自己是干什么的） */
  greeting: z.string().min(1),
  tasks: z.array(GuidedTaskSchema).min(1).max(5),
});

export type FactionDef = z.infer<typeof GuidedFactionSchema>;
export type TaskDef = z.infer<typeof GuidedTaskSchema>;

export function parseFaction(
  raw: unknown,
): { ok: true; faction: GuidedFaction } | { ok: false; issues: string[] } {
  const result = GuidedFactionSchema.safeParse(raw);
  if (!result.success) {
    return {
      ok: false,
      issues: result.error.issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`),
    };
  }
  const parsed = result.data;
  return {
    ok: true,
    faction: {
      id: parsed.id,
      name: parsed.name,
      cityId: parsed.city,
      pathway: parsed.pathway,
      priority: parsed.priority,
      greeting: parsed.greeting,
      // M2.85：引导任务只是内容存档 —— schema 照样校验结构，运行时不再读它
      tasks: parsed.tasks,
    },
  };
}
