/**
 * 物种模板的 schema（src/data/creatures.yaml）。
 *
 * 与 items / locations / cities / factions 一个口径：**代码只认这份 schema**，
 * YAML 写错了在启动时就报错，而不是等到某个玩家在雾里撞见一只没有描述的怪物。
 *
 * 一处声明，四处生效（任务书 §4.3.4）：
 *   habitat          连地图 —— 它可能出现在哪、迁移去哪
 *   pathwayAffinity  连途径 —— 哪条途径的人更容易撞见它
 *   drops            连物品 —— 观察本质能采到什么
 *   behaviors        连事件卡 —— 它会做什么（遭遇回执的旁白来源）
 */
import { z } from 'zod';
import { SPECIAL_IDS } from '../battle/specials.ts';
import type {
  CreatureBattleProfile,
  CreatureBehavior,
  CreatureDrop,
  CreatureRelations,
  CreatureSpecies,
  PerceptionLayer,
} from './types.ts';

export const BehaviorTriggerSchema = z.enum([
  'hpLow',
  'night',
  'fog',
  'hungry',
  'threatened',
  'always',
]);

export const CreatureHabitSchema = z.enum(['nocturnal', 'social', 'territorial', 'migratory']);

export const PerceptionLayerSchema = z.enum(['blur', 'silhouette', 'full', 'advantage', 'essence']);

export const CreatureDropSchema = z.object({
  itemId: z.string().min(1),
  /** 采集到它的概率（0—1）；还要再过一道 NUMERIC.creature.harvest.baseChance */
  chance: z.number().min(0).max(1),
});

/**
 * 一条行为。YAML 里写成**单键 map**（内容同学一眼能看出行为名）：
 *
 *   behaviors:
 *     - flee: { trigger: hpLow, chance: 0.6 }
 *     - howl: { trigger: night, chance: 0.2 }
 *
 * 键就是行为名（kind），值里是触发条件与概率。多键的 map 会被拦下 ——
 * 那是「写错格式」，不是「一只生物两个行为」（两个行为写两行）。
 */
export const CreatureBehaviorSchema = z.record(
  z.string().min(1),
  z.object({
    trigger: BehaviorTriggerSchema,
    chance: z.number().min(0).max(1),
  }),
);

/** 五层感知文本。**每一层都必须写**——缺一层的物种会在启动时被拦下。 */
export const CreaturePerceptionSchema = z.object({
  /** 弱 3 级及以上：只看到模糊 */
  blur: z.string().min(1),
  /** 弱 1—2 级：轮廓 */
  silhouette: z.string().min(1),
  /** 同序列：完整信息 */
  full: z.string().min(1),
  /** 强 1—2 级：占优 */
  advantage: z.string().min(1),
  /** 强 3 级及以上：本质 */
  essence: z.string().min(1),
});

/**
 * 战斗侧的内容声明（M2.9）。
 *
 * `special` 是**枚举**而不是自由字符串：写错一个名字启动就报错，
 * 而不是等某个玩家在雾里撞见一只「有专属行为但它什么也不做」的怪物。
 * 这是 M2.8「五层感知文本缺一层就报错」的同一条纪律。
 */
export const CreatureBattleSchema = z.object({
  damage: z.tuple([z.number().int().positive(), z.number().int().positive()]),
  hit: z.number().min(0).max(1),
  special: z.enum(SPECIAL_IDS as [string, ...string[]]),
  specialName: z.string().min(1),
  fleeChance: z.number().min(0).max(1).optional(),
});

/**
 * 生态位角色（M2.58）。枚举而不是自由字符串 —— 与 battle.special 同一条纪律：
 * 写错一个角色名在**启动时**就报错，而不是等到某份生态报告里一个物种安静地不参与任何关系。
 */
export const EcologicalRoleSchema = z.enum([
  'producer',
  'consumer',
  'decomposer',
  'parasite',
  'symbiont',
  'apex',
]);

/**
 * 生态关系（M2.58 阶段一）。**整个对象是可选的** —— 不写 = 沿用 M2.8 的旧行为。
 *
 * ⚠️ 五个数组里的每一个元素都是**物种 id**，由 loader 在启动时校验它确实存在
 * （见 src/data/loader.ts）。写错一个字母在内容层就被拦下，不会等到生态 tick
 * 里安静地少一条关系 —— 「少了三条关系」这种错在报告里只会表现为「捕食次数偏低」，
 * 而那有太多别的原因可以解释。
 *
 * 默认值给空数组而不是 undefined：类型上 CreatureRelations 的四个列表是非可选的
 * （只有整个 relations 可选），这样判定层不必对每个列表做存在性判断。
 */
export const CreatureRelationsSchema = z.object({
  role: EcologicalRoleSchema.default('consumer'),
  prey: z.array(z.string().min(1)).default([]),
  predators: z.array(z.string().min(1)).default([]),
  symbiosis: z.array(z.string().min(1)).default([]),
  parasite: z.array(z.string().min(1)).default([]),
});

export const CreatureSpeciesSchema = z.object({
  /** 物种 id（任务书 §4.3.4 用 species 作为键名） */
  species: z.string().min(1),
  /**
   * M2.85 数据兼容对齐：**指回 `bestiary.yaml` 的条目 id**。
   *
   * 为什么需要它：设定层（544 条，原作原文）与机制层（293 条，可遭遇）原本是**两张互不相识的表** ——
   * 玩家在 `.图鉴 生物` 看到「暗影之蛇」，却不知道它能不能打得动；在遭遇里碰见它，也查不到原著的记载。
   * 这一列把两边接上：`.图鉴 生物 <名字>` 会告诉你「这条在这里是能遇到的」。
   */
  bestiaryId: z.string().nullable().default(null),
  name: z.string().min(1),
  /** 基线序列：1（最强）— 9（最弱） */
  baseSequence: z.number().int().min(1).max(9),
  /*
   * 栖息地：locations.yaml 里的地点 id。
   *
   * ⚠️ M2.167：**允许为空** —— 空的意思是「它没有出生点」，也就是
   * **世界不会自己生出它**（初始播种按 栖息地 × 物种 播，补充池按地点取物种，
   * 两处都自然把它排除在外）。
   *
   * 这正是「堕落生物」需要的语义：它是**某个人撑不住之后变成的**，
   * 不该像森林卫士那样按地点一遍遍刷出来。写空的场合只有这一种。
   */
  habitat: z.array(z.string().min(1)).default([]),
  // 见 types.ts 的说明：允许写尚未实现的途径（实现后自动生效），拼错由 loader 拦
  pathwayAffinity: z.array(z.string().min(1)).default([]),
  drops: z.array(CreatureDropSchema).default([]),
  behaviors: z.array(CreatureBehaviorSchema).default([]),
  habits: z.array(CreatureHabitSchema).default([]),
  /**
   * M2.58 生态关系网。**可选**：不写的物种逐位沿用 M2.8 的序列差捕食规则。
   * 这是本阶段兼容性的全部要点 —— 内容表可以一个物种一个物种地补。
   */
  relations: CreatureRelationsSchema.optional(),
  tickRate: z.enum(['hourly', 'daily']).default('hourly'),
  baseHp: z.number().int().positive().default(40),
  /** 遭遇回执标题里的氛围句；空则退回物种名 */
  flavor: z.string().default(''),
  perception: CreaturePerceptionSchema,
  /**
   * M2.9：战斗侧的内容声明。
   * **YAML 里必填**（TS 类型里可选，见 creature/types.ts 的说明）——
   * 一个没有伤害数字的物种靠兜底也能打起来，但那会让八种生物退化成同一个木桩，
   * 而那种退化在报告里只会表现为「生物行为分布很均匀」。
   */
  battle: CreatureBattleSchema,
});

export type SpeciesDef = z.infer<typeof CreatureSpeciesSchema>;

export function parseCreatureSpecies(
  raw: unknown,
): { ok: true; species: CreatureSpecies } | { ok: false; issues: string[] } {
  const result = CreatureSpeciesSchema.safeParse(raw);
  if (!result.success) {
    return {
      ok: false,
      issues: result.error.issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`),
    };
  }
  const parsed = result.data;

  // 行为：record 数组 → 扁平列表。多键 map 在这里点名（zod 的 record 本身不限制键数）。
  const behaviors: CreatureBehavior[] = [];
  const behaviorIssues: string[] = [];
  for (const entry of parsed.behaviors) {
    const kinds = Object.keys(entry);
    if (kinds.length !== 1) {
      behaviorIssues.push(
        `${parsed.species}.behaviors: 一条行为只能有一个键（行为名），当前有 ${kinds.length} 个：${kinds.join(' / ')}`,
      );
      continue;
    }
    const kind = kinds[0]!;
    const value = entry[kind]!;
    behaviors.push({ kind, trigger: value.trigger, chance: value.chance });
  }
  if (behaviorIssues.length > 0) return { ok: false, issues: behaviorIssues };

  const drops: CreatureDrop[] = parsed.drops.map((drop) => ({
    itemId: drop.itemId,
    chance: drop.chance,
  }));

  const perception: Record<PerceptionLayer, string> = {
    blur: parsed.perception.blur,
    silhouette: parsed.perception.silhouette,
    full: parsed.perception.full,
    advantage: parsed.perception.advantage,
    essence: parsed.perception.essence,
  };

  /*
   * 生态关系（M2.58）：只有内容表**真的写了这一段**才产出对象。
   *
   * 为什么这里判 undefined 而不是给一个空关系的默认值：
   *   - undefined 与「有 relations 但四个列表全空」在判定层是**两种不同的东西** ——
   *     前者落回 M2.8 的序列差规则，后者表示「这个物种明确不吃任何东西」。
   *   - 把它们合并成一个，就等于偷偷给所有老物种加了一条「不许捕食」的声明，
   *     直接推翻 M2.8 已定的行为（而那是既有测试与跑批报告守着的）。
   */
  const relations: CreatureRelations | undefined =
    parsed.relations === undefined
      ? undefined
      : {
          role: parsed.relations.role,
          prey: [...parsed.relations.prey],
          predators: [...parsed.relations.predators],
          symbiosis: [...parsed.relations.symbiosis],
          parasite: [...parsed.relations.parasite],
        };

  const battle: CreatureBattleProfile = {
    damage: [parsed.battle.damage[0], parsed.battle.damage[1]],
    hit: parsed.battle.hit,
    special: parsed.battle.special,
    specialName: parsed.battle.specialName,
    ...(parsed.battle.fleeChance !== undefined ? { fleeChance: parsed.battle.fleeChance } : {}),
  };

  return {
    ok: true,
      species: {
      id: parsed.species,
      bestiaryId: parsed.bestiaryId ?? null,
      name: parsed.name,
      baseSequence: parsed.baseSequence,
      habitat: [...parsed.habitat],
      pathwayAffinity: [...parsed.pathwayAffinity],
      drops,
      behaviors,
      habits: [...parsed.habits],
      // 只有内容表真的写了 relations 才带上这个键（见上面的说明）
      ...(relations === undefined ? {} : { relations }),
      tickRate: parsed.tickRate,
      baseHp: parsed.baseHp,
      perception,
      flavor: parsed.flavor,
      battle,
    },
  };
}

/** 某条行为在给定的世界条件下是否「有资格」被掷到。纯函数，判定层与测试共用。 */
export function behaviorTriggered(
  behavior: CreatureBehavior,
  context: { hpLow: boolean; night: boolean; foggy: boolean; hungry: boolean; threatened: boolean },
): boolean {
  switch (behavior.trigger) {
    case 'hpLow':
      return context.hpLow;
    case 'night':
      return context.night;
    case 'fog':
      return context.foggy;
    case 'hungry':
      return context.hungry;
    case 'threatened':
      return context.threatened;
    case 'always':
      return true;
    default:
      return false;
  }
}
