import type { Db } from './sqlite.ts';

export type TradeStatus = 'pending' | 'completed' | 'cancelled' | 'expired';

export interface TradeRow {
  id: string;
  sellerId: string;
  buyerId: string;
  itemId: string;
  qty: number;
  /**
   * 成交价，单位**便士**（M2.5 追加的三层货币：内部一律最小单位整数）。
   * 显示层用 formatCurrency 换算成「X 金镑 Y 苏勒 Z 便士」。
   */
  price: number;
  /** 系统抽走的税，单位便士 */
  tax: number;
  status: TradeStatus;
  createdAt: number;
  confirmedAt: number | null;
  /** W4 设备指纹钩子；OneBot 拿不到设备信息时为空 */
  deviceKey?: string | null;
}

/**
 * trades：交易单。物品在创建时即冻结（从卖家可用栏位移出），取消/超时解冻。
 *
 * M2.5 追加：金额列有两套 —— `price_penny` / `tax_penny` 是新口径（单位便士），
 * `price` / `tax` 是旧列（**保留不删**，迁移期两种都能读）。写入时两套一起写，
 * 读取时以新列为准、旧列兜底 —— 这样一个版本之后可以直接删旧列，回滚也不难。
 */
export class TradeRepo {
  #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  insert(row: TradeRow): void {
    this.#db
      .prepare(
        `INSERT INTO trades
           (id, seller_id, buyer_id, item_id, qty, price, tax, status, created_at, confirmed_at, device_key,
            price_penny, tax_penny)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.sellerId,
        row.buyerId,
        row.itemId,
        row.qty,
        row.price,
        row.tax,
        row.status,
        row.createdAt,
        row.confirmedAt,
        row.deviceKey ?? null,
        // 新列与旧列同时写：单位都是便士，值完全相同
        row.price,
        row.tax,
      );
  }

  getById(id: string): TradeRow | null {
    const row = this.#db.prepare('SELECT * FROM trades WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? toTrade(row) : null;
  }

  findPendingFor(buyerId: string): TradeRow[] {
    const rows = this.#db
      .prepare("SELECT * FROM trades WHERE buyer_id = ? AND status = 'pending' ORDER BY created_at ASC")
      .all(buyerId) as Array<Record<string, unknown>>;
    return rows.map(toTrade);
  }

  listPending(): TradeRow[] {
    const rows = this.#db
      .prepare("SELECT * FROM trades WHERE status = 'pending' ORDER BY created_at ASC")
      .all() as Array<Record<string, unknown>>;
    return rows.map(toTrade);
  }

  updateStatus(id: string, status: TradeStatus, confirmedAt: number | null, tax?: number): void {
    this.#db
      .prepare(
        `UPDATE trades
         SET status = ?, confirmed_at = ?,
             tax = COALESCE(?, tax), tax_penny = COALESCE(?, tax_penny)
         WHERE id = ?`,
      )
      .run(status, confirmedAt, tax ?? null, tax ?? null, id);
  }

  /** 该角色发起且仍待确认的单数（防刷） */
  pendingCountOf(sellerId: string): number {
    const row = this.#db
      .prepare("SELECT COUNT(*) AS n FROM trades WHERE seller_id = ? AND status = 'pending'")
      .get(sellerId) as { n: number };
    return row.n;
  }

  /**
   * 该角色自 since 起的交易额（作为买家或卖家、已完成的单），单位便士。
   * 注意：W3 没有 IP/设备信息，这里按账号维度统计（见 W3 交付说明的偏差登记）。
   */
  volumeSince(characterId: string, since: number): number {
    const row = this.#db
      .prepare(
        `SELECT COALESCE(SUM(COALESCE(price_penny, price)), 0) AS total FROM trades
         WHERE status = 'completed' AND created_at >= ? AND (seller_id = ? OR buyer_id = ?)`,
      )
      .get(since, characterId, characterId) as { total: number };
    return row.total;
  }

  /**
   * 同一设备指纹在窗口内的交易额（W4 钩子），单位便士。
   * OneBot 上报没有设备信息，因此线上目前恒为 0；官方机器人接入后即可生效。
   */
  volumeSinceDevice(deviceKey: string, since: number): number {
    const row = this.#db
      .prepare(
        `SELECT COALESCE(SUM(COALESCE(price_penny, price)), 0) AS total FROM trades
         WHERE status = 'completed' AND created_at >= ? AND device_key = ?`,
      )
      .get(since, deviceKey) as { total: number };
    return row.total;
  }

  listByUser(characterId: string, limit = 10): TradeRow[] {
    const rows = this.#db
      .prepare(
        'SELECT * FROM trades WHERE seller_id = ? OR buyer_id = ? ORDER BY created_at DESC LIMIT ?',
      )
      .all(characterId, characterId, limit) as Array<Record<string, unknown>>;
    return rows.map(toTrade);
  }

  count(): number {
    const row = this.#db.prepare('SELECT COUNT(*) AS n FROM trades').get() as { n: number };
    return row.n;
  }
}

function toTrade(row: Record<string, unknown>): TradeRow {
  // 新列优先、旧列兜底：老存档里 price_penny 可能是默认值 0
  const penny = (newKey: string, oldKey: string): number => {
    const fresh = row[newKey];
    if (fresh !== null && fresh !== undefined && Number(fresh) > 0) return Number(fresh);
    return Number(row[oldKey] ?? 0);
  };
  return {
    id: String(row.id),
    sellerId: String(row.seller_id),
    buyerId: String(row.buyer_id),
    itemId: String(row.item_id),
    qty: Number(row.qty),
    price: penny('price_penny', 'price'),
    tax: penny('tax_penny', 'tax'),
    status: String(row.status) as TradeStatus,
    deviceKey: row.device_key === null || row.device_key === undefined ? null : String(row.device_key),
    createdAt: Number(row.created_at),
    confirmedAt: row.confirmed_at === null || row.confirmed_at === undefined ? null : Number(row.confirmed_at),
  };
}
