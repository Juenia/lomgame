/**
 * 并发场景（W6）：这些是封测最容易被玩家打出来的边界，必须逐条验过。
 * 每个场景都用真实 HTTP 打同一个服务进程，并直接读 SQLite 做断言。
 */
import { buildMessageEvent, reportEvent, getJson } from './client.ts';
import { dateKey } from '../infra/date.ts';
import type { TestServer } from './harness.ts';

export interface ScenarioResult {
  name: string;
  pass: boolean;
  detail: string;
}

const GROUP = '10001';

async function send(
  server: TestServer,
  input: { messageId: string; userId: string; rawText: string; scene?: 'private' | 'group' },
): Promise<boolean> {
  const event = buildMessageEvent({
    messageId: input.messageId,
    userId: input.userId,
    rawText: input.rawText,
    scene: input.scene ?? 'private',
    sceneId: GROUP,
  });
  const result = await reportEvent(server.appPort, event, 10_000, server.token);
  return result.ok;
}

function countRows(db: import('node:sqlite').DatabaseSync, sql: string, ...params: Array<string | number>): number {
  const row = db.prepare(sql).get(...params) as { n: number } | undefined;
  return row?.n ?? 0;
}

/** 场景 1：同一条 message_id 并发 10 次 → 只处理 1 次 */
export async function scenarioSameMessageId(server: TestServer, userId: string): Promise<ScenarioResult> {
  const name = '同 message_id 并发 10 次 → 只处理 1 次';
  await send(server, { messageId: `sc1-init-${userId}`, userId, rawText: '.创建 幂等测试 愚者' });
  server.onebot.take();

  const messageId = `sc1-dup-${userId}`;
  await Promise.all(
    Array.from({ length: 10 }, () => send(server, { messageId, userId, rawText: '.状态' })),
  );
  const replies = server.onebot.take().length;

  const db = server.openDb();
  try {
    const audits = countRows(db, "SELECT COUNT(*) AS n FROM audit_logs WHERE command = '状态' AND user_id = ?", userId);
    const idem = countRows(db, 'SELECT COUNT(*) AS n FROM idempotency_keys WHERE message_id = ?', `onebot:${messageId}`);
    const pass = replies === 1 && audits === 1 && idem === 1;
    return {
      name,
      pass,
      detail: `回复 ${replies} 条（期望 1）、审计 ${audits} 条（期望 1）、幂等键 ${idem} 条（期望 1）`,
    };
  } finally {
    db.close();
  }
}

/** 场景 2：同一条晋升消息并发 2 次 → 只扣 1 次材料 */
export async function scenarioPromotionNoDoubleDeduct(
  server: TestServer,
  userId: string,
): Promise<ScenarioResult> {
  const name = '同一条晋升消息并发 2 次 → 只扣 1 次材料';
  await send(server, { messageId: `sc2-init-${userId}`, userId, rawText: '.创建 晋升测试 愚者' });

  const db = server.openDb();
  try {
    const character = db.prepare('SELECT id FROM characters WHERE user_id = ?').get(userId) as
      | { id: string }
      | undefined;
    if (!character) return { name, pass: false, detail: '建号失败' };
    const id = character.id;
    // 直接铺好晋升前置条件（这一步是测试准备，不走指令）
    db.prepare('UPDATE characters SET dig = 100, mad = 0, cor = 0 WHERE id = ?').run(id);
    db.prepare('INSERT OR REPLACE INTO flags (character_id, flag, value, created_at) VALUES (?, ?, NULL, ?)').run(
      id,
      'ability_seer_9',
      Date.now(),
    );
    db.prepare(
      'INSERT OR REPLACE INTO inventory (character_id, item_id, bind_type, quantity, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run(id, '主材料·灰雾结晶', 'unbound', 4, Date.now());
  } finally {
    db.close();
  }

  const messageId = `sc2-promote-${userId}`;
  await Promise.all([
    send(server, { messageId, userId, rawText: '.晋升' }),
    send(server, { messageId, userId, rawText: '.晋升' }),
  ]);

  const check = server.openDb();
  try {
    const remaining = countRows(
      check,
      'SELECT COALESCE(SUM(quantity), 0) AS n FROM inventory WHERE item_id = ? AND character_id = (SELECT id FROM characters WHERE user_id = ?)',
      '主材料·灰雾结晶',
      userId,
    );
    const attempts = countRows(
      check,
      "SELECT COUNT(*) AS n FROM domain_events WHERE type IN ('promotion_success','promotion_fail')",
    );
    // 材料 ×2 = 一次晋升尝试的消耗；两次并发只应发生一次
    const pass = remaining === 2 && attempts === 1;
    return {
      name,
      pass,
      detail: `剩余材料 ${remaining}（期望 2 = 只扣一次×2）、晋升判定 ${attempts} 次（期望 1）`,
    };
  } finally {
    check.close();
  }
}

/**
 * 场景 3：同一条探索消息并发 2 次 → 只结算 1 次；不同消息并发 2 次 → 各结算 1 次
 * （证明是串行而不是丢单）。
 *
 * ⚠️ M2.85：行动值（AP）整体移除 —— 观测量换成 `explore_daily` 的探索次数。
 * 每地点每天上限 3 次，所以两条不同消息用**同城的两个地点**（都留在上限以内）。
 */
export async function scenarioExploreOnce(server: TestServer, userId: string): Promise<ScenarioResult> {
  const name = '同一条探索消息并发 2 次 → 只结算 1 次（不同消息则各结算 1 次）';
  await send(server, { messageId: `sc3-init-${userId}`, userId, rawText: '.创建 探索测试 愚者' });

  const readExplores = (): number => {
    const db = server.openDb();
    try {
      const row = db
        .prepare(
          `SELECT COALESCE(SUM(count), 0) AS n FROM explore_daily
           WHERE character_id = (SELECT id FROM characters WHERE user_id = ?)`,
        )
        .get(userId) as { n: number } | undefined;
      return row?.n ?? 0;
    } finally {
      db.close();
    }
  };

  const before = readExplores();
  const messageId = `sc3-dup-${userId}`;
  await Promise.all([
    send(server, { messageId, userId, rawText: '.探索 廷根市' }),
    send(server, { messageId, userId, rawText: '.探索 廷根市' }),
  ]);
  const afterDuplicate = readExplores();

  await Promise.all([
    send(server, { messageId: `sc3-a-${userId}`, userId, rawText: '.探索 廷根市' }),
    send(server, { messageId: `sc3-b-${userId}`, userId, rawText: '.探索 迷雾街区' }),
  ]);
  const afterTwoDistinct = readExplores();

  const pass = afterDuplicate - before === 1 && afterTwoDistinct - afterDuplicate === 2;
  return {
    name,
    pass,
    detail: `探索次数 ${before} → ${afterDuplicate}（重复消息只结算 1）→ ${afterTwoDistinct}（两条不同消息各结算 1）`,
  };
}

/** 场景 4：交易双方同时确认 → 只成交 1 次 */
export async function scenarioTradeDoubleConfirm(
  server: TestServer,
  sellerId: string,
  buyerId: string,
): Promise<ScenarioResult> {
  const name = '同一笔交易并发确认 2 次 → 只成交 1 次';
  await send(server, { messageId: `sc4-s-${sellerId}`, userId: sellerId, rawText: '.创建 卖家 愚者' });
  await send(server, { messageId: `sc4-b-${buyerId}`, userId: buyerId, rawText: '.创建 买家 战士' });

  const db = server.openDb();
  let tradeId = '';
  try {
    const seller = db.prepare('SELECT id FROM characters WHERE user_id = ?').get(sellerId) as { id: string };
    const buyer = db.prepare('SELECT id FROM characters WHERE user_id = ?').get(buyerId) as { id: string };
    db.prepare(
      'INSERT OR REPLACE INTO inventory (character_id, item_id, bind_type, quantity, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run(seller.id, '辅助材料·银粉', 'unbound', 1, Date.now());
    db.prepare(
      'INSERT OR REPLACE INTO inventory (character_id, item_id, bind_type, quantity, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run(buyer.id, '便士', 'unbound', 500, Date.now());
  } finally {
    db.close();
  }

  server.onebot.take();
  await send(server, { messageId: `sc4-trade-${sellerId}`, userId: sellerId, rawText: `.交易 @${buyerId} 辅助材料·银粉 1 100` });
  const outbound = server.onebot.take();
  const buyNotice = outbound.find((message) => message.path === 'send_private_msg' && String(message.body.user_id) === buyerId);
  tradeId = /单号：(\w{6})/.exec(String(buyNotice?.body.message ?? ''))?.[1] ?? '';
  if (!tradeId) return { name, pass: false, detail: '没能从买家通知里取到单号' };

  const confirmId = `sc4-confirm-${buyerId}`;
  await Promise.all([
    send(server, { messageId: confirmId, userId: buyerId, rawText: `.确认 ${tradeId}` }),
    send(server, { messageId: `${confirmId}-b`, userId: buyerId, rawText: `.确认 ${tradeId}` }),
  ]);

  const check = server.openDb();
  try {
    const sellerGold = countRows(
      check,
      'SELECT COALESCE(SUM(quantity),0) AS n FROM inventory WHERE item_id = ? AND character_id = (SELECT id FROM characters WHERE user_id = ?)',
      '便士',
      sellerId,
    );
    const buyerGold = countRows(
      check,
      'SELECT COALESCE(SUM(quantity),0) AS n FROM inventory WHERE item_id = ? AND character_id = (SELECT id FROM characters WHERE user_id = ?)',
      '便士',
      buyerId,
    );
    const buys = countRows(check, "SELECT COUNT(*) AS n FROM domain_events WHERE type = 'trade_buy'");
    const status = (
      check.prepare('SELECT status FROM trades WHERE id = ?').get(tradeId) as { status: string } | undefined
    )?.status;
    const pass = sellerGold === 95 && buyerGold === 400 && buys === 1 && status === 'completed';
    return {
      name,
      pass,
      detail: `卖家金镑 ${sellerGold}（期望 95）、买家 ${buyerGold}（期望 400）、成交事件 ${buys} 次（期望 1）、状态 ${status}`,
    };
  } finally {
    check.close();
  }
}

/** 场景 5：每日结算与玩家指令并发 → 结算幂等 */
export async function scenarioTickIdempotentDuringLoad(
  server: TestServer,
  userIds: string[],
  adminToken: string,
): Promise<ScenarioResult> {
  const name = '每日结算与玩家指令并发 → 结算只生效一次';

  // 先把当天已结算的记录删掉，模拟「当天还没结算」，这样两个并发触发里必然只有一个能抢到
  const setup = server.openDb();
  const date = dateKey(Date.now());
  try {
    setup.prepare('DELETE FROM daily_ticks WHERE date = ?').run(date);
  } finally {
    setup.close();
  }

  const tick = async (): Promise<Record<string, unknown>> => {
    const response = await fetch(`http://127.0.0.1:${server.appPort}/admin/tick`, {
      method: 'POST',
      headers: { 'x-admin-token': adminToken },
    });
    return (await response.json()) as Record<string, unknown>;
  };

  const [first, second] = await Promise.all([
    tick(),
    (async () => {
      // 与结算同时打一批玩家指令
      await Promise.all(
        userIds.map((userId, index) =>
          send(server, { messageId: `sc5-${userId}-${index}`, userId, rawText: '.状态' }),
        ),
      );
      return tick();
    })(),
  ]);

  const summaryA = first.summary as { skipped?: boolean } | undefined;
  const summaryB = second.summary as { skipped?: boolean } | undefined;
  const executed = [summaryA?.skipped === false, summaryB?.skipped === false].filter(Boolean).length;

  const db = server.openDb();
  try {
    const rows = countRows(db, 'SELECT COUNT(*) AS n FROM daily_ticks WHERE date = ?', date);
    const pass = executed === 1 && rows === 1;
    return {
      name,
      pass,
      detail: `两次并发触发里实际执行 ${executed} 次（期望 1）、daily_ticks 记录 ${rows} 条（期望 1）`,
    };
  } finally {
    db.close();
  }
}
