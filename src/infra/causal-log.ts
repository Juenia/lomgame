/**
 * 因果日志（M2.60）：把「发生过什么」变成「谁导致了谁」。
 *
 * ## 与 domain_events 的分工
 *
 *   domain_events（0001）—— **角色级操作流水**。「这个角色的 HP 为什么少了 1」。
 *   causal_nodes / causal_edges（本层）—— **事件之间的因果关系**。「谁导致了谁」。
 *
 * 两者不合并，因为读它们的人不同：前者是审计（逐角色的账），
 * 后者是复盘（一条链是怎么走下来的）。往 domain_events 里塞因果边会让
 * 「查一个角色的操作记录」这个热路径变成要扫全表。
 *
 * ## 节点 id 的来源（幂等的基础）
 *
 * 全部由「事的来源」拼出，与 world_events 同一个手法：
 *
 *   sighting:<sightingId>                  一次目击
 *   worldevent:<worldEventId>              一条世界事件
 *   reaction:<sourceId>:<powerId>          一次势力反应（与 M2.59 的 reaction.id 同源）
 *
 * 重放同一个事件得到同一个节点 → INSERT OR IGNORE 天然幂等。
 * 补跑与「逐小时真的跑过」得到的是**同一张因果图**，而不是两倍那么多条边。
 */
import type { Db } from './db/sqlite.ts';

/** 节点类型。只有三种 —— 多了会让图变成「什么都能连」。 */
export type CausalNodeKind = 'sighting' | 'worldevent' | 'reaction';

/** 边的关系。同样只有三种，理由见迁移文件的注释。 */
export type CausalRelation = 'caused' | 'responded' | 'mutated';

export interface CausalNode {
  id: string;
  kind: CausalNodeKind;
  locationId: string | null;
  characterId: string | null;
  powerId: string | null;
  summary: string;
  intensity: number;
  createdAt: number;
}

export interface CausalEdge {
  id: string;
  fromNode: string;
  toNode: string;
  relation: CausalRelation;
  /** 这条边是关于谁的（势力 id 或角色 id） */
  subject: string | null;
  createdAt: number;
}

export interface SightingNodeInput {
  characterId: string;
  locationId: string;
  speciesId: string;
  speciesName: string;
  /** 感知层次 —— 换算成 intensity 与摘要措辞 */
  layer: string;
  intensity: number;
  summary: string;
  /** 这次目击引发的世界事件 id（可能没有 —— 没传出去就没有） */
  rumorEventId?: string;
}

export class CausalRepo {
  #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /* ---------------- 写 ---------------- */

  /** 记一个节点。已存在（同 id）返回 false —— 重放看到的就是这个 false。 */
  addNode(node: CausalNode): boolean {
    const result = this.#db
      .prepare(
        `INSERT OR IGNORE INTO causal_nodes
           (id, kind, location_id, character_id, power_id, summary, intensity, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        node.id,
        node.kind,
        node.locationId,
        node.characterId,
        node.powerId,
        node.summary,
        clamp01(node.intensity),
        node.createdAt,
      );
    return Number(result.changes) > 0;
  }

  /** 记一条边。id 由两端拼出，所以同一对节点只会有同一条边（防重复连边）。 */
  addEdge(input: {
    fromNode: string;
    toNode: string;
    relation: CausalRelation;
    subject?: string | null;
    createdAt: number;
  }): boolean {
    const id = 'edge:' + input.relation + ':' + input.fromNode + '->' + input.toNode;
    const result = this.#db
      .prepare(
        `INSERT OR IGNORE INTO causal_edges (id, from_node, to_node, relation, subject, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.fromNode, input.toNode, input.relation, input.subject ?? null, input.createdAt);
    return Number(result.changes) > 0;
  }

  /**
   * 记一次目击，并在「传出去了」时连一条 caused 边到那条传闻。
   *
   * 返回这个目击节点 id —— 调用方拿它连势力反应。
   */
  recordSighting(
    input: SightingNodeInput & {
      at: number;
      sightingId: string;
      /**
       * M2.72：这条传闻**失真**了没有（M2.66 的 `distorted`）。
       *
       * 它决定这条边的**关系**：
       *   · 没失真 → `caused`（信息原样传出去了）
       *   · 失真   → `mutated`（信息在传出去的路上被改成了另一件事）
       *
       * 这是 `mutated` 的第一个生产者。M2.60 的迁移注释设想的例子是
       *「污染扩散 → 生物变异」（那需要一个物种变异机制，本版没有）；
       * 而「传闻失真」是**同一个语义**（A 改变了 B 的属性）在现有内容里的真实落点。
       *
       * 不传 = `caused`（与加这一条之前逐位相同）。
       */
      distorted?: boolean;
    },
  ): string {
    const nodeId = 'sighting:' + input.sightingId;
    this.addNode({
      id: nodeId,
      kind: 'sighting',
      locationId: input.locationId,
      characterId: input.characterId,
      powerId: null,
      summary: input.summary,
      intensity: input.intensity,
      createdAt: input.at,
    });
    if (input.rumorEventId !== undefined) {
      // 目击 → 传闻：这一条就是「信息怎么传出去」在因果图上的样子
      const rumorNode = 'worldevent:' + input.rumorEventId;
      this.addNode({
        id: rumorNode,
        kind: 'worldevent',
        locationId: input.locationId,
        characterId: null,
        powerId: null,
        // 失真的传闻在摘要里就写清楚 —— 因果图上「哪条消息是离谱的」要一眼看得出来
        summary:
          (input.distorted === true ? '失真传闻：' : '传闻：') +
          input.speciesName +
          '（源自一次目击）',
        intensity: input.intensity,
        createdAt: input.at,
      });
      this.addEdge({
        fromNode: nodeId,
        toNode: rumorNode,
        // M2.72：失真 → mutated（信息被改变了），没失真 → caused（与 M2.60 逐位相同）
        relation: input.distorted === true ? 'mutated' : 'caused',
        subject: input.characterId,
        createdAt: input.at,
      });
    }
    return nodeId;
  }

  /**
   * 记一条势力反应，并连一条 responded 边回它响应的那件事。
   *
   * `sourceNodeId` 是触发它的事（一次目击 / 一条世界事件）。
   * 这个参数就是 M2.60 的全部要点：**反应不再是孤立的播报，它挂在自己响应的事上。**
   */
  recordReaction(input: {
    powerId: string;
    powerName: string;
    action: string;
    sourceId: string;
    sourceNodeId: string;
    locationId: string | null;
    at: number;
  }): void {
    const nodeId = 'reaction:' + input.sourceId + ':' + input.powerId;
    this.addNode({
      id: nodeId,
      kind: 'reaction',
      locationId: input.locationId,
      characterId: null,
      powerId: input.powerId,
      summary: input.powerName + input.action,
      intensity: 0.5,
      createdAt: input.at,
    });
    this.addEdge({
      fromNode: input.sourceNodeId,
      toNode: nodeId,
      relation: 'responded',
      subject: input.powerId,
      createdAt: input.at,
    });
  }

  /** 记一条世界事件节点（灾厄 / 环境异象这类不来自目击的事件） */
  recordWorldEvent(input: {
    eventId: string;
    type: string;
    summary: string;
    intensity: number;
    at: number;
  }): string {
    const nodeId = 'worldevent:' + input.eventId;
    this.addNode({
      id: nodeId,
      kind: 'worldevent',
      locationId: null,
      characterId: null,
      powerId: null,
      summary: input.summary,
      intensity: input.intensity,
      createdAt: input.at,
    });
    return nodeId;
  }

  /* ---------------- 读（复盘用） ---------------- */

  /** 一条因果链：从某个节点出发，顺着边一直走到底（广度优先，带深度上限防环） */
  chainOf(nodeId: string, maxDepth = 5): { nodes: CausalNode[]; edges: CausalEdge[] } {
    const nodes = new Map<string, CausalNode>();
    const edges: CausalEdge[] = [];
    const start = this.node(nodeId);
    if (start === null) return { nodes: [], edges: [] };
    nodes.set(start.id, start);
    let frontier = [start.id];
    for (let depth = 0; depth < maxDepth && frontier.length > 0; depth += 1) {
      const next: string[] = [];
      for (const from of frontier) {
        for (const edge of this.edgesFrom(from)) {
          if (edges.some((existing) => existing.id === edge.id)) continue;
          edges.push(edge);
          if (!nodes.has(edge.toNode)) {
            const node = this.node(edge.toNode);
            if (node !== null) {
              nodes.set(node.id, node);
              next.push(node.id);
            }
          }
        }
      }
      frontier = next;
    }
    return { nodes: [...nodes.values()], edges };
  }

  node(id: string): CausalNode | null {
    const row = this.#db.prepare('SELECT * FROM causal_nodes WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row === undefined ? null : toNode(row);
  }

  edgesFrom(nodeId: string): CausalEdge[] {
    const rows = this.#db
      .prepare('SELECT * FROM causal_edges WHERE from_node = ? ORDER BY created_at ASC, id ASC')
      .all(nodeId) as Array<Record<string, unknown>>;
    return rows.map(toEdge);
  }

  /** 某个势力参与过的所有边（「这个势力记得什么」的最小答案） */
  edgesOfSubject(subject: string, limit = 50): CausalEdge[] {
    const rows = this.#db
      .prepare('SELECT * FROM causal_edges WHERE subject = ? ORDER BY created_at DESC LIMIT ?')
      .all(subject, limit) as Array<Record<string, unknown>>;
    return rows.map(toEdge);
  }

  countNodes(): number {
    const row = this.#db.prepare('SELECT COUNT(*) AS n FROM causal_nodes').get() as { n: number };
    return row.n;
  }

  countEdges(): number {
    const row = this.#db.prepare('SELECT COUNT(*) AS n FROM causal_edges').get() as { n: number };
    return row.n;
  }

  /** 按关系分组计数（报告用：这张图里有多少「响应」、多少「导致」） */
  countByRelation(): Record<string, number> {
    const rows = this.#db
      .prepare('SELECT relation, COUNT(*) AS n FROM causal_edges GROUP BY relation')
      .all() as Array<{ relation: string; n: number }>;
    const out: Record<string, number> = {};
    for (const row of rows) out[String(row.relation)] = Number(row.n);
    return out;
  }
}

function toNode(row: Record<string, unknown>): CausalNode {
  return {
    id: String(row['id']),
    kind: String(row['kind']) as CausalNodeKind,
    locationId: row['location_id'] === null ? null : String(row['location_id']),
    characterId: row['character_id'] === null ? null : String(row['character_id']),
    powerId: row['power_id'] === null ? null : String(row['power_id']),
    summary: String(row['summary'] ?? ''),
    intensity: Number(row['intensity'] ?? 0.5),
    createdAt: Number(row['created_at'] ?? 0),
  };
}

function toEdge(row: Record<string, unknown>): CausalEdge {
  return {
    id: String(row['id']),
    fromNode: String(row['from_node']),
    toNode: String(row['to_node']),
    relation: String(row['relation']) as CausalRelation,
    subject: row['subject'] === null ? null : String(row['subject']),
    createdAt: Number(row['created_at'] ?? 0),
  };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.min(1, Math.max(0, value));
}
