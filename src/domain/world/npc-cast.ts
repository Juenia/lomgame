/**
 * **世界人物名册**（M2.164）—— 世界里那些「不是原作主角」的人。
 *
 * ## 为什么需要第三张 NPC 表
 *
 * 项目里已经有两处「人物」：
 *
 *   `figures.yaml`      原作人物档案（70 位：有名有姓、有出处）
 *   `npc-tracks.yaml`   其中 41 位的**晋升轨迹**（能算出「距登神几档」）
 *
 * 而世界 tick 真正缺的不是这 41 位 —— 祂们是几百年一遇的怪物。世界缺的是
 * **巡警、码头工、旧书商、教士、线人、医生**：玩家走进任何一条街都该撞见的人。
 * 这一层此前是空的，后果不是「内容少」，而是**机制全挤在塔尖上**：
 * `npc-scheme` 的对手只能从那 41 位里挑，于是每一个阴谋都是半神算计半神；
 * `npc-relations` 的好感也只能攒在那 41 个人身上。
 *
 * ## 三张表的分工（不许有第二份清单）
 *
 *   `npc-tracks`   **谁在路上**（原作记载，静态，不能改）
 *   `npc-cast`     **谁在城里**（项目设计：身份、常驻、性情、用途）
 *   `npc_life`     **谁还活着**（运行期状态，进 DB —— 见 `npc-life.ts`）
 *
 * 前两张是**内容**，第三张是**状态**。同一个人**不许**同时出现在前两张里：
 * 名册的 id 与轨道撞车时加载器直接报错（否则「他死了」会写在错误的身份上）。
 *
 * ## 名字解析只有一个入口
 *
 * 在这之前，「npcId → 中文名」在每个命令里各查一次 `deps.npcTracks.find(...)` ——
 * 那种写法在名册铺开之后会**安静地退化成显示 id**（查不到就 `?? npcId`）。
 * 所以名字一律走 `NpcRoster.nameOf`：它同时认轨道与名册两张表。
 */
import { z } from 'zod';
import { TemperamentSchema, type Temperament } from './npc-relation.ts';
import type { NpcTrack } from './npc-track.ts';
import type { NpcDisposition } from './npc-disposition-schema.ts';

/**
 * 他是什么身份。
 *
 * ⚠️ 它是**内容分类**，不是判定开关：判定要按身份分档时走显式的 `Record<NpcKind, …>`
 * （漏一个键 tsc 就红），不要写 `kind === 'church' ? A : B` —— 那样新加一类会被静默吞进 else。
 */
export const NPC_KINDS = [
  'church', 'official', 'underworld', 'scholar', 'merchant',
  'laborer', 'military', 'healer', 'artist', 'noble', 'commoner',
] as const;
export type NpcKind = (typeof NPC_KINDS)[number];

export const NPC_KIND_LABELS: Readonly<Record<NpcKind, string>> = {
  church: '教会',
  official: '官方',
  underworld: '地下',
  scholar: '学者',
  merchant: '商人',
  laborer: '劳工',
  military: '军方',
  healer: '医者',
  artist: '艺人',
  noble: '贵族',
  commoner: '平民',
};

export const NpcKindSchema = z.enum(NPC_KINDS);

export const NpcCastSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: NpcKindSchema,
  /** 常驻城市（`cities.yaml` 的 id）；空 = 居无定所 */
  city: z.string().default(''),
  /** 常驻地点（`locations.yaml` 的 id）；空 = 在城里，但不固定在某处 */
  location: z.string().default(''),
  /** 本地势力（`factions.yaml` 的 id） */
  faction: z.string().default(''),
  /** 大组织（`organizations.yaml` 的 id） */
  organization: z.string().default(''),
  /** 所属教会（`churches.yaml` 的 id）；教会的教士才填 */
  church: z.string().default(''),
  /** 途径（空 = 普通人）；值域是 `PATHWAY_LABELS` 的键 */
  pathway: z.string().default(''),
  /** 序列：9 是最低一档（与全项目口径一致），普通人也是 9 */
  sequence: z.number().int().min(0).max(9).default(9),
  temperament: TemperamentSchema,
  /**
   * 用途标签（中文自由标签）。
   *
   * 它**不是枚举**：写的是「这个人能做什么、知道什么」（`可被收买` / `知道港口的事`），
   * 机制按标签筛选。之所以不做成枚举，是因为标签是**内容**，会一条一条长出来 ——
   * 而枚举每加一个值都要改代码，那就不是「加数据」了。
   */
  tags: z.array(z.string()).default([]),
  note: z.string().default(''),
});
export type NpcCast = z.infer<typeof NpcCastSchema>;

export const NpcCastFileSchema = z.object({
  meta: z.record(z.string(), z.unknown()).default({}),
  npc_cast: z.array(NpcCastSchema).default([]),
});

/** 名册里的一条：把两张来源表**拉平成同一个形状**（读取点只认这一种） */
export interface RosterEntry {
  id: string;
  name: string;
  /** 身份；`null` = 原作人物（轨道表里的人没有身份分类） */
  kind: NpcKind | null;
  city: string;
  location: string;
  /** 序列；`null` = 记载不详（轨道里解析不出来的那几条） */
  sequence: number | null;
  pathway: string;
  /** 所属教会（`churches.yaml` 的 id）；轨道来源为空 */
  church: string;
  /** 本地势力（`factions.yaml` 的 id）；轨道来源为空 */
  faction: string;
  temperament: Temperament;
  tags: readonly string[];
  source: 'track' | 'cast';
}

/**
 * **名册**：轨道 + 名册两份内容合成一个查询入口。
 *
 * 它只做查询，不持有状态 —— 「谁还活着」不在这里（那是 `npc-life.ts` 与 DB 的事），
 * 所以同一个名册可以放心地被所有读取点共用。
 */
export class NpcRoster {
  readonly #all: readonly RosterEntry[];
  readonly #byId = new Map<string, RosterEntry>();

  constructor(
    tracks: readonly NpcTrack[],
    cast: readonly NpcCast[],
    dispositions: readonly NpcDisposition[] = [],
  ) {
    const dispById = new Map(dispositions.map((d) => [d.npcId, d]));
    const fromTracks: RosterEntry[] = tracks.map((t) => ({
      id: t.id,
      name: t.name,
      kind: null,
      city: '',
      location: '',
      sequence: t.currentSequence,
      pathway: t.pathways[0] ?? '',
      church: '',
      faction: '',
      temperament: dispById.get(t.id)?.temperament ?? 'neutral',
      tags: [],
      source: 'track',
    }));
    const fromCast: RosterEntry[] = cast.map((c) => ({
      id: c.id,
      name: c.name,
      kind: c.kind,
      city: c.city,
      location: c.location,
      sequence: c.sequence,
      pathway: c.pathway,
      church: c.church,
      faction: c.faction,
      temperament: c.temperament,
      tags: c.tags,
      source: 'cast',
    }));
    this.#all = [...fromTracks, ...fromCast];
    for (const entry of this.#all) this.#byId.set(entry.id, entry);
  }

  get all(): readonly RosterEntry[] { return this.#all; }
  get size(): number { return this.#all.length; }

  byId(id: string): RosterEntry | null { return this.#byId.get(id) ?? null; }

/**
   * 名字。**查不到时返回 id 本身**（与既有 `?? npcId` 的行为一致）——
   * 但那是兜底，不是常态：真出了查不到的 id，应当由 `m2-164` 的用例去抓，
   * 而不是让玩家在回执里读到一串英文。
   */
  nameOf(id: string): string { return this.#byId.get(id)?.name ?? id; }

  /** 这座城里的人（场景渲染：街上站着谁） */
  inCity(cityId: string): RosterEntry[] { return this.#all.filter((e) => e.city === cityId); }

  /** 这个地点上的人 */
  atLocation(locationId: string): RosterEntry[] { return this.#all.filter((e) => e.location === locationId); }

  byKind(kind: NpcKind): RosterEntry[] { return this.#all.filter((e) => e.kind === kind); }

  /** 带某个标签的人（机制筛选：谁能被派去做什么） */
  withTag(tag: string): RosterEntry[] { return this.#all.filter((e) => e.tags.includes(tag)); }

  /** 城里**还活着**的普通人（不含原作人物）—— 阴谋与遭遇的池子 */
  townsfolkIn(cityId: string): RosterEntry[] {
    return this.#all.filter((e) => e.source === 'cast' && e.city === cityId);
  }
}
