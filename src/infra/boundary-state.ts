/**
 * 边界输入的触发（M2.62）。
 *
 * ## 这个文件为什么**不**读任何库状态
 *
 * 第一版让边界张力存在 `boundary_state` 表里（「上次事件是什么时候」），
 * 而 `test/m2-4.test.ts` 的分片一致性用例当场拦下了它：
 *
 * ```text
 * 4 片用不同节奏推进同样的小时 → 世界事件逐条一致
 * ```
 *
 * 4 个分片各有自己的 SQLite，各自的累积进度不同 → 算出不同的边界事件 →
 * 世界事件序列对不上。**凡是要进 world_events 的东西都必须是 (seed, 小时) 的函数。**
 *
 * 所以触发改由 `domain/world/boundary.ts` 的**时刻表**决定（纯函数，只吃 seed 与小时），
 * 这里只负责「时刻到了之后改世界」这一半。
 *
 * 保留下来的 `boundary_state` 表退化成**审计**：记「哪条边界什么时候来过什么」，
 * 供报告与后台看，**不参与任何判定**。
 */
import type { Db } from './db/sqlite.ts';
import type { WorldEvent } from '../domain/world/events.ts';
import type { WorldEventRepo } from './db/world-events.ts';
import { PowerStateRepo } from './db/power-state.ts';
import { ZoneStateRepo } from './db/zone-state.ts';
import { createSeededRng, seedFrom } from '../domain/rng.ts';
import {
  foreignInputAt,
  foreignInputText,
  type BoundaryIndex,
  type ForeignInputKind,
} from '../domain/world/boundary.ts';

export interface BoundaryState {
  boundaryId: string;
  lastEventAt: number | null;
  lastKind: ForeignInputKind | null;
  eventCount: number;
}

/** 审计仓储：只记，不判定 */
export class BoundaryStateRepo {
  #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  all(): Map<string, BoundaryState> {
    const rows = this.#db.prepare('SELECT * FROM boundary_state').all() as Array<Record<string, unknown>>;
    const out = new Map<string, BoundaryState>();
    for (const row of rows) {
      const boundaryId = String(row['boundary_id']);
      out.set(boundaryId, {
        boundaryId,
        lastEventAt: row['last_event_at'] === null ? null : Number(row['last_event_at']),
        lastKind: row['last_kind'] === null ? null : (String(row['last_kind']) as ForeignInputKind),
        eventCount: Number(row['event_count'] ?? 0),
      });
    }
    return out;
  }

  /** 记一次外来输入（幂等：同一边界同一时刻只记一次，靠主键冲突跳过重复） */
  recordEvent(boundaryId: string, at: number, kind: ForeignInputKind): void {
    this.#db
      .prepare(
        `INSERT INTO boundary_state (boundary_id, last_event_at, last_kind, event_count, updated_at)
         VALUES (?, ?, ?, 1, ?)
         ON CONFLICT(boundary_id) DO UPDATE SET
           last_event_at = MAX(boundary_state.last_event_at, ?), last_kind = ?,
           event_count = boundary_state.event_count + 1, updated_at = ?`,
      )
      .run(boundaryId, at, kind, at, at, kind, at);
  }

  count(): number {
    const row = this.#db.prepare('SELECT COUNT(*) AS n FROM boundary_state').get() as { n: number };
    return row.n;
  }
}

export interface BoundaryTickInput {
  db: Db;
  boundaryIndex: BoundaryIndex;
  worldEvents: WorldEventRepo;
  /** 世界 seed（时刻表与输入种类都由它派生） */
  seed: string;
  /**
   * 地点 → 它属于哪个生态域（用于把恐慌加到正确的域上）。
   * 不传 = 不改恐慌（只播报与警觉）。
   */
  zoneOfLocation?: (locationId: string) => string | null;
  /** 地点 → 此刻与它相关的本地势力 id。不传 = 不改势力警觉。 */
  powersAt?: (locationId: string) => readonly string[];
  /** 当前小时起点（毫秒）。**必须是整点** —— 与 generateWorldEvents 同一口径 */
  at: number;
}

export interface BoundaryTickResult {
  fired: Array<{ boundaryId: string; kind: ForeignInputKind; locationId: string; eventId: string }>;
}

/**
 * 跑一次边界输入判定。
 *
 * ## 一次输入真的改变本地世界（而不只是一条播报）
 *
 *   1. **域恐慌**（zone_state.fear）：移民涌入、污染上岸，人会慌 —— 而恐慌会抑制生态繁衍（M2.58③）；
 *   2. **势力警觉**（power_state.alert）：威胁来了，本地势力要应对 —— 而警觉会让它们更容易再动（M2.59）；
 *   3. **播报**（world_events）：让玩家看得见「外面来了东西」。
 *
 * ## ⚠️ 为什么**不**去改生态的静态基线（灵性 / 污染 / 秩序）
 *
 * 那几个值住在 `zones.yaml`（内容）里，是这个世界长期的样子。
 * 边界输入是每小时可能发生一次的事件 —— 如果每次去写它们，
 * 那它们会单调递增且永不回落，几十天之后整个参数表就废了。
 * 只有**会回落的状态量**（恐慌、警觉）才在这里被改。
 *
 * ## 幂等
 *
 * 事件的 id 是 `boundary:<边界>:<时刻>`，落库是 INSERT OR IGNORE ——
 * 同一个小时重放（补跑、分片重叠）不会重复播报。
 * 恐慌与警觉的累积也因此不会重复加（它们在事件真的新写入时才改）。
 */
export function tickBoundaries(input: BoundaryTickInput): BoundaryTickResult {
  const fired: BoundaryTickResult['fired'] = [];
  if (input.boundaryIndex.size === 0) return { fired };
  const audit = new BoundaryStateRepo(input.db);
  const powerStates = new PowerStateRepo(input.db);
  const zoneStates = new ZoneStateRepo(input.db);

  for (const boundary of input.boundaryIndex.boundaries) {
    const foreign = input.boundaryIndex.foreignPower(boundary.foreign_power);
    if (foreign === undefined) continue;
    /*
     * 时刻表与输入种类**全部由 seed 派生** ——
     * 这是分片一致性与补跑一致性的来源（见文件头）。
     */
    const def = foreignInputAt({
      boundary,
      seed: input.seed,
      attention: foreign.attention,
      at: input.at,
      gapRollFor: (index) =>
        createSeededRng(seedFrom(['boundary-gap', input.seed, boundary.id, index])).next(),
      kindRoll: createSeededRng(seedFrom(['boundary-kind', input.seed, boundary.id, input.at])).next(),
    });
    if (def === null) continue;

    /*
     * **先落播报，再改世界**：INSERT OR IGNORE 的返回值告诉我们这件事是不是新的。
     * 只有真的新写入时才改恐慌与警觉 ——
     * 否则补跑重放会把它们重复加几遍，而那正是「状态量被重放放大」的经典错法。
     */
    const eventId = 'boundary:' + boundary.id + ':' + input.at;
    const event: WorldEvent = {
      id: eventId,
      type: 'environment',
      text: '【边界 · ' + boundary.name + '】\n' + foreignInputText(def, foreign.name, boundary.name),
      visibility: 'public',
      createdAt: input.at,
      expiresAt: input.at + 6 * 60 * 60 * 1000,
    };
    const isNew = input.worldEvents.insert(event);
    audit.recordEvent(boundary.id, input.at, def.kind);
    if (!isNew) continue;

    // 1) 域恐慌：加到它所在的那个域上
    if (def.effect.fearDelta > 0 && input.zoneOfLocation !== undefined) {
      const zoneId = input.zoneOfLocation(boundary.location);
      if (zoneId !== null) zoneStates.recordSighting(zoneId, input.at, def.effect.fearDelta);
    }

    // 2) 势力警觉：与这个地点相关的本地势力要应对
    if (def.effect.alertDelta > 0 && input.powersAt !== undefined) {
      for (const powerId of input.powersAt(boundary.location)) {
        powerStates.recordReaction(powerId, input.at, def.effect.alertDelta);
      }
    }

    fired.push({
      boundaryId: boundary.id,
      kind: def.kind,
      locationId: boundary.location,
      eventId,
    });
  }
  return { fired };
}
