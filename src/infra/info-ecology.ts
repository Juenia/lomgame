/**
 * 信息生态的接口（M2.58 阶段三）。
 *
 * ## 它补的是哪条断链
 *
 * 在这之前，生态层与世界事件层是**两条互不相干的线**：
 *
 *   sightings 表        记录了「谁在什么时候遇到了什么」（M2.8 起就有）
 *   world_events 表     播报天气 / 传闻 / 灾厄（M2.4 起就有）
 *   src/domain/world/  **一处都没有读过 sightings**
 *
 * 也就是说：你在雾里撞见了不该撞见的东西，这件事**只留在你自己的档案里**，
 * 世界不会因此知道，不会传出去，也不会有人来管。
 *
 * ## 这一层做什么
 *
 *   目击 ──(域的隐秘度决定传不传得出去)──> 传闻（world_events）
 *        └─(同时)──────────────────────> 恐慌（zone_state）
 *                                          └─> 抑制该域的繁衍（回到生态层）
 *
 * 最后那个箭头是这一层的**全部意义**：信息改变生态。
 * 人一慌就会来清剿、封锁、净化，于是那个地方的东西生不下去 ——
 * 一个闭环，而不是单向的播报。
 *
 * ## 幂等
 *
 * 传闻的 id 由 `目击 id + 域` 拼出（`rumor:sighting:<id>`），
 * 与 world_events 的既有做法一致（id 由原因拼出 → INSERT OR IGNORE 天然幂等）。
 * 恐慌累积是**一次目击一次**，走 recordSighting 的 UPSERT，重复调用不会翻倍。
 */
import type { Db } from './db/sqlite.ts';
import type { WorldEventRepo } from './db/world-events.ts';
import { ZoneStateRepo } from './db/zone-state.ts';
import { createSeededRng, seedFrom } from '../domain/rng.ts';
import {
  decayFear,
  distortionChanceOf,
  fearDeltaOf,
  rumorChanceOf,
  type ZoneIndex,
} from '../domain/world/zone.ts';

/** 传闻文案池。**匿名、真假难辨** —— 与 M2.4 的世界传闻同一口气。 */
const SIGHTING_RUMORS: readonly string[] = [
  '有人在{loc}看见过什么东西，说完就不肯再开口了。',
  '{loc}那边最近不太平，去的人回来都不太愿意提。',
  '听说{loc}出了事，但报上去的人第二天就改口了。',
  '{loc}的看守换了三拨，没人说得清上一拨去哪了。',
  '有人在{loc}听见不该听见的声音，此后一直没睡好。',
];

/**
 * M2.66：**失真后的传闻文案池** —— 疯狂度在信息生态里的落点。
 *
 * 与上面那一池的分工：那一池是「确实出了事，但说不清」；这一池是「传着传着，
 * 事情变成了另一件事」——数目对不上、时间对不上、主角换了人。
 *
 * ⚠️ 失真**不是**「传不出去」（那是 hidden 的活），也不是「传得更多」
 *（那是 fear 的活）：传出去的次数一个字节都不变，变的只有**内容**与**它活多久**。
 */
const DISTORTED_RUMORS: readonly string[] = [
  '有人说{loc}下面埋着一整座城，说这话的人已经三天没露面了。',
  '{loc}的事越传越离谱 —— 到昨天为止，见过它的人已经有十七个，而那里一共只去过三个人。',
  '关于{loc}的说法一天变一个样，唯一没变的是：说的人都不肯带路。',
  '有人在{loc}数了一遍又一遍，每次数出来的数目都不一样。',
  '据说{loc}那天晚上不止一个东西走出来。报信的人坚持说，他看见的是同一张脸。',
];

/** 一条传闻默认活多久（M2.4 的传闻同一口径） */
const RUMOR_TTL_MS = 6 * 60 * 60 * 1000;

/** 失真的传闻活得更久 —— 离谱的消息总是传得更远 */
const DISTORTED_TTL_MS = 12 * 60 * 60 * 1000;

export interface SightingEcologyInput {
  db: Db;
  zoneIndex: ZoneIndex;
  /** 世界事件的落库出口；不传 = 只累积恐慌，不播报 */
  worldEvents?: WorldEventRepo;
  locationId: string;
  locationName: string;
  /** 目击 id —— 幂等键的来源 */
  sightingId: string;
  /** 世界 seed（掷骰用） */
  worldSeed: string;
  now: number;
}

export interface SightingEcologyResult {
  /** 这次目击属于哪个域；null = 这个地点没登记在任何域里 */
  zoneId: string | null;
  /** 传出去了没有 */
  rumored: boolean;
  /** 恐慌涨了多少 */
  fearDelta: number;
  /**
   * M2.66：这条传闻**失真**了没有（没传出去时恒为 false）。
   *
   * 单独回报而不是只看文案：报告要能数「这块地方的消息有多少是离谱的」，
   * 而从文本里正则去认是一种迟早会坏的判据（M2.40 的老形状）。
   */
  distorted: boolean;
  /**
   * 那条传闻的世界事件 id（没传出去时是 null）。
   *
   * M2.60：因果图要拿它连一条「目击 → 传闻」的边 ——
   * 那条边就是「信息怎么传出去」这件事在因果图上的样子。
   */
  rumorEventId: string | null;
}

/**
 * 把一次目击接进信息生态。
 *
 * 地点没登记在任何域里时**什么都不做**（返回 zoneId: null）——
 * 与阶段二的兼容口径一致：没配的东西不参与，而不是抛错或按默认值硬套。
 */
export function noteSightingForEcology(input: SightingEcologyInput): SightingEcologyResult {
  const zone = input.zoneIndex.of(input.locationId);
  if (zone === undefined) {
    return { zoneId: null, rumored: false, fearDelta: 0, rumorEventId: null, distorted: false };
  }

  const params = input.zoneIndex.paramsOf(input.locationId);
  const hidden = zone.hidden;
  const fearDelta = fearDeltaOf(hidden);

  /*
   * 恐慌累积**先于**播报判定：
   * 一件事传不传得出去是运气，但**发生过**本身就该让这个地方更紧张一点。
   * 反过来（先判播报、没传出去就不涨恐慌）会让隐秘度高的域永远不慌，
   * 而地下墓穴那种地方恰恰是最该攒着恐慌的。
   */
  new ZoneStateRepo(input.db).recordSighting(zone.id, input.now, fearDelta);

  // 掷骰用 seedFrom：同一次目击重放时算出同一个结果（幂等的基础）
  const rng = createSeededRng(seedFrom(['info-ecology', input.worldSeed, input.sightingId]));
  const rumored = rng.next() < rumorChanceOf(params, hidden);
  if (!rumored || input.worldEvents === undefined) {
    return { zoneId: zone.id, rumored: false, fearDelta, rumorEventId: null, distorted: false };
  }

  /*
   * ---- M2.66：**失真**（域的疯狂度决定） ----
   *
   * 三件事与既有做法对齐：
   *   1. **独立随机源**：失真判定从 `seedFrom([... 'distortion'])` 派生，不占主序列的随机数 ——
   *      否则「有没有失真」会改变上面那条抽文案的流水，同一次目击重放就得不到同一个结果；
   *   2. **只在真的传出去时才掷**：没传出去的那一支在上面已经 return 了（不该掷骰时不掷）；
   *   3. **文案池换了一个，抽取次数一个不差**：所以 rng 的消耗与加这一层之前完全相同。
   */
  const distortRng = createSeededRng(seedFrom(['info-ecology-distortion', input.worldSeed, input.sightingId]));
  const distorted = distortRng.next() < distortionChanceOf(params.madness);
  const pool = distorted ? DISTORTED_RUMORS : SIGHTING_RUMORS;
  const template = pool[Math.floor(rng.next() * pool.length)] ?? pool[0]!;
  const body = template.replace(/\{loc\}/g, input.locationName);
  // ⚠️ id 由**原因**拼出（与 events.ts 同一手法）：同一次目击重放得到同一个 id，
  //    于是 INSERT OR IGNORE 不会重复播报
  const rumorEventId = 'rumor:sighting:' + input.sightingId;
  input.worldEvents.insert({
    id: rumorEventId,
    type: 'rumor',
    text: '【世界 · ' + input.locationName + '】\n' + body,
    visibility: 'anonymous',
    createdAt: input.now,
    // 与 M2.4 的传闻同一个 TTL 口径由调用方决定；失真的那条活得久一倍
    expiresAt: input.now + (distorted ? DISTORTED_TTL_MS : RUMOR_TTL_MS),
  });
  return { zoneId: zone.id, rumored: true, fearDelta, rumorEventId, distorted };
}

/**
 * 恐慌的小时衰减 —— 交给生态 tick 一起跑（它本来就是每小时一次）。
 *
 * 为什么挂在这里而不是单独一个定时器：恐慌与生态读的是同一批域，
 * 分成两个定时器就意味着「衰减跑过了但生态 tick 没跑」这种中间态，
 * 而那种中间态只在压测并发的窗口里出现，最难查。
 */
export function decayZoneFear(db: Db, zoneIndex: ZoneIndex, now: number, hours: number): number {
  if (hours <= 0) return 0;
  const repo = new ZoneStateRepo(db);
  const states = repo.all();
  let changed = 0;
  for (const zone of zoneIndex.zones) {
    const state = states.get(zone.id);
    if (state === undefined || state.fear <= 0) continue;
    repo.setFear(zone.id, decayFear(state.fear, hours), now);
    changed += 1;
  }
  return changed;
}
