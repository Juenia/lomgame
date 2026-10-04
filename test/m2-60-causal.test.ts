/**
 * M2.60：因果日志（causal_nodes / causal_edges）。
 *
 * 这一份守的是「谁导致了谁」这件事第一次能被回答：
 *
 *   1. 节点与边的 **id 由来源拼出** —— 重放同一个事件得到同一个节点（幂等）；
 *   2. 同一对节点**只会有同一条边**（防重复连边）；
 *   3. 目击传出去时连一条 `caused` 边到传闻（信息怎么传出去）；
 *   4. 势力反应连一条 `responded` 边回它响应的事（谁对什么动了手）；
 *   5. `chainOf` 能顺着边走完整条链（复盘的全部意义）；
 *   6. 链会终止（带深度上限，不会被环卡死）。
 *
 * 第 1、2 两条是补跑安全的基础：调度器会重放同一小时，
 * 如果重放产生新节点，那么「同一张因果图」在补跑之后会变成两张。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CausalRepo } from '../src/infra/causal-log.ts';
import { migrate, openDatabase, type Db } from '../src/infra/db/sqlite.ts';

function freshDb(): Db {
  const db = openDatabase(':memory:');
  migrate(db);
  return db;
}

const AT = 1_700_000_000_000;

function sighting(repo: CausalRepo, id: string, rumorEventId?: string): string {
  return repo.recordSighting({
    sightingId: id,
    characterId: 'c1',
    locationId: 'old_dock',
    speciesId: 'whisperer',
    speciesName: '低语者',
    layer: 'full',
    intensity: 0.5,
    summary: '测试者在老码头看见了低语者',
    ...(rumorEventId === undefined ? {} : { rumorEventId }),
    at: AT,
  });
}

/* ================================================================== *
 * 一、幂等：重放安全
 * ================================================================== */

test('M2.60 因果：节点 id 由来源拼出 —— 重放同一次目击不会产生第二个节点', () => {
  const db = freshDb();
  try {
    const repo = new CausalRepo(db);
    const first = sighting(repo, 's1');
    const second = sighting(repo, 's1');
    assert.equal(first, second, '同一个 sightingId 必须得到同一个节点 id');
    assert.equal(repo.countNodes(), 1, '重放之后仍然只有一个节点');
  } finally {
    db.close();
  }
});

test('M2.60 因果：同一对节点只会有同一条边（防重复连边）', () => {
  const db = freshDb();
  try {
    const repo = new CausalRepo(db);
    const from = sighting(repo, 's1');
    repo.recordReaction({
      powerId: 'church', powerName: '教会', action: '开始了净化',
      sourceId: 's1', sourceNodeId: from, locationId: 'old_dock', at: AT,
    });
    // 重复记同一条反应（补跑会这样）
    repo.recordReaction({
      powerId: 'church', powerName: '教会', action: '开始了净化',
      sourceId: 's1', sourceNodeId: from, locationId: 'old_dock', at: AT,
    });
    assert.equal(repo.countEdges(), 1, '同一条边不该被记两次');
    assert.equal(repo.countNodes(), 2, '一次目击 + 一次反应 = 两个节点');
  } finally {
    db.close();
  }
});

test('M2.60 因果：addNode / addEdge 用返回值告诉调用方「是不是新写的」', () => {
  const db = freshDb();
  try {
    const repo = new CausalRepo(db);
    const node = {
      id: 'x', kind: 'sighting' as const, locationId: null, characterId: null,
      powerId: null, summary: 's', intensity: 0.5, createdAt: AT,
    };
    assert.equal(repo.addNode(node), true, '第一次写应当返回 true');
    assert.equal(repo.addNode(node), false, '第二次写应当返回 false（重放看的就是这个）');
  } finally {
    db.close();
  }
});

/* ================================================================== *
 * 二、两条真实的边
 * ================================================================== */

test('M2.60 因果：目击传出去时连一条 caused 边到传闻', () => {
  const db = freshDb();
  try {
    const repo = new CausalRepo(db);
    const from = sighting(repo, 's1', 'rumor:sighting:s1');
    const edges = repo.edgesFrom(from);
    assert.equal(edges.length, 1, '应当有且只有一条边');
    assert.equal(edges[0]!.relation, 'caused');
    assert.equal(edges[0]!.toNode, 'worldevent:rumor:sighting:s1');
    assert.equal(edges[0]!.subject, 'c1', '这条边是关于那个报信的人的');
    // 传闻那一端也要有节点，否则边上挂着的是悬空引用
    assert.ok(repo.node('worldevent:rumor:sighting:s1') !== null, '边的另一端必须有节点');
  } finally {
    db.close();
  }
});

test('M2.60 因果：目击没传出去时只有节点、没有边', () => {
  const db = freshDb();
  try {
    const repo = new CausalRepo(db);
    const from = sighting(repo, 's1');
    assert.equal(repo.countNodes(), 1, '目击本身仍然是一个节点');
    assert.equal(repo.edgesFrom(from).length, 0, '没传出去就没有 caused 边');
  } finally {
    db.close();
  }
});

test('M2.60 因果：势力反应连一条 responded 边回它响应的事', () => {
  const db = freshDb();
  try {
    const repo = new CausalRepo(db);
    const from = sighting(repo, 's1');
    repo.recordReaction({
      powerId: 'church', powerName: '教会', action: '开始了净化',
      sourceId: 's1', sourceNodeId: from, locationId: 'old_dock', at: AT,
    });
    const edges = repo.edgesFrom(from);
    assert.equal(edges.length, 1);
    assert.equal(edges[0]!.relation, 'responded', '响应是 responded，不是 caused');
    assert.equal(edges[0]!.subject, 'church', '这条边是关于教会的');
    const reaction = repo.node(edges[0]!.toNode);
    assert.ok(reaction !== null);
    assert.equal(reaction.kind, 'reaction');
    assert.equal(reaction.powerId, 'church');
  } finally {
    db.close();
  }
});

/* ================================================================== *
 * 三、复盘：走完整条链
 * ================================================================== */

test('M2.60 因果：一条链能走完 —— 目击 → 传闻 + 目击 → 势力反应', () => {
  const db = freshDb();
  try {
    const repo = new CausalRepo(db);
    const from = sighting(repo, 's1', 'rumor:sighting:s1');
    repo.recordReaction({
      powerId: 'church', powerName: '教会', action: '开始了净化',
      sourceId: 's1', sourceNodeId: from, locationId: 'old_dock', at: AT,
    });
    repo.recordReaction({
      powerId: 'police', powerName: '警察厅', action: '封锁了现场',
      sourceId: 's1', sourceNodeId: from, locationId: 'old_dock', at: AT,
    });
    const chain = repo.chainOf(from);
    assert.equal(chain.nodes.length, 4, '一次目击 + 一条传闻 + 两家势力 = 四个节点');
    assert.equal(chain.edges.length, 3, '三条边：一条 caused + 两条 responded');
    const kinds = chain.nodes.map((node) => node.kind).sort();
    assert.deepEqual(kinds, ['reaction', 'reaction', 'sighting', 'worldevent']);
  } finally {
    db.close();
  }
});

test('M2.60 因果：链会终止 —— 环与深链都不会把它卡死', () => {
  const db = freshDb();
  try {
    const repo = new CausalRepo(db);
    // 人工造一个环：A → B → A
    for (const id of ['a', 'b']) {
      repo.addNode({
        id, kind: 'worldevent', locationId: null, characterId: null,
        powerId: null, summary: id, intensity: 0.5, createdAt: AT,
      });
    }
    repo.addEdge({ fromNode: 'a', toNode: 'b', relation: 'caused', createdAt: AT });
    repo.addEdge({ fromNode: 'b', toNode: 'a', relation: 'caused', createdAt: AT });
    const chain = repo.chainOf('a');
    assert.ok(chain.nodes.length <= 2, '环不该让节点被反复收集：' + chain.nodes.length);
    assert.ok(chain.edges.length <= 2, '环不该让边被反复收集：' + chain.edges.length);
  } finally {
    db.close();
  }
});

test('M2.60 因果：查不存在的节点返回空链，不抛', () => {
  const db = freshDb();
  try {
    const repo = new CausalRepo(db);
    assert.equal(repo.node('不存在'), null);
    assert.deepEqual(repo.chainOf('不存在'), { nodes: [], edges: [] });
    assert.deepEqual(repo.edgesFrom('不存在'), []);
  } finally {
    db.close();
  }
});

test('M2.60 因果：按 subject 能查「某个势力记得什么」', () => {
  const db = freshDb();
  try {
    const repo = new CausalRepo(db);
    const a = sighting(repo, 's1');
    const b = sighting(repo, 's2');
    repo.recordReaction({
      powerId: 'church', powerName: '教会', action: '开始了净化',
      sourceId: 's1', sourceNodeId: a, locationId: 'old_dock', at: AT,
    });
    repo.recordReaction({
      powerId: 'police', powerName: '警察厅', action: '封锁了现场',
      sourceId: 's2', sourceNodeId: b, locationId: 'old_dock', at: AT + 1,
    });
    const churchEdges = repo.edgesOfSubject('church');
    assert.equal(churchEdges.length, 1, '教会只参与过一次');
    assert.equal(churchEdges[0]!.subject, 'church');
    assert.equal(repo.countByRelation()['responded'], 2, '两条 responded 边');
  } finally {
    db.close();
  }
});

test('M2.60 因果：世界事件也能建节点（灾厄这类不来自目击的）', () => {
  const db = freshDb();
  try {
    const repo = new CausalRepo(db);
    const id = repo.recordWorldEvent({
      eventId: 'calamity:123', type: 'calamity', summary: '雾魇压下来了', intensity: 0.8, at: AT,
    });
    assert.equal(id, 'worldevent:calamity:123');
    const node = repo.node(id);
    assert.ok(node !== null);
    assert.equal(node.kind, 'worldevent');
    assert.equal(node.intensity, 0.8);
    // 幂等：同一条世界事件重放得到同一个节点
    repo.recordWorldEvent({
      eventId: 'calamity:123', type: 'calamity', summary: '雾魇压下来了', intensity: 0.8, at: AT,
    });
    assert.equal(repo.countNodes(), 1);
  } finally {
    db.close();
  }
});
