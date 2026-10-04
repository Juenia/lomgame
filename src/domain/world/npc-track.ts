/**
 * NPC 晋升轨道（M2.85 世界演化第一步）—— **从 `figures.yaml` 的 `sequence` 文本解析出来**。
 *
 * ## 为什么需要它
 *
 * 在原作数据里，人物的 `sequence` 是一段**晋升轨迹文本**：
 *
 *   「序列 9-占卜家 → 0-愚者（半个旧日「诡秘之主」）」
 *   「序列 0（真神）」
 *   「序列 9-学徒 → 4-秘法师（《诡秘之主》完结时）」
 *
 * 它同时说明了三件事：**起点在哪一档**、**现在走到哪一档**、**中间经过什么**。
 * 在这之前，项目里没有任何东西读它 —— 于是「谁在同一条途径上、谁最接近登神、
 * 哪条途径还没有神」这些问题，**一个也回答不了**。
 *
 * ## 这一层与下一层
 *
 *   这一层（本文件）  静态：把轨迹解析成结构化数据 + 算「距登神几档」
 *   下一层（世界 tick）  动态：按世界时间推进 NPC 的序列；到达 0 → 发世界事件「登神」
 *
 * ⚠️ 与 `pantheon.yaml` 的关系：那张表是**原作里已经坐在神位上的**（27 位）。
 * 本表回答的是「**还有谁在路上**」—— 例如命运之轮目前无神，而威尔·昂赛汀（序列 1）正走在上面。
 */
import { z } from 'zod';

export const NpcTrackSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** 原作序列文本原文（未改写） */
  raw: z.string().default(''),
  /** 起点序列（越小越强）；解析不出来为 null */
  startSequence: z.number().int().min(0).max(9).nullable().default(null),
  /** 当前序列；解析不出来为 null */
  currentSequence: z.number().int().min(0).max(9).nullable().default(null),
  /** 轨迹段数（「→」的段数 + 1），未载为 0 */
  stages: z.number().int().min(0).default(0),
  /** 所属途径（项目口径 id） */
  pathways: z.array(z.string()).default([]),
});

export type NpcTrack = z.infer<typeof NpcTrackSchema>;

/**
 * 从原作序列文本里解析出起点 / 当前 / 段数。
 *
 * ## M2.90：多认一种写法 —— 「0（真神；“灾祸主宰”）」
 *
 * 原规则只认「N-名称」与「序列 N」两种，于是真数据里 **5 条「0（真神）」全被解析成 null**。
 * 而 null 在读取端的意思是「记载不详」，`npcSequenceOf` 于是兜底成 **9（最弱）**：
 * 一位真神在「谁会来搅你的仪式」「阴谋分几档」这些判定里变成序列 9 的路人。
 * 不报错、不警告 —— 与 M2.89 修掉的那个 `?? 9` 是同一类。
 *
 * 判据：**raw 以数字开头**（后面跟括号或直接结束）时，那个数字就是序列。
 * 只认开头、不认中间：「低序列非凡者」「无序列；位格为圣者层次」里本来就没有数字，
 * 那类记载说不清楚 —— 宁可留 null 让人去补（补的时候必须在 YAML 里写依据）。
 */
export function parseSequenceText(raw: string): { start: number | null; current: number | null; stages: number } {
  const s = String(raw ?? '');
  const nums = [...s.matchAll(/(\d+)\s*[-–—]/g)].map((m) => Number(m[1])).filter((n) => n >= 0 && n <= 9);
  const only = /^序列\s*(\d+)/.exec(s);
  const bare = /^\s*(\d+)\s*(?:[（(【\[]|$)/.exec(s);
  const bareNum = bare === null ? null : Number(bare[1]);
  const fallback = bareNum !== null && bareNum >= 0 && bareNum <= 9 ? bareNum : null;
  const start = only ? Number(only[1]) : (nums.length > 0 ? nums[0]! : fallback);
  const current = nums.length > 0 ? Math.min(...nums) : (only ? Number(only[1]) : fallback);
  const stages = s.split(/→|->/).map((x) => x.trim()).filter(Boolean).length;
  return { start, current, stages };
}

/** 距登神（序列 0）还有几档；已经登神或未载返回 null */
export function stepsToGodhood(track: NpcTrack): number | null {
  if (track.currentSequence === null || track.currentSequence <= 0) return null;
  return track.currentSequence;
}

/** 某条途径上的人，按「最接近登神」排序 */
export function climbersOf(tracks: readonly NpcTrack[], pathway: string): NpcTrack[] {
  return tracks
    .filter((t) => t.pathways.includes(pathway) && t.currentSequence !== null)
    .sort((a, b) => a.currentSequence! - b.currentSequence!);
}

/** 这条途径「已经有人登上神位」吗（当前序列 0 的人） */
export function hasGodOnPathway(tracks: readonly NpcTrack[], pathway: string): NpcTrack | null {
  return tracks.find((t) => t.pathways.includes(pathway) && t.currentSequence === 0) ?? null;
}
