/**
 * 服务器开关（M2.172）—— 管理员指令改的就是它。
 *
 * ## 三个开关，一个形状
 *
 *   game       游戏本身：关掉之后群里发什么都不会进判定层（管理员指令除外）
 *   push       主动推送：世界自身在说话（天气异象、世界事件）
 *   push_event 主动事件推送：与某个玩家直接相关的主动通知（失控、结算提醒）
 *
 * 每一个都有**全局**与**本群**两层：本群没设过就跟随全局，设过就按本群的来。
 * 「跟随」这一档是必需的 —— 没有它，运营把全局关掉之后，
 * 之前单独开过的群会显得「不听全局的话」，而那是另一回事。
 *
 * ## 为什么不每次查库
 *
 * `game` 这一档要在**每一条消息**上判断（群消息量最大），查库是纯浪费。
 * 表很小（最多 3 × 群数 行），启动时全量读进内存，写的时候同步更新缓存。
 */
import type { Db } from './sqlite.ts';

export const SWITCH_KEYS = ['game', 'push', 'push_event'] as const;
export type SwitchKey = (typeof SWITCH_KEYS)[number];

/** 中文名 —— 加一个开关而没补中文名，tsc 直接红（AGENTS §3.8） */
export const SWITCH_LABELS: Record<SwitchKey, string> = {
  game: '游戏',
  push: '主动推送',
  push_event: '主动事件推送',
};

export interface SwitchSnapshotRow {
  key: SwitchKey;
  /** 全局那一行 */
  global: boolean;
  /** 本群覆盖：键是群号，值是该群的设定（没有这个群就是跟随全局） */
  scenes: Record<string, boolean>;
}

function isSwitchKey(value: string): value is SwitchKey {
  return (SWITCH_KEYS as readonly string[]).includes(value);
}

export class ServerSwitchRepo {
  /**
   * 仓储是可选的：**不传就是纯内存**（不落库）。
   *
   * 为什么要这一档：RouterDeps 里这个字段一旦写成必需，全仓 100 多处构造点
   * （测试夹具、模拟器、建号脚本）都要跟着改一遍 —— 而它们一个都不关心开关。
   * 生产路径一定传 db（否则重启就丢），测试路径不传即可。
   */
  #db: Db | null;
  /** 内存镜像：键是 `key \u0000 sceneId`，sceneId 为空串表示全局 */
  #cache = new Map<string, boolean>();

  constructor(db?: Db | null) {
    this.#db = db ?? null;
    if (this.#db !== null) this.#load();
  }

  #load(): void {
    if (this.#db === null) return;
    const rows = this.#db
      .prepare('SELECT key, scene_id, value FROM server_switches')
      .all() as unknown as Array<{ key: string; scene_id: string; value: number }>;
    for (const row of rows) {
      if (!isSwitchKey(row.key)) continue;
      this.#cache.set(this.#cacheKey(row.key, row.scene_id), row.value !== 0);
    }
  }

  #cacheKey(key: SwitchKey, sceneId: string): string {
    return key + '\u0000' + sceneId;
  }

  /** 全局值。没写过就是**开**（新增开关不许改变既有行为） */
  globalOf(key: SwitchKey): boolean {
    return this.#cache.get(this.#cacheKey(key, '')) ?? true;
  }

  /** 本群有没有单独设过（设过才有值） */
  sceneOf(key: SwitchKey, sceneId: string): boolean | null {
    const value = this.#cache.get(this.#cacheKey(key, sceneId));
    return value === undefined ? null : value;
  }

  /**
   * 这个开关现在是不是开着的。
   *
   * `sceneId` 给空 ⇒ 只问全局；给了群号 ⇒ 本群覆盖优先，没设过就跟随全局。
   */
  isOn(key: SwitchKey, sceneId?: string | null): boolean {
    if (sceneId !== undefined && sceneId !== null && sceneId !== '') {
      const scene = this.sceneOf(key, sceneId);
      if (scene !== null) return scene;
    }
    return this.globalOf(key);
  }

  /** 写一行。`sceneId` 给 null / 空串 = 写全局那行 */
  set(key: SwitchKey, sceneId: string | null, on: boolean, now: number): void {
    const scope = sceneId ?? '';
    this.#db
      ?.prepare(
        'INSERT INTO server_switches (key, scene_id, value, updated_at) VALUES (?, ?, ?, ?) \n' +
          'ON CONFLICT(key, scene_id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      )
      .run(key, scope, on ? 1 : 0, now);
    this.#cache.set(this.#cacheKey(key, scope), on);
  }

  /** 删掉本群的覆盖行 ⇒ 这个群恢复跟随全局 */
  clearScene(key: SwitchKey, sceneId: string): void {
    this.#db?.prepare('DELETE FROM server_switches WHERE key = ? AND scene_id = ?').run(key, sceneId);
    this.#cache.delete(this.#cacheKey(key, sceneId));
  }

  /** 后台与状态指令要看的一览 */
  snapshot(): SwitchSnapshotRow[] {
    const scenes: Record<SwitchKey, Record<string, boolean>> = { game: {}, push: {}, push_event: {} };
    for (const [cacheKey, value] of this.#cache) {
      const [key, sceneId] = cacheKey.split('\u0000');
      if (key === undefined || sceneId === undefined) continue;
      if (!isSwitchKey(key) || sceneId === '') continue;
      scenes[key][sceneId] = value;
    }
    return SWITCH_KEYS.map((key) => ({ key, global: this.globalOf(key), scenes: scenes[key] }));
  }
}
