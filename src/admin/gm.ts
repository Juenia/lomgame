/**
 * GM 管理（M2.50）—— 服务端。
 *
 * ## 三条原则
 *
 * 1. **改玩家一律走 CharacterRepo.update()，不写裸 UPDATE。**
 *    update() 会写全部列。绕开它去 UPDATE 单列看着更精准，实际上很容易出「读库完全看不出来」
 *    的丢列事故 —— current_city_id 和 church_id 都在 update() 的注释里各记过一次同样的账。
 * 2. **能钳就钳，不能钳就明说。** GM 需要能越界（这就是 GM 工具的意义），但越界必须显式
 *    警告出来，不能悄悄接受。普通人的 MAD/COR 上限（20/10）低于失控闸门，这是「普通人
 *    不可能失控」这条前提的来源，而判定层直接依赖它。
 * 3. **每一次写入都进 audit_logs。** 后台能改玩家数值，改了什么、改成什么必须留痕。
 *
 * ## 为什么 setStatus 只给四个状态
 *
 * characters.status 有七个取值，但 promoting / in_battle / trading 是**过渡态**：它们由
 * 具体玩法在开始时写入、结束时清掉。手写进去之后没有任何流程会来清它，玩家就永久卡在
 * 「晋升中」—— 界面上看着只是一个下拉框选错了，代价是那张卡废掉。所以只暴露真正的
 * 终态：正常 / 重伤 / 失控 / 封禁。
 */
import { NUMERIC } from '../config/numeric.ts';
import { sequenceTitle } from '../card/titles.ts';
import { PATHWAY_LABELS, clamp, lossOfControlThresholdFor } from '../domain/character/rules.ts';
import type { CharacterState, CharacterStatus, PathwayId } from '../domain/character/types.ts';
import type { BindType } from '../domain/item/bind.ts';
import { AuditLog } from '../infra/audit.ts';
import { dateKey } from '../infra/date.ts';
import { CharacterRepo } from '../infra/db/characters.ts';
import { DailyCounterRepo } from '../infra/db/daily-counters.ts';
import { CityRepo, RouteRepo, TravelRepo } from '../infra/db/geo.ts';
import { InventoryRepo } from '../infra/db/inventory.ts';
import { ItemRepo } from '../infra/db/items.ts';
import { LostControlRepo } from '../infra/db/lost-control-events.ts';
import { PowerRelationRepo } from '../infra/db/power-state.ts';
import { loadPowers } from '../data/loader.ts';
import type { Db } from '../infra/db/sqlite.ts';

const OPERATOR = 'admin';

/* ------------------------------------------------------------------ */
/* 属性                                                                */
/* ------------------------------------------------------------------ */

export const STAT_KEYS = ['hp', 'mp', 'mad', 'cor', 'dig', 'dp'] as const;
export type StatKey = (typeof STAT_KEYS)[number];

/** 上下界与中文名。**只此一处**，服务端校验和前端控件都从这里来 */
export const STAT_BOUNDS: Record<StatKey, { min: number; max: number; label: string }> = {
  hp: { min: 0, max: 100, label: '生命 HP' },
  mp: { min: 0, max: 100, label: '灵性 MP' },
  mad: { min: 0, max: 100, label: '疯狂 MAD' },
  cor: { min: 0, max: 100, label: '污染 COR' },
  dig: { min: 0, max: 100, label: '魔药消化度 DIG' },
  dp: { min: 0, max: 10, label: '命运点 DP' },
};

/**
 * 可手改的状态。过渡态（晋升中 / 战斗中 / 交易中）**故意不给** —— 见文件头。
 */
export const SETTABLE_STATUS: ReadonlyArray<{ id: CharacterStatus; label: string }> = [
  { id: 'active', label: '正常' },
  { id: 'injured', label: '重伤' },
  { id: 'lost_control', label: '失控' },
  { id: 'banned', label: '封禁' },
];

const STATUS_LABEL: Record<string, string> = {
  active: '正常',
  injured: '重伤',
  lost_control: '失控',
  promoting: '晋升中',
  in_battle: '战斗中',
  trading: '交易中',
  banned: '封禁',
};

const BIND_LABEL: Record<string, string> = { bound: '已绑定', unbound: '未绑定' };

/* ------------------------------------------------------------------ */
/* 返回类型                                                            */
/* ------------------------------------------------------------------ */

export type GmResult =
  | { ok: true; message: string; warnings: string[] }
  | { ok: false; error: string };

const fail = (error: string): GmResult => ({ ok: false, error });
const done = (message: string, warnings: string[] = []): GmResult => ({ ok: true, message, warnings });

/* ------------------------------------------------------------------ */
/* 查询                                                                */
/* ------------------------------------------------------------------ */

export interface GmStats {
  characters: number;
  users: number;
  active: number;
  injured: number;
  lostControl: number;
  banned: number;
  mortal: number;
  initiated: number;
  lostControlToday: number;
}

export function gmStats(db: Db, now = Date.now()): GmStats {
  const one = (sql: string, ...params: Array<string | number>): number =>
    (db.prepare(sql).get(...params) as { n: number }).n;
  return {
    characters: one('SELECT COUNT(*) AS n FROM characters'),
    users: one('SELECT COUNT(*) AS n FROM users'),
    active: one("SELECT COUNT(*) AS n FROM characters WHERE status = 'active'"),
    injured: one("SELECT COUNT(*) AS n FROM characters WHERE status = 'injured'"),
    lostControl: one("SELECT COUNT(*) AS n FROM characters WHERE status = 'lost_control'"),
    banned: one("SELECT COUNT(*) AS n FROM characters WHERE status = 'banned'"),
    mortal: one("SELECT COUNT(*) AS n FROM characters WHERE pathway_status = 'mortal'"),
    initiated: one("SELECT COUNT(*) AS n FROM characters WHERE pathway_status = 'initiated'"),
    lostControlToday: one('SELECT COUNT(*) AS n FROM lost_control_events WHERE date = ?', dateKey(now)),
  };
}

export interface GmPlayer {
  characterId: string;
  userId: string;
  qqId: string;
  nickname: string;
  name: string;
  pathway: string | null;
  pathwayLabel: string;
  sequence: number | null;
  sequenceLabel: string;
  pathwayStatus: string;
  status: string;
  statusLabel: string;
  hp: number;
  mp: number;
  mad: number;
  cor: number;
  dig: number;
  dp: number;
  cityId: string | null;
  cityName: string;
  updatedAt: number;
}

interface PlayerRow extends Record<string, unknown> {
  id: string;
  user_id: string;
  name: string;
  pathway: string | null;
  sequence: number | null;
  pathway_status: string | null;
  status: string;
  hp: number;
  mp: number;
  mad: number;
  cor: number;
  dig: number;
  dp: number;
  current_city_id: string | null;
  updated_at: number;
  qq_id?: string | null;
  nickname?: string | null;
}

function toPlayer(row: PlayerRow, cityName: string): GmPlayer {
  const pathway = (row.pathway as PathwayId | null) ?? null;
  const sequence = row.sequence ?? null;
  return {
    characterId: row.id,
    userId: row.user_id,
    qqId: row.qq_id ?? row.user_id,
    nickname: row.nickname ?? '',
    name: row.name,
    pathway,
    // 英文 id 一律换成中文：GM 不该为了改一个数去记 sailor 是「水手」
    pathwayLabel: pathway ? (PATHWAY_LABELS[pathway] ?? pathway) : '（普通人）',
    sequence,
    sequenceLabel:
      pathway !== null && sequence !== null ? sequenceTitle(pathway, sequence) : '—',
    pathwayStatus: (row.pathway_status as string | null) ?? (pathway ? 'initiated' : 'mortal'),
    status: row.status,
    statusLabel: STATUS_LABEL[row.status] ?? row.status,
    hp: row.hp, mp: row.mp, mad: row.mad, cor: row.cor, dig: row.dig, dp: row.dp,
    cityId: row.current_city_id ?? null,
    cityName: row.current_city_id ? cityName : '（未定）',
    updatedAt: row.updated_at,
  };
}

const PLAYER_SQL = `SELECT c.*, u.qq_id AS qq_id, u.nickname AS nickname
   FROM characters c LEFT JOIN users u ON u.id = c.user_id`;

function cityNamer(db: Db): (id: string | null) => string {
  const cities = new CityRepo(db).all();
  const byId = new Map(cities.map((c) => [c.id, c.name]));
  return (id) => (id ? (byId.get(id) ?? id) : '');
}

/** 搜索：角色名 / 角色 id / QQ 号 / 昵称，空串就是列全部 */
export function gmSearch(db: Db, query: string, limit = 50): GmPlayer[] {
  const q = query.trim();
  const like = '%' + q + '%';
  const rows = db
    .prepare(
      `${PLAYER_SQL}
       WHERE ? = '' OR c.name LIKE ? OR c.id LIKE ? OR c.user_id LIKE ?
             OR COALESCE(u.qq_id, '') LIKE ? OR COALESCE(u.nickname, '') LIKE ?
       ORDER BY c.updated_at DESC
       LIMIT ?`,
    )
    .all(q, like, like, like, like, like, limit) as unknown as PlayerRow[];
  const nameOf = cityNamer(db);
  return rows.map((r) => toPlayer(r, nameOf(r.current_city_id)));
}

export function gmPlayer(db: Db, characterId: string): GmPlayer | null {
  const row = db.prepare(`${PLAYER_SQL} WHERE c.id = ?`).get(characterId) as
    | PlayerRow
    | undefined;
  if (!row) return null;
  return toPlayer(row, cityNamer(db)(row.current_city_id));
}

export interface GmDetail {
  player: GmPlayer;
  gender: string;
  churchId: string | null;
  churchContribution: number;
  promotionFails: number;
  createdAt: number;
  /** 失控闸门（当前序列的 MAD/COR 阈值）；普通人为 null */
  threshold: { mad: number; cor: number } | null;
  inventory: Array<{ itemId: string; name: string; bindType: string; bindTypeLabel: string; quantity: number }>;
  lostControl: Array<{ date: string; text: string; source: string; createdAt: number }>;
  audit: Array<{ command: string; input: string; output: string; createdAt: number }>;
  daily: Array<{ key: string; count: number }>;
  travel: { toCityId: string; toCityName: string; arrivesAt: number } | null;
}

/** now 可传：其它 GM 函数都接受它，这里不接受的话「今日计数」就只能按真实时间读，测不了 */
export function gmDetail(db: Db, characterId: string, now = Date.now()): GmDetail | null {
  const player = gmPlayer(db, characterId);
  if (!player) return null;
  const character = new CharacterRepo(db).findById(characterId);
  if (!character) return null;

  const items = new ItemRepo(db);
  const inventory = new InventoryRepo(db)
    .list(characterId)
    .map((slot) => ({
      itemId: slot.itemId,
      name: items.nameOf(slot.itemId),
      bindType: slot.bindType,
      bindTypeLabel: BIND_LABEL[slot.bindType] ?? slot.bindType,
      quantity: slot.quantity,
    }));

  const events = db
    .prepare(
      `SELECT date, text, source, created_at FROM lost_control_events
       WHERE character_id = ? ORDER BY id DESC LIMIT 10`,
    )
    .all(characterId) as Array<{ date: string; text: string; source: string; created_at: number }>;

  const audit = new AuditLog(db);
  const travel = new TravelRepo(db).activeOf(characterId);
  const nameOf = cityNamer(db);

  return {
    player,
    gender: character.gender,
    churchId: character.churchId ?? null,
    churchContribution: character.churchContribution ?? 0,
    promotionFails: character.promotionFails,
    createdAt: character.createdAt,
    threshold: lossOfControlThresholdFor(character.sequence),
    inventory,
    lostControl: events.map((e) => ({
      date: e.date, text: e.text, source: e.source, createdAt: e.created_at,
    })),
    audit: audit.recent(character.userId, 10).map((a) => ({
      command: a.command, input: a.input ?? '', output: a.output ?? '', createdAt: a.createdAt,
    })),
    daily: dailyRows(db, characterId, now),
    travel: travel ? travelInfo(db, travel, nameOf) : null,
  };
}

/** 今日各计数（键 → 次数），界面按行列出 */
function dailyRows(db: Db, characterId: string, now = Date.now()): Array<{ key: string; count: number }> {
  const used = new DailyCounterRepo(db).todayOf(characterId, dateKey(now));
  return [...used].map(([key, count]) => ({ key, count }));
}

/** 正在进行的旅途。routeId 是**路线**不是城市，终点要问路线自己 —— 直接当城市名显示会给出一个 id */
function travelInfo(
  db: Db,
  travel: { routeId: string; arrivesAt: number },
  nameOf: (id: string | null) => string,
): { toCityId: string; toCityName: string; arrivesAt: number } {
  const route = new RouteRepo(db).get(travel.routeId);
  const to = route?.to ?? travel.routeId;
  return { toCityId: to, toCityName: nameOf(to) || to, arrivesAt: travel.arrivesAt };
}

/* ------------------------------------------------------------------ */
/* 写入                                                                */
/* ------------------------------------------------------------------ */

function log(db: Db, character: CharacterState, action: string, input: unknown, output: string, now: number): void {
  new AuditLog(db).write({
    userId: character.userId,
    command: 'gm.' + action,
    input: JSON.stringify(input),
    output,
    createdAt: now,
  });
}

/**
 * 改属性。
 *
 * 超界**钳制并警告**（不是拒绝）：GM 手滑输 999 时，把 HP 写成 100 并告诉他发生了什么是
 * 更有用的行为；直接报错会让他再猜一次上限是多少。
 */
export function gmApplyStats(
  db: Db,
  characterId: string,
  patch: Partial<Record<StatKey, unknown>>,
  now = Date.now(),
): GmResult {
  const repo = new CharacterRepo(db);
  const character = repo.findById(characterId);
  if (!character) return fail('没有这个角色');

  const warnings: string[] = [];
  const changed: Record<string, { from: number; to: number }> = {};
  const next: CharacterState = { ...character };

  for (const key of STAT_KEYS) {
    const raw = patch[key];
    if (raw === undefined || raw === null || raw === '') continue;
    const value = Math.round(Number(raw));
    if (!Number.isFinite(value)) return fail(STAT_BOUNDS[key].label + ' 不是数字：' + String(raw));
    const { min, max, label } = STAT_BOUNDS[key];
    const clamped = clamp(value, min, max);
    if (clamped !== value) warnings.push(`${label} 只能 ${min}—${max}，输入的 ${value} 已按 ${clamped} 写入`);
    if (next[key] === clamped) continue;
    changed[key] = { from: next[key], to: clamped };
    (next as unknown as Record<StatKey, number>)[key] = clamped;
  }

  if (Object.keys(changed).length === 0) return done('没有变化。', warnings);

  /*
   * 普通人越界：MAD/COR 上限低于失控闸门，这是「普通人不可能失控」的前提。
   * 一旦写超了，那个前提就静默失效 —— 判定层不会报错，只会算出一个不该存在的失控。
   */
  if (next.pathwayStatus === 'mortal') {
    const caps = NUMERIC.initiation.mortalCaps as unknown as Record<string, number>;
    for (const key of ['hp', 'mp', 'mad', 'cor'] as const) {
      const cap = caps[key];
      if (cap !== undefined && next[key] > cap) {
        warnings.push(
          `普通人的 ${STAT_BOUNDS[key].label} 上限是 ${cap}（保护期设计：上限低于失控闸门，` +
            '所以普通人不可能失控）。现在写成了 ' + next[key] + '，这条前提失效了。',
        );
      }
    }
  }

  next.updatedAt = now;
  repo.update(next);
  const summary = Object.entries(changed)
    .map(([k, v]) => `${STAT_BOUNDS[k as StatKey].label} ${v.from} → ${v.to}`)
    .join('，');
  log(db, next, 'stats', changed, summary, now);
  return done('已写入：' + summary, warnings);
}

/** 改途径 / 序列。pathway 与 sequence 必须同进同退，pathway_status 由它们推出来 */
export function gmSetPathway(
  db: Db,
  characterId: string,
  pathway: unknown,
  sequence: unknown,
  now = Date.now(),
): GmResult {
  const repo = new CharacterRepo(db);
  const character = repo.findById(characterId);
  if (!character) return fail('没有这个角色');

  const clear = pathway === null || pathway === '' || pathway === undefined;
  const warnings: string[] = [];
  const next: CharacterState = { ...character };

  if (clear) {
    next.pathway = null;
    next.sequence = null;
    next.pathwayStatus = 'mortal';
  } else {
    const id = String(pathway) as PathwayId;
    if (!(id in PATHWAY_LABELS)) return fail('没有这条途径：' + String(pathway));
    const seq = Math.round(Number(sequence));
    if (!Number.isFinite(seq) || seq < 0 || seq > 9) return fail('序列只能是 0—9');
    next.pathway = id;
    next.sequence = seq;
    // 三联必须一致：只改 pathway 不改 pathway_status，会读出「有途径的普通人」
    next.pathwayStatus = 'initiated';
    if (seq > 2) {
      warnings.push('本版内容只做到序列 2（' + sequenceTitle(id, 2) + '），序列 ' + seq + ' 的称号有名字但没有对应的能力行。');
    }
  }

  next.updatedAt = now;
  repo.update(next);
  const summary = clear
    ? '改为普通人（途径与序列清空）'
    : PATHWAY_LABELS[next.pathway as PathwayId] + ' 序列 ' + String(next.sequence) +
      '（' + sequenceTitle(next.pathway as PathwayId, next.sequence as number) + '）';
  log(db, next, 'pathway', { pathway, sequence }, summary, now);
  return done('已写入：' + summary, warnings);
}

export function gmSetStatus(db: Db, characterId: string, status: unknown, now = Date.now()): GmResult {
  const allowed = SETTABLE_STATUS.map((s) => s.id) as string[];
  if (typeof status !== 'string' || !allowed.includes(status)) {
    return fail('只能设成：' + SETTABLE_STATUS.map((s) => s.label).join(' / '));
  }
  const repo = new CharacterRepo(db);
  const character = repo.findById(characterId);
  if (!character) return fail('没有这个角色');
  if (character.status === status) return done('没有变化。');

  const from = STATUS_LABEL[character.status] ?? character.status;
  const next: CharacterState = { ...character, status: status as CharacterStatus, updatedAt: now };
  repo.update(next);

  const warnings: string[] = [];
  /*
   * 强制失控要留档（玩家侧「今天失控过」是按这张表算的，explore 会读它），
   * 但 source 必须写成 'gm' —— 运营指标把这张表的行数当失控触发率，
   * 而那个指标超过 0.2 会直接报 P0。手动造的失控不能混进去。
   */
  if (status === 'lost_control') {
    new LostControlRepo(db).record({
      characterId,
      date: dateKey(now),
      pathway: character.pathway ?? 'mortal',
      text: '（GM 手动置为失控）',
      hpLoss: 0,
      madGain: 0,
      // M2.76：GM 手动置的失控**不进任何形态** —— null 的语义正是「不是某个形态」，
      // 与「内容还没写形态」共用一个值，但 source='gm' 已经把这两件事分开了。
      form: null,
      source: 'gm',
      createdAt: now,
    });
    warnings.push('已按 source=gm 留档；它不会计入运营的失控触发率。');
  }

  log(db, next, 'status', { status }, from + ' → ' + (STATUS_LABEL[status] ?? status), now);
  return done('状态：' + from + ' → ' + (STATUS_LABEL[status] ?? status), warnings);
}

export function gmTeleport(db: Db, characterId: string, cityId: unknown, now = Date.now()): GmResult {
  const repo = new CharacterRepo(db);
  const character = repo.findById(characterId);
  if (!character) return fail('没有这个角色');
  const city = new CityRepo(db).get(String(cityId));
  if (!city) return fail('没有这座城市：' + String(cityId));

  const warnings: string[] = [];
  // 传送时如果正在旅行，那条记录会永远停在 traveling —— 到达判定再也轮不到它，
  // 而 activeOf() 会一直返回它，玩家再也发不出新的移动。
  const travelling = new TravelRepo(db).activeOf(characterId);
  if (travelling) {
    new TravelRepo(db).update({ ...travelling, status: 'aborted' });
    warnings.push('原来有一段进行中的旅途，已中止（否则它会一直挂着，之后再也移动不了）。');
  }

  const next: CharacterState = { ...character, currentCityId: city.id, updatedAt: now };
  repo.update(next);
  log(db, next, 'teleport', { cityId: city.id }, '→ ' + city.name, now);
  return done('已传送到 ' + city.name, warnings);
}

export function gmInventory(
  db: Db,
  characterId: string,
  body: { action?: unknown; itemId?: unknown; quantity?: unknown; bindType?: unknown },
  now = Date.now(),
): GmResult {
  const repo = new CharacterRepo(db);
  const character = repo.findById(characterId);
  if (!character) return fail('没有这个角色');

  const items = new ItemRepo(db);
  const itemId = String(body.itemId ?? '');
  const item = items.get(itemId);
  if (!item) return fail('没有这件物品：' + itemId);

  const quantity = Math.round(Number(body.quantity));
  if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 9999) {
    return fail('数量只能是 1—9999');
  }
  const bindType = (body.bindType === 'bound' ? 'bound' : 'unbound') as BindType;
  const inventory = new InventoryRepo(db);
  const name = items.nameOf(itemId);

  if (body.action === 'take') {
    const ok = inventory.tryRemove(characterId, itemId, quantity, now);
    if (!ok) {
      const have = inventory.count(characterId, itemId);
      return fail(`背包里只有 ${have} 个 ${name}，收不回 ${quantity} 个（扣减不会部分执行）。`);
    }
    log(db, character, 'take', { itemId, quantity }, `收回 ${name} × ${quantity}`, now);
    return done(`已收回 ${name} × ${quantity}`);
  }

  inventory.add(characterId, itemId, quantity, bindType, now);
  log(db, character, 'give', { itemId, quantity, bindType }, `发放 ${name} × ${quantity}（${BIND_LABEL[bindType]}）`, now);
  return done(`已发放 ${name} × ${quantity}（${BIND_LABEL[bindType]}）`);
}

/**
 * M2.68：**改势力之间的关系**（世界级 GM 操作，与玩家无关）。
 *
 * ## 为什么需要一个世界级的 GM 动作
 *
 * `power_relations` 表从 M2.59 起就存在，`powers.yaml` 的文件头也写着
 * 「relations 是默认值，会被运行时状态覆盖」—— 但那张表**只有后台的只读页面读它**，
 * `upsert` 一个调用者都没有。于是「覆盖」这件事从来没有发生过。
 *
 * 这一轮把合并链接上了（内容 → 历史 → 运行时），这个动作是往**第三层**写的那支笔：
 * 剧情需要「黑帮和警察暂时休战」时，GM 能改，而且改完**热重载即生效**。
 *
 * ## 三条约束
 *
 * 1. **两端必须是真实存在的势力**：写一个不存在的 id 进去，合并链会把它变成一个
 *    永远不会被读到的孤儿（判据看不见、界面也看不见）。
 * 2. **一对一覆盖**（`from + to` 唯一）：同一条关系重复写是覆盖，不是新增。
 * 3. **留痕**：写进 `audit_logs`（与其它 GM 写入同一条纪律）。这里用的是操作者级别的
 *    日志而不是角色级别的 —— 势力关系不属于任何一个玩家。
 */
export function gmSetPowerRelation(
  db: Db,
  body: { from?: unknown; to?: unknown; kind?: unknown },
  now = Date.now(),
): GmResult {
  const from = String(body.from ?? '').trim();
  const to = String(body.to ?? '').trim();
  const kind = String(body.kind ?? '').trim();
  if (from === '' || to === '') return fail('要指定两端的势力（from / to）');
  if (from === to) return fail('一家势力和自己之间没有关系可写');
  if (kind !== 'ally' && kind !== 'hostile' && kind !== 'debt') {
    return fail('关系只能是 ally / hostile / debt');
  }

  const known = new Set(loadPowers().powers.map((power) => power.id));
  if (!known.has(from)) return fail('没有这家势力：' + from);
  if (!known.has(to)) return fail('没有这家势力：' + to);

  new PowerRelationRepo(db).upsert(from, to, kind, RELATION_WEIGHT, now);
  new AuditLog(db).write({
    userId: OPERATOR,
    command: 'gm.power-relation',
    input: JSON.stringify({ from, to, kind }),
    output: from + ' → ' + to + '：' + RELATION_LABEL[kind],
    createdAt: now,
  });
  return done(
    '已写入：' + from + ' → ' + to + ' = ' + RELATION_LABEL[kind] +
      '（覆盖 powers.yaml 与历史的同一条；热重载或重启后进判定）',
    ['这是一条**运行时**关系：删掉 power_relations 里那一行才会回到内容表的默认值。'],
  );
}

/** 运行时关系的默认权重（本版判定只看 kind，权重留给后续的「关系强度」） */
const RELATION_WEIGHT = 1;

const RELATION_LABEL: Readonly<Record<string, string>> = {
  ally: '同盟',
  hostile: '敌对',
  debt: '人情',
};

/**
 * 重置今日计数。
 *
 * 「今日」在库里散在五张表里，少清一张就会出现「探索次数重置了但 AP 还是用光的」
 * 这种半截状态 —— 所以这里一次清全。
 */
export function gmResetDaily(db: Db, characterId: string, now = Date.now()): GmResult {
  const repo = new CharacterRepo(db);
  const character = repo.findById(characterId);
  if (!character) return fail('没有这个角色');
  const date = dateKey(now);

  const targets: Array<[string, string, string[]]> = [
    ['daily_counters', 'character_id = ? AND date = ?', [characterId, date]],
    ['daily_actions', 'character_id = ? AND date = ?', [characterId, date]],
    ['explore_daily', 'character_id = ? AND date = ?', [characterId, date]],
    ['daily_tag_usage', 'character_id = ? AND date = ?', [characterId, date]],
    // cooldowns 不带日期，是「上次使用时刻」，要按角色全清
    ['cooldowns', 'character_id = ?', [characterId]],
  ];
  const cleared: string[] = [];
  for (const [table, where, params] of targets) {
    const info = db.prepare(`DELETE FROM ${table} WHERE ${where}`).run(...params);
    const n = Number(info.changes ?? 0);
    if (n > 0) cleared.push(`${table} ×${n}`);
  }

  const summary = cleared.length ? '清空 ' + cleared.join('，') : '今天本来就没有计数';
  log(db, character, 'reset-daily', { date }, summary, now);
  return done('已重置 ' + date + ' 的计数：' + summary);
}

/* ------------------------------------------------------------------ */
/* 下拉选项                                                            */
/* ------------------------------------------------------------------ */

export interface GmOptions {
  cities: Array<{ id: string; name: string }>;
  items: Array<{ id: string; name: string }>;
  pathways: Array<{ id: string; label: string }>;
  statuses: Array<{ id: string; label: string }>;
  stats: Array<{ key: StatKey; label: string; min: number; max: number }>;
  bindTypes: Array<{ id: string; label: string }>;
  sequences: number[];
  /** M2.68：势力（世界级的「改关系」那一栏要用） */
  powers: Array<{ id: string; name: string }>;
  /** M2.68：关系种类（值与 RELATION_LABEL 同一份） */
  relationKinds: Array<{ id: string; label: string }>;
}

export function gmOptions(db: Db): GmOptions {
  return {
    cities: new CityRepo(db).all().map((c) => ({ id: c.id, name: c.name })),
    items: new ItemRepo(db).all().map((i) => ({ id: i.id, name: i.name })),
    pathways: (Object.keys(PATHWAY_LABELS) as PathwayId[]).map((id) => ({ id, label: PATHWAY_LABELS[id] })),
    statuses: SETTABLE_STATUS.map((s) => ({ id: s.id, label: s.label })),
    stats: STAT_KEYS.map((k) => ({ key: k, label: STAT_BOUNDS[k].label, min: STAT_BOUNDS[k].min, max: STAT_BOUNDS[k].max })),
    bindTypes: [
      { id: 'unbound', label: BIND_LABEL.unbound! },
      { id: 'bound', label: BIND_LABEL.bound! },
    ],
    sequences: [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
    // M2.68：势力下拉（内容表里那 11 家）与关系种类的取值域
    powers: loadPowers().powers.map((power) => ({ id: power.id, name: power.name })),
    relationKinds: Object.entries(RELATION_LABEL).map(([id, label]) => ({ id, label })),
  };
}
